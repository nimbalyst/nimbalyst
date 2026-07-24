/**
 * Git Operations Atoms
 *
 * State for git operations including commit state, staging, and git status.
 *
 * Multi-project rail: each open project keeps its own git state so the
 * Git tab does not flash the previous project's status when the user
 * switches via the rail. The bare atoms below are read+write proxies
 * that resolve to the active workspace's family slot.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { activeWorkspacePathAtom } from './openProjects';

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  hasUncommitted: boolean;
  baseBranch?: string;
  isMerged?: boolean;
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

// Per-workspace storage. The proxies below read/write the slot for the
// active workspace path so existing call-sites do not need to change.

const gitStatusAtomFamily = atomFamily((_workspacePath: string) =>
  atom<GitStatus | null>(null)
);

const gitCommitsAtomFamily = atomFamily((_workspacePath: string) =>
  atom<GitCommit[]>([])
);

const stagedFilesAtomFamily = atomFamily((_workspacePath: string) =>
  atom<Set<string>>(new Set<string>())
);

const commitMessageAtomFamily = atomFamily((_workspacePath: string) =>
  atom<string>('')
);

const isCommittingAtomFamily = atomFamily((_workspacePath: string) =>
  atom<boolean>(false)
);

/** Drop every git-operations slot held for a workspace path. */
export function pruneGitOperationsWorkspaceState(workspacePath: string): void {
  gitStatusAtomFamily.remove(workspacePath);
  gitCommitsAtomFamily.remove(workspacePath);
  stagedFilesAtomFamily.remove(workspacePath);
  commitMessageAtomFamily.remove(workspacePath);
  isCommittingAtomFamily.remove(workspacePath);
}

/**
 * Git status for the active workspace. Updated by file watcher / GitRefWatcher.
 */
export const gitStatusAtom = atom<GitStatus | null, [GitStatus | null], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return null;
    return get(gitStatusAtomFamily(path));
  },
  (get, set, value) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    set(gitStatusAtomFamily(path), value);
  }
);

/**
 * Recent commits for the active workspace.
 */
export const gitCommitsAtom = atom<GitCommit[], [GitCommit[]], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return [];
    return get(gitCommitsAtomFamily(path));
  },
  (get, set, value) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    set(gitCommitsAtomFamily(path), value);
  }
);

/**
 * Files staged for commit. Set of file paths that the user has checked
 * in the UI. Per workspace so each project keeps its own staging.
 */
export const stagedFilesAtom = atom<Set<string>, [Set<string>], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return new Set<string>();
    return get(stagedFilesAtomFamily(path));
  },
  (get, set, value) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    set(stagedFilesAtomFamily(path), value);
  }
);

/**
 * Commit message being composed for the active workspace.
 */
export const commitMessageAtom = atom<string, [string], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return '';
    return get(commitMessageAtomFamily(path));
  },
  (get, set, value) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    set(commitMessageAtomFamily(path), value);
  }
);

/**
 * Whether a commit operation is in progress for the active workspace.
 */
export const isCommittingAtom = atom<boolean, [boolean], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return false;
    return get(isCommittingAtomFamily(path));
  },
  (get, set, value) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    set(isCommittingAtomFamily(path), value);
  }
);

/**
 * Per-file staging state.
 * Derived from stagedFilesAtom for efficient per-file subscriptions.
 */
export const fileStagedAtom = atomFamily((filePath: string) =>
  atom(
    (get) => {
      const staged = get(stagedFilesAtom);
      return staged.has(filePath);
    },
    (get, set, isStaged: boolean) => {
      const staged = new Set(get(stagedFilesAtom));
      if (isStaged) {
        staged.add(filePath);
      } else {
        staged.delete(filePath);
      }
      set(stagedFilesAtom, staged);
    }
  )
);

/**
 * Helper action to toggle staging for a file.
 */
export const toggleFileStagingAtom = atom(null, (get, set, filePath: string) => {
  const isStaged = get(fileStagedAtom(filePath));
  set(fileStagedAtom(filePath), !isStaged);
});

/**
 * Helper action to stage all edited files.
 */
export const stageAllFilesAtom = atom(null, (get, set, filePaths: string[]) => {
  set(stagedFilesAtom, new Set(filePaths));
});

/**
 * Helper action to clear staging.
 */
export const clearStagingAtom = atom(null, (get, set) => {
  set(stagedFilesAtom, new Set());
});

// Git commit proposals are handled by GitCommitConfirmationWidget
// Widget renders directly from tool call data - no atoms needed
// See packages/runtime/src/ui/AgentTranscript/components/CustomToolWidgets/GitCommitConfirmationWidget.tsx

// ============================================================
// Git Panel Refresh Triggers
// ============================================================

/**
 * Per-worktree refresh counter.
 * Incremented when a session in this worktree completes, triggering the
 * GitOperationsPanel to refresh its data.
 *
 * The counter approach is used instead of a boolean because:
 * 1. Multiple sessions can complete in sequence
 * 2. The counter ensures each completion triggers a refresh
 * 3. Components can use useEffect with this value as a dependency
 */
export const worktreeRefreshCounterAtom = atomFamily((_worktreeId: string) =>
  atom(0)
);

/**
 * Action atom to trigger a refresh for a specific worktree.
 * Called when a session in that worktree completes.
 */
export const triggerWorktreeRefreshAtom = atom(
  null,
  (get, set, worktreeId: string) => {
    const current = get(worktreeRefreshCounterAtom(worktreeId));
    set(worktreeRefreshCounterAtom(worktreeId), current + 1);
  }
);
