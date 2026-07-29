import type { ConversationEvent } from '@nimbalyst/collab-protocol';
import type {
  ConversationSyncEvent,
  ConversationTarget,
} from '@nimbalyst/runtime/sync';
import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

export type ConversationConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface ConversationRendererState {
  events: ConversationEvent[];
  status: ConversationConnectionStatus;
  error?: { code: string; message: string };
}

export type ConversationSyncIpcEvent = ConversationTarget & {
  event: ConversationSyncEvent;
};

const EMPTY_CONVERSATION_STATE: ConversationRendererState = {
  events: [],
  status: 'idle',
};

export function conversationAtomKey(target: ConversationTarget): string {
  return JSON.stringify([target.orgId, target.conversationId]);
}

export const conversationStateAtomFamily = atomFamily(
  (_key: string) => atom<ConversationRendererState>(EMPTY_CONVERSATION_STATE),
);

export function mergeConversationEvents(
  current: readonly ConversationEvent[],
  incoming: readonly ConversationEvent[],
): ConversationEvent[] {
  if (incoming.length === 0) return current as ConversationEvent[];
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort(
    (left, right) =>
      left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
}
