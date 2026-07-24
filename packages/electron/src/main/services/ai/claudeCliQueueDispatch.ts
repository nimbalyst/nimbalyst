/**
 * Queued-prompt dispatch for `claude-code-cli` sessions (NIM-834).
 *
 * The SDK-style dispatcher (`queuedPromptDispatcher.ts`) delivers a claimed
 * prompt by calling the in-process provider's `sendMessage`. claude-code-cli has
 * no in-process turn driver — its `sendMessage` is the Phase 1 stub that throws —
 * so any queued prompt routed that way (meta-agent spawn, restart continuation,
 * scheduled wakeup, mobile) was instantly marked failed.
 *
 * The genuine CLI drains its queue on different rails: `claudeCliQueueFlushSingleton`
 * writes the next pending prompt into the PTY whenever the PID watcher reports a
 * running→idle transition, and the launcher kicks that flush when a fresh CLI
 * settles at its prompt. This module routes dispatch onto those rails: ensure the
 * CLI is running (a headless launch is fine — the terminal view attaches when the
 * session is opened) and kick a flush directly only when the CLI is already idle.
 *
 * Dependency-injected so it unit-tests without node-pty / a live launcher.
 */

export interface ClaudeCliQueueDispatchInput {
  sessionId: string;
  workspacePath: string;
  /** Stored session model (combined id is fine — resolved to a CLI alias downstream). */
  model?: string | null;
  /** Spawn cwd override (the worktree path for worktree-linked sessions). */
  cwd?: string;
}

export interface ClaudeCliQueueDispatchDeps {
  isTerminalActive(sessionId: string): boolean;
  ensureSession(input: {
    sessionId: string;
    workspacePath: string;
    cwd?: string;
    model?: string;
  }): Promise<{ success: boolean; alreadyActive?: boolean; error?: string }>;
  /** Live PID-file turn state — authoritative over the async snapshot (NIM-821). */
  getLiveTurnState(sessionId: string): Promise<string | null>;
  /** SessionStateManager snapshot status, if any. */
  getSnapshotStatus(sessionId: string): string | null | undefined;
  flushNext(sessionId: string, workspacePath: string): Promise<unknown>;
  logInfo(message: string): void;
  logWarn(message: string): void;
}

/**
 * Returns true when the prompt delivery was handed to the CLI rails (CLI
 * launched, or a flush was kicked); false when the launch failed or the CLI is
 * mid-turn (the next idle transition drains the queue).
 */
export async function dispatchQueuedPromptToClaudeCli(
  deps: ClaudeCliQueueDispatchDeps,
  input: ClaudeCliQueueDispatchInput
): Promise<boolean> {
  const { sessionId, workspacePath } = input;

  if (!deps.isTerminalActive(sessionId)) {
    const result = await deps.ensureSession({
      sessionId,
      workspacePath,
      cwd: input.cwd,
      model: input.model ?? undefined,
    });
    if (!result.success) {
      deps.logWarn(
        `[ClaudeCliQueueDispatch] CLI launch failed for ${sessionId}: ${result.error ?? 'unknown error'}`
      );
      return false;
    }
    deps.logInfo(
      `[ClaudeCliQueueDispatch] launched CLI for ${sessionId}; queue drains on idle`
    );
    // The launch path flushes on the PID watcher's first idle transition. If the
    // CLI already reports idle (alreadyActive race / instant prompt), kick one
    // directly — the flush singleton's DB claim is race-safe, so an extra kick
    // is harmless.
    const live = await deps.getLiveTurnState(sessionId).catch(() => null);
    if (live === 'idle') {
      await deps.flushNext(sessionId, workspacePath);
    }
    return true;
  }

  // Terminal already live: same idle detection as ai:createQueuedPrompt — either
  // the snapshot or the live PID file saying idle kicks the flush (NIM-821: the
  // snapshot lags the PID watcher, so check both); if the CLI is mid-turn the
  // next idle transition drains the queue.
  if (deps.getSnapshotStatus(sessionId) === 'idle') {
    await deps.flushNext(sessionId, workspacePath);
    return true;
  }
  const live = await deps.getLiveTurnState(sessionId).catch(() => null);
  if (live === 'idle') {
    await deps.flushNext(sessionId, workspacePath);
    return true;
  }
  deps.logInfo(
    `[ClaudeCliQueueDispatch] CLI mid-turn for ${sessionId}; queue drains on next idle`
  );
  return false;
}
