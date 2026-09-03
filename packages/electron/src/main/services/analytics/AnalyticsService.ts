import Store from "electron-store";
import {PostHog} from "posthog-node";
import {ulid} from "ulid";
import {logger} from "../../utils/logger";
import {app} from "electron";
import {getReleaseChannel, isAnalyticsEnabled, setAnalyticsEnabled} from "../../utils/store";
import {isGitAvailable} from "../../utils/gitUtils";
import {bucketDaysSinceInstall, bucketLaunchNumber, decideLaunch, type BuildType} from "./launchAttribution";

const POSTHOG_PROJECT_PUBLIC_ID = 'phc_s3lQIILexwlGHvxrMBqti355xUgkRocjMXW4LjV0ATw';

type AnalyticsSettings = {
  analyticsEnabled: boolean;
  analyticsId: string;
  /**
   * Install-scoped launch attribution. Lives here rather than in the app store
   * so it shares the analytics store's lifetime — it goes away when the user
   * removes the app, which is the point. This is deliberately NOT a
   * machine-scoped identifier: nothing here survives an uninstall, so it cannot
   * be used to re-link a user who chose to leave.
   */
  firstLaunchAt?: string;
  launchCount?: number;
  /**
   * Lifetime count of agent sessions this install has created, for
   * `create_ai_session`'s ordinal bucket. Same lifetime and same reasoning as
   * the two above; it is a local integer and is never transmitted raw.
   */
  sessionsCreated?: number;
}

export type { BuildType } from './launchAttribution';

/**
 * Singleton analytics service for server side (electron) events. If you need to send events from the renderer on
 * the other side of the IPC boundary, use the usePostHog react hook from posthog-js/react to get the client-side
 * posthog instance.
 */
export class AnalyticsService {

