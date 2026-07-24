import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasCollabReplicaPreloadSupport,
  initCollabReplicaListeners,
  subscribeToCollabReplicaLocalUpdates,
} from '../collabReplicaListeners';

const identity = { accountId: 'account', orgId: 'org', documentId: 'doc' };

describe('collabReplicaListeners', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes one central IPC subscription only to the matching replica', () => {
    let ipcListener!: (payload: {
      identity: typeof identity;
      updateId: string;
      update: Uint8Array;
    }) => void;
    const removeIpcListener = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        documentSync: {
          onReplicaLocalUpdate: vi.fn((listener: typeof ipcListener) => {
            ipcListener = listener;
            return removeIpcListener;
          }),
        },
      },
    });
    const matching = vi.fn();
    const other = vi.fn();
    const unsubscribeMatching = subscribeToCollabReplicaLocalUpdates(identity, matching);
    const unsubscribeOther = subscribeToCollabReplicaLocalUpdates(
      { ...identity, documentId: 'other' },
      other,
    );
    const cleanup = initCollabReplicaListeners();

    ipcListener({ identity, updateId: 'local-1', update: new Uint8Array([1, 2]) });
    expect(matching).toHaveBeenCalledWith(new Uint8Array([1, 2]));
    expect(other).not.toHaveBeenCalled();

    unsubscribeMatching();
    unsubscribeOther();
    cleanup();
    expect(removeIpcListener).toHaveBeenCalledOnce();
  });

  it('does not crash when a hot-reloaded renderer is paired with an older preload', () => {
    vi.stubGlobal('window', {
      electronAPI: {
        documentSync: {},
      },
    });

    expect(() => initCollabReplicaListeners()).not.toThrow();
    expect(initCollabReplicaListeners()).toEqual(expect.any(Function));
    expect(hasCollabReplicaPreloadSupport()).toBe(false);
  });

  it('enables the replica path only when the complete preload contract is present', () => {
    vi.stubGlobal('window', {
      electronAPI: {
        documentSync: new Proxy({}, { get: () => vi.fn() }),
      },
    });

    expect(hasCollabReplicaPreloadSupport()).toBe(true);
  });
});
