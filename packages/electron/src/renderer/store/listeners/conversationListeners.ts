import type { Store } from 'jotai/vanilla/store';

import { store } from '..';
import {
  conversationAtomKey,
  conversationStateAtomFamily,
  mergeConversationEvents,
  type ConversationSyncIpcEvent,
} from '../atoms/conversations';

function isConversationSyncIpcEvent(
  value: unknown,
): value is ConversationSyncIpcEvent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ConversationSyncIpcEvent>;
  return (
    typeof candidate.orgId === 'string'
    && typeof candidate.conversationId === 'string'
    && !!candidate.event
    && typeof candidate.event.type === 'string'
  );
}

/**
 * Installs the one renderer-wide ConversationRoom event subscription.
 * Components and adapters observe the atom family, never Electron IPC.
 */
export function initConversationListeners(
  targetStore: Store = store,
): () => void {
  return window.electronAPI.on(
    'conversation:sync-event',
    (payload: unknown) => {
      if (!isConversationSyncIpcEvent(payload)) return;
      const key = conversationAtomKey(payload);
      const stateAtom = conversationStateAtomFamily(key);
      const current = targetStore.get(stateAtom);
      switch (payload.event.type) {
        case 'connecting':
          targetStore.set(stateAtom, {
            ...current,
            status: 'connecting',
            error: undefined,
          });
          break;
        case 'connected':
          targetStore.set(stateAtom, {
            ...current,
            status: 'connected',
            error: undefined,
          });
          break;
        case 'event':
          targetStore.set(stateAtom, {
            ...current,
            events: mergeConversationEvents(
              current.events,
              [payload.event.event],
            ),
          });
          break;
        case 'disconnected':
          targetStore.set(stateAtom, {
            ...current,
            status: 'disconnected',
          });
          break;
        case 'error':
          targetStore.set(stateAtom, {
            ...current,
            status: 'error',
            error: {
              code: payload.event.code,
              message: payload.event.message,
            },
          });
          break;
      }
    },
  );
}
