/**
 * Default base branch for new worktrees (#1958).
 *
 * A worktree created without an explicit base used to start from whatever
 * branch the main checkout happened to be on. It now starts from the project's
 * configured default, which is the remote default branch (`origin/HEAD`, e.g.
 * `origin/main`) unless the project says otherwise.
 *
 * Resolution never fails because of the setting: a configured ref that does
 * not exist locally falls back through the remote default, then local
 * main/master, then the main checkout's current branch, and the result carries
 * a `fallbackReason` the caller can log or show.
 *
 * Resolution never touches the network. Callers decide whether to fetch first:
 * the picker fetches on open, and `fetchRemoteBase` is the bounded single-branch
 * fetch the non-picker entry points run before creating.
 *
 * Refs stay fully qualified (`refs/remotes/origin/main`, `refs/heads/main`)
 * from resolution through fetch and `git worktree add`. A short `origin/main`
 * is ambiguous when a local branch of that name also exists, and git would
 * pick the local one. `displayRef` is the short form, used for the picker,
 * logs and the stored `worktrees.base_branch`.
 */

import { resolveMainBranch } from '../utils/gitAgentContext';
import { withTimeout } from '../utils/gitUncommittedFiles';
import { createGit, type GitEnv } from './gitClient';

export type WorktreeDefaultBaseMode = 'remote-default' | 'current-branch' | 'custom';

/** Persisted per project on `WorkspaceState.worktreeDefaultBase`. Unset means `remote-default`. */
export interface WorktreeDefaultBaseSetting {
  mode: WorktreeDefaultBaseMode;
  /** Only read when `mode` is `custom`. A local branch or a remote ref like `origin/develop`. */
  ref?: string;
}

/**
 * Where the resolved base came from. Also the `worktree_created`
 * `base_branch_source` analytics value for creations without an explicit base.
 */
export type WorktreeBaseSource = 'project-setting' | 'remote-default' | 'current-branch' | 'fallback';

export interface RemoteRef {
  remote: string;
  branch: string;
}

export interface ResolvedWorktreeBase {
  /**
   * What to pass to `git worktree add`: `refs/remotes/<remote>/<branch>`,
   * `refs/heads/<branch>`, a commit SHA for a detached HEAD, or a configured
   * ref that is neither (a tag, a SHA) verbatim. Empty when nothing resolves
   * (an unborn HEAD with no usable remote ref).
   */
  ref: string;
  /** Short form for display and storage: `origin/main`, `main`, or the SHA. */
  displayRef: string;
  source: WorktreeBaseSource;
  /** Set when the configured or preferred choice was unavailable and a later step was used. */
  fallbackReason?: string;
  /** Set when `ref` is a remote-tracking ref, so callers can fetch it. */
  remote?: RemoteRef;
}

/** The subset of simple-git the resolver uses, so tests and callers can pass any instance. */
export interface GitRaw {
  raw(args: string[]): Promise<string>;
}

/** Non-picker entry points wait at most this long for the single-branch fetch. */
export const WORKTREE_BASE_FETCH_TIMEOUT_MS = 5_000;

const REMOTES_PREFIX = 'refs/remotes/';
const HEADS_PREFIX = 'refs/heads/';

async function rawOrEmpty(git: GitRaw, args: string[]): Promise<string> {
  try {
    return (await git.raw(args)).trim();
  } catch {
    return '';
  }
}

