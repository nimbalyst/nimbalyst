// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import { toggleWorkstreamHeaderPin } from '../workstreamHeaderPin';
import {
  patchWorktreeRecordAtom,
  setWorktreeRecordAtom,
  worktreeRecordAtom,
} from '../../../store/atoms/worktrees';

function harness() {
  return {
    invoke: vi.fn().mockResolvedValue({ success: true }),
    patchWorktreeRecord: vi.fn(),
    updateSessionStore: vi.fn(),
    publishSessionPinnedUpdate: vi.fn(),
  };
}

describe('toggleWorkstreamHeaderPin', () => {
  it('pins a worktree on the worktree record, never on its root session', async () => {
    const h = harness();
    await toggleWorkstreamHeaderPin({
      workstreamId: 'session-1',
      worktreeId: 'worktree-1',
      isPinned: true,
      ...h,
    });

    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('worktree:update-pinned', 'worktree-1', true);
    expect(h.patchWorktreeRecord).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      updates: { isPinned: true },
    });
    // Pinning the worktree must not also pin the session behind it — the
    // sidebar renders one row for the worktree and would show a stale pin.
    expect(h.updateSessionStore).not.toHaveBeenCalled();
    expect(h.publishSessionPinnedUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['a workstream parent', 'workstream-1'],
    ['a solo session', 'session-9'],
  ])('pins %s on the session record and tells the sidebar', async (_label, workstreamId) => {
    const h = harness();
    await toggleWorkstreamHeaderPin({ workstreamId, worktreeId: null, isPinned: true, ...h });

    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('sessions:update-pinned', workstreamId, true);
    expect(h.updateSessionStore).toHaveBeenCalledWith({
      sessionId: workstreamId,
      updates: { isPinned: true },
    });
    // The session sidebar renders from local list state, so without this
    // publish its row keeps the old pin until the next full refresh.
    expect(h.publishSessionPinnedUpdate).toHaveBeenCalledWith({ sessionId: workstreamId, isPinned: true });
    expect(h.patchWorktreeRecord).not.toHaveBeenCalled();
  });

  it('unpins through the same route', async () => {
    const h = harness();
    await toggleWorkstreamHeaderPin({
      workstreamId: 'session-1',
      worktreeId: 'worktree-1',
      isPinned: false,
      ...h,
    });

    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('worktree:update-pinned', 'worktree-1', false);
    expect(h.patchWorktreeRecord).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      updates: { isPinned: false },
    });
  });

  it('does not report success optimistically when the IPC call fails', async () => {
    const h = harness();
    h.invoke.mockRejectedValue(new Error('db down'));

    await expect(
      toggleWorkstreamHeaderPin({ workstreamId: 'session-1', worktreeId: null, isPinned: true, ...h })
    ).rejects.toThrow('db down');

    expect(h.updateSessionStore).not.toHaveBeenCalled();
    expect(h.publishSessionPinnedUpdate).not.toHaveBeenCalled();
  });
});

describe('worktree record cache', () => {
  it('ignores a pin broadcast for a worktree this window never resolved', () => {
    const store = createStore();

    store.set(patchWorktreeRecordAtom, { worktreeId: 'unseen', updates: { isPinned: true } });

    // A half-empty record would satisfy the header's "already resolved" guard,
    // so worktree:get would never run and the name chip would stay blank.
    expect(store.get(worktreeRecordAtom('unseen'))).toBeNull();
  });

  it('patches a resolved record without dropping the rest of it', () => {
    const store = createStore();
    store.set(setWorktreeRecordAtom, {
      id: 'wt-1',
      name: 'endless-spruce',
      displayName: 'Test cleanup',
      path: '/tmp/wt-1',
      isPinned: false,
    });

    store.set(patchWorktreeRecordAtom, { worktreeId: 'wt-1', updates: { isPinned: true } });

    expect(store.get(worktreeRecordAtom('wt-1'))).toEqual({
      id: 'wt-1',
      name: 'endless-spruce',
      displayName: 'Test cleanup',
      path: '/tmp/wt-1',
      isPinned: true,
    });
  });
});
