/**
 * Worktree ownership - whether a repository may remove a directory as one of
 * its worktrees
 *
 * Removing a worktree deletes a directory, a git registration and a branch,
 * and each of them must belong to the repository the removal runs in. A
 * worktree of another repository (an attached folder removed through the
 * primary root, or a path reused after a checkout was deleted by hand), the
 * repository's own working tree, a moved checkout and a locked worktree are
 * refused before anything is deleted. So is a folder git no longer tracks,
 * whose files git cannot check for changes, and a worktree that holds
 * another of the repository's worktrees. The decision is a pure function
 * over facts read from git and the disk, so every outcome is testable
 * without staging it. Undoing a failed creation follows the same rule: it
 * removes only what the attempt created.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * The form a resolved path is compared in. On win32, separators and case do
 * not tell paths apart, and git prints forward slashes there.
 */
export function worktreePathKey(resolvedPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return resolvedPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }
  return resolvedPath.length > 1 ? resolvedPath.replace(/\/+$/, '') : resolvedPath;
}

/** Whether `childKey` lies strictly inside `parentKey`, both from `worktreePathKey` */
export function isWorktreePathInside(childKey: string, parentKey: string): boolean {
  return childKey.startsWith(parentKey.endsWith('/') ? parentKey : `${parentKey}/`);
}

/**
 * The comparison key of a worktree path, with symlinks resolved. Git lists
 * worktrees by their real paths: one created through `<dir>/link/x` is listed
 * as `<dir>/real/x`, so a stored path matches git's spelling only once both
 * are resolved. A path that no longer exists resolves through its nearest
 * existing ancestor with the missing rest appended, so a removed checkout
 * still matches its registration. Apply it to both sides of a comparison.
 */
