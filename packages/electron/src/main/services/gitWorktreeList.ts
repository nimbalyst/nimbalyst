/**
 * Pure parser for `git worktree list --porcelain`.
 *
 * Git prints one block per worktree, separated by a blank line, and the first
 * block is always the main worktree. Each block starts with `worktree <path>`
 * and carries `HEAD <sha>`, then `branch refs/heads/<name>`, `detached`, or
 * `bare`, plus optional `locked [reason]` and `prunable [reason]` lines.
 *
 * `GitWorktreeService.listWorktrees` marks every entry as main; callers that
 * need to tell the main worktree apart use this parser instead.
 *
 * Prefer `--porcelain -z` (git 2.36+): attributes end in NUL, records end in
 * an empty attribute, and paths are written raw. Without `-z`, git C-quotes a
 * path containing a tab, newline or quote, which this parser would read as
 * the literal quoted text.
 */

export interface WorktreeListEntry {
  path: string;
  /** Commit HEAD points at; null for a bare repository or an unborn branch. */
  head: string | null;
  /** Short branch name (`feature/x`), or null when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  /** True only for the first block, which git always prints for the main worktree. */
  isMain: boolean;
}

const ZERO_SHA = /^0+$/;

export function parseWorktreeListPorcelain(
  output: string,
  { nulTerminated = false }: { nulTerminated?: boolean } = {},
): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;

  const lines = nulTerminated ? output.split('\0') : output.split('\n').map(l => l.replace(/\r$/, ''));
  for (const line of lines) {
    if (line === '') {
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      current = {
        path: line.slice('worktree '.length),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
        isMain: entries.length === 0,
      };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) {
      const sha = line.slice('HEAD '.length).trim();
      current.head = sha && !ZERO_SHA.test(sha) ? sha : null;
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    }
  }

  return entries;
}
