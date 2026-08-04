/**
 * Worktree event atoms.
 *
 * Updated by store/listeners/worktreeListeners.ts. Components that previously
 * subscribed to worktree:* IPC events directly now read from these atoms.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';

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

/**
 * Latest `worktree:pinned-updated` event from main. Same request-atom shape as
 * {@link worktreeDisplayNameUpdateAtom}.
 */
export interface WorktreePinnedUpdate {
  version: number;
  payload: { worktreeId: string; isPinned: boolean };
}

export const worktreePinnedUpdateAtom = atom<WorktreePinnedUpdate | null>(null);

/**
 * The subset of a worktree record that chrome outside the session sidebar needs
 * (the Agent mode header). SessionHistory keeps its own richer cache with git
 * status; this one exists so surfaces that only have a worktree id don't have to
 * re-derive the name or pin state from a component they can't reach.
 */
export interface WorktreeRecord {
  id: string;
  name: string;
  displayName?: string | null;
  path: string;
  isPinned: boolean;
}

/**
 * Worktree records keyed by worktree id. Not persisted — populated on demand by
 * whoever resolves a worktree via `worktree:get`, and patched by the listeners
 * above so every reader stays current.
 */
export const worktreeRecordsAtom = atom<Map<string, WorktreeRecord>>(new Map());

/** Read one worktree record; null until something has resolved it. */
export const worktreeRecordAtom = atomFamily((worktreeId: string) =>
  atom((get) => get(worktreeRecordsAtom).get(worktreeId) ?? null)
);

/** Insert or replace a worktree record. */
export const setWorktreeRecordAtom = atom(null, (get, set, record: WorktreeRecord) => {
  const next = new Map(get(worktreeRecordsAtom));
  next.set(record.id, record);
  set(worktreeRecordsAtom, next);
});

/**
 * Patch a known worktree record. No-ops for unknown worktrees so a broadcast for
 * a worktree this window never resolved doesn't materialize a half-empty record.
 */
export const patchWorktreeRecordAtom = atom(
  null,
  (get, set, { worktreeId, updates }: { worktreeId: string; updates: Partial<Omit<WorktreeRecord, 'id'>> }) => {
    const records = get(worktreeRecordsAtom);
    const existing = records.get(worktreeId);
    if (!existing) return;
    const next = new Map(records);
    next.set(worktreeId, { ...existing, ...updates });
    set(worktreeRecordsAtom, next);
  }
);
