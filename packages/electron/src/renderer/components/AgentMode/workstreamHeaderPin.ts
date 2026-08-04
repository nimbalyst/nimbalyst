/**
 * Pin routing for the Agent mode workstream header.
 *
 * A workstream can be a worktree, a workstream parent, or a solo session, and
 * pin state lives in a different place for each: worktrees carry it on the
 * worktree record, everything else on the session record. Extracted from the
 * header component so the routing is testable without rendering it.
 */

interface ToggleWorkstreamHeaderPinOptions {
  /** Session id of the workstream (the root session, not the active child). */
  workstreamId: string;
  /** Worktree id when this workstream is a worktree. */
  worktreeId?: string | null;
  /** The pin state to move to. */
  isPinned: boolean;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  /** Optimistic patch so the button flips before main's broadcast lands. */
  patchWorktreeRecord: (payload: { worktreeId: string; updates: { isPinned: boolean } }) => void;
  updateSessionStore: (payload: { sessionId: string; updates: { isPinned: boolean } }) => void;
  /** Tells the session sidebar, which renders from its own list state. */
  publishSessionPinnedUpdate: (payload: { sessionId: string; isPinned: boolean }) => void;
}

export async function toggleWorkstreamHeaderPin({
  workstreamId,
  worktreeId,
  isPinned,
  invoke,
  patchWorktreeRecord,
  updateSessionStore,
  publishSessionPinnedUpdate,
}: ToggleWorkstreamHeaderPinOptions): Promise<void> {
  if (worktreeId) {
    await invoke('worktree:update-pinned', worktreeId, isPinned);
    patchWorktreeRecord({ worktreeId, updates: { isPinned } });
    return;
  }

  await invoke('sessions:update-pinned', workstreamId, isPinned);
  updateSessionStore({ sessionId: workstreamId, updates: { isPinned } });
  publishSessionPinnedUpdate({ sessionId: workstreamId, isPinned });
}
