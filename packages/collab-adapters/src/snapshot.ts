/**
 * Default snapshot helpers.
 *
 * Adapters that don't supply their own `exportRevisionSnapshot` /
 * `restoreRevisionSnapshot` get this Y state-vector pair, which
 * round-trips any Y.Doc faithfully but is opaque (no diffing across
 * versions). Adapters with a denser textual or structural snapshot
 * format override these.
 */
import { encodeStateAsUpdateV2, applyUpdateV2, type Doc } from 'yjs';

export function defaultExportRevisionSnapshot(yDoc: Doc): Uint8Array {
  return encodeStateAsUpdateV2(yDoc);
}

export function defaultRestoreRevisionSnapshot(
  yDoc: Doc,
  bytes: Uint8Array,
): void {
  applyUpdateV2(yDoc, bytes);
}
