/**
 * Central Worktree Listeners
 *
 * Subscribes to worktree-related IPC events ONCE and routes them to atoms.
 * Components read the atoms instead of calling `electronAPI.on(...)` from
 * useEffect.
 *
 * Events handled:
 * - `worktree:display-name-updated` -> worktreeDisplayNameUpdateAtom (request)
 * - `worktree:pinned-updated` -> worktreePinnedUpdateAtom (request)
 *
 * Both events also patch worktreeRecordsAtom so readers that only hold a
 * worktree id (the Agent mode header) don't need their own subscription.
 *
 * Call initWorktreeListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import {
  patchWorktreeRecordAtom,
  worktreeDisplayNameUpdateAtom,
  worktreePinnedUpdateAtom,
} from '../atoms/worktrees';

let initialized = false;

export function initWorktreeListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const cleanups: Array<() => void> = [];
  let displayNameVersion = 0;
  let pinnedVersion = 0;

  const u1 = window.electronAPI?.on?.(
    'worktree:display-name-updated',
    (data: { worktreeId: string; displayName: string }) => {
      if (!data?.worktreeId) return;
      displayNameVersion += 1;
      store.set(worktreeDisplayNameUpdateAtom, {
        version: displayNameVersion,
        payload: { worktreeId: data.worktreeId, displayName: data.displayName },
      });
      store.set(patchWorktreeRecordAtom, {
        worktreeId: data.worktreeId,
        updates: { displayName: data.displayName },
      });
    },
  );
  if (typeof u1 === 'function') cleanups.push(u1);

  const u2 = window.electronAPI?.on?.(
    'worktree:pinned-updated',
    (data: { worktreeId: string; isPinned: boolean }) => {
      if (!data?.worktreeId) return;
      pinnedVersion += 1;
      store.set(worktreePinnedUpdateAtom, {
        version: pinnedVersion,
        payload: { worktreeId: data.worktreeId, isPinned: data.isPinned },
      });
      store.set(patchWorktreeRecordAtom, {
        worktreeId: data.worktreeId,
        updates: { isPinned: data.isPinned },
      });
    },
  );
  if (typeof u2 === 'function') cleanups.push(u2);

  return () => {
    initialized = false;
    cleanups.forEach((fn) => fn?.());
  };
}
