import {
  bucketDuration,
  bucketRetryCount,
  categorizeTeamAnalyticsError,
  type TeamAnalyticsProperties,
} from './teamAnalytics';

export type CollaborationHealthStatus =
  | 'connecting'
  | 'syncing'
  | 'connected'
  | 'replaying'
  | 'offline-unsynced'
  | 'error'
  | 'disconnected';

interface ActiveAttempt {
  connectionPath: 'initial' | 'reconnect' | 'offline_open' | 'resume';
  startedAt: number;
  retryCount: number;
  hadPendingOutbox: boolean;
  lastStatus: CollaborationHealthStatus | null;
}

/**
 * A flapping WebSocket can restart a connection attempt in a tight loop, so
 * each tracker refuses to emit more than once per cooldown. The cooldown is
 * applied to every terminal outcome equally -- suppressing only successes (or
 * only failures) would bias the failure-rate alerts this event feeds.
 */
const DEFAULT_MIN_EMIT_INTERVAL_MS = 60_000;

export class CollaborationHealthAttemptTracker {
  private active: ActiveAttempt | null = null;
  private hasConnected = false;
  private lastEmittedAt: number | null = null;

  constructor(
    private readonly resourceType: 'team_index' | 'document' | 'tracker' | 'asset',
    private readonly encryptionMode: 'server_managed' | 'legacy_e2e' | 'unknown',
    private readonly now: () => number = () => Date.now(),
    private readonly minEmitIntervalMs: number = DEFAULT_MIN_EMIT_INTERVAL_MS,
  ) {}

  start(
    connectionPath: ActiveAttempt['connectionPath'],
    hadPendingOutbox = false,
  ): void {
    if (this.active) return;
    this.active = {
      connectionPath,
      startedAt: this.now(),
      retryCount: 0,
      hadPendingOutbox,
      lastStatus: null,
    };
  }

  observe(
    status: CollaborationHealthStatus,
    error?: unknown,
  ): TeamAnalyticsProperties<'collab_sync_attempt_completed'> | null {
    if (!this.active && (status === 'connecting' || status === 'syncing' || status === 'replaying')) {
      this.start(this.hasConnected ? 'reconnect' : 'initial');
    }
    const attempt = this.active;
    if (!attempt || attempt.lastStatus === status) return null;

    if (status === 'connecting' && attempt.lastStatus && attempt.lastStatus !== 'connecting') {
      attempt.retryCount += 1;
    }
    attempt.lastStatus = status;

    if (status === 'connected') {
      this.hasConnected = true;
      return this.complete('success');
    }
    if (status === 'offline-unsynced' && !this.hasConnected) {
      return this.complete('offline_ready');
    }
    if (status === 'error') {
      return this.complete('failed', error);
    }
    return null;
  }

  private complete(
    outcome: 'success' | 'failed' | 'offline_ready',
    error?: unknown,
  ): TeamAnalyticsProperties<'collab_sync_attempt_completed'> | null {
    const attempt = this.active!;
    this.active = null;
    const at = this.now();
    // The attempt itself still resolves (state stays correct); only the
    // reporting is suppressed while inside the cooldown.
    if (this.lastEmittedAt !== null && at - this.lastEmittedAt < this.minEmitIntervalMs) return null;
    this.lastEmittedAt = at;
    return {
      surface: 'desktop',
      resourceType: this.resourceType,
      connectionPath: attempt.connectionPath,
      outcome,
      ...(outcome === 'failed'
        ? { errorCategory: categorizeTeamAnalyticsError('sync', error) as TeamAnalyticsProperties<'collab_sync_attempt_completed'>['errorCategory'] }
        : {}),
      durationCategory: bucketDuration(at - attempt.startedAt),
      retryCountBucket: bucketRetryCount(attempt.retryCount),
      encryptionMode: this.encryptionMode,
      hadPendingOutbox: attempt.hadPendingOutbox,
    };
  }
}
