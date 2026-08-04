import type { SharedDocument } from './types';

export type DocFreshness = 'new' | 'updated';

export interface ChangedSharedDoc {
  doc: SharedDocument;
  freshness: DocFreshness;
}

const RECENT_LIMIT = 20;

/** Favorited docs in favorite order, resolved to current index entries. */
export function selectFavoriteDocs(
  favorites: readonly string[],
  docs: readonly SharedDocument[],
): SharedDocument[] {
  if (favorites.length === 0) return [];
  const byId = new Map(docs.map((d) => [d.documentId, d]));
  const result: SharedDocument[] = [];
  for (const id of favorites) {
    const doc = byId.get(id);
    if (doc) result.push(doc);
  }
  return result;
}

/**
 * Opened docs, most-recently-opened first (excludes never-opened). Driven by
 * the `openedAt` watermark — NOT read receipts — so bulk "Mark all as read"
 * (which advances receipts but opens nothing) never surfaces docs here.
 */
export function selectRecentDocs(
  docs: readonly SharedDocument[],
  openedAt: Readonly<Record<string, number>>,
  limit: number = RECENT_LIMIT,
): SharedDocument[] {
  return docs
    .map((doc) => ({ doc, openedAt: openedAt[doc.documentId] ?? 0 }))
    .filter((x) => x.openedAt > 0)
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, limit)
    .map((x) => x.doc);
}

/**
 * Unread docs classified 'new' (never viewed) vs 'updated' (viewed, changed
 * since), most-recently-updated first. `unreadFn` is injected so callers pass
 * the shared read-receipt resolver.
 */
export function classifyChangedDocs(
  docs: readonly SharedDocument[],
  unreadFn: (doc: SharedDocument) => { unread: boolean; hasReceipt: boolean },
): ChangedSharedDoc[] {
  const result: ChangedSharedDoc[] = [];
  for (const doc of docs) {
    if (doc.decryptFailed) continue;
    const { unread, hasReceipt } = unreadFn(doc);
    if (!unread) continue;
    result.push({ doc, freshness: hasReceipt ? 'updated' : 'new' });
  }
  result.sort((a, b) => (b.doc.updatedAt ?? 0) - (a.doc.updatedAt ?? 0));
  return result;
}
