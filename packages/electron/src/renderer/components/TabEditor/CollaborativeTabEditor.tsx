/**
 * CollaborativeTabEditor
 *
 * Tab shell for collaborative documents backed by DocumentSyncProvider.
 * No autosave, no file watcher, no history snapshots, no conflict dialog --
 * content syncs via Y.Doc over the encrypted WebSocket.
 *
 * The shell owns the DocumentSyncProvider lifecycle (creation, destruction,
 * key-rotation re-resolve, asset service, status/awareness atom wiring) and
 * dispatches to a branch component based on the document's logical type:
 *
 *   - 'markdown'  -> MarkdownCollabBranch: Lexical + CollabLexicalProvider +
 *                    LexicalDiffHeaderAdapter. The legacy code path; stays
 *                    special-cased and is not migrated onto the SDK hook.
 *   - 'excalidraw' / 'mindmap' / etc.
 *                 -> ExtensionCollabBranch: looks up the custom editor
 *                    registration whose manifest declares
 *                    `collaboration.supported: true`, builds an EditorHost
 *                    with `host.collaboration` populated, and renders the
 *                    extension component. The extension uses the SDK's
 *                    `useCollaborativeEditor` hook to wire its binding.
 *
 * State management:
 * - Connection status uses a Jotai atom family (keyed by filePath) so status
 *   changes never re-render the editor or its parent. Only the status bar
 *   subscribes to the atom.
 * - Awareness uses a Jotai atom family so only the avatar component re-renders
 *   when remote users join/leave/move cursors.
 * - Provider readiness uses a ref + one-time state flip (false -> true) that
 *   gates the initial editor mount. After that, no more re-renders.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MarkdownEditor, DocumentPathProvider } from '@nimbalyst/runtime';
import { $convertFromEnhancedMarkdownString, getEditorTransformers, type CommentsConfig } from '@nimbalyst/runtime/editor';
import { getTeamSyncProvider, sharedDocumentsAtom } from '../../store/atoms/collabDocuments';
import { buildCollabUri } from '../../utils/collabUri';
import { FixedTabHeaderContainer, FixedTabHeaderRegistry } from '@nimbalyst/runtime/plugins/shared/fixedTabHeader';
import { LexicalDiffHeaderAdapter } from '../UnifiedDiffHeader';
import { DocumentSyncProvider, CollabHistoryClient } from '@nimbalyst/runtime/sync';
import { CollabLexicalProvider } from '@nimbalyst/runtime/sync';
import { createRevisionAdapterFromCollabContent } from '@nimbalyst/runtime/sync';
import { historyDialogFileAtom } from '../../store/atoms/historyDialog';
import {
  collabHistoryControllerBumpAtom,
  registerCollabHistoryController,
  type CollabHistoryController,
} from '../../store/atoms/collabHistoryControllers';
import { $getRoot, type LexicalEditor } from 'lexical';
import type { EditorHost, ExtensionStorage } from '@nimbalyst/runtime';
import type { CollabDocumentConfig } from '../../utils/collabDocumentOpener';
import { resolveCollabConfigForUri } from '../../utils/collabDocumentOpener';
import { store, editorDirtyAtom, makeEditorKey, themeIdAtom } from '@nimbalyst/runtime/store';
import type { Doc } from 'yjs';
import type { Provider } from '@lexical/yjs';
import {
  collabAwarenessAtom,
  collabConnectionStatusAtom,
  collabKeyRotationEpochAtom,
  hasCollabUnsyncedChanges,
  type RemoteUser,
} from '../../store/atoms/collabEditor';
import { documentSyncRegistry } from '../../store/atoms/documentSyncRegistry';
import { CollabAssetService } from '../../services/CollabAssetService';
import { customEditorRegistry } from '../CustomEditors';
import type { CustomEditorRegistration } from '../CustomEditors/types';
import { useCollabLocalOrigin } from '../../hooks/useCollabLocalOrigin';
import { markDocViewed } from '../../hooks/useDocUnread';
import { getCollabContentAdapter } from '@nimbalyst/collab-adapters';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { FilePathBreadcrumb } from '../common/FilePathBreadcrumb';
import { UnifiedEditorHeaderBar } from './UnifiedEditorHeaderBar';
import {
  createCollaborationContext,
  createCollabExtensionHost,
  createExtensionAwarenessBridge,
  notifyCollabStatus,
} from './collabExtensionHost';

interface CollaborativeTabEditorProps {
  /** The collab:// URI for this document */
  filePath: string;
  /** Document title for display */
  fileName: string;
  /** Whether this tab is currently active */
  isActive: boolean;
  /** Collaboration connection config */
  collabConfig: CollabDocumentConfig;
  /** Dirty state callback */
  onDirtyChange?: (isDirty: boolean) => void;
  /** Callback when getContent function is available */
  onGetContentReady?: (getContentFn: () => string) => void;
  /** Callback when manual save function is ready */
  onManualSaveReady?: (saveFn: () => Promise<void>) => void;
}

