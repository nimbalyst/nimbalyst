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
import type { ReadReceipt } from '@nimbalyst/runtime';
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
    readReceiptService
      .getForScope('doc', orgId, workspacePath ?? undefined)
      .then((rows) => {
        if (cancelled) return;
        const map = new Map<string, ReadReceipt>();
        for (const r of rows) {
          map.set(r.entityId, {
            lastSeenVersion: r.lastSeenVersion,
            lastViewedAt: r.lastViewedAt,
          });
        }
        setReceipts(map);
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
  const watermark = lastUpdatedAt && lastUpdatedAt > 0 ? lastUpdatedAt : Date.now();
  const receipt: ReadReceipt = { lastSeenVersion: null, lastViewedAt: watermark };
  try {
    await readReceiptService.markViewed({
      entityKind: 'doc',
      entityId: documentId,
      scope: orgId,
      lastViewedAt: watermark,
      lastSeenVersion: null,
    });
    store.set(applyDocReceiptAtom, { documentId, orgId, receipt });
  } catch {
    /* best-effort */
  }
}