export function canonicalWorktreePath(worktreePath: string): string {
  const absolute = path.resolve(worktreePath);
  const missing: string[] = [];
  let existing = absolute;
  for (;;) {
    try {
      return worktreePathKey(path.join(fs.realpathSync.native(existing), ...missing));
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) {
        return worktreePathKey(absolute);
      }
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** One entry of `git worktree list --porcelain` */
export interface WorktreeRegistration {
  /** As git prints it, which is the real path */
  path: string;
  /** The checked-out branch without `refs/heads/`; null for a detached HEAD */
  branch: string | null;
  locked: boolean;
  lockReason?: string;
  /** The repository's own working tree, which git always lists first */
  isMain: boolean;
}

/**
 * Parses `git worktree list --porcelain`, with or without `-z`. With `-z`
 * every field ends in a NUL, so a path or a lock reason may hold a newline
 * and the reason is printed unquoted. Plain output never contains a NUL.
 */
export function parseWorktreePorcelain(output: string): WorktreeRegistration[] {
  const registrations: WorktreeRegistration[] = [];
  let current: WorktreeRegistration | null = null;
  for (const line of output.split(output.includes('\0') ? '\0' : /\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null, locked: false, isMain: registrations.length === 0 };
      registrations.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = branchFromRef(line.slice('branch '.length));
    } else if (current && (line === 'locked' || line.startsWith('locked '))) {
      current.locked = true;
      const reason = line.slice('locked'.length).trim();
      if (reason) {
        current.lockReason = reason;
      }
    }
  }
  return registrations;
}

function branchFromRef(ref: string): string | null {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

/**
 * What a directory's `.git` entry says about the repository that owns it. A
 * linked worktree's `.git` file names its admin dir, `<common-dir>/worktrees/<id>`,
 * and that admin dir's `gitdir` file names the `.git` file back. Git checks
 * the same pair before `worktree remove`, so a registration alone is not
 * enough: the path may since hold another repository's checkout.
 */
export type WorktreeGitLink =
  /** No `.git` entry, as a removal interrupted part way leaves the directory */
  | { kind: 'missing' }
  /**
   * Points into this repository's worktrees area, at an admin dir that no
   * longer exists. `git worktree remove` leaves this when it cannot delete
   * every file (it drops the admin dir regardless), and a prune leaves it
   * of a checkout that was offline. So does deleting and re-creating the
   * repository at the same path (a re-clone), and the folder may then hold
   * the only copy of its work. Git can no longer check it for changes.
   */
  | { kind: 'orphaned' }
  /** A `.git` directory, or a `.git` file naming no gitdir: not a linked worktree */
  | { kind: 'not-linked' }
  /** A linked worktree of another repository, at `owner` when that still exists */
  | { kind: 'other-repository'; owner: string | null }
  /**
   * Points into this repository's admin area, but that admin dir no longer
   * names this directory back, nor any other checkout that points to it: a
   * checkout moved by hand, which `git worktree repair` run inside it
   * reconnects
   */
  | { kind: 'moved' }
  /**
   * Points into this repository's admin area, whose back-reference names
   * another checkout, at `livePath`, that points to the same admin dir: a
   * copy of that worktree, or a checkout whose admin id git reused after a
   * prune. `git worktree repair` run here would take the admin dir away from
   * the live checkout.
   */
  | { kind: 'copy'; livePath: string }
  /**
   * A worktree of this repository, as git records it at `registeredPath`.
   * `branch` is read from the admin dir's HEAD file: null for a detached HEAD,
   * and also on a ref format that keeps HEAD elsewhere (reftable).
   */
  | { kind: 'this-repository'; registeredPath: string; branch: string | null; locked: boolean };

/** What git writes to a `HEAD` file whose real HEAD lives in a ref backend other than files */
const REFTABLE_HEAD_STUB = 'refs/heads/.invalid';

/** `p` with symlinks resolved, or as given when it cannot be resolved */
function realPathOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Resolves a pointer read from a file in `baseDir`. Git resolves a relative
 * pointer on disk, and relative worktree paths (`worktree.useRelativePaths`)
 * are computed between real paths, so `..` applies to the real directory: a
 * symlinked parent at another depth would otherwise lead somewhere else.
 */
function resolvePointer(baseDir: string, pointer: string): string {
  return path.isAbsolute(pointer) ? path.resolve(pointer) : path.resolve(realPathOr(baseDir), pointer);
}

/**
 * Reads `dir`'s `.git` link against the repository whose common dir (the
 * main `.git` directory) is `commonDir`. The back-reference is compared by
 * file identity, so a spelling git does not share (a bind mount, a subst
 * drive, a case difference) still matches. It compares the checkout
 * directories, not their `.git` files: a hard-linked copy (`cp -al`) or a
 * symlinked `.git` shares the live worktree's `.git` file, and a directory
 * cannot be hard-linked.
 */
export function readWorktreeGitLink(dir: string, commonDir: string): WorktreeGitLink {
  const dotGit = path.join(dir, '.git');
  let content: string;
  try {
    content = fs.readFileSync(dotGit, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'not-linked' };
  }
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(content)?.[1];
  if (!gitdir) {
    return { kind: 'not-linked' };
  }
  const adminDir = resolvePointer(dir, gitdir);
  if (!isWorktreePathInside(canonicalWorktreePath(adminDir), canonicalWorktreePath(path.join(commonDir, 'worktrees')))) {
    // `<common-dir>/worktrees/<id>` names its repository; a submodule's
    // `modules/<name>` does not
    const ownerGitDir = path.basename(path.dirname(adminDir)) === 'worktrees' ? path.dirname(path.dirname(adminDir)) : null;
    const owner = ownerGitDir && fs.existsSync(ownerGitDir)
      ? (path.basename(ownerGitDir) === '.git' ? path.dirname(ownerGitDir) : ownerGitDir)
      : null;
    return { kind: 'other-repository', owner };
  }
  try {
    fs.statSync(adminDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'orphaned' };
    }
    return { kind: 'moved' };
  }
  let backReference: string;
  try {
    backReference = resolvePointer(adminDir, fs.readFileSync(path.join(adminDir, 'gitdir'), 'utf8').trim());
  } catch {
    // The admin dir is there without its back-reference, which
    // `git worktree repair` run inside the checkout rewrites
    return { kind: 'moved' };
  }
  if (!isSameFile(path.dirname(backReference), dir)) {
    return pointsToAdminDir(backReference, adminDir)
      ? { kind: 'copy', livePath: path.dirname(backReference) }
      : { kind: 'moved' };
  }
  let branch: string | null = null;
  try {
    const head = /^ref:\s*(\S+)/.exec(fs.readFileSync(path.join(adminDir, 'HEAD'), 'utf8'))?.[1];
    // A repository on the reftable ref format keeps HEAD in `<admin>/reftable`
    // and leaves this file as a stub naming `refs/heads/.invalid`, which no
    // branch can be called. The porcelain list reads HEAD through git and is
    // preferred where it lists this worktree.
    branch = head && head !== REFTABLE_HEAD_STUB ? branchFromRef(head) : null;
  } catch {
    // An unreadable HEAD names no branch to delete
  }
  return {
    kind: 'this-repository',
    registeredPath: path.dirname(backReference),
    branch,
    // Read from the admin dir, because git before 2.31 does not print `locked`
    // in the porcelain list
    locked: fs.existsSync(path.join(adminDir, 'locked')),
  };
}

/**
 * The lock of the worktree git registered at `registeredPath`, read from the
 * admin dir that names it back. Git before 2.31 prints no `locked` line in
 * the porcelain list, and a checkout whose `.git` file is gone cannot lead to
 * its admin dir, so the admin dirs are searched by their back-reference.
 */
export function readRegisteredWorktreeLock(
  registeredPath: string,
  commonDir: string
): { locked: boolean; reason?: string } {
  const worktreesDir = path.join(commonDir, 'worktrees');
  const key = canonicalWorktreePath(registeredPath);
  let ids: string[];
  try {
    ids = fs.readdirSync(worktreesDir);
  } catch {
    return { locked: false };
  }
  for (const id of ids) {
    const adminDir = path.join(worktreesDir, id);
    try {
      const backReference = resolvePointer(adminDir, fs.readFileSync(path.join(adminDir, 'gitdir'), 'utf8').trim());
      if (canonicalWorktreePath(path.dirname(backReference)) !== key) {
        continue;
      }
      const reason = fs.readFileSync(path.join(adminDir, 'locked'), 'utf8').trim();
      return reason ? { locked: true, reason } : { locked: true };
    } catch {
      // No back-reference here, or no lock file
    }
  }
  return { locked: false };
}

/** Whether the `.git` file at `dotGit` points to `adminDir` */
function pointsToAdminDir(dotGit: string, adminDir: string): boolean {
  try {
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1];
    return gitdir !== undefined && isSameFile(resolvePointer(path.dirname(dotGit), gitdir), adminDir);
  } catch {
    return false;
  }
}

