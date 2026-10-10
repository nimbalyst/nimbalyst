import type { TrackerServerMessage } from './trackerProtocol.js';
/**
 * Generate a stable client mutation ID. The format is informational; the
 * server treats it as an opaque string echoed back in
 * `trackerMutationAck`.
 */
export declare function generateClientMutationId(): string;
export declare function parseServerMessage(data: unknown): TrackerServerMessage | null;
