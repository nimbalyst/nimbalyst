/**
 * useTrackerContentCollab
 *
 * Hook that provides collaboration config for a team-synced tracker item's
 * content editor. For local-only items, returns null (use PGLite path).
 *
 * For team-synced items, the hook acquires a shared `DocumentSyncProvider`
 * from `BodyDocCache` (phase 4a -- see
 * `design/Collaboration/tracker-sync-redesign.md` D5). Two detail panels
 * for the same item share one socket and one Y.Doc; close → reopen within
 * the cache's idle window (5 min) hits a warm provider instead of
 * paying for a fresh connect.
 *
 * PGLite persistence is handled by TrackerItemDetail via onGetContent/onDirtyChange
 * on the editor config. Bootstrap from PGLite markdown is handled by
 * TrackerItemDetail's collabEditorConfig via `initialEditorState`.
 *
 * Key design choice: the hook does NOT call `syncProvider.connect()` itself
 * -- CollaborationPlugin drives the connect via `providerFactory`. This is
 * important because Lexical's binding only observes FUTURE Y.Doc updates;
 * if the Y.Doc were populated before the binding is created, existing
 * server content would never render.
 *
 * `shouldBootstrap` is always true; Lexical's internal `_xmlText._length === 0`
 * check is the actual gate (bootstrap only fires when the shared text is
 * empty). Combined with `deferInitialSync: true` on CollabLexicalProvider,
 * this ensures the bootstrap decision happens AFTER the server's sync
 * response is applied, so we never CRDT-merge stale PGLite content into a
 * room that already has authoritative content from another collaborator.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentSyncProvider, DocumentSyncStatus, ReviewGateState, CollabLexicalProvider } from '@nimbalyst/runtime/sync';
import type { Doc } from 'yjs';
import type { Provider } from '@lexical/yjs';
import { $convertFromEnhancedMarkdownString, getEditorTransformers } from '@nimbalyst/runtime/editor';
import { $getRoot } from 'lexical';
import { resolveCollabConfigForUri } from '../utils/collabDocumentOpener';
import { getBodyDocCache, type BodyDocAcquisition, type BodyDocConfigFactory } from '../services/BodyDocCache';

const TRACKER_CONTENT_TTL_MS = String(90 * 24 * 60 * 60 * 1000);

interface UseTrackerContentCollabOptions {
  itemId: string;
  workspacePath?: string;
  syncMode: string;
  /** Number of team members -- enables review gate when > 1 */
  teamMemberCount: number;
  /**
   * orgId of the team that owns this workspace.
   * - `undefined`: the parent is still resolving team membership; the hook
   *   stays in `loading: true` so the UI shows a connecting state instead
   *   of prematurely mounting the local editor.
   * - `null`: the workspace has no team. The hook stays dormant -- callers
   *   should fall back to local PGLite editing.
   * - `string`: a team exists; collab setup proceeds as normal.
   */
  teamOrgId: string | null | undefined;
}

interface TrackerContentCollabResult {
  collaboration: {
    providerFactory: (id: string, yjsDocMap: Map<string, Doc>) => Provider;
    shouldBootstrap: boolean;
    username?: string;
    cursorColor?: string;
    /**
     * Cold-paint seed for Lexical. When the latest `tracker_body_cache`
     * row is available before the DocumentRoom Y.Doc finishes its initial
     * sync, the hook provides an `initialEditorState` callback that seeds
     * the editor with the cached markdown. CollabLexicalProvider's
     * `deferInitialSync: true` mode keeps the bootstrap decision behind
     * the server response, so a non-empty room still wins.
     */
    initialEditorState?: (() => void) | string;
  } | null;
  loading: boolean;
  status: DocumentSyncStatus;
  syncProvider: DocumentSyncProvider | null;
  reviewState: ReviewGateState | null;
  acceptRemoteChanges: () => void;
  rejectRemoteChanges: () => void;
  /**
   * Increments every time a new CollabLexicalProvider is created. Callers
   * should include this in the React key of the editor tree that hosts
   * `<CollaborationPlugin>`, so a stale plugin (with its `isProviderInitialized`
   * ref still `true` from a previous provider) is fully unmounted and the new
   * provider's sync listener actually gets registered.
   */
  providerEpoch: number;
  /**
   * The body markdown read from `tracker_body_cache` for the current
   * `body_version`. Exposed so the caller can drive a defensive
   * cold-paint fallback when `initialEditorState` was wired but
   * Lexical's binding declined to bootstrap (e.g. `_xmlText._length`
   * counted as non-zero because the binding wrote a root element
   * before sync delivered actual content). The caller may apply this
   * markdown via `editor.update()` after the WS reaches `connected`
   * and the editor is still visually empty. `null` means either no
   * cache row exists OR the fetch has not yet resolved.
   */
  bodyCacheMarkdown: string | null;
}

