/**
 * Shared Documents Discovery atoms — favorites, tree/hub filters, and the
 * derived Recent / New-&-Changed / Favorites selectors that power the
 * Shared Docs discovery hub (SharedDocsHome) and the CollabSidebar filters.
 *
 * Reuse note: the "changed since viewed" flag is ALREADY tracked by the
 * read-receipt system (`docReceiptsAtom`, driven by `useDocUnread` +
 * `markDocViewed`). New / Changed are pure derivations over
 * `sharedDocumentsAtom` + `docReceiptsAtom`, so no new DB table is needed.
 *
 * "Recently opened" is a SEPARATE concept from "read". A read receipt is
 * advanced both when a doc is opened AND when it's bulk-marked-read ("Mark all
 * as read"), so it can't distinguish an actual open. Recently-opened is
 * therefore tracked by its own `openedAt` watermark, stamped ONLY when a doc is
 * genuinely opened in the editor (`recordDocOpened`). The genuinely new state:
 *   - favorites: an ordered list of documentIds (most-recently-favorited first)
 *   - openedAt: documentId -> epoch ms of last real open (drives "Recent")
 *   - treeFilter / showUnreadBubbles: CollabSidebar view prefs
 * All of it is local-only, per-user, per-workspace, and persisted in
 * workspace state (like `collabTree` / `collabLayout`) — never synced.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { store } from '@nimbalyst/runtime/store';
import { isEntityUnread } from '@nimbalyst/runtime/readReceipts/readReceipts';
import { activeWorkspacePathAtom } from './openProjects';
import {
  sharedDocumentsAtom,
  activeTeamUserIdAtom,
  type SharedDocument,
} from './collabDocuments';
import { docReceiptsAtom, docSnapshot } from './docUnread';
import { markDocViewed } from '../../hooks/useDocUnread';

// ============================================================
// Types
// ============================================================

export type CollabTreeFilter = 'all' | 'favorites' | 'updated';

/** Freshness classification for a changed doc in the hub. */
export type DocFreshness = 'new' | 'updated';

export interface ChangedSharedDoc {
  doc: SharedDocument;
  freshness: DocFreshness;
}

/** Shape persisted under `collabDiscovery` in workspace state. */
export interface CollabDiscoveryState {
  favorites: string[];
  /** documentId -> epoch ms of the last genuine open (drives "Recent"). */
  openedAt: Record<string, number>;
  treeFilter: CollabTreeFilter;
  showUnreadBubbles: boolean;
}

const RECENT_LIMIT = 20;

// ============================================================
// Pure selectors (unit-tested directly, no atom/store coupling)
// ============================================================

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

// ============================================================
// Per-workspace atom families (source of truth)
// ============================================================

const favoritesAtomFamily = atomFamily((_workspacePath: string) => atom<string[]>([]));
const openedAtAtomFamily = atomFamily((_workspacePath: string) => atom<Record<string, number>>({}));
const treeFilterAtomFamily = atomFamily((_workspacePath: string) => atom<CollabTreeFilter>('all'));
const showUnreadBubblesAtomFamily = atomFamily((_workspacePath: string) => atom<boolean>(true));

// ============================================================
// Public atoms — derived from the active workspace
// ============================================================

/** Ordered list of favorited documentIds for the active workspace. */
export const collabFavoritesAtom = atom<string[]>((get) => {
  const path = get(activeWorkspacePathAtom);
  if (!path) return [];
  return get(favoritesAtomFamily(path));
});

/** documentId -> last-opened epoch ms for the active workspace. */
export const docOpenedAtAtom = atom<Record<string, number>>((get) => {
  const path = get(activeWorkspacePathAtom);
  if (!path) return {};
  return get(openedAtAtomFamily(path));
});

/** Sidebar segmented filter for the active workspace. */
export const collabTreeFilterAtom = atom<CollabTreeFilter, [CollabTreeFilter], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return 'all';
    return get(treeFilterAtomFamily(path));
  },
  (get, set, value) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    set(treeFilterAtomFamily(path), value);
    persistDiscovery(path);
  }
);

/** Whether unread bubbles are shown in the sidebar (cosmetic). */
export const showUnreadBubblesAtom = atom<boolean, [boolean], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return true;
    return get(showUnreadBubblesAtomFamily(path));
  },
  (get, set, value) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    set(showUnreadBubblesAtomFamily(path), value);
    persistDiscovery(path);
  }
);

// ============================================================
// Derived selectors for the hub
// ============================================================

/** Favorited docs, in favorite order, resolved to current index entries. */
export const favoriteSharedDocsAtom = atom<SharedDocument[]>((get) =>
  selectFavoriteDocs(get(collabFavoritesAtom), get(sharedDocumentsAtom))
);

/** Docs the user has opened, most-recently-opened first (excludes never-opened). */
export const recentSharedDocsAtom = atom<SharedDocument[]>((get) =>
  selectRecentDocs(get(sharedDocumentsAtom), get(docOpenedAtAtom))
);

