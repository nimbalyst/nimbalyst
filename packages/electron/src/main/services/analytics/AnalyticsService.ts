import Store from "electron-store";
import {PostHog} from "posthog-node";
import {ulid} from "ulid";
import {logger} from "../../utils/logger";
import {app} from "electron";
import {isAnalyticsEnabled, setAnalyticsEnabled} from "../../utils/store";
import {isGitAvailable} from "../../utils/gitUtils";

const POSTHOG_PROJECT_PUBLIC_ID = 'phc_s3lQIILexwlGHvxrMBqti355xUgkRocjMXW4LjV0ATw';

type AnalyticsSettings = {
  analyticsEnabled: boolean;
  analyticsId: string;
}

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

    const eventProperties: Record<string | number, any> = {
      '$session_id': this.sessionId,
      'has_git_installed': isGitAvailable(),
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