function randomCursorColor(): string {
  const colors = [
    '#E05555', '#2BA89A', '#3A8FD6', '#D97706',
    '#9B59B6', '#E06B8F', '#3B82F6', '#16A34A',
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

export function useTrackerContentCollab({
  itemId,
  workspacePath,
  syncMode,
  teamMemberCount,
  teamOrgId,
}: UseTrackerContentCollabOptions): TrackerContentCollabResult {
  const isTeamSynced = syncMode !== 'local';
  // Collab is only attempted for team-synced trackers in workspaces that
  // actually have a team. Without a team there is nothing to collaborate
  // with, so we skip the document-sync IPC entirely.
  const isCollabActive = isTeamSynced && typeof teamOrgId === 'string';
  // Pending: team-synced but the parent hasn't resolved the team yet.
  // Stay in `loading: true` so the UI shows a connecting state instead of
  // prematurely flipping to the local editor.
  const isCollabPending = isTeamSynced && teamOrgId === undefined;
  const isMultiUser = teamMemberCount > 1;
  const [loading, setLoading] = useState(isCollabActive || isCollabPending);
  const [status, setStatus] = useState<DocumentSyncStatus>('disconnected');
  const [reviewState, setReviewState] = useState<ReviewGateState | null>(null);
  const [providerEpoch, setProviderEpoch] = useState(0);
  const [bodyCacheMarkdown, setBodyCacheMarkdown] = useState<string | null>(null);
  const syncProviderRef = useRef<DocumentSyncProvider | null>(null);
  const collabProviderRef = useRef<CollabLexicalProvider | null>(null);
  const cursorColor = useMemo(() => randomCursorColor(), []);

  // Caller-stable username for awareness. Captured from the resolved
  // collab config on the first successful acquire; future re-acquires
  // (same item, same window) reuse it.
  const userNameRef = useRef<string>('Anonymous');

  // Acquire a shared DocumentSyncProvider from BodyDocCache. The cache
  // owns construction + lifecycle; we hand it a factory that materialises
  // a DocumentSyncConfig the first time the cache needs one for `itemId`.
  // On unmount we release; the cache holds the provider warm for 5 min
  // so close → reopen hits the warm socket.
  useEffect(() => {
    if (isCollabPending) {
      setLoading(true);
      return;
    }
    if (!isCollabActive || !workspacePath) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let acquisition: BodyDocAcquisition | null = null;
    // Clear any stale paint from a prior itemId. A fresh fetch sets it
    // below; missing-cache items (new, never-saved) stay null and fall
    // through to the caller's mdContent fallback.
    setBodyCacheMarkdown(null);

    // Phase 4b cold-paint: fetch the latest `tracker_body_cache` row in
    // parallel with the Y.Doc connect. When present, the editor seeds
    // with this markdown immediately instead of waiting on the
    // WebSocket. `deferInitialSync: true` on CollabLexicalProvider keeps
    // the bootstrap decision behind the server's initial sync response,
    // so a non-empty room still wins; the cache row is just an
    // optimistic paint with the *correct* body version.
    const bodyCacheFetch: Promise<string | null> = (async () => {
      try {
        const result = await window.electronAPI.documentService.getTrackerBodyCacheForDetail({ itemId });
        if (!result.success || !result.row) return null;
        const raw = result.row.content;
        if (raw == null) return null;
        return typeof raw === 'string' ? raw : (raw?.markdown ?? null);
      } catch (err) {
        console.warn('[useTrackerContentCollab] body cache fetch failed:', err);
        return null;
      }
    })();

    const factory: BodyDocConfigFactory = async (id) => {
      const documentId = `tracker-content/${id}`;
      const uri = `collab://tracker-content/${id}`;
      const config = await resolveCollabConfigForUri(
        workspacePath,
        uri,
        documentId,
        `Tracker ${id}`,
      );
      if (!config) {
        console.warn('[useTrackerContentCollab] Failed to resolve collab config for:', id);
        return null;
      }
      // Capture the resolved username so a later re-acquire (warm cache,
      // no factory call) still has the right display name. The cache is
      // per-window; the same user owns every entry, so caching once is
      // safe.
      userNameRef.current = config.userName || config.userEmail || 'Anonymous';
      return {
        serverUrl: config.serverUrl,
        getJwt: config.getJwt,
        orgId: config.orgId,
        keyCustody: config.keyCustody,
        documentKey: config.documentKey,
        // Legacy org key so pre-migration tracker bodies still decrypt (NIM-878).
        legacyDocumentKey: config.legacyDocumentKey,
        orgKeyFingerprint: config.orgKeyFingerprint,
        userId: config.userId,
        documentId: config.documentId,
        createWebSocket: config.createWebSocket,
        // reviewGateEnabled is per-room; setting it at first-acquire is
        // correct -- multi-user state for a single team-room does not
        // change mid-session.
        reviewGateEnabled: isMultiUser,
      };
    };

    setLoading(true);
    const cache = getBodyDocCache();
    cache.acquire(itemId, factory, {
      onStatusChange: (newStatus) => {
        if (cancelled) return;
        setStatus(newStatus);
        collabProviderRef.current?.handleStatusChange(newStatus);
        if (newStatus === 'connected') {
          // Setting room metadata is idempotent on the server; do it on
          // every connect so a re-warmed provider re-asserts the TTL.
          acquisition?.syncProvider.setRoomMetadata({ ttl_ms: TRACKER_CONTENT_TTL_MS });
        }
      },
      onRemoteUpdate: (origin) => {
        if (cancelled) return;
        collabProviderRef.current?.handleRemoteUpdate(origin);
      },
      onReviewStateChange: (state) => {
        if (cancelled) return;
        setReviewState(state);
      },
    }).then(async (acq) => {
      if (cancelled) {
        acq?.release();
        return;
      }
      if (!acq) {
        setLoading(false);
        return;
      }
      // Resolve the body-cache fetch first so the cached markdown is in
      // state before we bump providerEpoch -- the `collaboration` memo
      // reads bodyCacheMarkdown at the same providerEpoch bump that
      // triggers the editor mount. Doing it after the acquire keeps the
      // releases ordered correctly on cancellation; the two requests ran
      // in parallel so this `await` is usually already settled.
      const cachedMarkdown = await bodyCacheFetch;
      if (cancelled) {
        acq.release();
        return;
      }
      setBodyCacheMarkdown(cachedMarkdown);
      acquisition = acq;
      syncProviderRef.current = acq.syncProvider;
      // `deferInitialSync` suppresses the immediate `sync(true)` that
      // CollabLexicalProvider normally fires on listener registration.
      // Instead, sync(true) fires only when the DocumentSyncProvider reaches
      // 'connected' status (i.e., after the server's initial sync response
      // has been applied). By that time Lexical's Y.Doc observer has
      // already rendered any existing server content, so the bootstrap
      // check (`_xmlText._length === 0`) correctly skips bootstrap on a
      // non-empty room instead of CRDT-merging stale PGLite content.
      collabProviderRef.current = acq.makeCollabProvider({ deferInitialSync: true });
      // Bump the epoch so the editor host can force-remount CollaborationPlugin.
      // CollaborationPlugin guards its one-time provider initialization with an
      // `isProviderInitialized` ref, so a stale plugin instance held across HMR
      // or React reconciliation would otherwise keep using the destroyed
      // provider and never register its sync listener on the new one.
      setProviderEpoch((e) => e + 1);
      setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      console.error('[useTrackerContentCollab] cache.acquire failed:', err);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      acquisition?.release();
      acquisition = null;
      syncProviderRef.current = null;
      collabProviderRef.current = null;
      setStatus('disconnected');
    };
  }, [itemId, workspacePath, isCollabActive, isCollabPending, isMultiUser]);

  const acceptRemoteChanges = useCallback(() => {
    syncProviderRef.current?.acceptRemoteChanges();
  }, []);

  const rejectRemoteChanges = useCallback(() => {
    syncProviderRef.current?.rejectRemoteChanges();
  }, []);

  const collaboration = useMemo(() => {
    if (!collabProviderRef.current || providerEpoch === 0) return null;

    const provider = collabProviderRef.current;
    const cachedMarkdown = bodyCacheMarkdown;

    return {
      providerFactory: (id: string, yjsDocMap: Map<string, Doc>): Provider => {
        yjsDocMap.set(id, provider.getYDoc());
        return provider;
      },
      // Always true: Lexical's internal `_xmlText._length === 0` check is
      // the real gate. Because `deferInitialSync` delays sync(true) until
      // the server response is applied, bootstrap will only run when the
      // shared text is still empty at that point (a new room). Non-empty
      // rooms skip bootstrap and render the server state.
      shouldBootstrap: true,
      username: userNameRef.current,
      cursorColor,
      initialEditorState: cachedMarkdown
        ? () => {
            const root = $getRoot();
            root.clear();
            $convertFromEnhancedMarkdownString(cachedMarkdown, getEditorTransformers());
          }
        : undefined,
    };
  }, [cursorColor, providerEpoch, bodyCacheMarkdown]);

  // Local-only tracker, or team-synced tracker in a workspace with no team.
  // Either way: no collab, parent should render the local PGLite editor.
  if (!isCollabActive && !isCollabPending) {
    return {
      collaboration: null, loading: false, status: 'disconnected',
      syncProvider: null, reviewState: null,
      acceptRemoteChanges: () => {}, rejectRemoteChanges: () => {},
      providerEpoch: 0,
      bodyCacheMarkdown: null,
    };
  }

  return {
    collaboration,
    loading,
    status,
    syncProvider: syncProviderRef.current,
    reviewState,
    acceptRemoteChanges,
    rejectRemoteChanges,
    providerEpoch,
    bodyCacheMarkdown,
  };
}
