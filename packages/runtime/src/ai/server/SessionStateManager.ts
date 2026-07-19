/**
 * Session State Manager
 *
 * Manages in-memory state for AI sessions and synchronizes with database.
 * Provides event-based notifications for state changes.
 */

import { EventEmitter } from 'events';
import {
  SessionStatus,
  SessionState,
  SessionStateEvent,
  SessionStateListener,
  StartSessionOptions,
  UpdateActivityOptions,
  EndSessionOptions,
} from './types/SessionState';

const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes (as specified in requirements)

// Database interface for direct SQL access
interface DatabaseWorker {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
}

/**
 * startSession installs its immutable generation before notifying listeners.
 * If persistence or a listener throws, retain that ownership on the rejection
 * so callers can settle exactly the installed turn without consulting mutable
 * current state.
 */
export class SessionStartError extends Error {
  readonly attentionGeneration: string;
  readonly cause: unknown;

  constructor(attentionGeneration: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'SessionStartError';
    this.attentionGeneration = attentionGeneration;
    this.cause = cause;
  }
}

export class SessionStateManager extends EventEmitter {
  private activeSessions: Map<string, SessionState> = new Map();
  private database: DatabaseWorker | null = null;
  private activityUpdateTimers: Map<string, NodeJS.Timeout> = new Map();
  private attentionGenerationCounter = 0;

  constructor() {
    super();
    // Increase max listeners to accommodate multiple windows
    // Each window subscribes with 7 event listeners, so 50 allows ~7 windows
    this.setMaxListeners(50);
  }

  /**
   * Set the database worker (called after initialization).
   * Also runs stale session recovery since the database is now available.
   */
  setDatabase(database: DatabaseWorker): void {
    this.database = database;
    // Recover stale sessions now that the database is available.
    // initialize() may have already run (and skipped recovery because database was null),
    // so we need to run recovery here.
    this.recoverStaleSessions().catch(error => {
      console.error('[SessionStateManager] Failed to recover stale sessions on setDatabase:', error);
    });
  }

  /**
   * Initialize the state manager
   * - Recovers stale sessions from database
   * - Marks sessions as interrupted if they were running
   */
  async initialize(): Promise<void> {
    if (!this.database) {
      console.warn('[SessionStateManager] No database configured, skipping initialization');
      return;
    }

    try {
      await this.recoverStaleSessions();
    } catch (error) {
      console.error('[SessionStateManager] Failed to recover stale sessions:', error);
    }
  }

  /**
   * Start tracking a session
   */
  async startSession(options: StartSessionOptions): Promise<string> {
    const { sessionId, workspacePath, initialStatus = 'running' } = options;
    const attentionGeneration = options.attentionGeneration || this.createAttentionGeneration(sessionId);

    const state: SessionState = {
      sessionId,
      workspacePath,
      status: initialStatus,
      lastActivity: new Date(),
      isStreaming: false,
      attentionGeneration,
    };

    this.activeSessions.set(sessionId, state);

    // Persistence and event delivery both happen after the generation is
    // installed. Either can reject before the caller receives the generation,
    // so preserve that exact owner for generation-safe cleanup.
    try {
      await this.updateDatabase(sessionId, initialStatus);
      this.emitEvent({
        type: 'session:started',
        sessionId,
        workspacePath: state.workspacePath,
        timestamp: new Date(),
        attentionGeneration,
      });
    } catch (error) {
      throw new SessionStartError(attentionGeneration, error);
    }
    return attentionGeneration;
  }

