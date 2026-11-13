import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { getSessionCommitCheckout, revalidateProposalWorktree } from '../gitCommitProposalTarget';
import { loadGitCommitProposalRecord } from './gitCommitProposalPromptUtils';

/** Written on every proposal record whose `workspacePath` is the validated session checkout. */
export const COMMIT_TARGET_VERSION = 2;

const PROPOSE_AGAIN =
  'Ask the agent to propose the commit again.';

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/**
 * The git entry a path names: repository-relative, '/'-separated, lexically
 * normalized. Only the repository root is canonicalized (a root reached through
 * a symlinked prefix such as macOS /var is the same root); the entry itself is
 * never resolved through symlinks, because a symlink is its own git entry and
 * `link.txt -> other.txt` must not admit `other.txt`. Null when outside the root.
 */
function gitEntryKey(path: string, base: string, roots: string[]): string | null {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path);
  for (const root of roots) {
    if (absolute.startsWith(root + sep)) return absolute.slice(root.length + 1).split(sep).join('/');
  }
  return null;
}

function proposalRoots(record: Record<string, any>): string[] {
  const root = typeof record.repoPath === 'string' && record.repoPath ? record.repoPath : record.workspacePath;
  if (typeof root !== 'string' || !root) throw new Error(`This commit proposal does not record its repository. ${PROPOSE_AGAIN}`);
  return [...new Set([resolve(root), canonical(root)])];
}

/**
 * #1955: the git entries a stored proposal lists. A record without a file list
 * cannot be checked, so it is refused.
 */
function storedProposalEntries(record: Record<string, any>, roots: string[]): Set<string> {
  const stored = record.filesToStage;
  if (!Array.isArray(stored)) {
    throw new Error(`This commit proposal does not record its files. ${PROPOSE_AGAIN}`);
  }
  const base = typeof record.workspacePath === 'string' ? record.workspacePath : roots[0];
  const entries = new Set<string>();
  for (const entry of stored) {
    const path = typeof entry === 'string' ? entry : (entry as { path?: unknown })?.path;
    if (typeof path !== 'string' || !path) continue;
    const key = gitEntryKey(path, base, roots);
    if (key) entries.add(key);
  }
  return entries;
}

/** #1955 (D-A2): whether the stored proposal lists any file flagged as another session's. */
export function proposalHasOtherSessionFiles(record: Record<string, any> | null | undefined): boolean {
  const files: unknown[] = Array.isArray(record?.filesToStage) ? record!.filesToStage : [];
  return files.some(file => typeof file === 'object' && file !== null && !!(file as { otherSession?: unknown }).otherSession);
}

/**
 * #1955: every file a confirm sends must be one the stored proposal listed.
 * Without this, a proposal id only chose WHERE a commit landed, and the caller
 * could add any other file to it.
 */
export function assertFilesInProposalRecord(record: Record<string, any>, files: string[], relativeBase: string): void {
  const roots = proposalRoots(record);
  const allowed = storedProposalEntries(record, roots);
  const outside = files.filter(file => {
    if (typeof file !== 'string' || !file || file.includes('\0')) return true;
    const key = gitEntryKey(file, relativeBase, roots);
    return key === null || !allowed.has(key);
  });
  if (outside.length > 0) {
    throw new Error(`Refusing to commit files not in the proposal: ${outside.join(', ')}. ${PROPOSE_AGAIN}`);
  }
}

/**
 * #1955 review: git:commit validates a proposal only when it has both ids. One
 * without the other would skip every proposal check, so it is refused. A call
 * with neither is an ordinary commit from the Git panel.
 */
export function assertProposalIdentityPair(sessionId: unknown, proposalId: unknown): void {
  const hasSession = typeof sessionId === 'string' && sessionId.length > 0;
  const hasProposal = typeof proposalId === 'string' && proposalId.length > 0;
  if (hasSession !== hasProposal) {
    throw new Error('A commit from an AI session needs both its session id and its proposal id. Refresh the session before answering.');
  }
}

/** Mobile path: load the stored proposal and run the same subset check. */
export async function assertFilesInStoredProposal(
  sessionId: string,
  proposalId: string,
  files: string[],
  relativeBase: string,
): Promise<void> {
  const record = await loadGitCommitProposalRecord(sessionId, proposalId);
  if (!record) throw new Error('Cannot find this commit proposal. Refresh the session before answering.');
  assertFilesInProposalRecord(record, files, relativeBase);
}

/**
 * D-A4: a listed file that changed between proposal and confirm (reverted, or
 * removed before it was tracked) still fails the commit, but the message names
 * it and says what to do, instead of git's staging vocabulary.
 */
export function explainProposalCommitFailure(error: string | undefined): string | undefined {
  if (!error) return error;
  const notStaged = /^Some selected files were not staged: (.+)\. Commit aborted\.$/.exec(error);
  const pathspec = /pathspec '([^']+)' did not match any files/.exec(error);
  const names = notStaged?.[1] ?? pathspec?.[1];
  if (!names) return error;
  return `${names} changed after the proposal (no longer has changes to commit). Nothing was committed. ${PROPOSE_AGAIN}`;
}

/**
 * #1756 / #1529: a proposal commits where main validated it when the proposal
 * was created, as stored on its durable record. Paths the caller supplies are
 * ignored. A sibling-worktree target is checked again right before the commit,
 * since the worktree may have moved since. Records from older builds stored
 * the parent workspace while the widget committed in the session's worktree,
 * so they are refused rather than guessed at.
 */
export async function resolveProposalCommitPaths(
  sessionId: string,
  proposalId: string,
  /** #1955: when given, every file must be one the stored proposal lists. */
  filesToStage?: string[],
): Promise<{ workspacePath: string; repoPath?: string }> {
  const record = await loadGitCommitProposalRecord(sessionId, proposalId);
  if (!record || typeof record.workspacePath !== 'string' || !record.workspacePath) {
    throw new Error('Cannot find where this commit proposal commits. Refresh the session before answering.');
  }
  if (filesToStage) assertFilesInProposalRecord(record, filesToStage, record.workspacePath);
  const worktreePath = record.targetWorktree?.path;
  if (typeof worktreePath === 'string') {
    await revalidateProposalWorktree(sessionId, worktreePath);
    return { workspacePath: worktreePath, repoPath: worktreePath };
  }
  if (record.commitTargetVersion !== COMMIT_TARGET_VERSION) {
    throw new Error(`This commit proposal is from an older version of Nimbalyst and does not record where it commits. ${PROPOSE_AGAIN}`);
  }
  if (canonical(record.workspacePath) !== canonical(await getSessionCommitCheckout(sessionId))) {
    throw new Error(`This commit proposal no longer matches the session's checkout. ${PROPOSE_AGAIN}`);
  }
  return {
    workspacePath: record.workspacePath,
    ...(typeof record.repoPath === 'string' && record.repoPath ? { repoPath: record.repoPath } : {}),
  };
}
