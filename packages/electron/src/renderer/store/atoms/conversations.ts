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

const CONVERSATION_DRAFT_KEY_PREFIX = 'conversationDraft:';
const CONVERSATION_DRAFT_PERSIST_DELAY_MS = 1000;

export interface ConversationDraftSnapshot {
  text: string;
  updatedAt: number;
}

const conversationDraftPersistTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

function sameConversationTarget(
  left: ConversationTarget,
  right: ConversationTarget,
): boolean {
  return (
    left.orgId === right.orgId
    && left.conversationId === right.conversationId
  );
}

function encodeDraftKeyPart(value: string): string {
  // `app-settings` keys use dot notation. Encoding dots too keeps each draft
  // as one opaque top-level key rather than accidentally creating nested
  // settings from an externally supplied org/conversation id.
  return encodeURIComponent(value).replace(/\./g, '%2E');
}

export function conversationDraftStorageKey(target: ConversationTarget): string {
  return `${CONVERSATION_DRAFT_KEY_PREFIX}${encodeDraftKeyPart(target.orgId)}:${encodeDraftKeyPart(target.conversationId)}`;
}

export function parseConversationDraftStorageKey(
  key: string,
): ConversationTarget | null {
  if (!key.startsWith(CONVERSATION_DRAFT_KEY_PREFIX)) return null;
  const encoded = key.slice(CONVERSATION_DRAFT_KEY_PREFIX.length);
  const separator = encoded.indexOf(':');
  if (separator < 0) return null;
  try {
    const orgId = decodeURIComponent(encoded.slice(0, separator));
    const conversationId = decodeURIComponent(encoded.slice(separator + 1));
    return orgId && conversationId ? { orgId, conversationId } : null;
  } catch {
    return null;
  }
}

export function parseConversationDraftSnapshot(
  value: unknown,
): ConversationDraftSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ConversationDraftSnapshot>;
  return (
    typeof candidate.text === 'string'
    && typeof candidate.updatedAt === 'number'
    && Number.isFinite(candidate.updatedAt)
  )
    ? { text: candidate.text, updatedAt: candidate.updatedAt }
    : null;
}

export function conversationAtomKey(target: ConversationTarget): string {
  return JSON.stringify([target.orgId, target.conversationId]);
}

export const conversationStateAtomFamily = atomFamily(
  (_key: string) => atom<ConversationRendererState>(EMPTY_CONVERSATION_STATE),
);

export const conversationNotificationLevelAtomFamily = atomFamily(
  (_target: ConversationTarget) =>
    atom<ConversationSubscription['notificationLevel']>('all'),
  sameConversationTarget,
);

/** Per-conversation composer text, mirroring the AI session draft atom. */
export const conversationDraftInputAtomFamily = atomFamily(
  (_target: ConversationTarget) => atom<string>(''),
  sameConversationTarget,
);

/** Whether the app-settings value has resolved for this conversation. */
export const conversationDraftHydratedAtomFamily = atomFamily(
  (_target: ConversationTarget) => atom<boolean>(false),
  sameConversationTarget,
);

/**
 * Timestamp of the newest local or cross-window draft applied to the atom.
 * A delayed hydration response must never replace text typed after it began.
 */
export const conversationDraftUpdatedAtAtomFamily = atomFamily(
  (_target: ConversationTarget) => atom<number>(0),
  sameConversationTarget,
);

function persistConversationDraft(
  target: ConversationTarget,
  snapshot: ConversationDraftSnapshot,
  flush: boolean,
): void {
  const storageKey = conversationDraftStorageKey(target);
  const existing = conversationDraftPersistTimers.get(storageKey);
  if (existing) clearTimeout(existing);

  const write = () => {
    conversationDraftPersistTimers.delete(storageKey);
    window.electronAPI
      ?.invoke?.('app-settings:set', storageKey, snapshot)
      .catch((error: unknown) => {
        console.error('[conversations] Failed to persist conversation draft:', error);
      });
  };

  if (flush) {
    write();
    return;
  }
  conversationDraftPersistTimers.set(
    storageKey,
    setTimeout(write, CONVERSATION_DRAFT_PERSIST_DELAY_MS),
  );
}

/**
 * Canonical conversation-draft setter: update the atom immediately and save
 * through app-settings after a typing debounce. Successful sends use `flush`
 * so an older non-empty draft cannot return after the optimistic row appears.
 */
export const setConversationDraftInputAtom = atom(
  null,
  (
    get,
    set,
    {
      target,
      text,
      flush = false,
    }: {
      target: ConversationTarget;
      text: string;
      flush?: boolean;
    },
  ) => {
    const updatedAt = Math.max(
      Date.now(),
      get(conversationDraftUpdatedAtAtomFamily(target)) + 1,
    );
    set(conversationDraftInputAtomFamily(target), text);
    set(conversationDraftUpdatedAtAtomFamily(target), updatedAt);
    set(conversationDraftHydratedAtomFamily(target), true);
    persistConversationDraft(target, { text, updatedAt }, flush);
  },
);

/** Load the persisted draft once, without racing text entered during IPC. */
export const hydrateConversationDraftInputAtom = atom(
  null,
  async (get, set, target: ConversationTarget) => {
    if (get(conversationDraftHydratedAtomFamily(target))) return;
    try {
      const value = await window.electronAPI?.invoke?.(
        'app-settings:get',
        conversationDraftStorageKey(target),
      );
      const snapshot = parseConversationDraftSnapshot(value);
      if (
        snapshot
        && snapshot.updatedAt >= get(conversationDraftUpdatedAtAtomFamily(target))
      ) {
        set(conversationDraftInputAtomFamily(target), snapshot.text);
        set(conversationDraftUpdatedAtAtomFamily(target), snapshot.updatedAt);
      }
    } catch (error) {
      console.error('[conversations] Failed to hydrate conversation draft:', error);
    } finally {
      set(conversationDraftHydratedAtomFamily(target), true);
    }
  },
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
