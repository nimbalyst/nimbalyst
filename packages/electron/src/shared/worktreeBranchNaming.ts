/**
 * Worktree branch naming, shared by the worktree dialog and the main process
 *
 * A worktree's branch is `worktree/<suffix>`. A name the user typed is the
 * suffix exactly, so `feat/x` becomes the branch `worktree/feat/x`, and its
 * folder is the one-segment `feat-x`. Generated names, an unedited suggested
 * name and PR review's `pr-<n>` keep folder and branch on the same name, with
 * a `-N` added to both when the folder is taken.
 */

export const WORKTREE_BRANCH_PREFIX = 'worktree';
export const WORKTREE_BRANCH_SEPARATOR = '/';

/** Policy: the longest suffix a typed name may have */
export const WORKTREE_NAME_MAX_LENGTH = 64;

/**
 * Where a worktree name came from. `'user'`: typed or edited by the user,
 * becomes the branch exactly. `'suggested'`: generated or prefilled; takes
 * `-N` on folder and branch when its folder is taken, while a branch
 * conflict fails (only a generated name is retried with a fresh one).
 */
export type WorktreeNameSource = 'user' | 'suggested';

const BRANCH_PREFIX = `${WORKTREE_BRANCH_PREFIX}${WORKTREE_BRANCH_SEPARATOR}`;

export function buildWorktreeBranchName(suffix: string): string {
  return `${BRANCH_PREFIX}${suffix}`;
}

/** The suffix of a `worktree/` branch; any other branch as given */
export function stripWorktreeBranchPrefix(branch: string): string {
  return branch.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : branch;
}

export interface WorktreeNameProblem {
  message: string;
  /** True for Nimbalyst's own limits on a name git itself would accept */
  policy: boolean;
}

// ASCII control characters, space, and the characters git forbids in a ref
// eslint-disable-next-line no-control-regex
const FORBIDDEN_REF_CHARACTER = /[\x00-\x20\x7f~^:?*[\\]/;

// Characters git allows in a ref that a Windows file name cannot hold
const WINDOWS_FORBIDDEN_CHARACTER = /[<>"|]/;

// Device names Windows reserves, with or without an extension
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\.|$)/i;

/**
 * Why `worktree/<suffix>` cannot be the branch of a typed name, or null when
 * it can. The git rules are those of `git check-ref-format --branch`; on top
 * of them come policy rules. Besides a length limit and no leading `-`, the
 * policy keeps out what Git for Windows cannot store as a loose ref file, as
 * a branch travels between machines.
 */
export function validateWorktreeBranchSuffix(suffix: string): WorktreeNameProblem | null {
  const gitRule = (message: string): WorktreeNameProblem => ({ message, policy: false });
  if (!suffix) return gitRule('Name is empty.');
  if (suffix.startsWith('/')) return gitRule('Name cannot start with "/".');
  if (suffix.endsWith('/')) return gitRule('Name cannot end with "/".');
  if (suffix.includes('//')) return gitRule('Name cannot contain "//".');
  if (suffix.startsWith('.')) return gitRule('Name cannot start with ".".');
  if (suffix.endsWith('.')) return gitRule('Name cannot end with ".".');
  if (suffix.endsWith('.lock')) return gitRule('Name cannot end with ".lock".');
  if (suffix.includes('..')) return gitRule('Name cannot contain "..".');
  if (suffix.includes('@{')) return gitRule('Name cannot contain "@{".');
  if (FORBIDDEN_REF_CHARACTER.test(suffix)) {
    return gitRule('Name cannot contain spaces, control characters or any of: ~ ^ : ? * [ \\');
  }
  for (const part of suffix.split('/')) {
    if (part.startsWith('.')) return gitRule('Name parts between "/" cannot start with ".".');
    if (part.endsWith('.lock')) return gitRule('Name parts between "/" cannot end with ".lock".');
  }

  // Policy: git accepts all of these
  const policyRule = (message: string): WorktreeNameProblem => ({ message, policy: true });
  if (suffix.length > WORKTREE_NAME_MAX_LENGTH) {
    return policyRule(`Name is too long (max ${WORKTREE_NAME_MAX_LENGTH} chars).`);
  }
  if (suffix.startsWith('-')) return policyRule('Name cannot start with "-".');
  if (WINDOWS_FORBIDDEN_CHARACTER.test(suffix)) return policyRule('Name cannot contain any of: < > " |');
  for (const part of suffix.split('/')) {
    if (part.endsWith('.')) return policyRule('Name parts between "/" cannot end with ".".');
    if (WINDOWS_RESERVED_NAME.test(part)) {
      return policyRule(`Name parts between "/" cannot be "${part}", a device name Windows reserves.`);
    }
  }
  return null;
}

/**
 * The one-segment folder for a typed name: `/` becomes `-`, characters a
 * Windows file name cannot hold are dropped, runs of dashes collapse, and
 * leading and trailing dots and dashes go. A name Windows reserves for a
 * device gets a `_`.
 */
export function worktreeDirectoryNameFor(suffix: string): string {
  const slug = suffix
    .replace(/[\\/]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\x00-\x1f\x7f]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  if (!slug) return WORKTREE_BRANCH_PREFIX;
  return WINDOWS_RESERVED_NAME.test(slug) ? slug.replace(/^[^.]+/, (stem) => `${stem}_`) : slug;
}

export interface WorktreeBranchConflict {
  /** The existing branch */
  ref: string;
  /**
   * `exact`: the branch exists. `ancestor`: an existing branch is a parent
   * path of it (`worktree` for `worktree/x`). `descendant`: existing branches
   * sit below it. Git refuses all three.
   */
  kind: 'exact' | 'ancestor' | 'descendant';
}

/**
 * The local branch among `refs` (names without `refs/heads/`) that keeps git
 * from creating `branch`, or null. Where the file system ignores case, git's
 * loose refs do too, so the comparison should as well.
 */
export function findBranchConflict(
  branch: string,
  refs: Iterable<string>,
  { caseInsensitive = false }: { caseInsensitive?: boolean } = {}
): WorktreeBranchConflict | null {
  const key = (ref: string) => (caseInsensitive ? ref.toLowerCase() : ref);
  const target = key(branch);
  const existing = [...refs];
  const exact = existing.find((ref) => key(ref) === target);
  if (exact !== undefined) return { ref: exact, kind: 'exact' };
  for (const ref of existing) {
    const candidate = key(ref);
    if (target.startsWith(`${candidate}/`)) return { ref, kind: 'ancestor' };
    if (candidate.startsWith(`${target}/`)) return { ref, kind: 'descendant' };
  }
  return null;
}

/** The branch a worktree's row records, with the worktree it was read for */
export interface RecordedWorktreeBranch {
  worktreePath: string;
  branch: string;
}

/**
 * The branch to name for the worktree at `worktreePath`: the one its row
 * records. A typed name's folder (`feat-x`) does not give its branch back
 * (`worktree/feat/x`), so `folderName` only stands in until the row of this
 * worktree has loaded; a branch recorded for another worktree never does.
 */
export function worktreeBranchLabel(
  recorded: RecordedWorktreeBranch | null,
  worktreePath: string | null | undefined,
  folderName: string
): string {
  return recorded && recorded.worktreePath === worktreePath && recorded.branch
    ? recorded.branch
    : buildWorktreeBranchName(folderName);
}
