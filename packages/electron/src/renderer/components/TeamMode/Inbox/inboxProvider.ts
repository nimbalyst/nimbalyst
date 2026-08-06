/**
 * The Inbox data seam.
 *
 * The whole surface reads from an `InboxProvider` and nothing else.
 * `createAtomInboxProvider` is the production implementation: it maps the
 * runtime's `TeamInboxSnapshot` (fanned in from every organization's inbox
 * room) onto the renderer's hydrated deliveries and routes mutations over IPC.
 *
 * A provider is supplied through `InboxProviderContext`. When none is present
 * the surface renders its empty state — it never falls back to fixtures. The
 * fixture provider lives in `inboxFixtureProvider.ts` and is imported only by
 * tests and the design-review harness, so no fixture reaches a packaged build.
 */

import type {
  TeamInboxMaterializedDelivery,
  TeamInboxSnapshot,
} from '@nimbalyst/runtime/sync';
import type { Store } from 'jotai/vanilla/store';
import { createContext, useContext } from 'react';

import { teamInboxSnapshotAtom } from '../../../store/atoms/teamInbox';
import type {
  HydratedInboxDelivery,
  InboxRowView,
  InboxSnapshot,
  InboxSourceKind,
  InboxStatus,
} from './inboxTypes';

export interface InboxProvider {
  /** True when conversation rows can hydrate through the real room transport. */
  conversationTransport?: boolean;
  getSnapshot(): InboxSnapshot;
  subscribe(listener: () => void): () => void;
  markRead(deliveryIds: string[]): Promise<void>;
  dismiss(deliveryId: string): Promise<void>;
  /**
   * Optional: only providers that can actually change a conversation
   * subscription implement it. The surface hides the mute control when it is
   * absent rather than offering a button that throws.
   */
  setSubscriptionState?(deliveryId: string, state: 'following' | 'muted'): Promise<void>;
  migrateOrganization(orgId: string): Promise<void>;
  /**
   * Open the delivery's canonical source. Resolves `true` only when the user
   * actually landed there — the caller marks read on `true` and nothing else.
   * Stubbed until deep links are wired.
   */
  navigate(row: InboxRowView): Promise<boolean>;
  /**
   * Set only by the fixture provider. When present, the surface offers a
   * state picker so every list-level client state is reachable for design
   * review. Disappears with the fixtures.
   */
  simulateStatus?(status: InboxStatus): void;
}

const EMPTY_SNAPSHOT: InboxSnapshot = {
  status: 'ready',
  deliveries: [],
};

/**
 * What the surface reads when no provider is mounted above it: an inbox with
 * nothing in it. Production must reach the empty state here, never fixtures.
 */
export const EMPTY_INBOX_PROVIDER: InboxProvider = {
  getSnapshot: () => EMPTY_SNAPSHOT,
  subscribe: () => () => {},
  async markRead() {},
  async dismiss() {},
  async migrateOrganization() {},
  async navigate() {
    return false;
  },
};

/**
 * Activity deliveries name a resource rather than a comment, so they are
 * normalized onto the comment-ref shape the surface renders. Comment refs
 * already speak the protocol's source kinds and pass through untouched.
 */
function activitySourceKind(resourceKind: 'tracker' | 'document'): InboxSourceKind {
  return resourceKind === 'tracker' ? 'trackerComment' : 'documentInlineComment';
}

function mapDelivery(
  delivery: TeamInboxMaterializedDelivery,
): HydratedInboxDelivery {
  const source = delivery.source;
  const unavailable = delivery.unavailable || !source;
  const sourceId = source
    ? 'sourceId' in source ? source.sourceId : source.resourceId
    : '';
  const commentId = source
    ? 'commentId' in source ? source.commentId : source.sourceEventId
    : '';
  const preview = delivery.preview;
  return {
    id: delivery.id,
    recipientUserId: delivery.recipientUserId,
    orgId: delivery.orgId,
    orgName: delivery.orgName,
    source: {
      orgId: delivery.orgId,
      sourceKind: source
        ? 'resourceKind' in source
          ? activitySourceKind(source.resourceKind)
          : source.sourceKind
        : 'roomMessage',
      sourceId,
      commentId,
      ...(
        source
        && 'threadId' in source
        && source.threadId
          ? { threadId: source.threadId }
          : {}
      ),
    },
    reason: delivery.reason ?? 'follow',
    // The server does not stamp a structured actor yet. When it does, its
    // display name still has to come from somewhere the client can resolve —
    // today only the bounded preview's label. An actor is never synthesized;
    // without one the row falls back to display-only attribution.
    ...(delivery.actor && preview?.actorLabel
      ? { actor: { ...delivery.actor, displayName: preview.actorLabel } }
      : {}),
    ...(preview?.actorLabel ? { actorLabel: preview.actorLabel } : {}),
    ...(preview
      ? {
          preview: {
            sourceTitle: preview.sourceTitle,
            snippet: preview.snippet,
            itemType: preview.itemType,
            capturedAt: delivery.createdAt,
          },
        }
      : {}),
    createdAt: delivery.createdAt,
    readAt: delivery.readAt,
    dismissedAt: delivery.dismissedAt,
    availability: unavailable ? 'accessRemoved' : 'available',
    subscription: delivery.subscription,
    hasUnreadActivity: delivery.hasUnreadActivity,
    capabilities: { comment: !unavailable },
  };
}