function isSameFile(a: string, b: string): boolean {
  try {
    const statA = fs.statSync(a, { bigint: true });
    const statB = fs.statSync(b, { bigint: true });
    if (statA.ino === 0n || statB.ino === 0n) {
      // A filesystem without file ids (FAT) reports 0 for every file
      return canonicalWorktreePath(a) === canonicalWorktreePath(b);
    }
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    return false;
  }
}

export interface WorktreeRemovalFacts {
  existsOnDisk: boolean;
  /** False when `git worktree list` failed */
  registryReadable: boolean;
  /** The repository's registration of this path, matched by canonical path */
  registration: Pick<WorktreeRegistration, 'path' | 'branch' | 'locked' | 'isMain'> | null;
  /** The directory's `.git` link; null when the directory is gone or the link could not be checked */
  gitLink: WorktreeGitLink | null;
  /**
   * Another registered worktree of the repository whose checkout lies inside
   * the directory, which deleting the directory would delete with it; null
   * when there is none. Worktrees of other repositories inside it are not
   * listed here.
   */
  nestedWorktreePath: string | null;
  /** The branch the worktree was created on, from its row */
  expectedBranch?: string;
}

/**
 * A removal `planWorktreeRemoval` refused. Nothing has been deleted when it is
 * thrown, so a caller can restore whatever it hid beforehand.
 */
export class WorktreeRemovalRefusedError extends Error {
  readonly reason: WorktreeRemovalRefusal;

