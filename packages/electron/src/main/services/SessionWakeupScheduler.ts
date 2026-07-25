/**
 * SessionWakeupScheduler
 *
 * Single-timer scheduler for AI session scheduled wakeups. Holds at most one
 * setTimeout, aimed at the soonest pending row in `ai_session_wakeups`. When it
 * fires, the session is resumed by enqueuing the prompt onto the existing
 * AIService prompt queue (same path MetaAgentService.sendPromptToSession uses).
 *
 * Scope rules (per plan):
 * - Persists across app restarts (rows in PGLite).
 * - Does NOT run while the app is closed -- timer is only armed while running.
 * - Does NOT auto-fire if the workspace window is closed -- row goes into
 *   waiting_for_workspace and fires when the workspace opens.
 * - On launch, rows whose fire_at is already in the past are marked `overdue`
 *   and surfaced to the user via the sessions UI -- they do NOT auto-fire.
 */

import log from 'electron-log/main';
import { BrowserWindow, Notification } from 'electron';
import { findWindowByWorkspace } from '../window/WindowManager';
import {
  type SessionWakeup,
  type SessionWakeupsStore,
} from './PGLiteSessionWakeupsStore';

const logger = log.scope('SessionWakeupScheduler');

// Node clamps setTimeout to ~24.85 days (2^31-1 ms). Re-arm on the boundary
// for delays beyond that (the plan caps at 7d, but be defensive).
const MAX_TIMER_MS = 2_147_483_647;

/** Function used by the scheduler to actually resume a session. Injected so
 *  we don't take a hard dependency on AIService at module load. */
export type WakeupExecutor = (args: {
  sessionId: string;
  workspacePath: string;
  prompt: string;
}) => Promise<{ triggered: boolean }>;

export interface SessionWakeupSchedulerDeps {
  store: SessionWakeupsStore;
  /** Invoked to actually fire the wakeup (queue prompt + trigger processing). */
  executor: WakeupExecutor;
  /** Broadcasts `wakeup:changed` to all renderer windows. */
  broadcastChanged: (wakeup: SessionWakeup) => void;
  /** Returns true if a workspace window is currently open. */
  hasWorkspaceWindow?: (workspacePath: string) => boolean;
}

export class SessionWakeupScheduler {
  private static instance: SessionWakeupScheduler | null = null;

  private deps: SessionWakeupSchedulerDeps | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** ID of the wakeup that the current timer is aimed at, if any. */
  private armedFor: string | null = null;
  private started = false;

  static getInstance(): SessionWakeupScheduler {
    if (!SessionWakeupScheduler.instance) {
      SessionWakeupScheduler.instance = new SessionWakeupScheduler();
    }
    return SessionWakeupScheduler.instance;
  }

  /** Inject dependencies. Must be called before start(). */
  configure(deps: SessionWakeupSchedulerDeps): void {
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.deps) {
      throw new Error('SessionWakeupScheduler.configure() must be called before start()');
    }
    this.started = true;

    // Mark rows whose fire_at already passed as `overdue`. They do NOT
    // auto-fire -- the renderer surfaces them to the user.
    const pending = await this.deps.store.listPending();
    const now = Date.now();
    for (const row of pending) {
      if (row.fireAt <= now) {
        const updated = await this.deps.store.markOverdue(row.id);
        if (updated) {
          logger.info('Marked wakeup as overdue on launch', {
            id: updated.id,
            sessionId: updated.sessionId,
            wasDueMsAgo: now - row.fireAt,
          });
          this.deps.broadcastChanged(updated);
        }
      }
    }

