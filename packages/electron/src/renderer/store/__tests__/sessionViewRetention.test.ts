// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import {
  reloadSessionDataAtom, sessionArchivedAtom, sessionLoadedAtom, sessionMessagesAtom,
  sessionProcessingAtom, sessionStoreAtom,
} from '../atoms/sessions';
import { createSessionViewRetention } from '../sessionViewRetention';

const data = (id: string) => ({
  id, workspacePath: '/ws', model: 'claude:test', isArchived: true, title: `Title ${id}`,
  messages: [{ id: 1, text: 'x'.repeat(1000) }],
} as any);

afterEach(() => vi.unstubAllGlobals());

describe('session view retention', () => {
  it('evicts messages beyond the recently viewed sessions, keeping metadata', () => {
    const store = createStore();
    const retention = createSessionViewRetention(store, 1);
    for (const id of ['a', 'b', 'busy', 'unviewed']) store.set(sessionStoreAtom(id), data(id));
    store.set(sessionProcessingAtom('busy'), true);

    const releaseA = retention.acquire('a');
    const releaseB = retention.acquire('b');
    retention.acquire('b')();
    releaseA();
    // 'a' is the one recent session kept; 'b' is still viewed once; the
    // never-viewed session goes; the busy one waits.
    expect(store.get(sessionLoadedAtom('a'))).toBe(true);
    expect(store.get(sessionLoadedAtom('b'))).toBe(true);
    expect(store.get(sessionLoadedAtom('unviewed'))).toBe(false);
    expect(store.get(sessionMessagesAtom('unviewed'))).toHaveLength(0);
    expect(store.get(sessionArchivedAtom('unviewed'))).toBe(true);
    expect(store.get(sessionStoreAtom('unviewed'))?.title).toBe('Title unviewed');
    expect(store.get(sessionLoadedAtom('busy'))).toBe(true);

    releaseB();
    expect(store.get(sessionLoadedAtom('a'))).toBe(false);
    expect(store.get(sessionLoadedAtom('b'))).toBe(true);

    store.set(sessionProcessingAtom('busy'), false);
    retention.sweep();
    expect(store.get(sessionLoadedAtom('busy'))).toBe(false);
  });

  it('background reloads do not load or restore a session no viewer holds', async () => {
    const store = createStore();
    const aiLoadSession = vi.fn(async (id: string) => data(id));
    vi.stubGlobal('window', { electronAPI: { aiLoadSession } });

    await store.set(reloadSessionDataAtom, { sessionId: 'never-loaded', workspacePath: '/ws' });
    expect(store.get(sessionStoreAtom('never-loaded'))).toBeNull();

    store.set(sessionStoreAtom('evicted'), data('evicted'));
    createSessionViewRetention(store, 0).sweep();
    await store.set(reloadSessionDataAtom, { sessionId: 'evicted', workspacePath: '/ws' });
    expect(store.get(sessionLoadedAtom('evicted'))).toBe(false);
    expect(aiLoadSession).not.toHaveBeenCalled();
  });
});
