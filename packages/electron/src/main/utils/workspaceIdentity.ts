/**
 * Decide whether two workspace path *spellings* name the same project, and
 * which spelling to keep when they do.
 *
 * A project reached through a symlink, or opened with different case on a
 * case-insensitive volume, has more than one name for one directory. Windows,
 * sessions, and worktree rows are all keyed by the spelling the project was
 * opened with, while `resolveProjectPath` answers with a worktree's parent in
 * its fully symlink-resolved form. Comparing those two strings with `!==` is
 * what made `spawn_session` reject its own parent and filed `create_session`
 * children under a workspace no window was open on
 * (https://github.com/nimbalyst/nimbalyst/issues/1551, follow-up to #1433).
 *
 * Two rules keep this from becoming a way in:
 *
 * - Equivalence is only ever read from the filesystem. Every candidate spelling
 *   comes from `resolveProjectPathCandidates`, which confirms with `realpath`
 *   that a candidate names the very same directory and fails closed on forged
 *   or stale worktree registrations. A caller-supplied string is never trusted
 *   as a candidate for itself beyond that verification.
 * - Nothing is ever re-keyed. The match is resolved at comparison time and the
 *   *stored* spelling is what continues to be written, so persisted state keeps
 *   the identity it already has.
 */

import * as path from 'path';
import { isWorktreePath, resolveProjectPath, resolveProjectPathCandidates } from './workspaceDetection';

function normalize(workspacePath: string): string {
  const normalized = path.normalize(workspacePath);
  if (normalized.length > 1 && normalized.endsWith(path.sep)) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * The workspace a meta-agent caller is operating in, keeping the caller's own
 * spelling wherever it is meaningful.
 *
 * A worktree-resident caller still resolves to its parent project — session
 * rows and worktree rows are keyed by the project, not the worktree — but it
 * resolves to the parent as the user *opened* it when that spelling can be
 * verified, rather than to the realpath the parent is stored under nowhere.
 * A caller that is already a project keeps its path untouched, so an alias that
 * `realpath` cannot reconstruct (a case variant, for instance) survives.
 */
export function resolveCallerWorkspaceId(rawWorkspacePath: string): string {
  if (!rawWorkspacePath) {
    return rawWorkspacePath;
  }
  if (!isWorktreePath(rawWorkspacePath)) {
    return normalize(rawWorkspacePath);
  }

  // Candidate 0 is the realpath'd parent; a later candidate, when present, is
  // that same parent spelled through the symlink the caller came in by.
  const candidates = resolveProjectPathCandidates(rawWorkspacePath);
  return candidates[candidates.length - 1] ?? resolveProjectPath(rawWorkspacePath);
}

/**
 * Do these two spellings name the same project? True for an exact match, and
 * for two verified spellings of one directory. False for anything the
 * filesystem does not confirm — an unrelated project, a lookalike sharing a
 * prefix, or a directory whose worktree metadata does not check out.
 */
export function sameWorkspaceIdentity(
  storedPath: string | null | undefined,
  callerWorkspaceId: string | null | undefined,
): boolean {
  if (!storedPath || !callerWorkspaceId) {
    return false;
  }
  if (normalize(storedPath) === normalize(callerWorkspaceId)) {
    return true;
  }

  // Both sides are expanded, so the match still works after the caller's path
  // has been canonicalized and has only one spelling left of its own.
  const storedCandidates = resolveProjectPathCandidates(storedPath);
  const callerCandidates = resolveProjectPathCandidates(callerWorkspaceId);
  return storedCandidates.some((candidate) => callerCandidates.includes(candidate));
}

/**
 * The spelling to keep writing. Returns the stored one whenever it names the
 * caller's project, so a child session, its workstream container, its worktree,
 * and the window that has to host it all stay on the one key the workspace is
 * already registered under. Falls back to the caller's spelling when there is
 * no stored path to trust (an orphaned caller), which is the prior behavior.
 *
 * The stored path is returned BYTE-FOR-BYTE, never normalized: an existing key
 * spelled with a trailing separator is still the key every other row and the
 * open window use, and "tidying" it here would file the child under a string
 * nothing else matches. Normalization belongs to comparison only.
 */
export function resolveStoredWorkspaceId(
  storedPath: string | null | undefined,
  callerWorkspaceId: string,
): string {
  return sameWorkspaceIdentity(storedPath, callerWorkspaceId) ? (storedPath as string) : callerWorkspaceId;
}
