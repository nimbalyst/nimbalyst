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
  EncryptedTrackerItemEnvelope,
  EncryptedTrackerSchemaEnvelope,
  EncryptedTrackerNavigationEnvelope,
  EncryptedTrackerSavedViewEnvelope,
  TrackerItemPayload,
} from './trackerProtocol';
import { stripLocalOnlyFields } from './trackerProtocol';


/**
 * Serialize a `TrackerItemPayload` to the plaintext wire form for
 * server-managed mode. Strips device-local fields exactly like the encrypted
 * path so they never cross the wire.
 */
export function encodeTrackerPayloadPlaintext(payload: TrackerItemPayload): string {
  return JSON.stringify(stripLocalOnlyFields(payload));
}

/**
 * Parse a plaintext server-managed item envelope back into a payload. Throws
 * (caught per-item by the engine) on malformed JSON or a missing payload.
 */
export function decodeTrackerEnvelopePlaintext(
  envelope: EncryptedTrackerItemEnvelope,
): TrackerItemPayload {
  if (envelope.encryptedPayload === null) {
    throw new Error('decodeTrackerEnvelopePlaintext called on a tombstone (encryptedPayload=null)');
  }
  return JSON.parse(envelope.encryptedPayload) as TrackerItemPayload;
}

/**
 * Parse a plaintext server-managed schema envelope back into its model JSON
 * string. The model is already JSON, so this is a presence/typing guard.
 */
export function decodeTrackerSchemaEnvelopePlaintext(
  envelope: EncryptedTrackerSchemaEnvelope,
): string {
  if (envelope.encryptedPayload === null) {
    throw new Error('decodeTrackerSchemaEnvelopePlaintext called on a tombstone (encryptedPayload=null)');
  }
  return envelope.encryptedPayload;
}

export function decodeTrackerSavedViewEnvelopePlaintext(
  envelope: EncryptedTrackerSavedViewEnvelope,
): string {
  if (envelope.encryptedPayload === null) {
    throw new Error('decodeTrackerSavedViewEnvelopePlaintext called on a tombstone');
  }
  return envelope.encryptedPayload;
}

export function decodeTrackerNavigationEnvelopePlaintext(
  envelope: EncryptedTrackerNavigationEnvelope,
): string {
  if (envelope.encryptedPayload === null) {
    throw new Error('decodeTrackerNavigationEnvelopePlaintext called on a tombstone');
  }
  return envelope.encryptedPayload;
}