    await this.armNext();
    logger.info('SessionWakeupScheduler started');
  }

  /** Stops the timer; rows in DB are untouched. Called from before-quit. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.armedFor = null;
    this.started = false;
    logger.info('SessionWakeupScheduler stopped');
  }

  /**
   * Called by the MCP tool handler after persisting a new wakeup. Re-arms the
   * timer if the new row is sooner than what we're currently waiting on.
   */
  onCreated(row: SessionWakeup): void {
    if (!this.started) return;
    // Always re-arm: caller may have replaced an existing pending row.
    void this.armNext();
  }

  /** Cancel a wakeup. Re-arms if it was the head. */
  async cancel(id: string): Promise<SessionWakeup | null> {
    if (!this.deps) return null;
    const row = await this.deps.store.cancel(id);
    if (row) {
      this.deps.broadcastChanged(row);
      if (this.armedFor === id) {
        await this.armNext();
      }
    }
    return row;
  }

  /** Move fire_at to now and fire immediately. Used by "Run now" UI. */
  async runNow(id: string): Promise<SessionWakeup | null> {
    if (!this.deps) return null;
    const row = await this.deps.store.bumpToNow(id);
    if (row) {
      this.deps.broadcastChanged(row);
      await this.armNext();
    }
    return row;
  }

  /**
   * Hook called when a workspace window opens. Re-checks any
   * waiting_for_workspace rows for that workspace and fires them.
   */
  async onWorkspaceOpened(workspacePath: string): Promise<void> {
    if (!this.deps || !this.started) return;
    const waiting = await this.deps.store.listWaitingForWorkspace(workspacePath);
    if (waiting.length === 0) return;
    logger.info('Workspace opened, firing waiting wakeups', {
      workspacePath,
      count: waiting.length,
    });
    for (const row of waiting) {
      await this.fire(row);
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private async armNext(): Promise<void> {
    if (!this.deps || !this.started) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.armedFor = null;
    }

    const pending = await this.deps.store.listPending();
    if (pending.length === 0) {
      logger.debug('No pending wakeups to arm for');
      return;
    }
    const next = pending[0];
    const delay = Math.max(0, next.fireAt - Date.now());
    const cappedDelay = Math.min(delay, MAX_TIMER_MS);

    this.armedFor = next.id;
    this.timer = setTimeout(() => {
      // Either fire (if delay was within MAX_TIMER_MS) or just re-arm.
      if (delay <= MAX_TIMER_MS) {
        void this.onTimerFired(next.id);
      } else {
        void this.armNext();
      }
    }, cappedDelay);

    logger.debug('Armed next wakeup', {
      id: next.id,
      fireAt: new Date(next.fireAt).toISOString(),
      delayMs: delay,
    });
  }

  private async onTimerFired(id: string): Promise<void> {
    if (!this.deps) return;
    this.timer = null;
    this.armedFor = null;

    const row = await this.deps.store.get(id);
    if (!row) {
      logger.warn('Timer fired but wakeup row not found, re-arming', { id });
      await this.armNext();
      return;
    }
    if (row.status !== 'pending') {
      // Row was cancelled or already handled by another path
      logger.debug('Timer fired but row no longer pending, skipping', {
        id,
        status: row.status,
      });
      await this.armNext();
      return;
    }

    await this.fire(row);
    await this.armNext();
  }

  private async fire(row: SessionWakeup): Promise<void> {
    if (!this.deps) return;
    const hasWindow = this.deps.hasWorkspaceWindow
      ? this.deps.hasWorkspaceWindow(row.workspaceId)
      : !!findWindowByWorkspace(row.workspaceId);

    if (!hasWindow) {
      logger.info('No window for workspace, marking waiting_for_workspace', {
        id: row.id,
        workspaceId: row.workspaceId,
      });
      const updated = await this.deps.store.markWaitingForWorkspace(row.id);
      if (updated) this.deps.broadcastChanged(updated);
      return;
    }

    const firingRow = await this.deps.store.markFiring(row.id);
    if (!firingRow) {
      logger.warn('Failed to mark wakeup firing (status changed)', { id: row.id });
      return;
    }
    this.deps.broadcastChanged(firingRow);

    try {
      const result = await this.deps.executor({
        sessionId: row.sessionId,
        workspacePath: row.workspaceId,
        prompt: row.prompt,
      });

      if (!result.triggered) {
        const waitingRow = await this.deps.store.markWaitingForWorkspace(row.id);
        if (waitingRow) this.deps.broadcastChanged(waitingRow);
        return;
      }

      const fired = await this.deps.store.markFired(row.id);
      if (fired) {
        this.deps.broadcastChanged(fired);
        notifyWakeupFired(fired);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Wakeup execution failed', { id: row.id, error: message });
      const failed = await this.deps.store.markFailed(row.id, message);
      if (failed) this.deps.broadcastChanged(failed);
    }
  }
}

function notifyWakeupFired(row: SessionWakeup): void {
  if (!Notification.isSupported()) return;
  try {
    const title = 'Session resumed';
    const body = row.reason
      ? `${row.reason}`
      : 'A scheduled wakeup has fired.';
    const notification = new Notification({ title, body, silent: false });
    notification.on('failed', (_event, error) => {
      logger.warn('Wakeup notification failed', {
        sessionId: row.sessionId,
        workspaceId: row.workspaceId,
        error,
      });
    });
    notification.on('click', () => {
      const win = findWindowByWorkspace(row.workspaceId);
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        try {
          win.webContents.send('wakeup:focus-session', { sessionId: row.sessionId });
        } catch {
          // ignore -- window may have been destroyed mid-send
        }
      } else {
        // No window open for the workspace; bring any window to front so the
        // user has somewhere to click.
        const fallback = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        if (fallback) {
          if (fallback.isMinimized()) fallback.restore();
          fallback.show();
          fallback.focus();
        }
      }
    });
    notification.show();
  } catch (error) {
    logger.warn('Failed to show wakeup notification', error);
  }
}
