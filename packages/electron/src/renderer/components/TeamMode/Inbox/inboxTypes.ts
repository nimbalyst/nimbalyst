/**
 * Renderer-local view-model types for the messaging Inbox.
 *
 * The wire contracts live in `@nimbalyst/collab-protocol` and are re-exported
 * here rather than restated: `HydratedInboxDelivery` is the protocol's
 * `InboxDelivery` plus the fields only a hydrated renderer row needs (org and
 * project display names, availability, capabilities). There is exactly one
 * spelling of a source kind or a delivery reason in the app, and it is the
 * protocol's camelCase one.
 *
 * The split that matters for correctness:
 *
 *   HydratedInboxDelivery — the stored/hydrated record. May still carry a
 *                    bounded preview for a source the recipient can no longer
 *                    read.
 *   InboxRowView   — what the UI is allowed to render. `toRowView` redacts.
 *
 * Nothing in the component tree may read a `HydratedInboxDelivery` field
 * directly.
 */

import type {
  Actor,
  BoundedPreview,
  CommentRef,
  InboxDelivery,
} from '@nimbalyst/collab-protocol';

/** Delivery reason, in the precedence order the router applies. */
export type InboxDeliveryReason = InboxDelivery['reason'];

/** Which canonical source owns the thing this delivery points at. */
export type InboxSourceKind = CommentRef['sourceKind'];

/** Pointer to the canonical comment. Never a copy of it. */
export type InboxCommentRef = CommentRef;

/**
 * The protocol actor plus the names resolved at hydration time for display.
 * `kind: 'agent'` carries the authoring session; the human who authorized it is
 * always in `onBehalfOfUserId` (server-stamped from the JWT).
 */
export interface InboxActor extends Actor {
  /** Resolved at hydration time for display. */
  displayName: string;
  /** Owner's display name, for the "for {owner}" agent attribution. */
  onBehalfOfDisplayName?: string;
}

/** Bounded convenience copy. Never authoritative; may be stale offline. */
export interface InboxBoundedPreview extends BoundedPreview {
  capturedAt: number;
}

/**
 * What kind of thing a row points at, as the row is allowed to show it.
 *
 * This is the row's primary identity — it answers "what am I about to click"
 * before the reason does. A tracker delivery resolves all the way down to the
 * item type when the delivery carried one, so a bug reads as a bug.
 */
export interface InboxTypeIdentity {
  /** Material symbol name. */
  icon: string;
  /** Accent color for the icon and label. A CSS variable or a hex value. */
  accent: string;
  /** Short word the row leads with, e.g. `BUG`, `ROOM`, `DIRECT`. */
  label: string;
}

/**
 * Result of rechecking source access at hydration time.
 * - `accessRemoved` — the recipient lost access. Reveal nothing.
 * - `deletedSource` — the recipient was authorized; the source is gone.
 */
export type InboxAvailability = 'available' | 'accessRemoved' | 'deletedSource';

/** Personal follow state for the delivery's conversation. */
export type InboxSubscriptionState = 'following' | 'muted';

/** Dispatch state of an `agentMention` delivery owned by this user. */
export type InboxAgentDispatchState = 'pending' | 'dispatched';

export interface HydratedInboxDelivery
  extends Omit<InboxDelivery, 'source' | 'actor' | 'preview'> {
  orgName: string;
  projectId?: string;
  projectName?: string;
  /**
   * Deliveries whose source is an `ActivityRef` are normalized to a comment ref
   * at hydration time, so the surface has one shape to render.
   */
  source: InboxCommentRef;
  /**
   * Structured author, when the server supplied one. Absent deliveries fall
   * back to `actorLabel`; nothing here may be fabricated.
   */
  actor?: InboxActor;
  /** Display-only attribution used when there is no structured actor. */
  actorLabel?: string;
  preview?: InboxBoundedPreview;
  availability: InboxAvailability;
  subscription?: InboxSubscriptionState;
  /**
   * The conversation's `conversationAdvanced` watermark is newer than this
   * user's local read receipt. Drives the Unread filter for followed
   * conversations that produced no delivery of their own.
   */
  hasUnreadActivity?: boolean;
  agentDispatch?: InboxAgentDispatchState;
  /** Effective capabilities at hydration time. */
  capabilities: { comment: boolean };
  /** Why the composer is disabled, when `capabilities.comment` is false. */
  readOnlyReason?: string;
}

