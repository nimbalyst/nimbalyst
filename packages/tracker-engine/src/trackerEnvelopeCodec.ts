/**
 * TrackerEnvelopePlaintext
 *
 * Encode/decode helpers for the tracker wire envelope. Team tracker payloads
 * travel as PLAINTEXT JSON and are encrypted at rest by the server under the
 * server-managed team DEK, so there is no client-side envelope crypto left —
 * the retired client-managed (org-key) lane owned that.
 *
 * The envelope carries `itemId` / `syncId` / `updatedAt` / `deletedAt` /
 * `orgKeyFingerprint` alongside the payload; `orgKeyFingerprint` is now the
 * server's DEK fingerprint, recorded for diagnostics only.
 *
 * Splice protection moved with the crypto. The client-managed lane bound each
 * ciphertext to its (org, room, item) with AES-GCM additional authenticated
 * data so a valid envelope could not be replayed into a different room. That
 * guarantee is now server-side authorization: the room's DurableObject
 * accepts a mutation only from a JWT scoped to that org and project, so a
 * client cannot address another room's item in the first place. There is no
 * client-side AAD left to construct or verify.
 */

import type {
  TrackerItemEnvelope,
  TrackerSchemaEnvelope,
  TrackerNavigationEnvelope,
  TrackerSavedViewEnvelope,
  TrackerItemPayload,
} from './trackerProtocol.js';
import { stripLocalOnlyFields } from './trackerProtocol.js';
import { MAX_TRACKER_ITEM_PAYLOAD_BYTES, parseTrackerItemPayload } from '@nimbalyst/collab-protocol';
import { capActivityValue } from '@nimbalyst/tracker-core';

/** An item that cannot fit the room's per-item limit even with its activity trimmed. */
export class TrackerPayloadTooLargeError extends Error {
  readonly code = 'payloadTooLarge';

  constructor(
    readonly itemId: string,
    readonly bytes: number,
    readonly limitBytes: number = MAX_TRACKER_ITEM_PAYLOAD_BYTES,
  ) {
    super(`Tracker item ${itemId} is too large to share (${bytes} bytes, limit ${limitBytes}).`);
    this.name = 'TrackerPayloadTooLargeError';
  }
}

const utf8 = new TextEncoder();
const byteLength = (text: string): number => utf8.encode(text).length;

/**
 * Fit an over-budget item by trimming its activity trail: bound every value,
 * then drop the oldest entries. Only the wire copy is trimmed; the caller's
 * payload, and so the local item, keeps its full history (NIM-7336).
 */
function encodeWithTrimmedActivity(payload: TrackerItemPayload): string {
  const activity = (payload.activity ?? []).map(entry => ({
    ...entry,
    oldValue: capActivityValue(entry.oldValue),
    newValue: capActivityValue(entry.newValue),
  }));
  const withActivity = (kept: typeof activity) => JSON.stringify({ ...payload, activity: kept });
  const base = byteLength(withActivity([]));
  const entryBytes = activity.map(entry => byteLength(JSON.stringify(entry)));
  // `[a,b]` costs the entries plus one comma between each pair.
  let total = base;
  let first = activity.length;
  while (first > 0 && total + entryBytes[first - 1] + (first < activity.length ? 1 : 0) <= MAX_TRACKER_ITEM_PAYLOAD_BYTES) {
    total += entryBytes[first - 1] + (first < activity.length ? 1 : 0);
    first--;
  }
  return withActivity(activity.slice(first));
}

/**
 * Serialize a `TrackerItemPayload` to the plaintext wire form for
 * server-managed mode. Strips device-local fields exactly like the encrypted
 * path so they never cross the wire. Throws `TrackerPayloadTooLargeError` when
 * the item cannot fit the room's limit.
 */
export function encodeTrackerPayloadPlaintext(payload: TrackerItemPayload): string {
  const stripped = stripLocalOnlyFields(payload);
  let encoded = JSON.stringify(stripped);
  if (byteLength(encoded) > MAX_TRACKER_ITEM_PAYLOAD_BYTES) {
    encoded = encodeWithTrimmedActivity(stripped);
    const size = byteLength(encoded);
    if (size > MAX_TRACKER_ITEM_PAYLOAD_BYTES) {
      throw new TrackerPayloadTooLargeError(payload.itemId, size);
    }
  }
  const parsed = parseTrackerItemPayload(encoded, payload.itemId);
  if (!parsed.success) {
    throw new Error(`Invalid tracker item payload: ${parsed.error}`);
  }
  return encoded;
}

/**
 * Parse a plaintext server-managed item envelope back into a payload. Throws
 * (caught per-item by the engine) on malformed JSON or a missing payload.
 */
export function decodeTrackerEnvelopePlaintext(
  envelope: TrackerItemEnvelope,
): TrackerItemPayload {
  if (envelope.encryptedPayload === null) {
    throw new Error('decodeTrackerEnvelopePlaintext called on a tombstone (encryptedPayload=null)');
  }
  const parsed = parseTrackerItemPayload(envelope.encryptedPayload, envelope.itemId);
  if (!parsed.success) {
    throw new Error(`Invalid tracker item payload: ${parsed.error}`);
  }
  return parsed.value as unknown as TrackerItemPayload;
}

/**
 * Parse a plaintext server-managed schema envelope back into its model JSON
 * string. The model is already JSON, so this is a presence/typing guard.
 */
export function decodeTrackerSchemaEnvelopePlaintext(
  envelope: TrackerSchemaEnvelope,
): string {
  if (envelope.encryptedPayload === null) {
    throw new Error('decodeTrackerSchemaEnvelopePlaintext called on a tombstone (encryptedPayload=null)');
  }
  return envelope.encryptedPayload;
}

export function decodeTrackerSavedViewEnvelopePlaintext(
  envelope: TrackerSavedViewEnvelope,
): string {
  if (envelope.encryptedPayload === null) {
    throw new Error('decodeTrackerSavedViewEnvelopePlaintext called on a tombstone');
  }
  return envelope.encryptedPayload;
}

export function decodeTrackerNavigationEnvelopePlaintext(
  envelope: TrackerNavigationEnvelope,
): string {
  if (envelope.encryptedPayload === null) {
    throw new Error('decodeTrackerNavigationEnvelopePlaintext called on a tombstone');
  }
  return envelope.encryptedPayload;
}
