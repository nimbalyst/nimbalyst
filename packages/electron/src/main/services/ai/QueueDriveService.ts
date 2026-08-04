/**
 * QueueDriveService — the single main-process owner of queued-prompt drainage.
 *
 * Before this existed there were six independent one-shot triggers (renderer
 * effect, mobile control message, mobile sync index change, FIFO continuation,
 * `ai:triggerQueueProcessing` IPC, boot sweep) and every one of them failed
 * silently: if the edge arrived while the session was busy, the workspace had
 * no window, or the transcript wasn't mounted, the attempt evaporated and
 * nothing re-scheduled it. That is why users had to press Escape or restart —
 * those actions manufacture a new edge. See #962.
 *
 * This service turns every trigger into `requestDrive(...)` and owns the
 * retry. It deliberately adds NO claim semantics: exactly-once still comes
 * from the store's atomic `UPDATE ... WHERE status='pending'` claim.
 *
 * Pure module — Electron and the database are injected — so it is unit
 * testable without a main process.
 */

/** Why a drive was requested. Recorded in logs; W4 will persist it. */
export type DriveReason =
  | 'boot-recovery'
  | 'window-available'
  | 'session-idle'
  | 'fifo-continuation'
  | 'mobile-control'
  | 'mobile-index'
  | 'renderer-trigger'
  | 'send-now'
  | 'meta-agent'
  | 'wakeup'
  | 'restart-continuation'
  | 'safety-sweep';

/** Why an attempt could not dispatch. All of these are retryable except workspace-missing. */
export type BlockedReason =
  | 'no-window'
  | 'session-busy'
  | 'workspace-missing'
  | 'db-not-ready'
  | 'provider-unavailable';

export type DriveOutcome =
  | { kind: 'dispatched'; promptId?: string }
  | { kind: 'nothing-pending' }
  | { kind: 'deferred'; reason: BlockedReason }
  | { kind: 'failed'; reason: string };

export interface QueueDriveTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface QueueDriveDeps {
  /**
   * Run one drive attempt. Must resolve — a rejection is treated as a
   * deferred attempt so a transient throw can't strand the queue.
   */
  attempt(input: {
    sessionId: string;
    workspacePath: string;
    reason: DriveReason;
  }): Promise<DriveOutcome>;
  /** Fire once a window for this workspace exists. Returns an unsubscribe. */
  onWindowAvailable(workspacePath: string, listener: () => void): () => void;
  /** Fire once this session leaves the running state. Returns an unsubscribe. */
  onSessionIdle(sessionId: string, listener: () => void): () => void;
  /** Fire once the database is usable. Returns an unsubscribe. */
  onDatabaseReady?(listener: () => void): () => void;
  logInfo(message: string): void;
  logWarn(message: string): void;
  logError(message: string, error: unknown): void;
  timers?: QueueDriveTimers;
}

/**
 * Safety net for a wake condition we failed to model. Per-session and armed
 * only while that session has a deferred row, so this is explicitly not a
 * global queue poller.
 */
export const QUEUE_DRIVE_BACKOFF_MS = [2_000, 5_000, 15_000, 60_000] as const;

interface SessionDriveState {
  workspacePath: string;
  /** The attempt loop currently running for this session, if any. */
  inFlight: Promise<DriveOutcome> | null;
  /** A drive requested while one was in flight; collapses to a single re-run. */
  rerunReason: DriveReason | null;
  backoffIndex: number;
  backoffHandle: unknown | null;
  /** One subscription per blocked reason, so repeated defers can't stack listeners. */
  wakeSubscriptions: Map<BlockedReason, () => void>;
}

const WAKE_REASON: Record<BlockedReason, DriveReason> = {
  'no-window': 'window-available',
  'session-busy': 'session-idle',
  'workspace-missing': 'safety-sweep',
  'db-not-ready': 'safety-sweep',
  'provider-unavailable': 'safety-sweep',
};

export class QueueDriveService {
  private readonly deps: QueueDriveDeps;
  private readonly timers: QueueDriveTimers;
  private readonly sessions = new Map<string, SessionDriveState>();
  private disposed = false;

  constructor(deps: QueueDriveDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  /**
   * Ask for the session's queue to be drained. Fire-and-forget by design:
   * every caller is an edge, and the service owns everything after it.
   */
  requestDrive(sessionId: string, workspacePath: string, reason: DriveReason): void {
    void this.drive(sessionId, workspacePath, reason);
  }

  /**
   * Same as `requestDrive`, but resolves with the outcome. Only for the few
   * callers that must report back whether the prompt actually went out (the
   * wakeup scheduler marks a wakeup "waiting for workspace" on a non-dispatch).
   * A caller arriving mid-attempt joins that attempt rather than starting one.
   */
  drive(sessionId: string, workspacePath: string, reason: DriveReason): Promise<DriveOutcome> {
    if (this.disposed) {
      return Promise.resolve<DriveOutcome>({ kind: 'nothing-pending' });
    }

    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        workspacePath,
        inFlight: null,
        rerunReason: null,
        backoffIndex: 0,
        backoffHandle: null,
        wakeSubscriptions: new Map(),
      };
      this.sessions.set(sessionId, state);
    }

