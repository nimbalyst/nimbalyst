import { createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationDirectoryEntry } from '../../../../shared/conversationDirectory';
import {
  conversationDirectoryAtomFamily,
  conversationDirectoryLoadStateAtomFamily,
  conversationMembershipsByIdAtomFamily,
  conversationNotificationLevelAtomFamily,
  conversationParticipantsByIdAtomFamily,
} from '../../atoms/conversations';
import {
  applyConversationDescriptor,
  initConversationDirectoryListeners,
  markConversationNotificationLevelChanged,
  refreshConversationDirectory,
  refreshConversationMembers,
} from '../conversationDirectoryListeners';

const general: ConversationDirectoryEntry = {
  id: 'general',
  orgId: 'org-a',
  kind: 'orgRoom',
  visibility: 'public',
  title: 'General',
  agentPostingEnabled: false,
  createdByUserId: 'member-a',
  createdAt: 1,
  capabilities: ['read', 'comment'],
};

describe('conversation directory listeners', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hydrates an explicit org and refreshes it after the central push event', async () => {
    let changedListener: ((payload: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const invoke = vi.fn(async (
      channel: string,
      request: { orgId: string },
    ) => {
      expect(channel).toBe('conversation:directory:list');
      expect(request).toEqual({ orgId: 'org-a' });
      return [
        general,
        {
          ...general,
          id: 'dm-1',
          kind: 'dm',
          visibility: 'private',
          title: undefined,
          participants: [
            { userId: 'member-a', role: 'member', email: 'greg@example.com' },
            { userId: 'member-b', role: 'member', email: 'karl@example.com' },
          ],
        },
        {
          ...general,
          id: 'not-readable',
          capabilities: ['manageRoom'],
        },
      ];
    });
    vi.stubGlobal('window', {
      electronAPI: {
        invoke,
        on: vi.fn((
          channel: string,
          listener: (payload: unknown) => void,
        ) => {
          expect(channel).toMatch(
            /^conversation:(directory-changed|descriptor-updated)$/,
          );
          if (channel === 'conversation:directory-changed') {
            changedListener = listener;
          }
          return unsubscribe;
        }),
      },
    });

    const targetStore = createStore();
    const cleanup = initConversationDirectoryListeners(targetStore);

    changedListener?.({ orgId: 'org-a' });
    expect(invoke).not.toHaveBeenCalled();

    await refreshConversationDirectory('org-a', targetStore);

    expect(targetStore.get(conversationDirectoryAtomFamily('org-a')))
      .toEqual([
        general,
        expect.objectContaining({ id: 'dm-1' }),
      ]);
    expect(targetStore.get(conversationParticipantsByIdAtomFamily('org-a')))
      .toEqual({
        'dm-1': ['member-a', 'member-b'],
      });
    expect(targetStore.get(
      conversationDirectoryLoadStateAtomFamily('org-a'),
    )).toEqual({ status: 'ready' });

    changedListener?.({ orgId: 'org-a' });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));

    cleanup();
    // Both the invalidation and the descriptor subscription are released.
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('ignores a directory read that resolves after an authoritative descriptor', async () => {
    const releases: Array<(entries: ConversationDirectoryEntry[]) => void> = [];
    const invoke = vi.fn(() => new Promise((resolve) => {
      releases.push(resolve as (entries: ConversationDirectoryEntry[]) => void);
    }));
    vi.stubGlobal('window', { electronAPI: { invoke, on: vi.fn(() => vi.fn()) } });

    const targetStore = createStore();
    const design = { ...general, id: 'design', title: 'Design' };
    const first = refreshConversationDirectory('org-c', targetStore);
    releases[0]?.([
      { ...general, orgId: 'org-c' },
      { ...design, orgId: 'org-c' },
    ]);
    await first;

    // A second read starts, then #design is archived elsewhere and the
    // authoritative broadcast lands before that read answers.
    const stale = refreshConversationDirectory('org-c', targetStore);
    applyConversationDescriptor({
      orgId: 'org-c',
      descriptor: { ...design, orgId: 'org-c', archivedAt: 99 },
    }, targetStore);
    expect(targetStore.get(conversationDirectoryAtomFamily('org-c'))
      .map((entry) => entry.id)).toEqual(['general']);

    releases[1]?.([
      { ...general, orgId: 'org-c' },
      { ...design, orgId: 'org-c' },
    ]);
    await stale;

    // The stale response must not resurrect the archived room.
    expect(targetStore.get(conversationDirectoryAtomFamily('org-c'))
      .map((entry) => entry.id)).toEqual(['general']);
  });

  // The org window re-reads the directory on every focus gain. Announcing
  // "loading" and handing back structurally identical rows under fresh object
  // identities repainted the whole sidebar each time the window came forward.
  it('revalidates a loaded directory without a loading flip or new identities', async () => {
    const invoke = vi.fn(async () => [
      { ...general, orgId: 'org-f' },
      { ...general, orgId: 'org-f', id: 'design', title: 'Design' },
    ]);
    vi.stubGlobal('window', { electronAPI: { invoke, on: vi.fn(() => vi.fn()) } });

    const targetStore = createStore();
    const directoryAtom = conversationDirectoryAtomFamily('org-f');
    const loadStateAtom = conversationDirectoryLoadStateAtomFamily('org-f');
    await refreshConversationDirectory('org-f', targetStore);

    const entries = targetStore.get(directoryAtom);
    const loadState = targetStore.get(loadStateAtom);
    const statuses: string[] = [];
    const unsubscribe = targetStore.sub(loadStateAtom, () => {
      statuses.push(targetStore.get(loadStateAtom).status);
    });
    let directoryWrites = 0;
    const unsubscribeDirectory = targetStore.sub(directoryAtom, () => {
      directoryWrites += 1;
    });

    await refreshConversationDirectory('org-f', targetStore);
    unsubscribe();
    unsubscribeDirectory();

    expect(statuses).toEqual([]);
    expect(directoryWrites).toBe(0);
    expect(targetStore.get(directoryAtom)).toBe(entries);
    expect(targetStore.get(directoryAtom)[0]).toBe(entries[0]);
    expect(targetStore.get(loadStateAtom)).toBe(loadState);
  });

  // Only the row that actually moved may lose its identity.
  it('keeps unchanged rows identical when one row changes', async () => {
    let title = 'Design';
    const invoke = vi.fn(async () => [
      { ...general, orgId: 'org-g' },
      { ...general, orgId: 'org-g', id: 'design', title },
    ]);
    vi.stubGlobal('window', { electronAPI: { invoke, on: vi.fn(() => vi.fn()) } });

    const targetStore = createStore();
    const directoryAtom = conversationDirectoryAtomFamily('org-g');
    await refreshConversationDirectory('org-g', targetStore);
    const entries = targetStore.get(directoryAtom);

    title = 'Design review';
    await refreshConversationDirectory('org-g', targetStore);

    const updated = targetStore.get(directoryAtom);
    expect(updated).not.toBe(entries);
    expect(updated[0]).toBe(entries[0]);
    expect(updated[1]).not.toBe(entries[1]);
    expect(updated[1].title).toBe('Design review');
  });

  it('applies a descriptor broadcast onto the listed row, keeping its capabilities', () => {
    const targetStore = createStore();
    targetStore.set(conversationDirectoryLoadStateAtomFamily('org-d'), {
      status: 'ready',
    });
    targetStore.set(conversationDirectoryAtomFamily('org-d'), [
      { ...general, orgId: 'org-d' },
    ]);

    applyConversationDescriptor({
      orgId: 'org-d',
      descriptor: {
        ...general,
        orgId: 'org-d',
        title: 'General chat',
        topic: 'Everything else',
      },
    }, targetStore);

    expect(targetStore.get(conversationDirectoryAtomFamily('org-d')))
      .toEqual([expect.objectContaining({
        id: 'general',
        title: 'General chat',
        topic: 'Everything else',
        capabilities: ['read', 'comment'],
      })]);
  });

  it('hydrates the notification bell from the caller subscription without undoing a local change', async () => {
    const releases: Array<(entries: ConversationDirectoryEntry[]) => void> = [];
    const invoke = vi.fn(() => new Promise((resolve) => {
      releases.push(resolve as (entries: ConversationDirectoryEntry[]) => void);
    }));
    vi.stubGlobal('window', { electronAPI: { invoke, on: vi.fn(() => vi.fn()) } });

    const targetStore = createStore();
    const target = { orgId: 'org-e', conversationId: 'general' };
    const levelAtom = conversationNotificationLevelAtomFamily(target);
    expect(targetStore.get(levelAtom)).toBe('all');

    const first = refreshConversationDirectory('org-e', targetStore);
    releases[0]?.([{
      ...general,
      orgId: 'org-e',
      subscription: { state: 'following', notificationLevel: 'mentions' },
    }]);
    await first;
    expect(targetStore.get(levelAtom)).toBe('mentions');

    // A read is in flight when the user picks a level in the room header.
    const stale = refreshConversationDirectory('org-e', targetStore);
    markConversationNotificationLevelChanged(target);
    targetStore.set(levelAtom, 'none');
    releases[1]?.([{
      ...general,
      orgId: 'org-e',
      subscription: { state: 'following', notificationLevel: 'mentions' },
    }]);
    await stale;

    expect(targetStore.get(levelAtom)).toBe('none');
  });

  it('hydrates only the explicitly opened conversation membership list', async () => {
    const invoke = vi.fn(async (
      channel: string,
      request: { orgId: string; conversationId: string },
    ) => {
      expect(channel).toBe('conversation:directory:list-members');
      expect(request).toEqual({
        orgId: 'org-a',
        conversationId: 'private-room',
      });
      return {
        memberships: [{
          conversationId: 'private-room',
          userId: 'member-a',
          role: 'roomAdmin',
          addedByUserId: 'member-a',
          createdAt: 1,
        }],
      };
    });
    vi.stubGlobal('window', {
      electronAPI: { invoke },
    });
    const targetStore = createStore();

    await refreshConversationMembers(
      { orgId: 'org-a', conversationId: 'private-room' },
      targetStore,
    );

    expect(targetStore.get(conversationMembershipsByIdAtomFamily('org-a')))
      .toEqual({
        'private-room': [
          expect.objectContaining({
            userId: 'member-a',
            role: 'roomAdmin',
          }),
        ],
      });
    expect(invoke).toHaveBeenCalledOnce();
  });
});
