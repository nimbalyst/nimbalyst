import { existsSync } from 'fs';
import { isAbsolute } from 'path';

/**
 * Dependencies for {@link registerSessionWorktreeAssetRoot}. Injected so the
 * decision unit-tests without Electron, the protocol module's global root set,
 * or the filesystem -- the same shape as `resolveClaudeCliWorktreeCwd`.
 */
export interface SessionWorktreeAssetRootDeps {
  /** Add an allowed `nim-asset://` root. Idempotent on the protocol side. */
  addRoot: (absolutePath: string) => void;
  /** Existence check for the worktree dir; defaults to `fs.existsSync`. */
  dirExists?: (path: string) => boolean;
  /** Optional warn logger for the rejected paths. */
  logWarn?: (message: string) => void;
}

/** The part of a session this needs. Kept structural so callers pass the session as-is. */
export interface SessionWithOptionalWorktree {
  worktreePath?: string | null;
}

/**
 * Allow `nim-asset://` to serve images from a session's git worktree.
 *
 * A worktree is a *sibling* of the workspace root (`<ws>_worktrees/<name>`),
 * not a child, so it never matches the workspace root registered at window
 * creation and `validateNimAssetPath` rejects everything inside it. Images the
 * agent writes there render as inline thumbnails but fail to expand, because
 * the expanded view fetches them over `nim-asset://` and gets a 403 (#1343).
 *
 * Scope: only the directory the agent for this session is already running in,
 * taken from the session record rather than from the requested path. That is
 * strictly narrower than what the session already has -- we spawn the agent
 * with write access to this exact directory -- so it grants read access to
 * somewhere it can already write, and nothing else. In particular it does NOT
 * infer a worktree from a path shape, and it never registers a caller-supplied
 * directory.
 *
 * Returns the path registered, or `null` when nothing was registered. Safe to
 * call on every turn; the protocol's root set is a Set and `addRoot` is
 * idempotent, which is also what makes this survive a restart without a
 * separate startup pass.
 */
export function registerSessionWorktreeAssetRoot(
  session: SessionWithOptionalWorktree | null | undefined,
  deps: SessionWorktreeAssetRootDeps,
): string | null {
  const worktreePath = session?.worktreePath;
  if (!worktreePath) return null;

  // A relative path would resolve against the main process's cwd, which has
  // nothing to do with the workspace. Refuse rather than register a root
  // pointing somewhere arbitrary.
  if (!isAbsolute(worktreePath)) {
    deps.logWarn?.(
      `[nimAssetWorktreeRoots] ignoring non-absolute worktree path: ${worktreePath}`,
    );
    return null;
  }

  const dirExists = deps.dirExists ?? existsSync;
  if (!dirExists(worktreePath)) {
    // Stale record: the worktree was removed on disk but the session still
    // names it. Registering it would allow a later directory created at the
    // same path to be served.
    deps.logWarn?.(
      `[nimAssetWorktreeRoots] worktree path missing on disk, not registering: ${worktreePath}`,
    );
    return null;
  }

  deps.addRoot(worktreePath);
  return worktreePath;
}