function mapSnapshot(snapshot: TeamInboxSnapshot): InboxSnapshot {
  return {
    status: snapshot.status,
    deliveries: snapshot.deliveries.map(mapDelivery),
    unavailableOrganizations: snapshot.organizations
      .filter((organization) =>
        organization.status === 'messagingUnavailable'
        && (
          organization.errorCode === 'ORG_SERVER_MANAGED_DEK_REQUIRED'
          || organization.errorCode === 'ORG_SERVER_MANAGED_DEK_MISSING'
        ))
      .map((organization) => ({
        orgId: organization.orgId,
        orgName: organization.orgName,
        errorCode: organization.errorCode as
          | 'ORG_SERVER_MANAGED_DEK_REQUIRED'
          | 'ORG_SERVER_MANAGED_DEK_MISSING',
      })),
    lastSyncedAt: snapshot.lastSyncedAt,
  };
}

function deepLinkForRow(row: InboxRowView): string | null {
  if (!row.sourceKind || !row.sourceId) return null;
  if (row.sourceKind === 'trackerComment') {
    const url = new URL(
      `nimbalyst://tracker/${encodeURIComponent(row.sourceId)}`,
    );
    url.searchParams.set('orgId', row.orgId);
    if (row.commentId) url.searchParams.set('commentId', row.commentId);
    return url.toString();
  }
  if (
    row.sourceKind === 'documentInlineComment'
    || row.sourceKind === 'documentDiscussion'
  ) {
    const url = new URL(
      `nimbalyst://doc/${encodeURIComponent(row.sourceId)}`,
    );
    url.searchParams.set('orgId', row.orgId);
    if (row.threadId) url.searchParams.set('threadId', row.threadId);
    if (row.commentId) url.searchParams.set('commentId', row.commentId);
    return url.toString();
  }
  if (!row.commentId) return null;
  return (
    `nimbalyst://conversation/${encodeURIComponent(row.sourceId)}` +
    `/message/${encodeURIComponent(row.commentId)}`
  );
}

export function createAtomInboxProvider(store: Store): InboxProvider {
  let cachedSource: TeamInboxSnapshot | null = null;
  let cachedSnapshot: InboxSnapshot | null = null;
  const getSnapshot = () => {
    const source = store.get(teamInboxSnapshotAtom);
    if (source !== cachedSource || !cachedSnapshot) {
      cachedSource = source;
      cachedSnapshot = mapSnapshot(source);
    }
    return cachedSnapshot;
  };

  return {
    conversationTransport: true,
    getSnapshot,
    subscribe(listener) {
      return store.sub(teamInboxSnapshotAtom, listener);
    },
    async markRead(deliveryIds) {
      await window.electronAPI.invoke('team-inbox:mark-read', deliveryIds);
    },
    async dismiss(deliveryId) {
      await window.electronAPI.invoke('team-inbox:dismiss', deliveryId);
    },
    // No `setSubscriptionState`: conversation subscription mutations are not
    // reachable from the Inbox yet, so the surface hides the control.
    async migrateOrganization(orgId) {
      const result = await window.electronAPI.invoke(
        'team:retry-encryption-migration',
        orgId,
      ) as { success?: boolean; error?: string } | undefined;
      if (result && result.success === false) {
        throw new Error(result.error ?? 'Organization migration failed');
      }
      await window.electronAPI.invoke('team-inbox:refresh');
    },
    async navigate(row) {
      const deepLink = deepLinkForRow(row);
      if (!deepLink) return false;
      return window.electronAPI.invoke(
        'deep-link:open-inbox-source',
        deepLink,
      ) as Promise<boolean>;
    },
  };
}

export const InboxProviderContext = createContext<InboxProvider | null>(null);

/** Resolve the provider from context, falling back to an empty inbox. */
export function useInboxProvider(fallback?: InboxProvider): InboxProvider {
  return useContext(InboxProviderContext) ?? fallback ?? EMPTY_INBOX_PROVIDER;
}