  constructor(reason: WorktreeRemovalRefusal, message: string) {
    super(message);
    this.name = 'WorktreeRemovalRefusedError';
    this.reason = reason;
  }
}

export type WorktreeRemovalRefusal = Extract<WorktreeRemovalPlan, { action: 'refuse' }>['reason'];

export type WorktreeRemovalPlan =
  | {
      action: 'refuse';
      reason:
        | 'main-worktree'
        | 'locked'
        | 'unverifiable'
        | 'not-owned'
        | 'moved'
        | 'copy'
        | 'untracked'
        | 'contains-worktree';
    }
  /** The directory is gone and git no longer lists it; its branch stays */
  | { action: 'already-removed' }
  /**
   * Remove the worktree and its registration at `registeredPath`, then
   * delete `branch` when it is set. `force` deletes it even when it is not
   * merged; otherwise only a merged branch goes.
   */
  | { action: 'remove'; registeredPath: string; branch: string | null; forceBranchDelete: boolean };

export function planWorktreeRemoval(facts: WorktreeRemovalFacts): WorktreeRemovalPlan {
  const { registration, gitLink, expectedBranch } = facts;
  if (registration?.isMain) {
    return { action: 'refuse', reason: 'main-worktree' };
  }
  if (!facts.existsOnDisk) {
    if (!registration) {
      // Already pruned, or the repository cannot be asked. Nothing ties the
      // branch to this worktree any more, and it may hold unmerged work.
      return { action: 'already-removed' };
    }
    if (registration.locked) {
      // The lock says the directory must stay registered, as for a worktree
      // on an unmounted drive
      return { action: 'refuse', reason: 'locked' };
    }
    // Git cannot tell a deleted checkout from one moved by hand, which may
    // hold the only copy of the branch's commits, so a branch that is not
    // merged stays. Unregistering deletes the admin dir such a checkout's
    // .git file points to, so it is no longer a git checkout, but
    // `git worktree add <path> <branch>` can check the kept branch out again.
    return {
      action: 'remove',
      registeredPath: registration.path,
      branch: branchToDelete(registration.branch, expectedBranch),
      forceBranchDelete: false,
    };
  }
  if (!facts.registryReadable || !gitLink) {
    return { action: 'refuse', reason: 'unverifiable' };
  }
  switch (gitLink.kind) {
    case 'this-repository':
      if (registration?.locked || gitLink.locked) {
        // The directory is deleted before git is asked to unregister it, so
        // this is the only check that keeps a locked worktree (one on a
        // removable drive, say) on disk
        return { action: 'refuse', reason: 'locked' };
      }
      return unlessNested(facts, {
        action: 'remove',
        registeredPath: registration?.path ?? gitLink.registeredPath,
        // The list reads HEAD through git's refs, which works on every ref
        // format; the admin dir's HEAD file names a branch only on the files
        // format, so it is the answer only where git lists another spelling
        branch: branchToDelete(registration ? registration.branch : gitLink.branch, expectedBranch),
        forceBranchDelete: true,
      });
    case 'missing':
      // A registered checkout whose `.git` file is gone, as a removal
      // interrupted part way leaves it. Unregistered, only its path ties it
      // to this repository, and it may be anyone's folder.
      if (!registration) {
        return { action: 'refuse', reason: 'untracked' };
      }
      if (registration.locked) {
        return { action: 'refuse', reason: 'locked' };
      }
      // The registration's admin dir is shared with any copy of the checkout
      // moved elsewhere by hand, which may hold the only copy of the branch's
      // commits, so as for a gone directory, a branch that is not merged
      // stays.
      return unlessNested(facts, {
        action: 'remove',
        registeredPath: registration.path,
        branch: branchToDelete(registration.branch, expectedBranch),
        forceBranchDelete: false,
      });
    case 'orphaned':
      if (registration) {
        // The path is registered through another admin dir than the one its
        // `.git` file names, which only a hand edit produces
        return { action: 'refuse', reason: 'unverifiable' };
      }
      // Git has no record left of the checkout and cannot check it for
      // changes, and the repository may have been re-created since, so its
      // commits may exist only in the folder's lost object store. Nothing can
      // verify that deleting it loses nothing.
      return { action: 'refuse', reason: 'untracked' };
    case 'moved':
      return { action: 'refuse', reason: 'moved' };
    case 'copy':
      return { action: 'refuse', reason: 'copy' };
    case 'other-repository':
    case 'not-linked':
      // Even when this repository still lists the path: its checkout was
      // deleted without a prune and the path reused
      return { action: 'refuse', reason: 'not-owned' };
  }
}

