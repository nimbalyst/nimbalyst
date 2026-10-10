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
import type { TrackerItemEnvelope, TrackerSchemaEnvelope, TrackerNavigationEnvelope, TrackerSavedViewEnvelope, TrackerItemPayload } from './trackerProtocol.js';
/** An item that cannot fit the room's per-item limit even with its activity trimmed. */
export declare class TrackerPayloadTooLargeError extends Error {
    readonly itemId: string;
    readonly bytes: number;
    readonly limitBytes: number;
    readonly code = "payloadTooLarge";
    constructor(itemId: string, bytes: number, limitBytes?: number);
}
/**
 * Serialize a `TrackerItemPayload` to the plaintext wire form for
 * server-managed mode. Strips device-local fields exactly like the encrypted
 * path so they never cross the wire. Throws `TrackerPayloadTooLargeError` when
 * the item cannot fit the room's limit.
 */
export declare function encodeTrackerPayloadPlaintext(payload: TrackerItemPayload): string;
/**
 * Parse a plaintext server-managed item envelope back into a payload. Throws
 * (caught per-item by the engine) on malformed JSON or a missing payload.
 */
export declare function decodeTrackerEnvelopePlaintext(envelope: TrackerItemEnvelope): TrackerItemPayload;
/**
 * Parse a plaintext server-managed schema envelope back into its model JSON
 * string. The model is already JSON, so this is a presence/typing guard.
 */
export declare function decodeTrackerSchemaEnvelopePlaintext(envelope: TrackerSchemaEnvelope): string;
export declare function decodeTrackerSavedViewEnvelopePlaintext(envelope: TrackerSavedViewEnvelope): string;
export declare function decodeTrackerNavigationEnvelopePlaintext(envelope: TrackerNavigationEnvelope): string;
