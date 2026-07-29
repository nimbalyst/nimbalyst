import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { teamInboxSnapshotAtom } from '../../atoms/teamInbox';
import { initTeamInboxListeners } from '../teamInboxListeners';

const emptySnapshot: TeamInboxSnapshot = {
  status: 'loading',
  deliveries: [],
  organizations: [],
};

describe('initTeamInboxListeners', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('writes startup and broadcast snapshots into the materialized atom store', async () => {
    const jotaiStore = createStore();
    let broadcast:
      | ((snapshot: TeamInboxSnapshot) => void)
      | undefined;
    const started: TeamInboxSnapshot = {
      ...emptySnapshot,
      status: 'ready',
      organizations: [{
        orgId: 'org-a',
        orgName: 'Acme',
        status: 'ready',
      }],
    };
    const updated: TeamInboxSnapshot = {
      ...started,
      lastSyncedAt: 123,
    };
    const unsubscribe = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          expect(channel).toBe('team-inbox:start');
          return started;
        }),
        on: vi.fn((
          channel: string,
          listener: (snapshot: TeamInboxSnapshot) => void,
        ) => {
          expect(channel).toBe('team-inbox:state-changed');
          broadcast = listener;
          return unsubscribe;
        }),
      },
    });

    const cleanup = initTeamInboxListeners(jotaiStore);
    await vi.waitFor(() => {
      expect(jotaiStore.get(teamInboxSnapshotAtom)).toEqual(started);
    });

    broadcast?.(updated);
    expect(jotaiStore.get(teamInboxSnapshotAtom)).toEqual(updated);

    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
