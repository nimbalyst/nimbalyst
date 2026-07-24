/**
 * Central Worktree Listeners
 *
 * Subscribes to worktree-related IPC events ONCE and routes them to atoms.
 * Components read the atoms instead of calling `electronAPI.on(...)` from
 * useEffect.
 *
 * Events handled:
 * - `worktree:display-name-updated` -> worktreeDisplayNameUpdateAtom (request)
 *
 * Call initWorktreeListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import { worktreeDisplayNameUpdateAtom } from '../atoms/worktrees';

let initialized = false;

export function initWorktreeListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const cleanups: Array<() => void> = [];
  let displayNameVersion = 0;

  const u1 = window.electronAPI?.on?.(
    'worktree:display-name-updated',
    (data: { worktreeId: string; displayName: string }) => {
      if (!data?.worktreeId) return;
      displayNameVersion += 1;
      store.set(worktreeDisplayNameUpdateAtom, {
        version: displayNameVersion,
        payload: { worktreeId: data.worktreeId, displayName: data.displayName },
      });
    },
  );
  if (typeof u1 === 'function') cleanups.push(u1);

  return () => {
    initialized = false;
    cleanups.forEach((fn) => fn?.());
  };
}