    // Latest workspacePath wins — a session can move between a project and
    // its worktree, and the newest caller has the better path.
    state.workspacePath = workspacePath;

    if (state.inFlight) {
      state.rerunReason = reason;
      return state.inFlight;
    }

    const attempt = this.run(sessionId, reason);
    const tracked = attempt.finally(() => {
      const current = this.sessions.get(sessionId);
      if (current && current.inFlight === tracked) {
        current.inFlight = null;
      }
    });
    state.inFlight = tracked;
    return tracked;
  }

  /** Drop all timers and subscriptions (app shutdown). */
  dispose(): void {
    this.disposed = true;
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.disarm(sessionId);
    }
    this.sessions.clear();
  }

  private async run(sessionId: string, initialReason: DriveReason): Promise<DriveOutcome> {
    const state = this.sessions.get(sessionId);
    if (!state) return { kind: 'nothing-pending' };

    let reason = initialReason;
    let outcome: DriveOutcome = { kind: 'nothing-pending' };

    // Loop rather than re-enter: concurrent requests collapsed into
    // `rerunReason` are serviced here, so one session never has two
    // attempts in flight.
    for (;;) {
      state.rerunReason = null;

      try {
        outcome = await this.deps.attempt({
          sessionId,
          workspacePath: state.workspacePath,
          reason,
        });
      } catch (error) {
        this.deps.logError(
          `[QueueDrive] attempt threw for session ${sessionId} (${reason}); treating as deferred`,
          error,
        );
        outcome = { kind: 'deferred', reason: 'provider-unavailable' };
      }

      this.applyOutcome(sessionId, reason, outcome);

      if (!state.rerunReason || this.disposed) break;
      reason = state.rerunReason;
    }

    return outcome;
  }

  private applyOutcome(sessionId: string, reason: DriveReason, outcome: DriveOutcome): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    switch (outcome.kind) {
      case 'dispatched':
        this.deps.logInfo(
          `[QueueDrive] ${reason}: dispatched${outcome.promptId ? ` prompt ${outcome.promptId}` : ''} for session ${sessionId}`,
        );
        // The dispatch chain owns the follow-on prompts and calls back in
        // through `fifo-continuation`, so nothing to retry here.
        this.disarm(sessionId);
        break;

      case 'nothing-pending':
        this.disarm(sessionId);
        break;

      case 'deferred':
        this.deps.logInfo(
          `[QueueDrive] ${reason}: deferred session ${sessionId} (${outcome.reason})`,
        );
        this.armWake(sessionId, outcome.reason);
        this.armBackoff(sessionId);
        break;

      case 'failed':
        this.deps.logWarn(
          `[QueueDrive] ${reason}: session ${sessionId} failed terminally (${outcome.reason})`,
        );
        this.disarm(sessionId);
        break;
    }
  }

  /**
   * Subscribe to the condition that unblocks this session. One subscription
   * per blocked reason so a session that defers ten times doesn't register
   * ten listeners.
   */
  private armWake(sessionId: string, blocked: BlockedReason): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.wakeSubscriptions.has(blocked)) return;

    const fire = () => {
      const current = this.sessions.get(sessionId);
      if (!current) return;
      this.disarmWake(sessionId, blocked);
      this.requestDrive(sessionId, current.workspacePath, WAKE_REASON[blocked]);
    };

    let unsubscribe: (() => void) | undefined;
    switch (blocked) {
      case 'no-window':
        unsubscribe = this.deps.onWindowAvailable(state.workspacePath, fire);
        break;
      case 'session-busy':
        unsubscribe = this.deps.onSessionIdle(sessionId, fire);
        break;
      case 'db-not-ready':
        unsubscribe = this.deps.onDatabaseReady?.(fire);
        break;
      default:
        // No event models this one; the backoff net covers it.
        break;
    }

    if (unsubscribe) {
      state.wakeSubscriptions.set(blocked, unsubscribe);
    }
  }

  private disarmWake(sessionId: string, blocked: BlockedReason): void {
    const state = this.sessions.get(sessionId);
    const unsubscribe = state?.wakeSubscriptions.get(blocked);
    if (!state || !unsubscribe) return;
    state.wakeSubscriptions.delete(blocked);
    try {
      unsubscribe();
    } catch (error) {
      this.deps.logError(`[QueueDrive] failed to unsubscribe ${blocked} for ${sessionId}`, error);
    }
  }

  private armBackoff(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.backoffHandle !== null) return;

    const delay =
      QUEUE_DRIVE_BACKOFF_MS[Math.min(state.backoffIndex, QUEUE_DRIVE_BACKOFF_MS.length - 1)];
    state.backoffIndex += 1;

    state.backoffHandle = this.timers.setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (!current) return;
      current.backoffHandle = null;
      this.requestDrive(sessionId, current.workspacePath, 'safety-sweep');
    }, delay);
  }

  /** Clear the backoff timer and every wake subscription for this session. */
  private disarm(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    if (state.backoffHandle !== null) {
      this.timers.clearTimeout(state.backoffHandle);
      state.backoffHandle = null;
    }
    state.backoffIndex = 0;

    for (const blocked of Array.from(state.wakeSubscriptions.keys())) {
      this.disarmWake(sessionId, blocked);
    }
  }
}
