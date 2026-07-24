import { existsSync } from 'fs';

/**
 * Dependencies for {@link resolveClaudeCliWorktreeCwd}. Injected so the
 * resolution logic unit-tests without a database, the WorktreeStore, or fs.
 */
export interface ClaudeCliWorktreeCwdDeps {
  /** Load the session's `worktreeId` (null/undefined for a non-worktree session). */
  getSessionWorktreeId: (sessionId: string) => Promise<string | null | undefined>;
  /** Resolve a `worktreeId` to its on-disk path (null/undefined when unknown). */
  getWorktreePath: (worktreeId: string) => Promise<string | null | undefined>;
  /** Existence check for the worktree dir; defaults to `fs.existsSync`. Injectable for tests. */
  worktreeDirExists?: (path: string) => boolean;
  /** Optional warn logger for the fallback paths. */
  logWarn?: (message: string, err?: unknown) => void;
}

/**
 * Resolve the working directory an interactive `claude-code-cli` launch should
 * spawn in. A worktree session MUST run in its worktree so the CLI's edits land
 * on the worktree branch, not the parent's checked-out branch (#933 / NIM-2001).
 *
 * The renderer only knows the parent workspace path and passes it as
 * `requestedCwd`; it never threads the worktree path down the interactive
 * terminal strip. So resolve the worktree authoritatively from the session's
 * `worktreeId` here — the same lookup the SDK path (MessageStreamingHandler's
 * `effectiveWorkspacePath = session.worktreePath || workspacePath`) and the
 * queued CLI path (AIService.dispatchQueuedPromptToClaudeCliSession) already do —
 * and override `requestedCwd` with it.
 *
 * Falls back to `requestedCwd` for non-worktree sessions, when the worktree
 * can't be resolved, when its directory is missing on disk (stale record), or on
 * any lookup error: a launch in the parent is better than a failed launch.
 */
export async function resolveClaudeCliWorktreeCwd(
  sessionId: string,
  requestedCwd: string | undefined,
  deps: ClaudeCliWorktreeCwdDeps
): Promise<string | undefined> {
  try {
    const worktreeId = await deps.getSessionWorktreeId(sessionId);
    if (!worktreeId) return requestedCwd;

    const worktreePath = await deps.getWorktreePath(worktreeId);
    if (!worktreePath) return requestedCwd;

    const dirExists = deps.worktreeDirExists ?? existsSync;
    if (!dirExists(worktreePath)) {
      deps.logWarn?.(
        `[claudeCliWorktreeCwd] worktree ${worktreeId} path missing on disk (${worktreePath}); ` +
          `launching in ${requestedCwd ?? '(none)'}`
      );
      return requestedCwd;
    }

    return worktreePath;
  } catch (err) {
    deps.logWarn?.('[claudeCliWorktreeCwd] worktree resolution failed; launching in requested cwd', err);
    return requestedCwd;
  }
}
