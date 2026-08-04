import type {
  ConversationDescriptor,
  ConversationMembership,
} from '@nimbalyst/collab-protocol';
import type {
  ConversationDescriptorUpdatedEvent,
  ConversationDirectoryChangedEvent,
  ConversationDirectoryEntry,
  ConversationDirectoryMembersRequest,
} from '../../../shared/conversationDirectory';
import type { ConversationTarget } from '@nimbalyst/runtime/sync';
import type { Store } from 'jotai/vanilla/store';

import {
  listConversationDirectory,
  listDirectoryConversationMembers,
} from '../../services/conversationDirectoryClient';
// The store singleton, not the `store/index` barrel: components import
// `refreshConversationDirectory` directly, and the barrel would drag every
// renderer atom module in behind it.
import { store } from '@nimbalyst/runtime/store';
import { selectConversationDirectory } from '../conversationDirectoryViewModel';
import {
  conversationDirectoryAtomFamily,
  conversationDirectoryLoadStateAtomFamily,
  conversationMembershipsByIdAtomFamily,
  conversationNotificationLevelAtomFamily,
} from '../atoms/conversations';
import { setIfChanged, setListIfChanged } from './atomRevalidation';
import { createRequestSequence } from './requestSequence';

function isConversationDirectoryChangedEvent(
  value: unknown,
): value is ConversationDirectoryChangedEvent {
  return (
    !!value
    && typeof value === 'object'
    && typeof (value as Partial<ConversationDirectoryChangedEvent>).orgId
      === 'string'
  );
}

function isConversationDescriptorUpdatedEvent(
  value: unknown,
): value is ConversationDescriptorUpdatedEvent {
  const event = value as Partial<ConversationDescriptorUpdatedEvent> | null;
  return (
    !!event
    && typeof event === 'object'
    && typeof event.orgId === 'string'
    && !!event.descriptor
    && typeof event.descriptor.id === 'string'
  );
}

/**
 * Directory reads race their own invalidation: a slow `list` issued before an
 * archive can land after it and resurrect the room. Each read takes a token and
 * drops its result unless it is still the latest; applying a descriptor push
 * bumps the sequence so no earlier read can overwrite it.
 */
const directoryRequests = createRequestSequence();

/**
 * When the user last changed a conversation's notification level in this
 * session, so a directory response that was already in flight cannot undo it.
 * A plain monotonic counter: the values only ever get compared to each other.
 */
let notificationClock = 0;
const notificationChangedAt = new Map<string, number>();

function notificationKey(target: ConversationTarget): string {
  return `${target.orgId}\u0000${target.conversationId}`;
}

/** Called by the room header the moment the user picks a level. */
export function markConversationNotificationLevelChanged(
  target: ConversationTarget,
): void {
  notificationChangedAt.set(notificationKey(target), ++notificationClock);
}

/**
 * Seed the notification bell from the caller's subscription on each directory
 * row. Only a value the server actually supplied is applied (older servers omit
 * `subscription` entirely), and never over a level the user changed after this
 * response was requested.
 */
function hydrateNotificationLevels(
  orgId: string,
  entries: readonly ConversationDirectoryEntry[],
  requestedAt: number,
  targetStore: Store,
): void {
  for (const entry of entries) {
    const level = entry.subscription?.notificationLevel;
    if (!level) continue;
    const target = { orgId, conversationId: entry.id };
    const changedAt = notificationChangedAt.get(notificationKey(target)) ?? 0;
    if (changedAt > requestedAt) continue;
    targetStore.set(conversationNotificationLevelAtomFamily(target), level);
  }
}

/**
 * Load one explicit organization's directory into renderer state.
 *
 * Exported for routed org-window startup. Live mutation broadcasts call the
 * same function, so initial hydration and refresh share one state transition.
 *
 * Stale-while-revalidate: a directory that already loaded keeps showing its
 * rows while the re-read is in flight, and an answer identical to what the
 * atoms hold writes nothing at all. The org window re-reads on every focus
 * gain, so announcing "loading" and replacing the rows with structurally equal
 * copies repainted the sidebar each time the window came forward.
 */
