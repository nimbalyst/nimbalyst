import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

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

  // The fan-in re-broadcasts the whole snapshot for presence heartbeats and for
  // the read receipts this window's own mark-read round trip produces. Writing
  // a fresh object each time repainted every sidebar row and every inbox row
  // for data that had not moved.
  it('keeps the snapshot identity when a broadcast carries no change', async () => {
    const jotaiStore = createStore();
    let broadcast: ((snapshot: TeamInboxSnapshot) => void) | undefined;
    const ready: TeamInboxSnapshot = {
      ...emptySnapshot,
      status: 'ready',
      deliveries: [{
        id: 'delivery-1',
        orgId: 'org-a',
        orgName: 'Acme',
        teamMemberId: asTeamMemberId('member-1'),
        hasUnreadActivity: true,
        createdAt: 1,
        source: {
          orgId: 'org-a',
          sourceKind: 'roomMessage',
          sourceId: 'general',
          commentId: 'message-1',
        },
      }],
      organizations: [{ orgId: 'org-a', orgName: 'Acme', status: 'ready' }],
    } as TeamInboxSnapshot;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async () => ready),
        on: vi.fn((
          _channel: string,
          listener: (snapshot: TeamInboxSnapshot) => void,
        ) => {
          broadcast = listener;
          return () => {};
        }),
      },
    });

    const cleanup = initTeamInboxListeners(jotaiStore);
    await vi.waitFor(() => {
      expect(jotaiStore.get(teamInboxSnapshotAtom).status).toBe('ready');
    });

    const notified = vi.fn();
    const unsubscribe = jotaiStore.sub(teamInboxSnapshotAtom, notified);
    const first = jotaiStore.get(teamInboxSnapshotAtom);

    // Same data, fresh objects — exactly what crosses IPC on a heartbeat.
    broadcast?.(structuredClone(ready));
    expect(jotaiStore.get(teamInboxSnapshotAtom)).toBe(first);
    expect(notified).not.toHaveBeenCalled();

    // A real change still lands.
    broadcast?.({ ...structuredClone(ready), lastSyncedAt: 99 });
    expect(jotaiStore.get(teamInboxSnapshotAtom).lastSyncedAt).toBe(99);
    expect(notified).toHaveBeenCalledTimes(1);

    unsubscribe();
    cleanup();
  });
});