// Generate a random color for cursor display
function randomCursorColor(): string {
  const colors = [
    '#E05555', '#2BA89A', '#3A8FD6', '#D97706',
    '#9B59B6', '#E06B8F', '#3B82F6', '#16A34A',
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

const AUTO_REVISION_POLL_MS = 30_000;
const AUTO_REVISION_IDLE_MS = 60_000;
const AUTO_REVISION_MIN_INTERVAL_MS = 5 * 60 * 1000;

function normalizeSnapshotBytes(snapshot: Uint8Array | ArrayBuffer): Uint8Array {
  return snapshot instanceof Uint8Array ? snapshot : new Uint8Array(snapshot);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Collaborative user avatars (subscribes to Jotai atom -- isolated re-renders)
// ---------------------------------------------------------------------------

const CollabAvatars: React.FC<{ filePath: string }> = ({ filePath }) => {
  const users = useAtomValue(collabAwarenessAtom(filePath));
  if (users.size === 0) return null;

  return (
    <div className="flex items-center -space-x-1.5">
      {[...users.entries()].map(([userId, user]) => {
        const initials = user.name
          .split(/\s+/)
          .map(w => w[0])
          .join('')
          .toUpperCase()
          .slice(0, 2) || '?';
        return (
          <div
            key={userId}
            className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium"
            style={{
              backgroundColor: user.color,
              color: '#fff',
              border: '1.5px solid var(--nim-bg-secondary)',
            }}
            title={user.name}
          >
            {initials}
          </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Status bar (subscribes to Jotai atom -- isolated re-renders)
// ---------------------------------------------------------------------------

const CollabStatusBar: React.FC<{
  filePath: string;
  fileName: string;
}> = ({ filePath, fileName }) => {
  const status = useAtomValue(collabConnectionStatusAtom(filePath));

  const statusDot = status === 'connected'
    ? 'bg-green-500'
    : status === 'replaying'
      ? 'bg-blue-500'
      : status === 'offline-unsynced'
        ? 'bg-orange-500'
    : status === 'error'
      ? 'bg-red-500'
    : status === 'connecting' || status === 'syncing'
      ? 'bg-yellow-500'
      : 'bg-gray-500';

  const statusLabel = status === 'connected'
    ? 'Connected'
    : status === 'replaying'
      ? 'Replaying local changes...'
      : status === 'offline-unsynced'
        ? 'Offline - unsynced changes'
    : status === 'error'
      ? 'Decryption failed - encryption key mismatch'
    : status === 'connecting'
      ? 'Connecting...'
    : status === 'syncing'
        ? 'Syncing...'
        : 'Disconnected';

  return (
    <div
      className="flex items-center gap-2 px-3 py-1 text-xs"
      style={{
        borderBottom: '1px solid var(--nim-border)',
        color: 'var(--nim-text-muted)',
        backgroundColor: 'var(--nim-bg-secondary)',
      }}
    >
      <div className={`w-2 h-2 rounded-full ${statusDot}`} />
      <span>{statusLabel}</span>
      <CollabAvatars filePath={filePath} />
      <span className="mx-1">|</span>
      <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>group</span>
      <span>{fileName}</span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Hydration gate overlay (NIM-949)
//
// Shared docs (especially server-only ones with no local file backing) must not
// present a blank, EDITABLE surface before the room hydrates -- typing into an
// unloaded doc is how a transient auth/connection blip became real lost work.
// Until first hydration we cover the editor with a non-interactive overlay that
// blocks pointer input and shows a loading/reconnecting state. Subscribes to the
// status atom directly so its text stays live without re-rendering the editor.
// ---------------------------------------------------------------------------

const CollabHydrationOverlay: React.FC<{ filePath: string }> = ({ filePath }) => {
  const status = useAtomValue(collabConnectionStatusAtom(filePath));
  const reconnecting = status === 'error' || status === 'disconnected' || status === 'offline-unsynced';
  return (
    <div
      className="collab-hydration-overlay absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-nim-muted"
      style={{ background: 'var(--nim-bg)', cursor: 'progress' }}
      // Block all pointer interaction with the un-hydrated editor beneath.
      onPointerDownCapture={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <span className="material-symbols-outlined animate-spin" style={{ fontSize: '20px' }}>progress_activity</span>
      <span className="text-sm">
        {reconnecting ? 'Reconnecting to server…' : 'Loading from server…'}
      </span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const CollaborativeTabEditor: React.FC<CollaborativeTabEditorProps> = ({
  filePath,
  fileName,
  isActive,
  collabConfig: initialCollabConfig,
  onDirtyChange,
  onGetContentReady,
  onManualSaveReady,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [activeConfig, setActiveConfig] = useState(initialCollabConfig);
  const syncProviderRef = useRef<DocumentSyncProvider | null>(null);
  const collabProviderRef = useRef<CollabLexicalProvider | null>(null);
  const getContentRef = useRef<(() => string) | null>(null);
  const lexicalEditorRef = useRef<LexicalEditor | null>(null);
  const historyControllerRef = useRef<CollabHistoryController | null>(null);
  const bootstrapEnsuredRef = useRef(false);
  const bootstrapInFlightRef = useRef(false);
  const lastObservedSnapshotHashRef = useRef<string | null>(null);
  const lastObservedSnapshotAtRef = useRef<number>(Date.now());
  const lastRecordedRevisionHashRef = useRef<string | null>(null);
  const lastAutoRevisionAtRef = useRef(0);
  const setHistoryDialogFile = useSetAtom(historyDialogFileAtom);
  const bumpHistoryControllers = useSetAtom(collabHistoryControllerBumpAtom);
  const isActiveRef = useRef(isActive);
  const docIndexUpdatedAtRef = useRef<number | null>(null);
  const sharedDocuments = useAtomValue(sharedDocumentsAtom);
  const cursorColor = useMemo(() => randomCursorColor(), []);
  const assetService = useMemo(() => new CollabAssetService(activeConfig), [activeConfig]);
  const localOrigin = useCollabLocalOrigin(
    activeConfig.workspacePath,
    activeConfig.documentId,
    activeConfig.documentType ?? 'markdown',
  );
  const keyRotationEpoch = useAtomValue(collabKeyRotationEpochAtom);
  // Captured Lexical editor instance -- needed by FixedTabHeader plugins
  // (search/replace, the unified diff header, etc.) when the agent applies edits.
  const [lexicalEditor, setLexicalEditor] = useState<any | null>(null);

  useEffect(() => {
    historyControllerRef.current = null;
    bootstrapEnsuredRef.current = false;
    bootstrapInFlightRef.current = false;
    lastObservedSnapshotHashRef.current = null;
    lastObservedSnapshotAtRef.current = Date.now();
    lastRecordedRevisionHashRef.current = null;
    lastAutoRevisionAtRef.current = 0;
  }, [activeConfig.orgId, activeConfig.documentId, filePath]);

  useEffect(() => {
    const doc = sharedDocuments.find((entry) => entry.documentId === activeConfig.documentId);
    docIndexUpdatedAtRef.current = doc?.updatedAt ?? null;
  }, [sharedDocuments, activeConfig.documentId]);

  const getDocReadWatermark = useCallback((provider: DocumentSyncProvider | null): number | null => {
    const contentUpdatedAt = provider?.getLastUpdatedAt() ?? null;
    const indexUpdatedAt = docIndexUpdatedAtRef.current;
    const watermark = Math.max(contentUpdatedAt ?? 0, indexUpdatedAt ?? 0);
    return watermark > 0 ? watermark : null;
  }, []);

  const createHistoryClient = useCallback(() => new CollabHistoryClient({
    serverUrl: activeConfig.serverUrl,
    getJwt: activeConfig.getJwt,
    urlExtraQuery: activeConfig.urlExtraQuery,
    orgId: activeConfig.orgId,
    documentId: activeConfig.documentId,
    keyCustody: activeConfig.keyCustody,
    documentKey: activeConfig.documentKey,
  }), [activeConfig]);

  const createRevisionFromCurrentSnapshot = useCallback(async (
    revisionKind: 'bootstrap' | 'manual' | 'auto',
    options: { skipIfLatestMatches?: boolean } = {}
  ): Promise<boolean> => {
    const controller = historyControllerRef.current;
    if (!controller?.exportSnapshot) return false;
    if (controller.getStatus() !== 'connected') return false;

    const snapshot = normalizeSnapshotBytes(await controller.exportSnapshot());
    // An empty snapshot has nothing to record, and the server rejects a revision
    // with an empty encryptedSnapshot (400 "payload.encryptedSnapshot is
    // required"). This happens when the body never hydrated (e.g. an undecodable
    // snapshot left the Y.Doc blank) -- don't push a bootstrap/auto revision for
    // it. See NIM-959.
    if (snapshot.length === 0) return false;
    const contentHash = await sha256Hex(snapshot);
    if (options.skipIfLatestMatches && contentHash === lastRecordedRevisionHashRef.current) {
      lastObservedSnapshotHashRef.current = contentHash;
      lastObservedSnapshotAtRef.current = Date.now();
      return false;
    }

    await controller.client.createRevision({
      revisionKind,
      editorType: controller.editorType,
      contentFormat: controller.contentFormat,
      plaintext: snapshot,
      basisSequence: controller.getBasisSequence(),
    });

    const now = Date.now();
    lastObservedSnapshotHashRef.current = contentHash;
    lastObservedSnapshotAtRef.current = now;
    lastRecordedRevisionHashRef.current = contentHash;
    if (revisionKind === 'auto') {
      lastAutoRevisionAtRef.current = now;
    }
    return true;
  }, []);

  const runManualSave = useCallback(async (): Promise<void> => {
    try {
      await createRevisionFromCurrentSnapshot('manual');
    } catch (error) {
      console.warn('[CollaborativeTabEditor] Failed to create manual revision', error);
    }
  }, [createRevisionFromCurrentSnapshot]);

  const ensureBootstrapRevision = useCallback(async (): Promise<void> => {
    const controller = historyControllerRef.current;
    if (!controller?.exportSnapshot) return;
    if (controller.getStatus() !== 'connected') return;
    if (bootstrapEnsuredRef.current || bootstrapInFlightRef.current) return;

    bootstrapInFlightRef.current = true;
    try {
      const response = await controller.client.listRevisions({ limit: 1 });
      const latestRevision = response.revisions[0] ?? null;
      if (latestRevision) {
        bootstrapEnsuredRef.current = true;
        lastRecordedRevisionHashRef.current = latestRevision.contentHash;
        lastObservedSnapshotHashRef.current = latestRevision.contentHash;
        lastObservedSnapshotAtRef.current = Date.now();
        if (latestRevision.revisionKind === 'auto') {
          lastAutoRevisionAtRef.current = latestRevision.createdAt;
        }
        return;
      }

      await createRevisionFromCurrentSnapshot('bootstrap');
      bootstrapEnsuredRef.current = true;
    } catch (error) {
      console.warn('[CollaborativeTabEditor] Failed to ensure bootstrap revision', error);
    } finally {
      bootstrapInFlightRef.current = false;
    }
  }, [createRevisionFromCurrentSnapshot]);

  // Re-key: when the rotation epoch changes, re-fetch config with new encryption key
  useEffect(() => {
    if (keyRotationEpoch === 0) return; // Initial render, no rotation yet

    console.log('[CollaborativeTabEditor] Key rotation detected (epoch:', keyRotationEpoch, '), re-fetching config...');

    resolveCollabConfigForUri(
      activeConfig.workspacePath,
      filePath,
      activeConfig.documentId,
      activeConfig.title,
    ).then((freshConfig) => {
      if (freshConfig) {
        console.log('[CollaborativeTabEditor] Got fresh config with new key, recreating providers');
        setActiveConfig(freshConfig);
      } else {
        console.warn('[CollaborativeTabEditor] Failed to get fresh config after key rotation');
      }
    });
  }, [keyRotationEpoch]); // eslint-disable-line react-hooks/exhaustive-deps
  // providerReady flips once from false->true. Using a ref + forceUpdate
  // avoids the render loop from useState. We only need one re-render to
  // mount MarkdownEditor, then never again.
  const providerReadyRef = useRef(false);
  const [, forceUpdate] = React.useReducer(x => x + 1, 0);
  // NIM-949: flips false->true the first time the room hydrates (status reaches
  // 'connected'/'replaying'). Drives the hydration-gate overlay. One-time flip.
  const [hasHydrated, setHasHydrated] = useState(false);

  // Create the DocumentSyncProvider and CollabLexicalProvider on mount.
  // IMPORTANT: We do NOT call connect() here. CollaborationPlugin calls
  // provider.connect() itself after registering its onSync listener.
  // If we connect early, the sync event fires before the listener is
  // registered and the bootstrap / initial content seeding is missed.
  useEffect(() => {
    isActiveRef.current = isActive;
    if (window.electronAPI?.setDocumentEdited) {
      const status = syncProviderRef.current?.getStatus() ?? 'disconnected';
      window.electronAPI.setDocumentEdited(
        isActive && hasCollabUnsyncedChanges(status)
      );
    }
    // Switching to this doc (already synced) marks it read.
    if (isActive && activeConfig.orgId && syncProviderRef.current?.isSynced()) {
      void markDocViewed(
        activeConfig.documentId,
        activeConfig.orgId,
        getDocReadWatermark(syncProviderRef.current),
      );
    }
  }, [isActive, activeConfig.documentId, activeConfig.orgId, getDocReadWatermark]);

  useEffect(() => {
    console.log('[CollaborativeTabEditor] Creating providers, initialContent:', !!activeConfig.initialContent);

    const syncProvider = new DocumentSyncProvider({
      serverUrl: activeConfig.serverUrl,
      getJwt: activeConfig.getJwt,
      orgId: activeConfig.orgId,
      keyCustody: activeConfig.keyCustody,
      documentKey: activeConfig.documentKey,
      // Legacy org key so pre-migration shared-doc rows still decrypt (NIM-878).
      legacyDocumentKey: activeConfig.legacyDocumentKey,
      orgKeyFingerprint: activeConfig.orgKeyFingerprint,
      userId: activeConfig.userId,
      documentId: activeConfig.documentId,
      createWebSocket: activeConfig.createWebSocket,
      onStatusChange: (status) => {
        console.log('[CollaborativeTabEditor] Status change:', status);
        // Write to Jotai atom -- only CollabStatusBar re-renders
        store.set(collabConnectionStatusAtom(filePath), status);
        // NIM-949: the room has hydrated once it reaches a synced state. From
        // then on the editor is safe to interact with even if it later goes
        // offline-unsynced (we now hold the content). setState bails out on the
        // repeat 'connected' values, so this re-renders the editor only once.
        if (status === 'connected' || status === 'replaying') {
          setHasHydrated(true);
        }
        if (isActiveRef.current && window.electronAPI?.setDocumentEdited) {
          window.electronAPI.setDocumentEdited(hasCollabUnsyncedChanges(status));
        }
        // Forward to CollabLexicalProvider (markdown path) and to any SDK
        // subscribers registered via host.collaboration.onStatusChange
        // (extension path). Both fan-outs are no-ops when the corresponding
        // branch isn't active.
        collabProviderRef.current?.handleStatusChange(status);
        if (syncProviderRef.current) {
          notifyCollabStatus(syncProviderRef.current, status);
        }
        if (status === 'connected') {
          void ensureBootstrapRevision();
          // Mark the doc read once it has synced, if the user is looking at it.
          // Clears its unread dot in the sidebar. Watermark = the doc's current
          // content timestamp so a later teammate edit re-surfaces as unread.
          if (isActiveRef.current && activeConfig.orgId) {
            void markDocViewed(
              activeConfig.documentId,
              activeConfig.orgId,
              getDocReadWatermark(syncProvider),
            );
          }
        }
      },
      initialPendingUpdateBase64: activeConfig.pendingUpdateBase64,
      onPendingUpdateChange: async (pendingUpdateBase64) => {
        await window.electronAPI.documentSync.setPendingUpdate(
          activeConfig.workspacePath,
          activeConfig.orgId,
          activeConfig.documentId,
          pendingUpdateBase64,
        );
      },
      onRemoteUpdate: (origin) => {
        // Forward to CollabLexicalProvider
        collabProviderRef.current?.handleRemoteUpdate(origin);
      },
      // Review gate disabled for now -- will be enabled in Phase 4c
      reviewGateEnabled: false,
    });

    // Subscribe to awareness changes and write to Jotai atom
    const awarenessUnsub = syncProvider.onAwarenessChange((states) => {
      const users = new Map<string, RemoteUser>();
      for (const [userId, state] of states) {
        users.set(userId, { name: state.user.name, color: state.user.color });
      }
      store.set(collabAwarenessAtom(filePath), users);
    });

    const collabProvider = new CollabLexicalProvider(syncProvider, {
      // Shared docs are server-authoritative. Let the server's initial sync
      // land before Lexical considers the room bootstrapped, otherwise a local
      // seed can duplicate or resurrect content.
      deferInitialSync: true,
    });

    syncProviderRef.current = syncProvider;
    collabProviderRef.current = collabProvider;

    // Register with the DocumentSync registry so the network-available cascade
    // can kick this provider's reconnect loop after the CollabV3 index is
    // confirmed healthy (see networkAvailabilityListeners.ts).
    documentSyncRegistry.register(syncProvider);

    // One-time flip: mount MarkdownEditor
    if (!providerReadyRef.current) {
      providerReadyRef.current = true;
      forceUpdate();
    }

    return () => {
      awarenessUnsub();
      documentSyncRegistry.unregister(syncProvider);
      syncProvider.destroy();
      syncProviderRef.current = null;
      collabProviderRef.current = null;
      if (isActiveRef.current && window.electronAPI?.setDocumentEdited) {
        window.electronAPI.setDocumentEdited(false);
      }
      // Clean up the atoms
      store.set(collabConnectionStatusAtom(filePath), 'disconnected');
      store.set(collabAwarenessAtom(filePath), new Map());
    };
  }, [activeConfig, ensureBootstrapRevision, filePath, getDocReadWatermark]);

  // Build the provider factory for CollaborationPlugin
  // This function is called by CollaborationPlugin with a doc ID and yjsDocMap.
  // We return our adapter which already has the Y.Doc from DocumentSyncProvider.
  const providerFactory = useCallback((id: string, yjsDocMap: Map<string, Doc>): Provider => {
    console.log('[CollaborativeTabEditor] providerFactory called, id:', id, 'providerReady:', !!collabProviderRef.current);
    const provider = collabProviderRef.current;
    if (!provider) {
      throw new Error('[CollaborativeTabEditor] CollabLexicalProvider not initialized');
    }

    // Register our Y.Doc in the yjsDocMap so CollaborationPlugin can find it
    const ydoc = provider.getYDoc();
    yjsDocMap.set(id, ydoc);
    console.log('[CollaborativeTabEditor] Y.Doc registered in yjsDocMap');

    return provider;
  }, []);

  // Memoize the collaboration config for MarkdownEditor so that
  // re-renders never cascade through to Lexical/CollaborationPlugin.
  const collaborationMemoConfig = useMemo(() => ({
    providerFactory,
    shouldBootstrap: !!activeConfig.initialContent,
    initialContent: activeConfig.initialContent,
    username: activeConfig.userName || activeConfig.userId,
    cursorColor,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [providerFactory, activeConfig.initialContent, activeConfig.userName, activeConfig.userId, cursorColor]);

  // Document comments config for the markdown collab branch. Comments live in
  // the same shared Y.Doc (top-level `comments` array); @-mentions fan out as
  // inbox events through the TeamSyncProvider.
  const commentsMemoConfig = useMemo<CommentsConfig>(() => ({
    getYDoc: () => collabProviderRef.current?.getYDoc() ?? null,
    currentUser: {
      id: activeConfig.userId,
      name: activeConfig.userName || activeConfig.userEmail || activeConfig.userId,
    },
    getMembers: () => {
      const teamProvider = getTeamSyncProvider(activeConfig.workspacePath);
      const members = teamProvider?.getTeamState()?.members ?? [];
      return members
        .filter((m) => m.userId !== activeConfig.userId)
        .map((m) => ({
          userId: m.userId,
          name: m.email || m.userId,
          personalOrgId: m.personalOrgId,
        }));
    },
    documentTitle: activeConfig.title,
    documentId: activeConfig.documentId,
    documentUri: buildCollabUri(activeConfig.orgId, activeConfig.documentId),
    onMention: (recipientUserIds, payload) => {
      const teamProvider = getTeamSyncProvider(activeConfig.workspacePath);
      if (!teamProvider) {
        console.warn('[CollaborativeTabEditor] No TeamSyncProvider for mention fanout');
        return;
      }
      void teamProvider
        .fanoutInboxEvent({
          recipients: recipientUserIds,
          kind: 'mention',
          sourceKind: 'lexical_document',
          sourceId: activeConfig.documentId,
          payload,
        })
        .catch((err) => {
          console.warn('[CollaborativeTabEditor] fanoutInboxEvent failed', err);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [
    activeConfig.userId,
    activeConfig.userName,
    activeConfig.userEmail,
    activeConfig.workspacePath,
    activeConfig.title,
    activeConfig.documentId,
    activeConfig.orgId,
  ]);

  const markdownConfig = useMemo(() => ({
    onUploadAsset: (file: File) => assetService.uploadFile(file),
    onAssetReferencesRemoved: (removedUris: string[]) => {
      // Fire-and-forget; main deletes exactly the URIs the plugin saw
      // disappear (never the full server set), so we can't accidentally
      // delete a peer's still-live attachment.
      void assetService.notifyAssetReferencesRemoved(removedUris).catch(err => {
        console.warn('[CollaborativeTabEditor] gc-assets failed', err);
      });
    },
  }), [assetService]);

  // Create a minimal EditorHost for collaboration mode
  // Most operations are no-ops since content syncs via Y.Doc
  const editorHost = useMemo((): EditorHost => {
    const editorKey = makeEditorKey(filePath);

    // No-op storage for collaborative docs
    const storage: ExtensionStorage = {
      get: () => undefined,
      set: async () => {},
      delete: async () => {},
      getGlobal: () => undefined,
      setGlobal: async () => {},
      deleteGlobal: async () => {},
      getSecret: async () => undefined,
      setSecret: async () => {},
      deleteSecret: async () => {},
    };

    return {
      filePath,
      fileName,
      get theme() { return 'auto'; },
      get isActive() { return isActive; },
      workspaceId: undefined,

      onThemeChanged: () => () => {},

      // Content loading: return initial content if seeding, otherwise empty.
      // CollaborationPlugin hydrates from Y.Doc when shouldBootstrap is false.
      async loadContent(): Promise<string> {
        return activeConfig.initialContent || '';
      },

      async loadBinaryContent(): Promise<ArrayBuffer> {
        return new ArrayBuffer(0);
      },

      // File change: no-op. Changes come through Y.Doc.
      onFileChanged(): () => void {
        return () => {};
      },

      // Dirty state: write to Jotai atom
      setDirty(isDirty: boolean): void {
        store.set(editorDirtyAtom(editorKey), isDirty);
        onDirtyChange?.(isDirty);
      },

      // Save: no-op. Content syncs via Y.Doc.
      async saveContent(): Promise<void> {
        // No disk saves for collaborative documents
      },

      // Save request: no-op subscription
      onSaveRequested(): () => void {
        return () => {};
      },

      openHistory(): void {
        setHistoryDialogFile(filePath);
      },

      storage,

      setEditorContext(): void {},

      registerEditorAPI(): void {},

      registerMenuItems(): void {},
    };
  }, [filePath, fileName, isActive, onDirtyChange, setHistoryDialogFile]);

  // Expose manual save as "save a shared revision". This keeps Cmd/Ctrl+S
  // meaningful in collaboration mode even though there is no local disk save.
  useEffect(() => {
    if (onManualSaveReady) {
      onManualSaveReady(runManualSave);
    }
  }, [onManualSaveReady, runManualSave]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // Capture-phase listener so Cmd/Ctrl+S inside the collab editor records
    // a manual revision before Lexical's own keybinding swallows the event.
    // The parent TabEditor also wires Cmd+S via onManualSaveReady, but its
    // React handler runs on bubble and Lexical can stop propagation before
    // it fires.
    const isMac = /Mac/i.test(navigator.userAgent);
    const onKeyDown = (event: KeyboardEvent) => {
      const isAppModifier = isMac ? event.metaKey : event.ctrlKey;
      if (!isAppModifier || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void runManualSave();
    };

    root.addEventListener('keydown', onKeyDown, true);
    return () => root.removeEventListener('keydown', onKeyDown, true);
  }, [runManualSave]);

  // Periodic auto snapshots for collaborative docs. We watch the current
  // editor snapshot on a low-frequency loop, mark when content last changed,
  // and only emit an `auto` revision after the document has been idle for a
  // bit and the latest content is not already represented by a known revision.
  useEffect(() => {
    let cancelled = false;
    // Guard against overlapping ticks: exportSnapshot + sha256 + POST can
    // exceed the poll interval, and two concurrent ticks would race on the
    // bookkeeping refs (idle timer, last-recorded hash).
    let running = false;

    const tick = async () => {
      if (running) return;
      const controller = historyControllerRef.current;
      if (!controller?.exportSnapshot) return;
      if (controller.getStatus() !== 'connected') return;
      if (!bootstrapEnsuredRef.current) return;

      running = true;
      try {
        const snapshot = normalizeSnapshotBytes(await controller.exportSnapshot());
        if (cancelled) return;

        // An empty snapshot base64-encodes to '', which the revisions endpoint
        // rejects ("payload.encryptedSnapshot is required"). Because the failed
        // POST never records the revision, the idle doc would retry every poll
        // forever. Skip empty snapshots entirely.
        if (snapshot.byteLength === 0) return;

        const contentHash = await sha256Hex(snapshot);
        if (cancelled) return;

        if (contentHash !== lastObservedSnapshotHashRef.current) {
          lastObservedSnapshotHashRef.current = contentHash;
          lastObservedSnapshotAtRef.current = Date.now();
          return;
        }

        const now = Date.now();
        if (now - lastObservedSnapshotAtRef.current < AUTO_REVISION_IDLE_MS) return;
        if (now - lastAutoRevisionAtRef.current < AUTO_REVISION_MIN_INTERVAL_MS) return;
        if (contentHash === lastRecordedRevisionHashRef.current) return;

        try {
          await controller.client.createRevision({
            revisionKind: 'auto',
            editorType: controller.editorType,
            contentFormat: controller.contentFormat,
            plaintext: snapshot,
            basisSequence: controller.getBasisSequence(),
          });
          if (cancelled) return;
          lastRecordedRevisionHashRef.current = contentHash;
          lastAutoRevisionAtRef.current = now;
        } catch (error) {
          console.warn('[CollaborativeTabEditor] Failed to create auto revision', error);
        }
      } finally {
        running = false;
      }
    };

    void tick();
    const intervalId = window.setInterval(() => {
      void tick();
    }, AUTO_REVISION_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeConfig.documentId, activeConfig.orgId]);

  // Decrement the main-side collab-asset:// registry refcount on unmount
  // and on every activeConfig swap (key rotation re-resolves config, which
  // re-calls document-sync:open and bumps the refcount). Pairing the
  // close with each activeConfig assignment keeps the counter balanced.
  useEffect(() => {
    const documentId = activeConfig.documentId;
    return () => {
      void window.electronAPI.documentSync.closeDoc(documentId).catch(err => {
        console.warn('[CollaborativeTabEditor] close-doc failed', err);
      });
    };
  }, [activeConfig]);

  // ---- Branch selection ---------------------------------------------------
  const documentType = activeConfig.documentType ?? 'markdown';
  const extensionRegistration: CustomEditorRegistration | null = useMemo(() => {
    if (documentType === 'markdown') return null;
    // Look up by the share filename, which carries the extension (e.g.
    // `MyDrawing.excalidraw`). Falls back to `<title>.<documentType>` so
    // recipients of a doc shared with a bare title still get routed to
    // the right editor.
    const lookupName =
      fileName.includes('.') ? fileName : `${activeConfig.title}.${documentType}`;
    const match = customEditorRegistry.findRegistrationForFile(lookupName);
    if (!match) return null;
    if (!match.collaboration?.supported) return null;
    return match;
  }, [documentType, fileName, activeConfig.title]);
  // Manual resync ("Re-upload to Shared Doc"). For an OPEN custom-editor collab
  // doc we MUST write through the live renderer connection: the default IPC
  // path opens a throwaway main-process provider that connects -> writes ->
  // disconnects, and the collab room (Durable Object) can evict before durably
  // persisting when no client stays connected, so the upload is silently lost.
  // The open editor's provider stays connected, so applying the local file via
  // the live Y.Doc both repaints the canvas (the binding observes the change)
  // and durably syncs to the server. Falls back to the IPC when the doc isn't
  // open or is markdown (which has its own bootstrap path).
  const handleReuploadFromLocal = useCallback(async () => {
    const provider = syncProviderRef.current;
    if (documentType !== 'markdown' && provider) {
      try {
        const adapter = getCollabContentAdapter(documentType);
        const originRes = await window.electronAPI?.documentSync?.getLocalOrigin?.(
          activeConfig.workspacePath,
          activeConfig.documentId,
        );
        const localPath = originRes?.binding?.resolvedPath;
        if (adapter?.applyFromFile && localPath && window.electronAPI?.readFileContent) {
          const fileRes = await window.electronAPI.readFileContent(localPath);
          if (fileRes?.success && typeof fileRes.content === 'string') {
            adapter.applyFromFile(provider.getYDoc(), fileRes.content);
            // Durably persist to the server before reporting success -- a
            // timed-out flush means a teammate / reopen may still see the old
            // room, so surface that instead of a false "updated" toast.
            const acked = await provider.flushWithAck(8000);
            console.log(
              `[CollaborativeTabEditor] live re-upload flushed: acked=${acked} type=${documentType} doc=${activeConfig.documentId} bytes=${fileRes.content.length}`,
            );
            if (!acked) {
              errorNotificationService.showError(
                'Re-upload not confirmed',
                'The push was sent but the server did not confirm persisting it. Check your connection and retry.',
              );
              return;
            }
            errorNotificationService.showInfo(
              'Shared document updated',
              'Pushed the current local file into the shared document.',
              { duration: 4000 },
            );
            await localOrigin.refresh();
            return;
          }
        }
      } catch (err) {
        console.error('[CollaborativeTabEditor] live re-upload failed; falling back to IPC', err);
      }
    }
    // Doc not open / not a custom editor -> main-process re-upload.
    void localOrigin.reuploadFromLocalSource();
  }, [documentType, activeConfig, localOrigin]);

  const localOriginActionItems = useMemo(() => {
    const actionDisabled = localOrigin.busyAction !== null;
    return [
      {
        label: 'Open Local',
        icon: 'folder_open',
        disabled: !localOrigin.hasResolvedBinding || actionDisabled,
        onClick: () => {
          void localOrigin.openLocalSource();
        },
      },
      {
        label: 'Re-upload to Shared Doc',
        icon: 'upload',
        disabled: !localOrigin.binding || actionDisabled,
        onClick: () => {
          void handleReuploadFromLocal();
        },
      },
      {
        label: localOrigin.binding ? 'Relink Local Source' : 'Link Local Source',
        icon: 'link',
        disabled: actionDisabled,
        onClick: () => {
          void localOrigin.relinkLocalSource();
        },
      },
      {
        label: 'Clear Local Source',
        icon: 'link_off',
        disabled: !localOrigin.binding || actionDisabled,
        onClick: () => {
          void localOrigin.clearLocalSource();
        },
      },
    ];
  }, [localOrigin, handleReuploadFromLocal]);
  const handleLexicalEditorReady = useCallback((editor: any) => {
    setLexicalEditor((prev: any) => (prev === editor ? prev : editor));
    lexicalEditorRef.current = editor ?? null;
    setTimeout(() => {
      FixedTabHeaderRegistry.getInstance().notifyChange();
    }, 150);
  }, []);

  const handleGetContentReady = useCallback((fn: () => string) => {
    getContentRef.current = fn;
    onGetContentReady?.(fn);
  }, [onGetContentReady]);

  // Publish a per-tab history controller so the CollabHistoryDialog can
  // list / load / create revisions against the live document key without
  // re-resolving config or threading callbacks through Jotai.
  useEffect(() => {
    if (documentType !== 'markdown') return;
    const syncProvider = syncProviderRef.current;
    if (!syncProvider) return;
    if (!lexicalEditor) return;

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const controller: CollabHistoryController = {
      client: createHistoryClient(),
      editorType: 'markdown',
      contentFormat: 'markdown',
      previewKind: 'text',
      exportSnapshot: () => {
        const getContent = getContentRef.current;
        const markdown = getContent ? getContent() : '';
        return encoder.encode(markdown);
      },
      applySnapshot: (plaintext: Uint8Array) => {
        const editor = lexicalEditorRef.current;
        if (!editor) return;
        const markdown = decoder.decode(plaintext);
        editor.update(() => {
          const root = $getRoot();
          root.clear();
          $convertFromEnhancedMarkdownString(markdown, getEditorTransformers());
        });
      },
      getBasisSequence: () => syncProvider.getLastSeq(),
      getStatus: () => syncProvider.getStatus(),
      waitForPendingWrites: (timeoutMs?: number) => syncProvider.waitForPendingWrites(timeoutMs),
    };
    historyControllerRef.current = controller;

    const unregister = registerCollabHistoryController(
      filePath,
      controller,
      () => bumpHistoryControllers()
    );
    void ensureBootstrapRevision();

    return () => {
      if (historyControllerRef.current === controller) {
        historyControllerRef.current = null;
      }
      unregister();
    };
  }, [bumpHistoryControllers, createHistoryClient, documentType, ensureBootstrapRevision, filePath, lexicalEditor]);

  return (
    <div ref={rootRef} className="collaborative-tab-editor" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Connection status bar -- subscribes to Jotai atom, isolated re-renders */}
      <CollabStatusBar
        filePath={filePath}
        fileName={fileName}
      />

      <UnifiedEditorHeaderBar
        filePath={filePath}
        fileName={fileName}
        workspaceId={activeConfig.workspacePath}
        isMarkdown={documentType === 'markdown'}
        lexicalEditor={documentType === 'markdown' ? (lexicalEditor ?? undefined) : undefined}
        breadcrumbContent={
          localOrigin.binding?.resolvedPath ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-[var(--nim-text-faint)] text-[12px] uppercase tracking-wide">
                Uploaded from
              </span>
              <FilePathBreadcrumb
                filePath={localOrigin.binding.resolvedPath}
                workspacePath={activeConfig.workspacePath}
                className="min-w-0 flex-1"
              />
            </div>
          ) : localOrigin.binding ? (
            <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
              <span className="shrink-0 text-[var(--nim-text-faint)] text-[12px] uppercase tracking-wide">
                Uploaded from
              </span>
              <span className="truncate text-[var(--nim-warning)]">
                {localOrigin.binding.relativePath} (missing)
              </span>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
              <span className="shrink-0 text-[var(--nim-text-faint)] text-[12px] uppercase tracking-wide">
                Shared doc
              </span>
              <span className="truncate text-[var(--nim-text)] font-medium">{fileName}</span>
            </div>
          )
        }
        showShareLinkButton={false}
        showSharedDocButton={false}
        showHistoryAction={true}
        showCommonFileActions={false}
        extraActionItems={localOriginActionItems}
      />

      {/* Editor area */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {/* NIM-949: gate editing until the room hydrates, so a server-only doc
            never presents a blank editable surface during a connection/auth blip. */}
        {providerReadyRef.current && !hasHydrated && (
          <CollabHydrationOverlay filePath={filePath} />
        )}
        {!providerReadyRef.current ? (
          <div className="flex items-center justify-center h-full text-nim-muted">
            Connecting to document...
          </div>
        ) : documentType === 'markdown' ? (
          <DocumentPathProvider documentPath={filePath}>
            <FixedTabHeaderContainer
              filePath={filePath}
              fileName={fileName}
              editor={lexicalEditor ?? undefined}
            />
            {/* Accept/reject bar when an AI edit is pending review. Mirrors
                the TabEditor markdown branch. */}
            <LexicalDiffHeaderAdapter
              editor={lexicalEditor ?? undefined}
              filePath={filePath}
              fileName={fileName}
            />
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <MarkdownEditor
                host={editorHost}
                config={markdownConfig}
                onGetContent={handleGetContentReady}
                onEditorReady={handleLexicalEditorReady}
                collaborationConfig={collaborationMemoConfig}
                commentsConfig={commentsMemoConfig}
              />
            </div>
          </DocumentPathProvider>
        ) : extensionRegistration && syncProviderRef.current ? (
          <ExtensionCollabBranch
            registration={extensionRegistration}
            syncProvider={syncProviderRef.current}
            filePath={filePath}
            fileName={fileName}
            isActive={isActive}
            activeConfig={activeConfig}
            createHistoryClient={createHistoryClient}
            onHistoryControllerChange={(controller) => {
              historyControllerRef.current = controller;
              if (controller?.exportSnapshot) {
                void ensureBootstrapRevision();
              }
            }}
            onDirtyChange={onDirtyChange}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-nim-muted">
            No editor available for document type: {documentType}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Extension branch (Excalidraw, Mindmap, etc.)
// ---------------------------------------------------------------------------

interface ExtensionCollabBranchProps {
  registration: CustomEditorRegistration;
  syncProvider: DocumentSyncProvider;
  filePath: string;
  fileName: string;
  isActive: boolean;
  activeConfig: CollabDocumentConfig;
  createHistoryClient: () => CollabHistoryClient;
  onHistoryControllerChange: (controller: CollabHistoryController | null) => void;
  onDirtyChange?: (isDirty: boolean) => void;
}

const ExtensionCollabBranch: React.FC<ExtensionCollabBranchProps> = ({
  registration,
  syncProvider,
  filePath,
  fileName,
  isActive,
  activeConfig,
  createHistoryClient,
  onHistoryControllerChange,
  onDirtyChange,
}) => {
  const setHistoryDialogFile = useSetAtom(historyDialogFileAtom);
  const bumpHistoryControllers = useSetAtom(collabHistoryControllerBumpAtom);
  const adapterRef = useRef<import('@nimbalyst/runtime').RevisionSnapshotAdapter | null>(null);
  const unregisterControllerRef = useRef<(() => void) | null>(null);

  const publishHistoryController = useCallback((adapter: import('@nimbalyst/runtime').RevisionSnapshotAdapter | null) => {
    unregisterControllerRef.current?.();
    unregisterControllerRef.current = null;

    // Fallback: if the extension didn't supply a per-tab snapshot adapter,
    // try to synthesise one from the registered CollabContentAdapter for
    // this documentType. This is the "fold" in
    // design/Collaboration/collab-content-adapter.md -- extensions that
    // register a content adapter get history support for free.
    const effectiveAdapter =
      adapter ??
      (activeConfig.documentType
        ? createRevisionAdapterFromCollabContent({
            documentType: activeConfig.documentType,
            getYDoc: () => syncProvider.getYDoc(),
          })
        : null);

    const controller: CollabHistoryController = {
      client: createHistoryClient(),
      editorType: activeConfig.documentType ?? 'custom',
      contentFormat: effectiveAdapter?.contentFormat ?? (activeConfig.documentType ?? 'metadata-only'),
      previewKind: effectiveAdapter?.previewKind ?? 'metadata-only',
      exportSnapshot: effectiveAdapter ? () => effectiveAdapter.exportRevisionSnapshot() : undefined,
      applySnapshot: effectiveAdapter ? (bytes) => effectiveAdapter.restoreRevisionSnapshot(bytes) : undefined,
      getBasisSequence: () => syncProvider.getLastSeq(),
      getStatus: () => syncProvider.getStatus(),
      waitForPendingWrites: (timeoutMs?: number) => syncProvider.waitForPendingWrites(timeoutMs),
    };

    onHistoryControllerChange(controller);
    unregisterControllerRef.current = registerCollabHistoryController(
      filePath,
      controller,
      () => bumpHistoryControllers()
    );
  }, [activeConfig.documentType, bumpHistoryControllers, createHistoryClient, filePath, onHistoryControllerChange, syncProvider]);
  // Build the y-protocols Awareness + DocumentSync bridge.
  // Created once per provider instance; recreated when activeConfig changes
  // (which already recreates the syncProvider above).
  const bridgeRef = useRef<ReturnType<typeof createExtensionAwarenessBridge> | null>(null);
  if (!bridgeRef.current) {
    bridgeRef.current = createExtensionAwarenessBridge({
      syncProvider,
      yDoc: syncProvider.getYDoc(),
      user: {
        id: activeConfig.userId,
        name: activeConfig.userName ?? activeConfig.userId,
        color: '#3A8FD6',
      },
    });
  }
  useEffect(() => {
    return () => {
      bridgeRef.current?.destroy();
      bridgeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Markdown collaboration is connected by Lexical's CollaborationPlugin via
  // CollabLexicalProvider.connect(). Custom editors bypass that plugin, so the
  // host must explicitly connect the shared DocumentSyncProvider here.
  useEffect(() => {
    void syncProvider.connect().catch((error) => {
      console.error('[ExtensionCollabBranch] Failed to connect DocumentSyncProvider:', {
        documentId: activeConfig.documentId,
        error,
      });
    });
  }, [syncProvider, activeConfig.documentId]);

  useEffect(() => {
    if (!adapterRef.current) {
      publishHistoryController(null);
    }
  }, [publishHistoryController]);

  const collaboration = useMemo(
    () =>
      createCollaborationContext({
        syncProvider,
        awareness: bridgeRef.current!.awareness,
        activeConfig,
        onRevisionAdapterChange: (adapter) => {
          adapterRef.current = adapter;
          publishHistoryController(adapter);
        },
      }),
    [activeConfig, publishHistoryController, syncProvider]
  );

  // Tear down the controller when the branch unmounts.
  useEffect(() => {
    return () => {
      onHistoryControllerChange(null);
      unregisterControllerRef.current?.();
      unregisterControllerRef.current = null;
    };
  }, [onHistoryControllerChange]);

  // Theme bridge for the extension host. The host reads the current
  // theme via `getTheme()` (always fresh, no host recreate) and
  // subscribes to theme changes through `subscribeToThemeChanges`.
  // Mirrors how TabEditor wires non-collab custom editors.
  const themeChangeCallbackRef = useRef<((theme: string) => void) | null>(null);
  useEffect(() => {
    const unsubscribe = store.sub(themeIdAtom, () => {
      const next = store.get(themeIdAtom);
      themeChangeCallbackRef.current?.(next);
    });
    return unsubscribe;
  }, []);

  const host = useMemo(
    () =>
      createCollabExtensionHost({
        filePath,
        fileName,
        isActive,
        workspaceId: activeConfig.workspacePath,
        activeConfig,
        collaboration,
        onDirtyChange,
        onOpenHistory: () => setHistoryDialogFile(filePath),
        getTheme: () => store.get(themeIdAtom),
        subscribeToThemeChanges: (callback) => {
          themeChangeCallbackRef.current = callback;
          return () => {
            if (themeChangeCallbackRef.current === callback) {
              themeChangeCallbackRef.current = null;
            }
          };
        },
      }),
    [filePath, fileName, isActive, activeConfig, collaboration, onDirtyChange, setHistoryDialogFile]
  );

  const ExtensionEditor = registration.component;
  return (
    <DocumentPathProvider documentPath={filePath}>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <ExtensionEditor host={host} />
      </div>
    </DocumentPathProvider>
  );
};