export async function refreshConversationDirectory(
  orgId: string,
  targetStore: Store = store,
): Promise<void> {
  if (!orgId) throw new Error('Conversation directory requires orgId');
  const loadStateAtom = conversationDirectoryLoadStateAtomFamily(orgId);
  const token = directoryRequests.next(orgId);
  const requestedAt = notificationClock;
  if (targetStore.get(loadStateAtom).status !== 'ready') {
    setIfChanged(targetStore, loadStateAtom, { status: 'loading' });
  }
  try {
    const conversations = await listConversationDirectory({ orgId });
    // Superseded while in flight: a newer read or an authoritative descriptor
    // push already wrote this org's state, and this response is older than it.
    if (!directoryRequests.isLatest(orgId, token)) return;
    const entries = selectConversationDirectory(conversations, { orgId });
    setListIfChanged(targetStore, conversationDirectoryAtomFamily(orgId), entries);
    hydrateNotificationLevels(orgId, entries, requestedAt, targetStore);
    setIfChanged(targetStore, loadStateAtom, { status: 'ready' });
  } catch (error) {
    if (directoryRequests.isLatest(orgId, token)) {
      setIfChanged(targetStore, loadStateAtom, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

/**
 * Apply one authoritative descriptor from a team-sync broadcast.
 *
 * Only a row the directory already holds is updated: the descriptor carries no
 * capabilities, so a conversation this client has never listed cannot be
 * synthesized into a readable row — that case re-reads the directory instead.
 * An archived descriptor drops out, since the atom holds unarchived rows.
 */
export function applyConversationDescriptor(
  event: ConversationDescriptorUpdatedEvent,
  targetStore: Store = store,
): void {
  const { orgId, descriptor } = event;
  const directoryAtom = conversationDirectoryAtomFamily(orgId);
  const current = targetStore.get(directoryAtom);
  const existing = current.find((entry) => entry.id === descriptor.id);
  if (!existing) {
    if (
      targetStore.get(conversationDirectoryLoadStateAtomFamily(orgId)).status
        === 'idle'
    ) {
      return;
    }
    void refreshConversationDirectory(orgId, targetStore).catch((error) => {
      console.error(
        `[ConversationDirectory] Failed to refresh ${orgId}:`,
        error,
      );
    });
    return;
  }
  // Authoritative: invalidate every read that was already in flight.
  directoryRequests.bump(orgId);
  const merged: ConversationDirectoryEntry = {
    ...existing,
    ...stripUndefined(descriptor),
    archivedAt: descriptor.archivedAt,
    capabilities: existing.capabilities,
  };
  setListIfChanged(
    targetStore,
    directoryAtom,
    merged.archivedAt !== undefined
      ? current.filter((entry) => entry.id !== descriptor.id)
      : current.map((entry) => (entry.id === descriptor.id ? merged : entry)),
  );
}

/**
 * An older server omits `topic` or `participants` from a broadcast it does
 * populate on the listing; spreading those absent keys would blank the row.
 */
function stripUndefined(
  descriptor: ConversationDescriptor,
): Partial<ConversationDescriptor> {
  return Object.fromEntries(
    Object.entries(descriptor).filter(([, value]) => value !== undefined),
  ) as Partial<ConversationDescriptor>;
}

export function setConversationMemberships(
  request: ConversationDirectoryMembersRequest,
  memberships: readonly ConversationMembership[],
  targetStore: Store = store,
): void {
  const membershipsAtom = conversationMembershipsByIdAtomFamily(request.orgId);
  targetStore.set(membershipsAtom, {
    ...targetStore.get(membershipsAtom),
    [request.conversationId]: [...memberships],
  });
}

/**
 * Load only the conversation the user opened. DM labels use the lean directory
 * identities instead, so this never fans out into one request per DM.
 */
export async function refreshConversationMembers(
  request: ConversationDirectoryMembersRequest,
  targetStore: Store = store,
): Promise<void> {
  if (!request.orgId || !request.conversationId) {
    throw new Error('Conversation members require organization and conversation ids');
  }
  const result = await listDirectoryConversationMembers(request);
  setConversationMemberships(request, result.memberships, targetStore);
}

/**
 * Installs the renderer-wide directory invalidation subscription.
 * Components only read atoms and request explicit org-scoped refreshes.
 */
export function initConversationDirectoryListeners(
  targetStore: Store = store,
): () => void {
  const offChanged = window.electronAPI.on(
    'conversation:directory-changed',
    (payload: unknown) => {
      if (!isConversationDirectoryChangedEvent(payload)) return;
      if (
        targetStore.get(
          conversationDirectoryLoadStateAtomFamily(payload.orgId),
        ).status === 'idle'
      ) {
        return;
      }
      void refreshConversationDirectory(payload.orgId, targetStore).catch(
        (error) => {
          console.error(
            `[ConversationDirectory] Failed to refresh ${payload.orgId}:`,
            error,
          );
        },
      );
    },
  );
  const offDescriptor = window.electronAPI.on(
    'conversation:descriptor-updated',
    (payload: unknown) => {
      if (!isConversationDescriptorUpdatedEvent(payload)) return;
      applyConversationDescriptor(payload, targetStore);
    },
  );
  return () => {
    offChanged();
    offDescriptor();
  };
}
