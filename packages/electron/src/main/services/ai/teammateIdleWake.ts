/**
 * Wakes an idle lead session when a teammate message or a finished background
 * task arrives after its turn ended. Extracted from MessageStreamingHandler so
 * the wake can be tested without standing up a provider and a window.
 *
 * When the lead is mid-turn, messages are delivered via interrupt + streamInput
 * inside the provider's sendMessage. This covers the idle case by triggering a
 * new send with the message.
 */

export interface TeammateIdleWakeData {
  sessionId: string;
  message: string;
}

export interface WakeTargetWindow {
  isDestroyed: () => boolean;
}

export interface TeammateIdleWakeDeps<W extends WakeTargetWindow = WakeTargetWindow> {
  isSessionActive: (sessionId: string) => boolean;
  startSession: (options: { sessionId: string; workspacePath: string }) => Promise<void>;
  endSession: (sessionId: string) => Promise<void>;
  /** Workspace path of the turn that installed this listener. */
  turnWorkspacePath: () => string;
  resolveOwnerWorkspacePath: (sessionId: string) => Promise<string | null>;
  findWindow: (workspacePath: string) => W | null | undefined;
  sendMessage: (
    window: W,
    message: string,
    sessionId: string,
    workspacePath: string,
  ) => Promise<unknown>;
  /** Defers the send off the provider's event emission. */
  defer: (fn: () => void) => void;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  logError: (message: string, error: unknown) => void;
}

export function createTeammateIdleWakeListener<W extends WakeTargetWindow>(deps: TeammateIdleWakeDeps<W>) {
  return async (data: TeammateIdleWakeData): Promise<void> => {
    if (!data.sessionId) {
      deps.logWarn('[AIService] teammate:messageWhileIdle with no sessionId');
      return;
    }
    // Don't wake a session that already ended (e.g., all teammates completed
    // between the message being queued and this handler running).
    if (!deps.isSessionActive(data.sessionId)) {
      deps.logInfo(`[AIService] Ignoring teammate message for ended session ${data.sessionId}`);
      return;
    }
    deps.logInfo(`[AIService] Teammate message while lead idle, triggering sendMessage for session ${data.sessionId}`);
    // Load with the workspace that owns the session row. The turn's path can be
    // a worktree the agent cd'd into and was adopted only in memory; loading
    // with it is rejected as cross-workspace, and the wake was lost.
    const workspacePath = (await deps.resolveOwnerWorkspacePath(data.sessionId)) ?? deps.turnWorkspacePath();
    // startSession below marks the session running; anything that stops the
    // send from starting must undo that or the session reads as running forever.
    const abandon = (message: string, error: unknown) => {
      deps.logError(message, error);
      deps.endSession(data.sessionId).catch((endError) => {
        deps.logError('[AIService] Failed to end session after abandoned idle wake', endError);
      });
    };
    try {
      // Mark the session running so the UI shows the stop button before the
      // deferred send starts. startSession is idempotent.
      await deps.startSession({ sessionId: data.sessionId, workspacePath });

      const targetWindow = deps.findWindow(workspacePath);
      if (!targetWindow || targetWindow.isDestroyed()) {
        abandon('[AIService] No window for idle wake', new Error(`No window for workspace ${workspacePath}`));
        return;
      }
      deps.defer(() => {
        deps.sendMessage(targetWindow, data.message, data.sessionId, workspacePath).catch((err) => {
          abandon('[AIService] Failed to process teammate message while idle', err);
        });
      });
    } catch (error) {
      abandon('[AIService] Failed to handle teammate message while idle', error);
    }
  };
}