  /**
   * Update session activity
   */
  async updateActivity(options: UpdateActivityOptions): Promise<void> {
    const { sessionId, status, isStreaming, attentionGeneration: expectedGeneration } = options;

    const state = this.activeSessions.get(sessionId);
    if (!state) {
      // Session not in memory -- still update DB and emit events so subscribers
      // (e.g. MetaAgentService) are notified even if the session was created
      // via queue processing or the state manager lost track after restart.
      if (status !== undefined) {
        console.warn(`[SessionStateManager] Session ${sessionId} not in activeSessions, updating DB and emitting event directly`);
        const attentionGeneration = expectedGeneration || (
          status === 'running' ? this.createAttentionGeneration(sessionId) : undefined
        );
        await this.updateDatabase(sessionId, status);
        const workspacePath = await this.getWorkspacePathForSession(sessionId) ?? undefined;
        if (status === 'waiting_for_input') {
          this.emitEvent({ type: 'session:waiting', sessionId, workspacePath, timestamp: new Date(), attentionGeneration });
        } else if (status === 'error') {
          this.emitEvent({ type: 'session:error', sessionId, workspacePath, error: 'Session error', timestamp: new Date(), attentionGeneration });
        } else if (status === 'running') {
          this.emitEvent({ type: isStreaming ? 'session:streaming' : 'session:started', sessionId, workspacePath, timestamp: new Date(), attentionGeneration });
        } else if (status === 'idle') {
          // Turn boundary (e.g. claude-code-cli PID watcher): a terminal event so
          // the renderer clears the running indicator. session:activity would not.
          this.emitEvent({ type: 'session:completed', sessionId, workspacePath, timestamp: new Date(), attentionGeneration });
        }
      } else {
        console.warn(`[SessionStateManager] Cannot update activity for unknown session: ${sessionId}`);
      }
      return;
    }

    if (
      expectedGeneration &&
      state.attentionGeneration &&
      state.attentionGeneration !== expectedGeneration
    ) {
      return;
    }

    // Update in-memory state
    const previousStatus = state.status;
    state.lastActivity = new Date();
    if (expectedGeneration) {
      state.attentionGeneration = expectedGeneration;
    } else if (
      (status === 'running' || status === 'waiting_for_input') &&
      (previousStatus === 'idle' || previousStatus === 'error')
    ) {
      // A prompt may be the first observable signal for a new long-lived CLI
      // turn, before its PID file flips to running. Treat waiting as a genuine
      // turn start so the prompt receives a fresh immutable generation.
      state.attentionGeneration = this.createAttentionGeneration(sessionId);
    }
    const attentionGeneration = state.attentionGeneration;
    if (status !== undefined) {
      state.status = status;
    }
    if (isStreaming !== undefined) {
      state.isStreaming = isStreaming;
    }

    // Update database
    if (status !== undefined) {
      await this.updateDatabase(sessionId, status);
    } else {
      // Just update last_activity without changing status
      await this.updateLastActivity(sessionId);
    }

    // After the async DB write, check if the in-memory status was superseded
    // by a concurrent updateActivity call. If so, skip emitting this stale event.
    // This prevents a race where rapid waiting->running transitions (e.g. auto-approved
    // tool permissions) cause a late session:waiting to fire after session:streaming.
    if (
      (status !== undefined && state.status !== status) ||
      state.attentionGeneration !== attentionGeneration
    ) {
      return;
    }

    // Emit appropriate event
    if (status === 'running') {
      this.emitEvent({
        type: isStreaming ? 'session:streaming' : 'session:started',
        sessionId,
        workspacePath: state.workspacePath,
        timestamp: new Date(),
        attentionGeneration,
      });
    } else if (status === 'waiting_for_input') {
      this.emitEvent({
        type: 'session:waiting',
        sessionId,
        workspacePath: state.workspacePath,
        timestamp: new Date(),
        attentionGeneration,
      });
    } else if (status === 'error') {
      this.emitEvent({
        type: 'session:error',
        sessionId,
        workspacePath: state.workspacePath,
        error: 'Session encountered an error',
        timestamp: new Date(),
        attentionGeneration,
      });
    } else if (status === 'idle') {
      // An explicit idle status is a turn boundary (e.g. the claude-code-cli PID
      // watcher reporting the CLI finished). Emit a terminal event so the
      // renderer clears sessionProcessingAtom — session:activity would leave the
      // running indicator stuck on. The session stays in activeSessions so the
      // next turn's running transition is still detected.
      this.emitEvent({
        type: 'session:completed',
        sessionId,
        workspacePath: state.workspacePath,
        timestamp: new Date(),
        attentionGeneration,
      });
    } else {
      this.emitEvent({
        type: 'session:activity',
        sessionId,
        workspacePath: state.workspacePath,
        timestamp: new Date(),
        attentionGeneration,
      });
    }
  }

  /**
   * End a session (mark as idle)
   */
  async endSession(sessionId: string, options: EndSessionOptions = {}): Promise<void> {
    const state = this.activeSessions.get(sessionId);
    if (
      state &&
      options.attentionGeneration &&
      state.attentionGeneration &&
      state.attentionGeneration !== options.attentionGeneration
    ) {
      return;
    }
    const attentionGeneration = options.attentionGeneration || state?.attentionGeneration;
    if (!state) {
      // Session not in memory (e.g., app restarted while session was running).
      // Still update the database to ensure it's not left as 'running',
      // and emit session:completed so the renderer updates sessionProcessingAtom.
      // Without the event, the renderer thinks the session is still running and
      // queued prompts will never be triggered.
      const workspacePath = await this.getWorkspacePathForSession(sessionId);
      console.warn(`[SessionStateManager] endSession called for session not in activeSessions: ${sessionId}, updating DB directly`);
      await this.updateDatabase(sessionId, 'idle');
      this.emitEvent({
        type: 'session:completed',
        sessionId,
        workspacePath: workspacePath || undefined,
        timestamp: new Date(),
        attentionGeneration,
      });
      return;
    }

    // Remove from active sessions
    this.activeSessions.delete(sessionId);

    // Clear any activity update timer
    const timer = this.activityUpdateTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.activityUpdateTimers.delete(sessionId);
    }