  private log =
    logger.analytics ??
    logger.ai ??
    ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as const);

  private static instance: AnalyticsService = new AnalyticsService();

  public static getInstance(): AnalyticsService {
    return this.instance;
  }

  private constructor() {
    this.init();
  }

  private settingsStore?: Store<AnalyticsSettings>;
  private postHogClient?: PostHog;
  private sessionTracker?: PostHog; // only used to track session start times
  private distinctId?: string;
  private sessionId?: string;
  private isDevInstallation: boolean = process.env.NODE_ENV?.toLowerCase() === 'development';
  private isOfficialBuild: boolean = process.env.OFFICIAL_BUILD === 'true';
  private launchAttribution?: { launchNumber: number; daysSinceInstall: number };

  public init(): void {
    this.postHogClient ??= this.initPostHogClient();
    this.sessionTracker ??= this.initPostHogClient();
    this.healthCheck();
    this.log.info(`Analytics service initialized (analytics ID: ${this.getDistinctId()}, official build: ${this.isOfficialBuild})`);
  }

  public sendEvent(eventName: string, properties?: Record<string | number, any>): void {
    // Validate event name
    if (!eventName) {
      this.log.warn('[Analytics] Skipping event: empty eventName');
      return;
    }

    // Check PostHog client initialization
    if (!this.postHogClient) {
      this.log.error('[Analytics] Skipping event: PostHog client not initialized', { eventName });
      return;
    }

    // Check analytics enabled state
    if (!this.allowedToSendAnalytics()) {
      this.log.info('[Analytics] Skipping event: analytics disabled', {
        eventName,
        analyticsEnabled: isAnalyticsEnabled()
      });
      return;
    }

    // Send event
    const eventProperties: Record<string | number, any> = {
      '$session_id': this.sessionId,
      'nimbalyst_version': app.getVersion(),
      ...this.releaseAttribution(),
      ...properties,
    }

    // Mark users as dev users if they've ever used a non-official build
    // This ensures the property is set even if they missed the session start event
    if (!this.isOfficialBuild) {
      eventProperties.$set_once = {
        'is_dev_user': true,
        ...eventProperties.$set_once
      }
    }

    // this.log.info(`event: ${eventName}`, eventProperties);
    this.postHogClient.capture({
      distinctId: this.getDistinctId(),
      event: eventName,
      properties: eventProperties,
    })
  }

  /**
   * Resolve a PostHog feature flag. Returns `null` when the answer is unknown
   * — client not up, analytics opted out, or the network call failed — so
   * callers can distinguish "off" from "we couldn't ask". Never throws.
   */
  public async getFeatureFlag(key: string): Promise<boolean | null> {
    if (!this.postHogClient || !this.allowedToSendAnalytics()) {
      return null;
    }
    try {
      const value = await this.postHogClient.isFeatureEnabled(key, this.getDistinctId());
      return value ?? null;
    } catch (err) {
      this.log.warn(`[Analytics] Feature flag '${key}' lookup failed`, err);
      return null;
    }
  }

  /**
   * Can this install receive remote configuration through PostHog at all?
   *
   * Deliberately stricter than `allowedToSendAnalytics`, which fails *open*
   * when the settings store cannot be read. The one caller is the migration
   * rollout kill switch, where "we could not read the setting" must never
   * resolve to "go ahead and rewrite the user's database". See
   * `database/sqlite/migrationFlag.ts` for why an install that answers `false`
   * here is kept out of automatic migration entirely.
   */
  public canEvaluateRemoteConfig(): boolean {
    if (!this.postHogClient) return false;
    try {
      return isAnalyticsEnabled();
    } catch (error) {
      this.log.warn('[Analytics] Could not read analytics consent; treating remote config as unavailable', { error });
      return false;
    }
  }

  /**
   * The JSON payload attached to a feature flag, or `null` when it cannot be
   * obtained — client not up, analytics opted out, flag off, or the network
   * call failed. Never throws. Callers must treat `null` as "no answer", not
   * as a value.
   */
  public async getFeatureFlagPayload(key: string): Promise<unknown | null> {
    if (!this.postHogClient || !this.canEvaluateRemoteConfig()) {
      return null;
    }
    try {
      const payload = await this.postHogClient.getFeatureFlagPayload(key, this.getDistinctId());
      return payload ?? null;
    } catch (err) {
      this.log.warn(`[Analytics] Feature flag payload '${key}' lookup failed`, err);
      return null;
    }
  }

  public async optIn(): Promise<void> {
    this.log.info('Processing analytics opt-in');

    this.postHogClient ??= this.initPostHogClient();
    await this.postHogClient?.optIn()

    setAnalyticsEnabled(true);

    // Keep analytics ID in the analytics-specific store
    if (!this.getSettingsStore().get("analyticsId")) {
      this.getSettingsStore().set({ analyticsId: `nimbalyst_${ulid()}` });
    }
  }

  public async optOut(): Promise<void> {
    this.log.info('Processing analytics opt-out');

    if (this.postHogClient) {
      await this.postHogClient.captureImmediate({ distinctId: this.getDistinctId(), event: 'analytics_opt_out' });
      await this.postHogClient.optOut()
    }

    setAnalyticsEnabled(false);
  }

  /**
   * Invoked by the render-side tracker when PostHog generates a new session ID so the electron-side tracker can send
   * the same session ID in its events too. You probably never need to call this yourself.
   */
  public setSessionId(sessionId: string): void {
    // this.log.info(`Setting analytics session ID: ${sessionId}, previous session ID: ${this.sessionId}, official build: ${this.isOfficialBuild}`);
    this.sessionId = sessionId;

    if (!this.allowedToSendAnalytics()) {
      this.log.info('Skipping session start event (analytics disabled)');
      return;
    }

    // `nimbalyst_session_start` is the one event every install emits — it is
    // even sent for opted-out users as the retention ping — and until now it
    // was the one event that carried the version only as a person property
    // ($set, latest wins), so no funnel built on it could be attributed to a
    // release. Stamped on the event here as well as $set.
    const { launchNumber, daysSinceInstall } = this.recordLaunch();
    const eventProperties: Record<string | number, any> = {
      '$session_id': this.sessionId,
      'has_git_installed': isGitAvailable(),
      'nimbalyst_version': app.getVersion(),
      ...this.releaseAttribution(),
      'launch_number': bucketLaunchNumber(launchNumber),
      'days_since_install': bucketDaysSinceInstall(daysSinceInstall),
      $set: {
        'nimbalyst_version': app.getVersion(),
        'cpu_arch': process.arch,
      }
    };

    // Mark users as dev users if they've ever used a non-official build
    // This uses $set_once which only sets the property if it doesn't already exist
    // Once someone is marked as a dev user, they remain marked even on official builds
    if (!this.isOfficialBuild) {
      eventProperties.$set_once = {
        'is_dev_user': true
      }
    }

    // Also track whether this is a dev installation (NODE_ENV=development)
    if (this.isDevInstallation) {
      eventProperties.$set_once = {
        ...eventProperties.$set_once,
        'is_dev_install': true
      }
    }

    this.sessionTracker?.capture({
      distinctId: this.getDistinctId(),
      event: 'nimbalyst_session_start',
      properties: eventProperties
    })
  }

  public async destroy(): Promise<void> {
    const t0 = Date.now();
    if (this.postHogClient) {
      await this.postHogClient.shutdown();
    }
    const t1 = Date.now();
    this.log.info(`Analytics service shut down in ${t1 - t0}ms`);
  }

  public allowedToSendAnalytics(): boolean {
    // Check if user has enabled analytics in settings
    try {
      const enabled = isAnalyticsEnabled();
      return enabled;
    } catch (error) {
      this.log.error('[Analytics] Error checking analytics enabled state', { error });
      // Fail open - if we can't read the setting, allow analytics
      // This ensures analytics works even if store initialization fails
      return true;
    }
  }

  /**
   * Health check for analytics system.
   * Logs diagnostic information to help identify initialization failures.
   */
  private healthCheck(): void {
    const checks = {
      postHogClient: !!this.postHogClient,
      sessionTracker: !!this.sessionTracker,
      distinctId: this.getDistinctId(),
      storeAccessible: true,
      analyticsEnabled: false,
    };

    try {
      checks.analyticsEnabled = this.allowedToSendAnalytics();
    } catch (error) {
      checks.storeAccessible = false;
      this.log.error('[Analytics] Store access failed during health check', { error });
    }

    this.log.info('[Analytics] Health check', checks);

    if (!checks.postHogClient) {
      this.log.error('[Analytics] CRITICAL: PostHog client not initialized');
    }

    if (!checks.storeAccessible) {
      this.log.error('[Analytics] CRITICAL: Cannot access analytics settings store');
    }

    if (!checks.analyticsEnabled) {
      this.log.info('[Analytics] Analytics disabled by user preference');
    }
  }

  public getDistinctId(): string {
    return this.distinctId ??= this.getSettingsStore().get('analyticsId');
  }

  /**
   * Release attribution, on every event.
   *
   * `nimbalyst_version` was already an event property here, but `build_type`
   * was only recoverable from the `is_dev_user` person property — which is
   * `$set_once` and sticky forever, so a user who ever ran a dev build has
   * every later official-build event indistinguishable from their dev ones.
   * A per-event value is what actually lets a funnel exclude dev traffic.
   */
  public buildType(): BuildType {
    if (this.isDevInstallation) return 'dev';
    return this.isOfficialBuild ? 'official' : 'local';
  }

  /** Same values the main process stamps, for the renderer to register. */
  public releaseAttributionForRenderer(): { release_channel: string; build_type: string } {
    const { release_channel, build_type } = this.releaseAttribution();
    return { release_channel: release_channel ?? 'unknown', build_type };
  }

  private releaseAttribution(): { release_channel?: string; build_type: string } {
    try {
      return {
        'release_channel': getReleaseChannel(),
        'build_type': this.buildType(),
      };
    } catch (error) {
      // Never let a store read failure drop an event.
      this.log.warn('[Analytics] Could not resolve release attribution', { error });
      return { 'build_type': this.buildType() };
    }
  }

  /**
   * Increment and read this install's launch attribution.
   *
   * Memoized per process because `setSessionId` is driven by
   * `posthog.onSessionId`, which fires once per WINDOW and again on session
   * rotation — incrementing there would count windows, not launches.
   */
  private recordLaunch(): { launchNumber: number; daysSinceInstall: number } {
    if (this.launchAttribution) return this.launchAttribution;
    const store = this.getSettingsStore();
    const { next, launchNumber, daysSinceInstall } = decideLaunch(
      { firstLaunchAt: store.get('firstLaunchAt'), launchCount: store.get('launchCount') },
      Date.now(),
    );
    store.set('firstLaunchAt', next.firstLaunchAt);
    store.set('launchCount', next.launchCount);
    return this.launchAttribution = { launchNumber, daysSinceInstall };
  }

  /**
   * Increment and read this install's lifetime session-creation count.
   *
   * A persisted counter rather than a `COUNT(*)` over `ai_sessions` on purpose:
   * the number is wanted on every single create, and a per-create aggregate
   * query is exactly the N+1 shape this codebase keeps having to remove.
   *
   * Deliberately NOT memoized the way `recordLaunch` is -- that one must count
   * launches rather than windows, whereas every creation here is its own
   * ordinal.
   */
  public nextSessionOrdinal(): number {
    const store = this.getSettingsStore();
    const ordinal = (store.get('sessionsCreated') ?? 0) + 1;
    store.set('sessionsCreated', ordinal);
    return ordinal;
  }

  private getSettingsStore(): Store<AnalyticsSettings> {
    return this.settingsStore ??= new Store({
      name: 'analytics-settings',
      defaults: {
        analyticsEnabled: true,
        analyticsId: `nimbalyst_${ulid()}`
      }
    });
  }

  private initPostHogClient(): PostHog {
    return new PostHog(
      POSTHOG_PROJECT_PUBLIC_ID,
      {
        privacyMode: true,
        bootstrap: {
          distinctId: this.getDistinctId()
        },
        disableGeoip: false,
        enableExceptionAutocapture: false,
        before_send: (event) => process.env.PLAYWRIGHT_TEST ? null : event
      }
    );
  }

}
