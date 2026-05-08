/**
 * Worktree event atoms.
 *
 * Updated by store/listeners/worktreeListeners.ts. Components that previously
 * subscribed to worktree:* IPC events directly now read from these atoms.
 */

import { atom } from 'jotai';

/**
 * Latest `worktree:display-name-updated` event from main.
 *
 * Request-atom shape: each event bumps `version` and replaces `payload`.
 * Consumers use `useAtomValue` + the skip-initial-mount idiom (capture the
 * initial version in a ref, bail when it matches) so the side effect fires
 * only on real bumps. Filter by `payload.worktreeId` to react to a specific
 * worktree.
 */
export interface WorktreeDisplayNameUpdate {
  version: number;
  payload: { worktreeId: string; displayName: string };
}

export const worktreeDisplayNameUpdateAtom = atom<WorktreeDisplayNameUpdate | null>(null);
