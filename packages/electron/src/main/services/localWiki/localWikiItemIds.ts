/**
 * Ids of the Local wiki's typed pages and table rows, as main last read them.
 *
 * Those items exist only as files; the renderer shows them as tracker records
 * with `source: 'local-wiki'`. Every path that writes a tracker row, pushes to
 * a team tracker room, or records per-item state checks `isLocalWikiItemId`
 * and refuses, so a wiki item can never become a database row or reach the
 * team. Kept dependency-free so the tracker services can import it.
 */

const idsByRoot = new Map<string, ReadonlySet<string>>();

/** Replaces the known item ids of one wiki folder. */
export function rememberLocalWikiItemIds(root: string, ids: Iterable<string>): void {
  idsByRoot.set(root, new Set(ids));
}

export function addLocalWikiItemId(root: string, id: string): void {
  idsByRoot.set(root, new Set([...(idsByRoot.get(root) ?? []), id]));
}

export function forgetLocalWikiItemIds(root?: string): void {
  if (root === undefined) idsByRoot.clear();
  else idsByRoot.delete(root);
}

export function isLocalWikiItemId(id: unknown): boolean {
  if (typeof id !== 'string' || !id) return false;
  for (const ids of idsByRoot.values()) if (ids.has(id)) return true;
  return false;
}

export class LocalWikiItemWriteRefused extends Error {
  constructor(id: string, what: string) {
    super(`${id} is a Local wiki item (a file in the wiki folder); ${what} does not apply to it`);
    this.name = 'LocalWikiItemWriteRefused';
  }
}

/** Throws when `id` is a Local wiki item. */
export function refuseLocalWikiItem(id: unknown, what: string): void {
  if (isLocalWikiItemId(id)) throw new LocalWikiItemWriteRefused(String(id), what);
}
