import { createHash } from 'node:crypto';

/**
 * Deterministic local tracker id for an imported URN.
 *
 * Every client runs this same function, so two members importing the same
 * upstream item independently — before the team tracker room converges — compute
 * the SAME id. When their rows sync, they collide on `ON CONFLICT (id)` in
 * `applyRemoteItem` and dedup into one item instead of producing duplicates.
 *
 * Derived from the URN ONLY (not the tracker type): one member may import an
 * issue as `bug` and another as `task`, and they must still converge. The URN is
 * already the stable cross-client identity (`github://owner/repo#42`).
 *
 * Kept in its own dependency-free module so it can be unit-tested without
 * dragging in the Electron `app` chain that `TrackerImportService` pulls in.
 */
export function importedItemId(urn: string): string {
  return `import_${createHash('sha1').update(urn).digest('hex').slice(0, 24)}`;
}
