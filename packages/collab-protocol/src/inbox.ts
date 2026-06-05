/**
 * Polymorphic inbox-event protocol.
 *
 * An inbox event is a recipient-scoped notification (an `@`-mention in a
 * document comment, a reply, a reaction, ...) that fans out from the source
 * resource's TeamRoom to each recipient's PersonalIndexRoom (in the
 * recipient's *personal* org).
 *
 * The event payload is E2E encrypted with the **source org key** — the same
 * org encryption key already distributed to every team member via
 * `key_envelopes`. The server stores and relays ciphertext only. The event
 * carries plaintext `sourceOrgId` so the recipient's client knows which org
 * key to decrypt with.
 *
 * Polymorphism: `kind` (what happened) × `sourceKind` (what it happened on).
 * The server never inspects the payload; client renderers dispatch on
 * `kind` / `sourceKind`.
 */

/** What happened. */
export type InboxEventKind =
  | 'mention'
  | 'reply'
  | 'reaction'
  | 'share'
  | 'assignment';

/**
 * What it happened on. Open-ended by design (polymorphic) — new source kinds
 * (tracker items, mockups, ...) can be added without a protocol change.
 */
export type InboxEventSourceKind =
  | 'lexical_document'
  | 'tracker'
  | 'mockup_document'
  | (string & {});

/**
 * An inbox event as stored on the server and transmitted over the wire.
 * Everything sensitive lives in `encryptedPayload`; the plaintext fields are
 * only what the server needs for routing/ordering and what the recipient
 * needs to pick a decryption key.
 */
export interface InboxEvent {
  /** ULID for global ordering within the recipient's inbox */
  id: string;
  kind: InboxEventKind;
  sourceKind: InboxEventSourceKind;
  /** Plaintext org whose key decrypts `encryptedPayload` (the source/team org) */
  sourceOrgId: string;
  /** Plaintext resource id within the source org (documentId, trackerItemId, ...) */
  sourceId: string;
  /** Plaintext user id of whoever triggered the event */
  actorUserId: string;
  /** Base64 AES-256-GCM ciphertext, encrypted with the source org key */
  encryptedPayload: string;
  /** Base64 IV for `encryptedPayload` */
  iv: string;
  /** Unix ms */
  createdAt: number;
  /** Unix ms when the recipient marked it read; null/undefined = unread */
  readAt?: number | null;
}

/**
 * Decrypted inbox-event payload (client-side only — never leaves a client in
 * plaintext). Fields are optional so each `kind`/`sourceKind` can populate the
 * subset it needs. Renderers interpret this based on `InboxEvent.kind`.
 */
export interface InboxEventPayload {
  /** Display name of the actor (e.g. "Alice") */
  actorName?: string;
  /** Title of the source resource (e.g. the document title) */
  sourceTitle?: string;
  /** A short excerpt of the comment / reply / change */
  snippet?: string;
  /** Comment thread id, for deep-linking into a thread */
  threadId?: string;
  /** MarkNode id anchoring the comment in the document */
  markId?: string;
  /** Deep-link target the client can open (e.g. `collab://org:..:doc:..`) */
  url?: string;
}

// ============================================================================
// PersonalIndexRoom inbox messages (recipient side)
// ============================================================================

/** Client -> PersonalIndexRoom: request inbox events (optionally incremental) */
export interface InboxSyncRequestMessage {
  type: 'inboxSyncRequest';
  /** Unix ms; when set, return only events created after this time */
  since?: number;
}

/** PersonalIndexRoom -> Client: inbox snapshot */
export interface InboxSyncResponseMessage {
  type: 'inboxSyncResponse';
  events: InboxEvent[];
  /** Count of unread events (readAt is null) */
  unreadCount: number;
  /** Echo of the request `since`, present only for incremental responses */
  since?: number;
}

/** PersonalIndexRoom -> Client: a newly delivered inbox event (realtime) */
export interface InboxEventBroadcastMessage {
  type: 'inboxEventBroadcast';
  event: InboxEvent;
}

/** Client -> PersonalIndexRoom: mark events read */
export interface MarkInboxReadMessage {
  type: 'markInboxRead';
  /** Event ids to mark read; empty array marks all */
  eventIds: string[];
}

/** PersonalIndexRoom -> Client: confirm read state + updated unread count */
export interface MarkInboxReadResponseMessage {
  type: 'markInboxReadResponse';
  eventIds: string[];
  unreadCount: number;
}

// ============================================================================
// TeamRoom fanout messages (source side)
// ============================================================================

/**
 * Client -> TeamRoom: register the sender's personal org id so the TeamRoom can
 * address the sender's PersonalIndexRoom when fanning events out to them. Sent
 * by each member's client on connect.
 */
export interface AnnouncePersonalOrgMessage {
  type: 'announcePersonalOrg';
  personalOrgId: string;
}

/**
 * Client -> TeamRoom: fan an inbox event out to a set of team members.
 *
 * The sender encrypts `encryptedPayload` once with the team (source) org key;
 * all recipients are team members who already hold that key. The TeamRoom
 * stamps `actorUserId` from the authenticated sender, mints the event id, and
 * delivers to each recipient's PersonalIndexRoom via `rpc_deliverInboxEvent`.
 */
export interface InboxEventFanoutMessage {
  type: 'inboxEventFanout';
  /** Recipient user ids (team members). The sender is skipped if included. */
  recipients: string[];
  kind: InboxEventKind;
  sourceKind: InboxEventSourceKind;
  /** Resource id within this org (documentId, trackerItemId, ...) */
  sourceId: string;
  /** Base64 AES-256-GCM ciphertext, encrypted with this org's key */
  encryptedPayload: string;
  iv: string;
}

/** TeamRoom -> Client: ack a fanout request with the count delivered */
export interface InboxEventFanoutAckMessage {
  type: 'inboxEventFanoutAck';
  delivered: number;
}