/** Whether `ref` resolves to a commit. Rejects anything git could read as an option. */
export async function refExists(git: GitRaw, ref: string): Promise<boolean> {
  if (!ref || ref.startsWith('-')) return false;
  // `--quiet` resolves with empty output for a missing ref instead of rejecting.
  return (await rawOrEmpty(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== '';
}

async function listRemotes(git: GitRaw): Promise<string[]> {
  const out = await rawOrEmpty(git, ['remote']);
  return out ? out.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

/** `origin` if present, otherwise the only remote, otherwise none. */
async function pickRemote(git: GitRaw): Promise<string | null> {
  const remotes = await listRemotes(git);
  if (remotes.includes('origin')) return 'origin';
  return remotes.length === 1 ? remotes[0] : null;
}

/** Match `<remote>/<branch>` against the repo's remotes, longest remote name first. */
function matchRemote(remotes: string[], shortRef: string): RemoteRef | null {
  for (const remote of [...remotes].sort((a, b) => b.length - a.length)) {
    const prefix = `${remote}/`;
    if (shortRef.startsWith(prefix) && shortRef.length > prefix.length) {
      return { remote, branch: shortRef.slice(prefix.length) };
    }
  }
  return null;
}

function remoteResolved(remoteRef: RemoteRef, source: WorktreeBaseSource): ResolvedWorktreeBase {
  const displayRef = `${remoteRef.remote}/${remoteRef.branch}`;
  return { ref: `${REMOTES_PREFIX}${displayRef}`, displayRef, source, remote: remoteRef };
}

function localResolved(branch: string, source: WorktreeBaseSource): ResolvedWorktreeBase {
  return { ref: `${HEADS_PREFIX}${branch}`, displayRef: branch, source };
}

/**
 * Split a stored short base like `origin/main` into `{ remote, branch }`,
 * checking the repo's actual remotes so a local branch literally named
 * `origin/foo` is not misread. Returns null for anything that is not a
 * remote-tracking ref, including a name a local branch shadows (git itself
 * would use the local branch).
 */
export async function splitRemoteRef(git: GitRaw, ref: string): Promise<RemoteRef | null> {
  if (!ref || ref.startsWith('-')) return null;
  if (ref.startsWith(REMOTES_PREFIX)) {
    const remoteRef = matchRemote(await listRemotes(git), ref.slice(REMOTES_PREFIX.length));
    return remoteRef && (await refExists(git, ref)) ? remoteRef : null;
  }
  const remoteRef = matchRemote(await listRemotes(git), ref);
  if (!remoteRef) return null;
  if (await refExists(git, `${HEADS_PREFIX}${ref}`)) return null;
  if (!(await refExists(git, `${REMOTES_PREFIX}${ref}`))) return null;
  return remoteRef;
}

/**
 * The main checkout's current branch, or its commit SHA on a detached HEAD.
 * An unborn branch (no commits yet) resolves to nothing, so creation still
 * reports WorkspaceHasNoCommitsError instead of a raw git failure.
 */
async function resolveCurrentBranch(git: GitRaw): Promise<ResolvedWorktreeBase | null> {
  const symbolic = await rawOrEmpty(git, ['symbolic-ref', '--quiet', 'HEAD']);
  if (symbolic.startsWith(HEADS_PREFIX)) {
    return (await refExists(git, symbolic))
      ? localResolved(symbolic.slice(HEADS_PREFIX.length), 'current-branch')
      : null;
  }
  const sha = await rawOrEmpty(git, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  return sha ? { ref: sha, displayRef: sha, source: 'current-branch' } : null;
}

/**
 * The remote default branch as a remote ref, then a local main branch, then
 * the current branch. `source` is `remote-default` only when a remote ref was
 * found.
 */
async function resolveRemoteDefault(git: GitRaw): Promise<ResolvedWorktreeBase> {
  const remote = await pickRemote(git);
  if (remote) {
    const head = await rawOrEmpty(git, ['symbolic-ref', '--quiet', `${REMOTES_PREFIX}${remote}/HEAD`]);
    // A dangling <remote>/HEAD (its branch was pruned) does not count.
    if (head.startsWith(`${REMOTES_PREFIX}${remote}/`) && (await refExists(git, head))) {
      return remoteResolved({ remote, branch: head.slice(`${REMOTES_PREFIX}${remote}/`.length) }, 'remote-default');
    }
    for (const candidate of ['main', 'master']) {
      if (await refExists(git, `${REMOTES_PREFIX}${remote}/${candidate}`)) {
        return remoteResolved({ remote, branch: candidate }, 'remote-default');
      }
    }
  }

  const noRemoteReason = remote
    ? `${remote} has no fetched default branch`
    : 'no remote to take a default branch from';

  // resolveMainBranch names origin/HEAD's branch when it is set, even if that
  // branch only exists locally; main and master are still checked explicitly
  // because a dangling origin/HEAD makes it return a name with no local branch.
  const named = await resolveMainBranch(git);
  for (const candidate of [...new Set([named, 'main', 'master'].filter(Boolean))]) {
    if (await refExists(git, `${HEADS_PREFIX}${candidate}`)) {
      return { ...localResolved(candidate, 'fallback'), fallbackReason: `${noRemoteReason}; using local ${candidate}` };
    }
  }

  const current = await resolveCurrentBranch(git);
  const reason = `${noRemoteReason} and no local main or master; using the current branch`;
  return current
    ? { ...current, source: 'fallback', fallbackReason: reason }
    : { ref: '', displayRef: '', source: 'fallback', fallbackReason: `${noRemoteReason} and the current branch has no commits` };
}

/**
 * A configured custom ref, qualified. `origin/x` naming an existing remote
 * ref is the remote ref even if a local branch shares the name (the settings
 * panel lists it as a remote branch); a local branch name is `refs/heads/x`;
 * anything else that resolves to a commit (tag, SHA, full ref) is kept as is.
 */
async function resolveCustomRef(git: GitRaw, ref: string): Promise<ResolvedWorktreeBase | null> {
  if (!ref || ref.startsWith('-')) return null;
  if (ref.startsWith(REMOTES_PREFIX) || ref.startsWith(HEADS_PREFIX)) {
    if (!(await refExists(git, ref))) return null;
    if (ref.startsWith(HEADS_PREFIX)) return localResolved(ref.slice(HEADS_PREFIX.length), 'project-setting');
    const remoteRef = matchRemote(await listRemotes(git), ref.slice(REMOTES_PREFIX.length));
    return remoteRef
      ? remoteResolved(remoteRef, 'project-setting')
      : { ref, displayRef: ref.slice(REMOTES_PREFIX.length), source: 'project-setting' };
  }
  const remoteRef = matchRemote(await listRemotes(git), ref);
  if (remoteRef && (await refExists(git, `${REMOTES_PREFIX}${ref}`))) {
    return remoteResolved(remoteRef, 'project-setting');
  }
  if (await refExists(git, `${HEADS_PREFIX}${ref}`)) return localResolved(ref, 'project-setting');
  if (await refExists(git, ref)) return { ref, displayRef: ref, source: 'project-setting' };
  return null;
}

/**
 * Resolve the base for a new worktree in `git`'s repository. An explicit base
 * from the caller (picker, PR review) always wins and never reaches here.
 */
export async function resolveWorktreeBase(
  git: GitRaw,
  setting?: WorktreeDefaultBaseSetting | null,
): Promise<ResolvedWorktreeBase> {
  const mode = setting?.mode ?? 'remote-default';

  if (mode === 'current-branch') {
    return (await resolveCurrentBranch(git)) ?? { ref: '', displayRef: '', source: 'current-branch' };
  }

  if (mode === 'custom') {
    const ref = setting?.ref?.trim() ?? '';
    const custom = await resolveCustomRef(git, ref);
    if (custom) return custom;
    const fallback = await resolveRemoteDefault(git);
    const missing = ref ? `${ref} not found locally` : 'no branch configured';
    return {
      ...fallback,
      source: 'fallback',
      fallbackReason: fallback.fallbackReason
        ? `${missing}; ${fallback.fallbackReason}`
        : `${missing}; using ${fallback.displayRef}`,
    };
  }

  return resolveRemoteDefault(git);
}

/**
 * One bounded fetch of the base's branch so a non-picker creation does not
 * start from a stale cached ref. Never throws: on timeout or failure the
 * caller creates from whatever ref is cached.
 *
 * The fetch gets its own git instance so the timeout can kill the child
 * process (abort signal, plus simple-git's no-output `block` timeout) instead
 * of leaving it running after the caller has moved on.
 */
export async function fetchRemoteBase(
  repoPath: string,
  base: RemoteRef,
  { timeoutMs = WORKTREE_BASE_FETCH_TIMEOUT_MS, env }: { timeoutMs?: number; env?: GitEnv } = {},
): Promise<{ success: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const git = createGit(repoPath, { abort: controller.signal, timeout: { block: timeoutMs } }, env);
    // `git fetch <remote> <branch>` also updates refs/remotes/<remote>/<branch>
    // through the remote's configured fetch refspec.
    await withTimeout(
      git.raw(['fetch', '--quiet', '--', base.remote, base.branch]),
      // The abort normally settles first; this is the backstop.
      timeoutMs + 1_000,
      `git fetch ${base.remote} ${base.branch} timed out after ${timeoutMs}ms`,
    );
    return { success: true };
  } catch (error) {
    if (controller.signal.aborted) {
      return { success: false, error: `git fetch ${base.remote} ${base.branch} timed out after ${timeoutMs}ms` };
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

type DefaultBaseSettingProvider = (workspacePath: string) => WorktreeDefaultBaseSetting | undefined;

let settingProvider: DefaultBaseSettingProvider | null = null;

/**
 * The project setting lives in the electron-store workspace state, which the
 * git service must not import (it is constructed in several handlers and in
 * tests). The IPC layer registers the reader once at startup.
 */
export function setWorktreeDefaultBaseProvider(provider: DefaultBaseSettingProvider | null): void {
  settingProvider = provider;
}

export function getWorktreeDefaultBaseSetting(workspacePath: string): WorktreeDefaultBaseSetting | undefined {
  try {
    return settingProvider?.(workspacePath);
  } catch {
    return undefined;
  }
}
