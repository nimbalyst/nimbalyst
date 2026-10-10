import type { TrackerServerMessage } from './trackerProtocol.js';

/**
 * Generate a stable client mutation ID. The format is informational; the
 * server treats it as an opaque string echoed back in
 * `trackerMutationAck`.
 */
export function generateClientMutationId(): string {
  // crypto.randomUUID is available in both browsers and Node 19+, which
  // covers every platform the engine runs on.
  const uuid = crypto.randomUUID();
  return `cm-${uuid}`;
}

export function parseServerMessage(data: unknown): TrackerServerMessage | null {
  const text =
    typeof data === 'string'
      ? data
      : typeof data === 'object' && data && 'toString' in data
        ? String(data)
        : null;
  if (text === null) return null;
  try {
    return JSON.parse(text) as TrackerServerMessage;
  } catch {
    return null;
  }
}
