/**
 * useDocUnread — drives the collaborative-doc "unread dot" atoms from the local
 * read-receipt store, mirroring useTrackerUnread.
 *
 * `useDocUnread` runs once in the CollabMode container; the dot components only
 * read `docUnreadAtom`. `markDocViewed` is called from CollaborativeTabEditor
 * when a doc becomes active and first-sync completes (and on subsequent edits).
 */

import { useEffect } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { mergeReceipt, type ReadReceipt } from '@nimbalyst/runtime';
import {
  activeTeamOrgIdAtom,
  activeTeamUserIdAtom,
  sharedDocumentsAtom,
} from '../store/atoms/collabDocuments';
import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import {
  applyDocReceiptAtom,
  docReceiptsAtom,
  recomputeDocUnreadAtom,
} from '../store/atoms/docUnread';
import { readReceiptService } from '../services/RendererReadReceiptService';

/** Load doc receipts for the active org and keep unread flags recomputed. */
export function useDocUnread(): void {
  const docs = useAtomValue(sharedDocumentsAtom);
  const orgId = useAtomValue(activeTeamOrgIdAtom);
  const currentUserId = useAtomValue(activeTeamUserIdAtom);
  const workspacePath = useAtomValue(activeWorkspacePathAtom);
  const [receipts, setReceipts] = useAtom(docReceiptsAtom);
  const recompute = useSetAtom(recomputeDocUnreadAtom);

  // Seed receipts for the org scope.
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    // Receipts are scoped to one org. Clear the previous scope immediately,
    // then merge the async load advance-only so a mark-read that lands while
    // this request is in flight cannot be overwritten by the older snapshot.
    setReceipts(new Map());
    readReceiptService
      .getForScope('doc', orgId, workspacePath ?? undefined)
      .then((rows) => {
        if (cancelled) return;
        setReceipts((current) => {
          const next = new Map(current);
          for (const r of rows) {
            next.set(r.entityId, mergeReceipt(next.get(r.entityId), {
              lastSeenVersion: r.lastSeenVersion,
              lastViewedAt: r.lastViewedAt,
            }));
          }
          return next;
        });
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, workspacePath, setReceipts]);

  // Recompute unread when the doc set, receipts, identity or org change.
  useEffect(() => {
    if (!orgId) return;
    recompute({ orgId, docs, receipts, currentUserId });
  }, [docs, receipts, currentUserId, orgId, recompute]);
}

/**
 * Mark a shared doc viewed up to `lastUpdatedAt` (the doc's current content
 * timestamp from its sync provider). Advance-only in the store; clears the dot
 * immediately. Called imperatively from CollaborativeTabEditor.
 */
export async function markDocViewed(
  documentId: string,
  orgId: string,
  lastUpdatedAt: number | null,
): Promise<void> {
  // A read action means "seen through the time of this click", not merely
  // through the last index timestamp currently loaded. A delayed broadcast
  // authored before the click must not resurrect the dot when it arrives.
  // Keep the known server timestamp too in case its clock is ahead locally.
  const watermark = Math.max(Date.now(), lastUpdatedAt ?? 0);
  const receipt: ReadReceipt = { lastSeenVersion: null, lastViewedAt: watermark };
  try {
    await readReceiptService.markViewed({
      entityKind: 'doc',
      entityId: documentId,
      scope: orgId,
      lastViewedAt: watermark,
      lastSeenVersion: null,
      workspacePath: store.get(activeWorkspacePathAtom) ?? undefined,
    });
    store.set(applyDocReceiptAtom, { documentId, orgId, receipt });
  } catch {
    /* best-effort */
  }
}
