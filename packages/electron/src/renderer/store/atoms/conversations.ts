import type {
  ConversationEvent,
  ConversationMembership,
  ConversationSubscription,
} from '@nimbalyst/collab-protocol';
import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import type {
  ConversationSyncEvent,
  ConversationTarget,
} from '@nimbalyst/runtime/sync';
import { atom } from 'jotai';

import { atomFamily } from '../debug/atomFamilyRegistry';

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

export type ConversationDirectoryStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error';

export interface ConversationDirectoryLoadState {
  status: ConversationDirectoryStatus;
  error?: string;
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

export const conversationNotificationLevelAtomFamily = atomFamily(
  (_target: ConversationTarget) =>
    atom<ConversationSubscription['notificationLevel']>('all'),
  (left, right) => (
    left.orgId === right.orgId
    && left.conversationId === right.conversationId
  ),
);

export const conversationDirectoryAtomFamily = atomFamily(
  (_orgId: string) => atom<ConversationDirectoryEntry[]>([]),
);

/**
 * Direct-message participant ids already carried by the directory response.
 *
 * Keeping this derived from the directory atom makes the listing the sole
 * source of truth and avoids one membership request per DM.
 */
export const conversationParticipantsByIdAtomFamily = atomFamily(
  (orgId: string) => atom((get) => Object.fromEntries(
    get(conversationDirectoryAtomFamily(orgId))
      .filter((entry) => entry.kind === 'dm' && entry.participants)
      .map((entry) => [
        entry.id,
        entry.participants!.map((participant) => participant.userId),
      ]),
  )),
);

export const conversationMembershipsByIdAtomFamily = atomFamily(
  (_orgId: string) =>
    atom<Readonly<Record<string, readonly ConversationMembership[]>>>({}),
);

export const conversationDirectoryLoadStateAtomFamily = atomFamily(
  (_orgId: string) => atom<ConversationDirectoryLoadState>({ status: 'idle' }),
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
