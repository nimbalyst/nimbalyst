/**
 * useTrackerUnread — drives the tracker "unread dot" atoms from the local
 * read-receipt store.
 *
 * Mirrors the AI-session pattern: a central place fetches receipts + recomputes
 * the per-item `trackerUnreadAtom`; the dot components only READ that atom
 * (per the IPC_LISTENERS rule — no component subscribes to the receipt IPC).
 *
 * `useTrackerUnread` runs once in the TrackerMode container. `useMarkTrackerViewed`
 * runs in TrackerItemDetail and debounces a mark-viewed when an item is opened.
 */

import { useEffect } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  applyTrackerReceiptAtom,
  recomputeTrackerUnreadAtom,
  trackerReceiptsAtom,
  type ReadReceipt,
} from '@nimbalyst/runtime';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { readReceiptService } from '../services/RendererReadReceiptService';

/** Debounce so rapid item navigation doesn't spam mark-viewed writes. */
const MARK_VIEWED_DEBOUNCE_MS = 400;

/**
 * Load the current user's tracker receipts for the workspace and keep every
 * item's unread flag recomputed as items / receipts / identity change.
 */
export function useTrackerUnread(
  workspacePath: string | undefined,
  currentEmail: string | null,
): void {
  const itemsMap = useAtomValue(trackerItemsMapAtom);
  const [receipts, setReceipts] = useAtom(trackerReceiptsAtom);
  const recompute = useSetAtom(recomputeTrackerUnreadAtom);

  // Seed receipts for the workspace scope.
  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    readReceiptService
      .getForScope('tracker', workspacePath, workspacePath)
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
        /* best-effort; unread just stays as-is */
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, setReceipts]);

  // Recompute unread when the item set, receipts, identity or workspace change.
  useEffect(() => {
    if (!workspacePath) return;
    const items = Array.from(itemsMap.values());
    recompute({ workspace: workspacePath, items, receipts, currentEmail });
  }, [itemsMap, receipts, currentEmail, workspacePath, recompute]);
}

/**
 * Debounced mark-viewed for the currently-open tracker item. Refires when the
 * open item's `updatedAt` advances (a newer version arrived while visible), so
 * the receipt keeps pace and the dot stays cleared.
 */
export function useMarkTrackerViewed(
  item: TrackerRecord | null,
  workspacePath: string | undefined,
): void {
  const applyReceipt = useSetAtom(applyTrackerReceiptAtom);
  const itemId = item?.id;
  const updatedAt = item?.system.updatedAt;

  useEffect(() => {
    if (!itemId || !workspacePath || !updatedAt) return;
    const timer = setTimeout(() => {
      const updatedMs = Date.parse(updatedAt);
      const watermark = Number.isNaN(updatedMs) ? Date.now() : updatedMs;
      const receipt: ReadReceipt = { lastSeenVersion: null, lastViewedAt: watermark };
      readReceiptService
        .markViewed({
          entityKind: 'tracker',
          entityId: itemId,
          scope: workspacePath,
          lastViewedAt: watermark,
          lastSeenVersion: null,
          workspacePath,
        })
        .then(() => applyReceipt({ itemId, workspace: workspacePath, receipt }))
        .catch(() => {
          /* best-effort */
        });
    }, MARK_VIEWED_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [itemId, updatedAt, workspacePath, applyReceipt]);
}
