// @vitest-environment jsdom
import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';

import { teamInboxSnapshotAtom } from '../../../../store/atoms/teamInbox';
import { createAtomInboxProvider } from '../inboxProvider';
import { toRowView } from '../inboxViewModel';

describe('createAtomInboxProvider', () => {
  it('maps merged runtime state, exposes custody failures, and routes protocol mutations', async () => {
    const store = createStore();
    const snapshot: TeamInboxSnapshot = {
      status: 'ready',
      deliveries: [{
        id: 'delivery-a',
        recipientUserId: 'member-a',
        orgId: 'org-a',
        orgName: 'Acme',
        createdAt: 100,
        source: {
          orgId: 'org-a',
          sourceKind: 'trackerComment',
          sourceId: 'tracker-a',
          commentId: 'comment-a',
        },
        reason: 'assignment',
        preview: {
          actorLabel: 'Priya',
          sourceTitle: 'NIM-1',
          snippet: 'Please review',
        },
        subscription: 'following',
        hasUnreadActivity: false,
      }],
      organizations: [
        { orgId: 'org-a', orgName: 'Acme', status: 'ready' },
        {
          orgId: 'org-legacy',
          orgName: 'Legacy Co',
          status: 'messagingUnavailable',
          errorCode: 'ORG_SERVER_MANAGED_DEK_REQUIRED',
        },
      ],
    };
    store.set(teamInboxSnapshotAtom, snapshot);
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'team:retry-encryption-migration') {
        return { success: true };
      }
      if (channel === 'deep-link:open-inbox-source') return true;
      return { success: true };
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { invoke },
    });
    const provider = createAtomInboxProvider(store);

    expect(provider.getSnapshot()).toMatchObject({
      status: 'ready',
      deliveries: [{
        id: 'delivery-a',
        orgName: 'Acme',
        reason: 'assignment',
        source: {
          sourceKind: 'trackerComment',
          sourceId: 'tracker-a',
          commentId: 'comment-a',
        },
        actorLabel: 'Priya',
      }],
      unavailableOrganizations: [{
        orgId: 'org-legacy',
        orgName: 'Legacy Co',
      }],
    });

    // A wire delivery without a structured actor gets display-only attribution,
    // never a fabricated Actor with an empty `onBehalfOfUserId`.
    expect(provider.getSnapshot().deliveries[0].actor).toBeUndefined();
    // A provider that cannot change the follow state must not claim it can.
    expect(provider.setSubscriptionState).toBeUndefined();

    await provider.markRead(['delivery-a']);
    await provider.dismiss('delivery-a');
    await provider.migrateOrganization('org-legacy');
    const row = toRowView(provider.getSnapshot().deliveries[0], {
      now: 200,
    });
    await expect(provider.navigate(row)).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledWith(
      'team-inbox:mark-read',
      ['delivery-a'],
    );
    expect(invoke).toHaveBeenCalledWith(
      'team-inbox:dismiss',
      'delivery-a',
    );
    expect(invoke).toHaveBeenCalledWith(
      'team:retry-encryption-migration',
      'org-legacy',
    );
    expect(invoke).toHaveBeenCalledWith('team-inbox:refresh');
    expect(invoke).toHaveBeenCalledWith(
      'deep-link:open-inbox-source',
      expect.stringContaining('nimbalyst://tracker/tracker-a'),
    );
  });

  it('subscribes through the Jotai store', () => {
    const store = createStore();
    const provider = createAtomInboxProvider(store);
    const listener = vi.fn();
    const unsubscribe = provider.subscribe(listener);

    store.set(teamInboxSnapshotAtom, {
      status: 'ready',
      deliveries: [],
      organizations: [],
    });

    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