    // Update database
    await this.updateDatabase(sessionId, 'idle');

    // Emit event
    this.emitEvent({
      type: 'session:completed',
      sessionId,
      workspacePath: state.workspacePath,
      timestamp: new Date(),
      attentionGeneration,
    });
  }

  /**
   * Mark a session as interrupted (for crashes or force stops)
   */
  async interruptSession(sessionId: string, options: EndSessionOptions = {}): Promise<void> {
    const state = this.activeSessions.get(sessionId);
    if (
      state &&
      options.attentionGeneration &&
      state.attentionGeneration &&
      state.attentionGeneration !== options.attentionGeneration
    ) {
      return;
    }
    const attentionGeneration = options.attentionGeneration || state?.attentionGeneration;
    if (state) {
      this.activeSessions.delete(sessionId);
    }

    // Update database -- interrupted is just idle (SDK process died)
    await this.updateDatabase(sessionId, 'idle');

    // Emit event (event type stays 'interrupted' for tray/UI to react to)
    this.emitEvent({
      type: 'session:interrupted',
      sessionId,
      workspacePath: state?.workspacePath,
      timestamp: new Date(),
      attentionGeneration,
    });
  }

  /**
   * Get the IDs of every session this manager is currently TRACKING — i.e. bare
   * `activeSessions` map membership. This is NOT the same as "currently running":
   * a `claude-code-cli` session is deliberately retained in the map after its
   * turn goes idle (so the next turn's running transition is detected on the same
   * entry), and the genuine `claude` CLI is a long-lived interactive process that
   * stays alive — idle — between turns. So this list includes idle sessions.
   *
   * Almost every caller actually wants "whose turn is in progress?" — use
   * `getRunningSessionIds()` for that. Treating membership as "running" pinned the
   * renderer's "Processing…" spinner on idle background CLI sessions forever
   * (NIM-846). Use this only when you genuinely need the tracked/alive set.
   */
  getTrackedSessionIds(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  /**
   * Get the IDs of sessions whose turn is actually in progress — status
   * 'running' or actively streaming. This is the canonical "is it running?"
   * query; unlike `getTrackedSessionIds()` it excludes idle entries retained in
   * the map (notably long-lived claude-code-cli sessions). See NIM-846.
   */
  getRunningSessionIds(): string[] {
    const ids: string[] = [];
    for (const [sessionId, state] of this.activeSessions) {
      if (state.status === 'running' || state.isStreaming) {
        ids.push(sessionId);
      }
    }
    return ids;
  }

  /**
   * Get state for a specific session
   */
  getSessionState(sessionId: string): SessionState | null {
    return this.activeSessions.get(sessionId) ?? null;
  }

  /**
   * Check if a session is active
   */
  isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /**
   * Subscribe to state change events
   */
  subscribe(listener: SessionStateListener): () => void {
    const handler = (event: SessionStateEvent) => listener(event);

    const onStarted = (data: Omit<Extract<SessionStateEvent, { type: 'session:started' }>, 'type'>) =>
      handler({ ...data, type: 'session:started' });
    const onStreaming = (data: Omit<Extract<SessionStateEvent, { type: 'session:streaming' }>, 'type'>) =>
      handler({ ...data, type: 'session:streaming' });
    const onWaiting = (data: Omit<Extract<SessionStateEvent, { type: 'session:waiting' }>, 'type'>) =>
      handler({ ...data, type: 'session:waiting' });
    const onCompleted = (data: Omit<Extract<SessionStateEvent, { type: 'session:completed' }>, 'type'>) =>
      handler({ ...data, type: 'session:completed' });
    const onError = (data: Omit<Extract<SessionStateEvent, { type: 'session:error' }>, 'type'>) =>
      handler({ ...data, type: 'session:error' });
    const onInterrupted = (data: Omit<Extract<SessionStateEvent, { type: 'session:interrupted' }>, 'type'>) =>
      handler({ ...data, type: 'session:interrupted' });
    const onActivity = (data: Omit<Extract<SessionStateEvent, { type: 'session:activity' }>, 'type'>) =>
      handler({ ...data, type: 'session:activity' });

    // Listen to all event types
    this.on('session:started', onStarted);
    this.on('session:streaming', onStreaming);
    this.on('session:waiting', onWaiting);
    this.on('session:completed', onCompleted);
    this.on('session:error', onError);
    this.on('session:interrupted', onInterrupted);
    this.on('session:activity', onActivity);

    // Return unsubscribe function
    return () => {
      this.removeListener('session:started', onStarted);
      this.removeListener('session:streaming', onStreaming);
      this.removeListener('session:waiting', onWaiting);
      this.removeListener('session:completed', onCompleted);
      this.removeListener('session:error', onError);
      this.removeListener('session:interrupted', onInterrupted);
      this.removeListener('session:activity', onActivity);
    };
  }

  /**
   * Cleanup all active sessions on shutdown
   */
  async shutdown(): Promise<void> {
    const sessionIds = Array.from(this.activeSessions.keys());

    // Mark all active sessions as interrupted
    for (const sessionId of sessionIds) {
      await this.interruptSession(sessionId);
    }

    // Clear all timers
    for (const timer of this.activityUpdateTimers.values()) {
      clearTimeout(timer);
    }
    this.activityUpdateTimers.clear();

    // Clear state
    this.activeSessions.clear();
  }

  /**
   * Private: Recover stale sessions from database
   */
  private async recoverStaleSessions(): Promise<void> {
    if (!this.database) return;

    try {
      // Recover sessions that were 'running' -- the SDK subprocess is dead after restart,
      // so these are just idle now.
      const runningResult = await this.database.query(
        `SELECT id, last_activity FROM ai_sessions WHERE status = 'running'`,
        []
      );

      for (const row of runningResult.rows) {
        const sessionId = row.id;

        // Skip sessions that are actively tracked in memory (currently running this app session)
        if (this.activeSessions.has(sessionId)) {
          continue;
        }

        await this.updateDatabase(sessionId, 'idle');
        console.log(`[SessionStateManager] Marked running session as idle after restart: ${sessionId}`);
      }

      // Sessions with status 'waiting_for_input' are intentionally LEFT ALONE.
      // The user may still need to answer the question (even days/weeks later).
      // The durable prompt widgets will be restored from ai_agent_messages on load,
      // and answering will auto-resume the session via the answer handler.
      const waitingResult = await this.database.query(
        `SELECT id FROM ai_sessions WHERE status = 'waiting_for_input'`,
        []
      );
      if (waitingResult.rows.length > 0) {
        const ids = waitingResult.rows.map((r: any) => r.id);
        console.log(`[SessionStateManager] Preserved ${ids.length} session(s) waiting for input: ${ids.join(', ')}`);
      }
    } catch (error) {
      console.error('[SessionStateManager] Failed to recover stale sessions:', error);
    }
  }

  /**
   * Private: Update database with new status
   * Note: Only updates last_activity, NOT updated_at. The updated_at timestamp
   * should only change when messages are added to the session, so that session
   * history sorting accurately reflects when the last message was sent/received.
   */
  private async updateDatabase(sessionId: string, status: SessionStatus): Promise<void> {
    if (!this.database) return;

    try {
      await this.database.query(
        `UPDATE ai_sessions SET status = $1, last_activity = CURRENT_TIMESTAMP WHERE id = $2`,
        [status, sessionId]
      );
    } catch (error) {
      console.error(`[SessionStateManager] Failed to update database for session ${sessionId}:`, error);
    }
  }

  /**
   * Private: Update last_activity timestamp in database
   */
  private async updateLastActivity(sessionId: string): Promise<void> {
    if (!this.database) return;

    try {
      await this.database.query(
        `UPDATE ai_sessions SET last_activity = CURRENT_TIMESTAMP WHERE id = $1`,
        [sessionId]
      );
    } catch (error) {
      console.error(`[SessionStateManager] Failed to update last_activity for session ${sessionId}:`, error);
    }
  }

  /**
   * Private: Emit an event
   */
  private emitEvent(event: SessionStateEvent): void {
    this.emit(event.type, event);
  }

  private createAttentionGeneration(sessionId: string): string {
    this.attentionGenerationCounter += 1;
    return `${sessionId}:${Date.now().toString(36)}:${this.attentionGenerationCounter.toString(36)}`;
  }

  private async getWorkspacePathForSession(sessionId: string): Promise<string | null> {
    if (!this.database) {
      return null;
    }

    try {
      const result = await this.database.query<{ workspace_id: string | null }>(
        `SELECT workspace_id
         FROM ai_sessions
         WHERE id = $1
         LIMIT 1`,
        [sessionId]
      );
      return result.rows[0]?.workspace_id ?? null;
    } catch (error) {
      console.error(`[SessionStateManager] Failed to load workspace path for session ${sessionId}:`, error);
      return null;
    }
  }
}

// Singleton instance
let instance: SessionStateManager | null = null;

export function getSessionStateManager(): SessionStateManager {
  if (!instance) {
    instance = new SessionStateManager();
  }
  return instance;
}

export function setSessionStateManager(manager: SessionStateManager): void {
  instance = manager;
}
