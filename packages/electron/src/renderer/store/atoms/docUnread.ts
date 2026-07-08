/**
 * Doc unread atoms — the reactive "unread dot" state for shared collaborative
 * documents, mirroring the tracker/session unread pattern.
 *
 * Docs are electron-only (CollabSidebar / CollaborativeTabEditor), so these
 * atoms live here rather than in runtime. The pure unread decision is the
 * shared resolver in `@nimbalyst/runtime`.
 *
 * Snapshot: docs have no numeric version projected to the sidebar, so we
 * compare the index `updatedAt` timestamp (which now advances on content edits
 * via the server touch-doc-index path) against the receipt, with the doc's
 * `lastWriterUserId` as the self-edit-suppression actor.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import {
  isEntityUnread,
  type ReadReceipt,
  type UnreadEntitySnapshot,
} from '@nimbalyst/runtime/readReceipts/readReceipts';
import type { SharedDocument } from './collabDocuments';

/** Whether a single shared doc is unread. The sidebar dot subscribes here. */
export const docUnreadAtom = atomFamily((_documentId: string) => atom(false));

/** Per-org rollup of unread document ids. Map<orgId, Set<documentId>>. */
export const docUnreadByOrgAtom = atom<Map<string, Set<string>>>(new Map());

/** The current user's doc read receipts, keyed by documentId. */
export const docReceiptsAtom = atom<Map<string, ReadReceipt>>(new Map());

/** Build the pure unread snapshot from a shared document (index entry). */
export function docSnapshot(doc: SharedDocument): UnreadEntitySnapshot {
  return {
    currentVersion: null,
    currentVersionTimestamp: doc.updatedAt ?? 0,
    lastChangeActorId: doc.lastWriterUserId ?? null,
  };
}

function setOrgUnread(
  map: Map<string, Set<string>>,
  orgId: string,
  documentId: string,
  unread: boolean,
): Map<string, Set<string>> {
  const next = new Map(map);
  const existing = next.get(orgId);
  if (unread) {
    const set = new Set(existing ?? []);
    if (set.has(documentId)) return map;
    set.add(documentId);
    next.set(orgId, set);
  } else {
    if (!existing || !existing.has(documentId)) return map;
    const set = new Set(existing);
    set.delete(documentId);
    if (set.size === 0) next.delete(orgId);
    else next.set(orgId, set);
  }
  return next;
}

export const setDocUnreadAtom = atom(
  null,
  (get, set, payload: { documentId: string; orgId: string; unread: boolean }) => {
    const { documentId, orgId, unread } = payload;
    set(docUnreadAtom(documentId), unread);
    const rollup = get(docUnreadByOrgAtom);
    const nextRollup = setOrgUnread(rollup, orgId, documentId, unread);
    if (nextRollup !== rollup) set(docUnreadByOrgAtom, nextRollup);
  },
);

/**
 * Recompute unread for a batch of docs against the current receipts. Called by
 * the doc unread hook whenever the doc list / receipts / identity change.
 */
export const recomputeDocUnreadAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      orgId: string;
      docs: SharedDocument[];
      receipts: Map<string, ReadReceipt>;
      currentUserId: string | null;
    },
  ) => {
    const { orgId, docs, receipts, currentUserId } = payload;
    for (const doc of docs) {
      const unread = isEntityUnread(
        docSnapshot(doc),
        receipts.get(doc.documentId) ?? null,
        currentUserId,
      );
      if (get(docUnreadAtom(doc.documentId)) !== unread) {
        set(setDocUnreadAtom, { documentId: doc.documentId, orgId, unread });
      }
    }
  },
);

/** Record a local mark-viewed (advance the receipt) and clear the doc's dot. */
export const applyDocReceiptAtom = atom(
  null,
  (
    get,
    set,
    payload: { documentId: string; orgId: string; receipt: ReadReceipt },
  ) => {
    const { documentId, orgId, receipt } = payload;
    const next = new Map(get(docReceiptsAtom));
    next.set(documentId, receipt);
    set(docReceiptsAtom, next);
    set(setDocUnreadAtom, { documentId, orgId, unread: false });
  },
);
