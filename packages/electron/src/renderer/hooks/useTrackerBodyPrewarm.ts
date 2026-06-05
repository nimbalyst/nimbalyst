/**
 * useTrackerBodyPrewarm
 *
 * Renderer hook that opportunistically warms the body Y.Docs for a set
 * of visible tracker item ids. Wraps `BodyDocCache.prewarm` so callers
 * (kanban, list) only have to supply the visible ids and the team-aware
 * collab config factory.
 *
 * Phase 4a of the rewrite spec'd in
 * `design/Collaboration/tracker-sync-redesign.md` (section D5).
 *
 * Behavior
 * --------
 * - Triggers a debounced (50 ms) prewarm whenever `itemIds` settles.
 * - Capped via the cache's prewarm budget (default 5 concurrent).
 * - Caller passes `enabled=false` to disable for local-only workspaces
 *   or when the team JWT isn't resolved yet; the hook becomes a no-op.
 * - When the workspace has no team this hook is harmless: the factory
 *   returns `null` and the cache skips that item silently.
 *
 * The hook does NOT pin entries -- prewarm bypasses refcounting so an
 * un-opened item evicts naturally under the cache's 5-min idle timeout.
 * If the user opens a detail panel within the window, the cache hits a
 * warm provider.
 */

import { useEffect } from 'react';
import { getBodyDocCache, type BodyDocConfigFactory } from '../services/BodyDocCache';
import { resolveCollabConfigForUri } from '../utils/collabDocumentOpener';

/**
 * Debounce window before firing prewarm after `itemIds` settles. Tuned
 * to 2s so the prewarm does NOT pile onto the document-sync:open storm
 * the restored collab tabs already kick off at app launch -- the 50ms
 * default was contributing to a multi-minute event-loop block at
 * startup for users with many trackers (see DocumentSyncHandlers fp
 * cache notes, user report 2026-06-01).
 */
const PREWARM_DEBOUNCE_MS = 2000;
/**
 * Hard cap on the number of items prewarmed per render. Dropped from 50
 * to 10 for the same startup-cost reason: each prewarm opens a proxied
 * WebSocket and builds a Y.Doc; 50 concurrent at launch was overkill
 * even with the BodyDocCache's 5-concurrent budget.
 */
const PREWARM_LIMIT = 10;

export interface UseTrackerBodyPrewarmOptions {
  /** Workspace owning the items. Required when `enabled`. */
  workspacePath?: string;
  /** Stable list of itemIds to consider. Already-warm items are skipped. */
  itemIds: string[];
  /**
   * Whether prewarm is wanted at all. Set false for local-only workspaces
   * or before the team org is resolved. The hook is a no-op when false.
   */
  enabled: boolean;
  /**
   * Whether the room currently has more than one connected member. The
   * cache caches the constructed `DocumentSyncProvider`; its
   * `reviewGateEnabled` is fixed at construction, so we must construct
   * with the same value the eventual detail-open would use -- otherwise
   * a prewarm-then-acquire flow ends up with the wrong gating semantics.
   * Defaults to false (matches the local-edit case).
   */
  multiUser?: boolean;
}

export function useTrackerBodyPrewarm({
  workspacePath,
  itemIds,
  enabled,
  multiUser = false,
}: UseTrackerBodyPrewarmOptions): void {
  useEffect(() => {
    if (!enabled) return;
    if (!workspacePath) return;
    if (itemIds.length === 0) return;

    // Snapshot the prefix once. The kanban / list may re-render
    // frequently; we want a stable prewarm input across those renders.
    const prefix = itemIds.slice(0, PREWARM_LIMIT);

    const timer = setTimeout(() => {
      const factory: BodyDocConfigFactory = async (id) => {
        const documentId = `tracker-content/${id}`;
        const uri = `collab://tracker-content/${id}`;
        const config = await resolveCollabConfigForUri(
          workspacePath,
          uri,
          documentId,
          `Tracker ${id}`,
        );
        if (!config) return null;
        return {
          serverUrl: config.serverUrl,
          getJwt: config.getJwt,
          orgId: config.orgId,
          documentKey: config.documentKey,
          orgKeyFingerprint: config.orgKeyFingerprint,
          userId: config.userId,
          documentId: config.documentId,
          createWebSocket: config.createWebSocket,
          reviewGateEnabled: multiUser,
        };
      };
      void getBodyDocCache().prewarm(prefix, factory);
    }, PREWARM_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // The intent is "re-warm when the prefix of visible ids changes."
    // Joining the array with '|' gives us a stable dep that the React
    // shallow-compare can use without falsely firing on a new
    // referentially-distinct-but-content-equal array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    workspacePath,
    multiUser,
    itemIds.slice(0, PREWARM_LIMIT).join('|'),
  ]);
}