/** Actor as the row is allowed to show it. */
export interface InboxActorView {
  kind: 'user' | 'agent';
  displayName: string;
  /** Agents only: the authoring session's label. */
  sessionName?: string;
  /** Agents only: rendered as "for {owner}". */
  onBehalfOfDisplayName?: string;
  /** Agent mention dispatched but not yet picked up by the session. */
  pending: boolean;
}

/**
 * The redacted, display-ready row. Every field here is safe to render.
 * Built only by `toRowView`.
 */
export interface InboxRowView {
  id: string;
  /** Current team member id for the row's organization. */
  viewerUserId: string;
  reason: InboxDeliveryReason;
  reasonLabel: string;
  availability: InboxAvailability;
  /** Present when `availability !== 'available'`. */
  unavailableLabel?: string;
  orgId: string;
  orgName: string;
  projectId?: string;
  projectName?: string;
  sourceId?: string;
  commentId?: string;
  threadId?: string;
  sourceKind?: InboxSourceKind;
  /**
   * Tracker item type, when the delivery carried one and the reader may still
   * see it. Redacted along with the rest of the source on `accessRemoved`.
   */
  itemType?: string;
  type: InboxTypeIdentity;
  sourceTitle?: string;
  actor?: InboxActorView;
  preview?: string;
  /** Preview came from cache while offline; label it. */
  previewStale: boolean;
  createdAt: number;
  timestampLabel: string;
  unread: boolean;
  dismissible: boolean;
  subscription?: InboxSubscriptionState;
  canReply: boolean;
  readOnlyReason?: string;
  /**
   * Lowercased haystack for inbox search. Built from the *redacted* fields
   * above, so a revoked row can never match on content the reader lost.
   */
  searchText: string;
}

/**
 * The reason axis only. Read state is a separate, independent axis
 * (`unreadOnly`) so "unread mentions" is expressible; when unread was one of
 * these ids, choosing it meant giving up whichever reason you were looking at.
 */
export type InboxFilterId = 'all' | 'mentions' | 'assigned' | 'follows';

/** `null` on an axis means "no restriction on this axis". */
export interface InboxScope {
  orgIds: string[] | null;
  sourceKinds: InboxSourceKind[] | null;
  projectIds: string[] | null;
}

export const EMPTY_INBOX_SCOPE: InboxScope = { orgIds: null, sourceKinds: null, projectIds: null };

/** Options the scope control offers, derived from the loaded rows. */
export interface InboxScopeOptions {
  orgs: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
  sourceKinds: InboxSourceKind[];
}

/**
 * List-level state. Mirrors the plan's "Client States" table for the states the
 * list itself owns; per-row states (access removed, deleted source, read-only,
 * agent pending, muted/following) live on the row.
 */
export type InboxStatus =
  | 'loading'
  | 'ready'
  | 'offlineWithCache'
  | 'offlineWithoutCache'
  | 'reconnecting';

export interface InboxSnapshot {
  status: InboxStatus;
  deliveries: HydratedInboxDelivery[];
  unavailableOrganizations?: Array<{
    orgId: string;
    orgName: string;
    errorCode:
      | 'ORG_SERVER_MANAGED_DEK_REQUIRED'
      | 'ORG_SERVER_MANAGED_DEK_MISSING';
  }>;
  /** When the personal-index page last arrived; drives the stale label. */
  lastSyncedAt?: number;
}

export interface InboxRowGroup {
  id: string;
  label: string;
  rows: InboxRowView[];
}
