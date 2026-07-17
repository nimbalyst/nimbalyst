/**
 * Read-receipts: the pure, backend-agnostic core of the "unread indicator"
 * feature for trackers and collaborative docs.
 *
 * A read receipt records that a given user has viewed a given entity
 * (tracker item or doc) up to a certain version at a certain time. The
 * "unread" decision compares an entity's current version/last-change author
 * against the user's receipt.
 *
 * This module holds ONLY pure logic (no DB, no IPC, no atoms) so it can be
 * unit-tested in isolation and reused identically by the main-process
 * repository, the renderer atoms/listeners, and sync ingestion.
 *
 * Personal, not team: receipts are personal per-user state ABOUT team objects.
 * They sync on the PERSONAL channel, never the team rooms. See jwt-scopes.md.
 */

/** The kinds of entity a receipt can be about. Extensible. */
export type ReadReceiptEntityKind = 'tracker' | 'doc';

/**
 * A self-contained read receipt as carried over the personal sync channel
 * (the decrypted payload). Identifies the entity AND the watermark.
 */
export interface SyncedReadReceipt {
  entityKind: ReadReceiptEntityKind;
  entityId: string;
  /** workspace path (trackers) | org id (docs) */
  scope: string;
  lastViewedAt: number;
  lastSeenVersion: number | null;
}

/**
 * A stored receipt for one (user, entityKind, entityId, scope). Versions are
 * the entity's monotonic sync version (tracker `sync_id` / doc `sequence`);
 * `null` when the backing store had no version (legacy / timestamp-only).
 */
export interface ReadReceipt {
  lastSeenVersion: number | null;
  /** epoch ms */
  lastViewedAt: number;
}

/**
 * A snapshot of an entity's current state, enough to decide unread-ness.
 * `currentVersion` is the monotonic version (tracker `sync_id`, doc
 * `sequence`); `currentVersionTimestamp` is the fallback used when either the
 * item or the receipt lacks a version.
 *
 * `lastChangeActorId` is the stable id of whoever made the most recent change:
 * for trackers the human email (`system.lastModifiedBy.email`), for docs the
 * `lastWriterUserId`. It is `null` when unknown. An AI agent acting via MCP is
 * a DISTINCT actor from the human, so its id will not equal `currentActorId`
 * and its edits therefore surface as unread (by design).
 */
export interface UnreadEntitySnapshot {
  currentVersion: number | null;
  /** epoch ms */
  currentVersionTimestamp: number;
  lastChangeActorId: string | null;
}

/**
 * Decide whether an entity is unread for the current user.
 *
 * Rules (see plan §2):
 *   1. Suppress the human's own most-recent change (never show my own edit as
 *      unread). Keys strictly on the interactive human identity; agent edits
 *      are NOT suppressed.
 *   2. Never viewed (no receipt) → unread.
 *   3. Changed since viewed (`receipt.lastSeenVersion < currentVersion`) →
 *      unread. Falls back to timestamp when either version is missing.
 *
 * @param currentActorId the current human's stable id (tracker email / doc
 *   userId). `null`/empty when there is no identity — then nothing is
 *   suppressed as "mine".
 */
export function isEntityUnread(
  snapshot: UnreadEntitySnapshot,
  receipt: ReadReceipt | null | undefined,
  currentActorId: string | null | undefined,
): boolean {
  // 1. Self-edit suppression — the human's own latest change never reads as
  //    unread. Requires a known current identity AND a known last-change actor.
  if (
    currentActorId &&
    snapshot.lastChangeActorId &&
    snapshot.lastChangeActorId === currentActorId
  ) {
    return false;
  }

  // 2. Never viewed.
  if (!receipt) {
    return true;
  }

  // 3. Changed since viewed — prefer monotonic version comparison.
  if (snapshot.currentVersion != null && receipt.lastSeenVersion != null) {
    return receipt.lastSeenVersion < snapshot.currentVersion;
  }

  // Fallback: timestamp comparison when a version is unavailable on either side.
  return snapshot.currentVersionTimestamp > receipt.lastViewedAt;
}

/**
 * Merge an incoming receipt into an existing one, ADVANCE-ONLY: a receipt may
 * only ever move forward. Used both for local mark-viewed and for
 * last-writer-wins ingestion of a remote personal-sync receipt. Viewing on
 * device A must mark read on device B; it must never regress.
 */
export function mergeReceipt(
  existing: ReadReceipt | null | undefined,
  incoming: ReadReceipt,
): ReadReceipt {
  if (!existing) {
    return { lastSeenVersion: incoming.lastSeenVersion, lastViewedAt: incoming.lastViewedAt };
  }

  const lastViewedAt = Math.max(existing.lastViewedAt, incoming.lastViewedAt);

  // Version is monotonic; take the max, treating null as "no version".
  let lastSeenVersion: number | null;
  if (existing.lastSeenVersion == null) {
    lastSeenVersion = incoming.lastSeenVersion;
  } else if (incoming.lastSeenVersion == null) {
    lastSeenVersion = existing.lastSeenVersion;
  } else {
    lastSeenVersion = Math.max(existing.lastSeenVersion, incoming.lastSeenVersion);
  }

  return { lastSeenVersion, lastViewedAt };
}

/**
 * True when `incoming` would actually advance `existing` (i.e. the merge is
 * not a no-op). Lets callers skip a pointless DB write / sync push when a
 * regressing or duplicate receipt arrives.
 */
export function receiptAdvances(
  existing: ReadReceipt | null | undefined,
  incoming: ReadReceipt,
): boolean {
  if (!existing) return true;
  const merged = mergeReceipt(existing, incoming);
  return (
    merged.lastViewedAt !== existing.lastViewedAt ||
    merged.lastSeenVersion !== existing.lastSeenVersion
  );
}
