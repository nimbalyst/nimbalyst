// @vitest-environment node
import { createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionLaunchCountAtom } from '../sessionLaunchCounts';
import { refreshSessionListAtom, sessionListWorkspaceAtom, sessionRegistryAtom } from '../sessions';

afterEach(() => vi.unstubAllGlobals());

describe('session launch count hydration', () => {
  it('retains archived/hidden launch counts through partial child hydration and clears deleted launches on refresh', async () => {
    const store = createStore();
    const invoke = vi.fn().mockResolvedValue({
      success: true, sessions: [{ id: 'coordinator', createdAt: 1, updatedAt: 1 }],
      launchedSessionCounts: { coordinator: 3 },
    });
    vi.stubGlobal('window', { electronAPI: { invoke } });
    store.set(sessionListWorkspaceAtom, '/project');
    await store.set(refreshSessionListAtom);
    expect(store.get(sessionLaunchCountAtom('coordinator'))).toBe(3);
    expect(store.get(sessionLaunchCountAtom('ordinary'))).toBe(0);
    // Child list hydration / view filtering cannot replace the launch projection.
    store.set(sessionRegistryAtom, new Map());
    expect(store.get(sessionLaunchCountAtom('coordinator'))).toBe(3);

    invoke.mockResolvedValueOnce({ success: false, sessions: [] });
    await store.set(refreshSessionListAtom);
    expect(store.get(sessionLaunchCountAtom('coordinator'))).toBe(3);
    invoke.mockResolvedValueOnce({ success: true, sessions: [], launchedSessionCounts: {} });
    await store.set(refreshSessionListAtom);
    expect(store.get(sessionLaunchCountAtom('coordinator'))).toBe(0);
  });

  it('ignores an older response after a newer list load or workspace change', async () => {
    const store = createStore();
    let resolveOld!: (value: unknown) => void;
    const invoke = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue({ success: true, sessions: [], launchedSessionCounts: { current: 1 } });
    vi.stubGlobal('window', { electronAPI: { invoke } });
    store.set(sessionListWorkspaceAtom, '/project');
    const old = store.set(refreshSessionListAtom);
    store.set(sessionListWorkspaceAtom, '/other');
    await store.set(refreshSessionListAtom);
    resolveOld({ success: true, sessions: [], launchedSessionCounts: { stale: 4 } });
    await old;
    expect(store.get(sessionLaunchCountAtom('current'))).toBe(1);
    expect(store.get(sessionLaunchCountAtom('stale'))).toBe(0);
  });
});
