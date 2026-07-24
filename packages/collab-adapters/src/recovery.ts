import type { Doc } from 'yjs';

import type { CollabContentAdapter } from './CollabContentAdapter';

/**
 * Exact plaintext file representation used by local recovery copies.
 *
 * `toPlainText()` is a search/AI projection and may intentionally discard
 * structure (for example, Excalidraw returns only visible labels). Recovery
 * must instead preserve the adapter's round-trippable `exportToFile()` value.
 * UTF-8 byte exports remain eligible; opaque binary exports are not plaintext
 * and return null so the host can report an unsupported adapter.
 */
export function exportCollabRecoveryPlaintext(
  adapter: CollabContentAdapter,
  yDoc: Doc,
): string | null {
  const source = adapter.exportToFile(yDoc);
  if (typeof source === 'string') return source;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    return null;
  }
}
