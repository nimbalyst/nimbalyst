import type { ConversationEvent } from '@nimbalyst/collab-protocol';
import { createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  conversationAtomKey,
  conversationStateAtomFamily,
} from '../../atoms/conversations';
import { initConversationListeners } from '../conversationListeners';

describe('initConversationListeners', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('installs one IPC subscription and routes realtime events to the target atom', () => {
    let listener: ((payload: unknown) => void) | null = null;
    const unsubscribe = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        on: vi.fn((channel: string, next: (payload: unknown) => void) => {
          expect(channel).toBe('conversation:sync-event');
          listener = next;
          return unsubscribe;
        }),
      },
    });
    const targetStore = createStore();
    const cleanup = initConversationListeners(targetStore);
    const event: ConversationEvent = {
      id: 'message-1',
      conversationId: 'conversation-a',
      sequence: 1,
      clientMutationId: 'mutation-1',
      actor: {
        kind: 'user',
        userId: 'member-a',
        onBehalfOfUserId: 'member-a',
      },
      operation: 'messageCreated',
      payload: {
        body: { version: 1, format: 'plainText', text: 'arrived' },
      },
      createdAt: 1,
      serverReceivedAt: 1,
    };

    expect(listener).not.toBeNull();
    const installedListener =
      listener as unknown as (payload: unknown) => void;
    installedListener({
      orgId: 'org-a',
      conversationId: 'conversation-a',
      event: { type: 'event', event },
    });

    const state = targetStore.get(conversationStateAtomFamily(
      conversationAtomKey({
        orgId: 'org-a',
        conversationId: 'conversation-a',
      }),
    ));
    expect(state.events).toEqual([event]);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
