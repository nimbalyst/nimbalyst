// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import {
  loadSessionDataAtom, reloadSessionDataAtom, sessionStoreAtom, sessionMessagesAtom,
  sessionDraftInputAtom, sessionProcessingAtom, sessionHasPendingInteractivePromptAtom,
  setSessionWorkspaceOpenAtom, pruneClosedSessionDataAtom,
} from '../sessions';

const data = (id: string, workspacePath = '/closed') => ({
  id, workspacePath, model: 'claude:test', messages: [{ id: 1, text: 'saved transcript' }],
} as any);
const deferred = () => {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(done => { resolve = done; });
  return { promise, resolve };
};

afterEach(() => vi.unstubAllGlobals());

describe('closed project conversation cache', () => {
  it('releases history and derived messages, preserving drafts, other projects and active work', () => {
    const store = createStore();
    for (const id of ['idle', 'running', 'waiting']) store.set(sessionStoreAtom(id), data(id));
    store.set(sessionStoreAtom('other'), data('other', '/open'));
    store.set(sessionDraftInputAtom('idle'), 'unsaved draft');
    store.set(sessionProcessingAtom('running'), true);
    store.set(sessionHasPendingInteractivePromptAtom('waiting'), true);
    expect(store.get(sessionMessagesAtom('idle'))).toHaveLength(1);
    store.set(setSessionWorkspaceOpenAtom, { workspacePath: '/closed', isOpen: false });
    expect(store.get(sessionStoreAtom('idle'))).toBeNull();
    expect(store.get(sessionMessagesAtom('idle'))).toHaveLength(0);
    expect(store.get(sessionDraftInputAtom('idle'))).toBe('unsaved draft');
    for (const id of ['running', 'waiting', 'other']) expect(store.get(sessionStoreAtom(id))).not.toBeNull();
    store.set(sessionProcessingAtom('running'), false);
    store.set(sessionHasPendingInteractivePromptAtom('waiting'), false);
    store.set(pruneClosedSessionDataAtom);
    expect(store.get(sessionStoreAtom('running'))).toBeNull();
    expect(store.get(sessionStoreAtom('waiting'))).toBeNull();
    store.set(setSessionWorkspaceOpenAtom, { workspacePath: '/closed', isOpen: true });
    store.set(sessionStoreAtom('idle'), data('idle'));
    expect(store.get(sessionMessagesAtom('idle'))).toHaveLength(1);
  });

  it.each([loadSessionDataAtom, reloadSessionDataAtom])('does not restore a closed history after its active turn finishes', async (loadAtom) => {
    const store = createStore();
    const response = deferred();
    vi.stubGlobal('window', { electronAPI: { aiLoadSession: vi.fn(() => response.promise) } });
    const sessionId = 'finishing';
    store.set(sessionProcessingAtom(sessionId), true);
    store.set(setSessionWorkspaceOpenAtom, { workspacePath: '/closed', isOpen: false });
    const loading = store.set(loadAtom, { sessionId, workspacePath: '/closed' });
    store.set(sessionProcessingAtom(sessionId), false);
    store.set(pruneClosedSessionDataAtom);
    response.resolve(data(sessionId));
    await loading;
    expect(store.get(sessionStoreAtom(sessionId))).toBeNull();
  });

  // reloadSessionDataAtom only refreshes resident data, and close releases it.
  it.each([loadSessionDataAtom])('rejects obsolete loads across close and reopen', async (loadAtom) => {
    const store = createStore();
    const old = deferred();
    const fresh = deferred();
    const aiLoadSession = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    vi.stubGlobal('window', { electronAPI: { aiLoadSession } });
    const request = { sessionId: 'late', workspacePath: '/closed' };
    const first = store.set(loadAtom, request);
    store.set(setSessionWorkspaceOpenAtom, { workspacePath: '/closed', isOpen: false });
    store.set(setSessionWorkspaceOpenAtom, { workspacePath: '/closed', isOpen: true });
    const second = store.set(loadAtom, request);
    old.resolve(data('late'));
    await first;
    expect(store.get(sessionStoreAtom('late'))).toBeNull();
    fresh.resolve({ ...data('late'), title: 'fresh' });
    await second;
    expect(store.get(sessionStoreAtom('late'))?.title).toBe('fresh');
  });
});