/**
 * Changed/new docs (unread), classified as 'new' (never viewed) vs 'updated'
 * (viewed before, changed since), most-recently-updated first.
 */
export const changedSharedDocsAtom = atom<ChangedSharedDoc[]>((get) => {
  const receipts = get(docReceiptsAtom);
  const currentUserId = get(activeTeamUserIdAtom);
  return classifyChangedDocs(get(sharedDocumentsAtom), (doc) => {
    const receipt = receipts.get(doc.documentId) ?? null;
    return {
      unread: isEntityUnread(docSnapshot(doc), receipt, currentUserId),
      hasReceipt: receipt !== null,
    };
  });
});

/** Set of documentIds that are currently unread (for O(1) tree filtering). */
export const changedDocIdsAtom = atom<Set<string>>((get) => {
  return new Set(get(changedSharedDocsAtom).map((c) => c.doc.documentId));
});

// ============================================================
// Actions
// ============================================================

/** Toggle a doc's favorite state (optimistic + persisted). */
export function toggleFavoriteDoc(documentId: string): void {
  const path = store.get(activeWorkspacePathAtom);
  if (!path) return;
  const fam = favoritesAtomFamily(path);
  const current = store.get(fam);
  const next = current.includes(documentId)
    ? current.filter((id) => id !== documentId)
    : [documentId, ...current];
  store.set(fam, next);
  persistDiscovery(path);
}

/** True when a doc is favorited in the active workspace. */
export function isDocFavorited(documentId: string): boolean {
  return store.get(collabFavoritesAtom).includes(documentId);
}

/**
 * Stamp a doc as opened NOW (drives the "Recent" list). Call this only for a
 * genuine open in the editor — never from bulk/per-doc mark-read, which advance
 * the read receipt but do not open anything.
 */
export function recordDocOpened(documentId: string): void {
  const path = store.get(activeWorkspacePathAtom);
  if (!path) return;
  const fam = openedAtAtomFamily(path);
  store.set(fam, { ...store.get(fam), [documentId]: Date.now() });
  persistDiscovery(path);
}

/**
 * Mark every currently-unread shared doc as viewed, clearing all bubbles.
 * Best-effort; advances read receipts to each doc's current content time.
 */
export async function markAllSharedDocsViewed(orgId: string): Promise<void> {
  const changed = store.get(changedSharedDocsAtom);
  // Fire concurrently — each is a small advance-only receipt write; awaiting
  // them serially would stall on a large unread backlog.
  await Promise.all(
    changed.map(({ doc }) => markDocViewed(doc.documentId, orgId, doc.updatedAt ?? null)),
  );
}

// ============================================================
// Hydration & persistence (workspace state)
// ============================================================

/**
 * Populate the discovery atoms for a workspace from its persisted state.
 * Safe to call repeatedly; later calls overwrite with the loaded values.
 */
export function hydrateCollabDiscovery(
  workspacePath: string,
  state: Partial<CollabDiscoveryState> | undefined | null,
): void {
  const favorites = Array.isArray(state?.favorites)
    ? state!.favorites.filter((id): id is string => typeof id === 'string')
    : [];
  const openedAt: Record<string, number> = {};
  if (state?.openedAt && typeof state.openedAt === 'object') {
    for (const [id, ts] of Object.entries(state.openedAt)) {
      if (typeof ts === 'number' && ts > 0) openedAt[id] = ts;
    }
  }
  const treeFilter: CollabTreeFilter =
    state?.treeFilter === 'favorites' || state?.treeFilter === 'updated' ? state.treeFilter : 'all';
  const showUnreadBubbles = state?.showUnreadBubbles !== false; // default true

  store.set(favoritesAtomFamily(workspacePath), favorites);
  store.set(openedAtAtomFamily(workspacePath), openedAt);
  store.set(treeFilterAtomFamily(workspacePath), treeFilter);
  store.set(showUnreadBubblesAtomFamily(workspacePath), showUnreadBubbles);
}

/** Write the current discovery state for a workspace back to workspace state. */
function persistDiscovery(workspacePath: string): void {
  const payload: CollabDiscoveryState = {
    favorites: store.get(favoritesAtomFamily(workspacePath)),
    openedAt: store.get(openedAtAtomFamily(workspacePath)),
    treeFilter: store.get(treeFilterAtomFamily(workspacePath)),
    showUnreadBubbles: store.get(showUnreadBubblesAtomFamily(workspacePath)),
  };
  window.electronAPI?.invoke?.('workspace:update-state', workspacePath, {
    collabDiscovery: payload,
  }).catch((err: unknown) => {
    console.warn('[collabDiscovery] Failed to persist discovery state:', err);
  });
}

/** Drop cached per-workspace discovery atoms (project close). */
export function pruneCollabDiscoveryState(workspacePath: string): void {
  favoritesAtomFamily.remove(workspacePath);
  openedAtAtomFamily.remove(workspacePath);
  treeFilterAtomFamily.remove(workspacePath);
  showUnreadBubblesAtomFamily.remove(workspacePath);
}