/**
 * `plan`, unless the directory it deletes holds another worktree. The
 * ownership and lock checks cover the directory itself, and deleting it
 * would take the inner checkout, its uncommitted work and any lock with it.
 */
function unlessNested(facts: WorktreeRemovalFacts, plan: WorktreeRemovalPlan): WorktreeRemovalPlan {
  return facts.nestedWorktreePath ? { action: 'refuse', reason: 'contains-worktree' } : plan;
}

/**
 * The branch to delete with a worktree: the one it has checked out. When the
 * caller names the worktree's own branch, no other branch is deleted, so a
 * worktree someone switched to a different branch keeps both.
 */
function branchToDelete(checkedOut: string | null, expectedBranch: string | undefined): string | null {
  if (checkedOut === null) {
    // A detached HEAD, for example in the middle of a rebase
    return null;
  }
  if (expectedBranch !== undefined && checkedOut !== expectedBranch) {
    return null;
  }
  return checkedOut;
}

/**
 * What a failed creation may have left, against what was there before it
 * ran. The attempt runs `git branch` and then `git worktree add`, the two
 * steps `worktree add -b` runs itself, so whether the branch is its own is
 * known rather than inferred. A failing post-checkout hook leaves the folder,
 * its registration and the new branch; a refused path can still leave the
 * branch.
 */
export interface WorktreeCreateRollbackFacts {
  /** The branch the attempt was creating */
  branch: string;
  /** The attempt's own `git branch` succeeded */
  branchCreated: boolean;
  before: { pathExisted: boolean; registered: boolean };
  /** Null when git could not be asked after the failure */
  after: {
    pathExists: boolean;
    registered: boolean;
    /** The branch the registration at the target has checked out; null for none or a detached HEAD */
    registeredBranch: string | null;
    locked: boolean;
    /** Another registered worktree lies inside the folder */
    holdsOtherWorktree: boolean;
    branchExists: boolean;
  } | null;
}

export interface WorktreeCreateRollbackPlan {
  /** `worktree remove --force` the registration the attempt created, which deletes its folder with it */
  unregister: boolean;
  /** Delete what git leaves of that folder once it is unregistered */
  removeFolder: boolean;
  /** `branch -D` the branch the attempt created */
  deleteBranch: boolean;
}

/**
 * Undoes only what the failed attempt provably created. A registration is
 * its own only when it has the attempt's new branch checked out: another
 * app or a terminal, which the in-process repository lock does not hold
 * off, may have registered a worktree at the same path meanwhile. A branch
 * or registration that existed before stays, and so does a folder git did
 * not register in this attempt, which may be anyone's. A folder that existed
 * before and that the attempt's own registration took over can only have
 * been empty, as git adopts no other; unregistering deletes it with the
 * registration, and `removeFolder` only skips deleting what git leaves of
 * it. A locked registration, or one whose folder holds another worktree,
 * stays with its branch, as a removal would refuse it too.
 */
export function planWorktreeCreateRollback({
  branch,
  branchCreated,
  before,
  after,
}: WorktreeCreateRollbackFacts): WorktreeCreateRollbackPlan {
  if (!after || !branchCreated) {
    return { unregister: false, removeFolder: false, deleteBranch: false };
  }
  const ownRegistration = after.registered && !before.registered && after.registeredBranch === branch;
  const unregister = ownRegistration && !after.locked && !after.holdsOtherWorktree;
  return {
    unregister,
    removeFolder: unregister && !before.pathExisted,
    // Git refuses to delete a branch a registered worktree has checked out
    deleteBranch: after.branchExists && (!ownRegistration || unregister),
  };
}
