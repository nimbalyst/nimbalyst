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
import { MarkdownEditor, MonacoEditor, DocumentPathProvider } from '@nimbalyst/runtime';
import { $convertFromEnhancedMarkdownString, getEditorTransformers, type CommentsConfig } from '@nimbalyst/runtime/editor';
import {
  getTeamSyncProvider,
  sharedDocumentsAtom,
  sharedFoldersAtom,
} from '../../store/atoms/collabDocuments';
import { buildCollabUri } from '../../utils/collabUri';
import { FixedTabHeaderContainer, FixedTabHeaderRegistry } from '@nimbalyst/runtime/plugins/shared/fixedTabHeader';
import { LexicalDiffHeaderAdapter } from '../UnifiedDiffHeader';
import { DocumentSyncProvider, CollabHistoryClient, LocalDocumentReplica } from '@nimbalyst/runtime/sync';
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
  collabKeyRotationEpochAtom,
  collabProductStatusAtom,
  type RemoteUser,
} from '../../store/atoms/collabEditor';
import { documentSyncRegistry } from '../../store/atoms/documentSyncRegistry';
import { CollabAssetService } from '../../services/CollabAssetService';
import { ElectronLocalReplicaStore } from '../../services/ElectronLocalReplicaStore';
import {
  buildDocumentReplicaCacheKey,
  getDocumentReplicaCache,
  type DocumentReplicaAcquisition,
  type DocumentReplicaCacheListener,
} from '../../services/DocumentReplicaCache';
import {
  publishCollabTransportState,
  resetCollabDocumentState,
  setCollabOutboxState,
  setCollabReplicaState,
} from '../../store/listeners/collabStateListeners';
import { closeActiveTabRequestAtom } from '../../store/atoms/appCommands';
// dialogRef, not useDialog: TabContent mounts this component in a separate
// React root (one per tab), so the app-root DialogProvider context is not
// reachable through the tree. The module-level ref is the cross-root path.
import { dialogRef } from '../../contexts/DialogContext';
import { customEditorRegistry } from '../CustomEditors';
import type { CustomEditorRegistration } from '../CustomEditors/types';
import { useCollabLocalOrigin } from '../../hooks/useCollabLocalOrigin';
import { markDocViewed } from '../../hooks/useDocUnread';
import { recordDocOpened } from '../../store/atoms/collabDiscovery';
import { exportCollabRecoveryPlaintext, getCollabContentAdapter } from '@nimbalyst/collab-adapters';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { UnifiedEditorHeaderBar } from './UnifiedEditorHeaderBar';
import {
  CollabDocumentHeaderMeta,
  CollabRecoveryBanner,
} from './CollabDocumentHeaderMeta';
import {
  getSharedDocumentDisplayPath,
  getSharedDocumentDisplayPathWithFallback,
} from '../CollabMode/collabTree';
import {
  createCollaborationContext,
  createCollabExtensionHost,
  createExtensionAwarenessBridge,
  notifyCollabStatus,
} from './collabExtensionHost';
import { hasCollabReplicaPreloadSupport } from '../../store/listeners/collabReplicaListeners';
import { getCollaborativeDocumentTypeCatalog } from '../../services/CollaborativeDocumentTypeCatalog';
import { getCodeCollabExportFileName } from '../../utils/CodeCollabContentAdapter';

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
  const status = useAtomValue(collabProductStatusAtom(filePath));
  return (
    <div
      className="collab-hydration-overlay absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-nim-muted"
      style={{ background: 'var(--nim-bg)', cursor: 'progress' }}
      // Block all pointer interaction with the un-hydrated editor beneath.
      onPointerDownCapture={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <span className="material-symbols-outlined animate-spin" style={{ fontSize: '20px' }}>progress_activity</span>
      <span className="text-sm">
        {status.kind === 'local-copy-damaged'
          ? status.label
          : status.kind === 'local-saving-unavailable'
            ? status.label
            : 'Loading from server…'}
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
  const activeConfigRef = useRef(initialCollabConfig);
  const [keyRotationPending, setKeyRotationPending] = useState(false);
  const syncProviderRef = useRef<DocumentSyncProvider | null>(null);
  const replicaRef = useRef<LocalDocumentReplica | null>(null);
  const replicaAcquisitionRef = useRef<DocumentReplicaAcquisition | null>(null);
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
  const sharedFolders = useAtomValue(sharedFoldersAtom);
  const sharedDisplayPath = useMemo(() => {
    const fallbackPath = getSharedDocumentDisplayPath({
      documentId: activeConfig.documentId,
      title: activeConfig.displayPath || activeConfig.title || fileName,
      parentFolderId: null,
    }, []);
    const currentDocument = sharedDocuments.find(
      document => document.documentId === activeConfig.documentId,
    );
    if (currentDocument) {
      return getSharedDocumentDisplayPathWithFallback(
        currentDocument,
        sharedFolders,
        fallbackPath,
      );
    }
    return fallbackPath;
  }, [activeConfig.displayPath, activeConfig.documentId, activeConfig.title, fileName, sharedDocuments, sharedFolders]);
  const cursorColor = useMemo(() => randomCursorColor(), []);
  const assetService = useMemo(() => new CollabAssetService(activeConfig), [activeConfig]);
  const localOrigin = useCollabLocalOrigin(
    activeConfig.workspacePath,
    activeConfig.documentId,
    activeConfig.documentType ?? 'markdown',
  );
  const keyRotationEpoch = useAtomValue(collabKeyRotationEpochAtom);
  const latestKeyRotationRequestRef = useRef(0);
  const replicaKeyGenerationRef = useRef(0);
  const offlineReplicaEnabled = hasCollabReplicaPreloadSupport();
  const recordOfflineMetric = useCallback((event: {
    metric: string;
    [property: string]: string | number | boolean | null;
  }) => {
    // console.info('[CollabOfflineMetric]', JSON.stringify(event));
  }, []);

  useEffect(() => {
    activeConfigRef.current = activeConfig;
  }, [activeConfig]);
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
    latestKeyRotationRequestRef.current = keyRotationEpoch;
    replicaKeyGenerationRef.current += 1;
    setKeyRotationPending(true);
    // Retire the old-key connection immediately. The next provider is not
    // acquired until resolveCollabConfigForUri returns the actual new key
    // fingerprint, so an epoch notification can never cache stale key bytes.
    void replicaAcquisitionRef.current?.supersede().catch((error) => {
      console.warn('[CollaborativeTabEditor] Failed to retire rotated replica provider:', error);
    });

    const config = activeConfigRef.current;

    resolveCollabConfigForUri(
      config.workspacePath,
      filePath,
      config.documentId,
      config.title,
      config.documentType,
      { forceRefresh: true },
    ).then((freshConfig) => {
      if (latestKeyRotationRequestRef.current !== keyRotationEpoch) return;
      if (freshConfig) {
        console.log('[CollaborativeTabEditor] Got fresh config with new key, recreating providers');
        setActiveConfig(freshConfig);
        setKeyRotationPending(false);
      } else {
        console.warn('[CollaborativeTabEditor] Failed to get fresh config after key rotation');
        setCollabReplicaState(filePath, 'unavailable');
      }
    }).catch((error) => {
      if (latestKeyRotationRequestRef.current !== keyRotationEpoch) return;
      console.warn('[CollaborativeTabEditor] Failed to resolve fresh config after key rotation:', error);
      setCollabReplicaState(filePath, 'unavailable');
    });
  }, [filePath, keyRotationEpoch]);
   // Increments each time a fresh CollabLexicalProvider is ready; 0 = not
  // ready. Also used as the editor subtree's key so every (re)acquisition
  // mounts a fresh CollaborationPlugin. The previous ref+forceUpdate gate
  // let HMR re-renders slip through with a destroyed/nulled provider
  // (CollaborationPlugin guards its init with an internal ref, so a stale
  // plugin instance keeps using the dead provider -- same trap
  // useTrackerContentCollab's providerEpoch solves).
  const [providerEpoch, setProviderEpoch] = useState(0);
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
      window.electronAPI.setDocumentEdited(
        isActive && !!replicaRef.current && replicaRef.current.getOutboxState() !== 'clean'
      );
    }
    // Switching to this doc (already synced) marks it read and counts as a
    // genuine open (drives the "Recent" list).
    if (isActive && activeConfig.orgId && syncProviderRef.current?.isSynced()) {
      void markDocViewed(
        activeConfig.documentId,
        activeConfig.orgId,
        getDocReadWatermark(syncProviderRef.current),
      );
      recordDocOpened(activeConfig.documentId);
    }
  }, [isActive, activeConfig.documentId, activeConfig.orgId, getDocReadWatermark]);

  useEffect(() => {
    // console.log('[CollaborativeTabEditor] Acquiring replica, initialContent:', !!activeConfig.initialContent);
    setProviderEpoch(0);
    setHasHydrated(false);
    resetCollabDocumentState(filePath);
    if (keyRotationPending) return;
    const acquisitionKeyGeneration = replicaKeyGenerationRef.current;
    const tabOpenedAt = performance.now();
    let interactiveRecorded = false;
    let caughtUpRecorded = false;
    const recordInteractive = (source: 'local_replica' | 'server_hydration') => {
      if (interactiveRecorded) return;
      interactiveRecorded = true;
      recordOfflineMetric({ metric: 'first_paint_source', source });
      recordOfflineMetric({
        metric: 'time_to_interactive',
        source,
        durationMs: Math.round(performance.now() - tabOpenedAt),
      });
    };
    if (!offlineReplicaEnabled) {
      // Compatibility path for the staged rollout. It intentionally keeps the
      // legacy collabPendingUpdates writer and starts from server hydration;
      // no durable cursor, cache, headless drain, or asset outbox is assumed.
      setCollabReplicaState(filePath, 'ready');
      const syncProvider = new DocumentSyncProvider({
        serverUrl: activeConfig.serverUrl,
        getJwt: activeConfig.getJwt,
        orgId: activeConfig.orgId,
        keyCustody: activeConfig.keyCustody,
        documentKey: activeConfig.documentKey,
        legacyDocumentKey: activeConfig.legacyDocumentKey,
        orgKeyFingerprint: activeConfig.orgKeyFingerprint,
        userId: activeConfig.userId,
        documentId: activeConfig.documentId,
        createWebSocket: activeConfig.createWebSocket,
        onContentChanged: (yDoc) => {
          const adapter = getCollabContentAdapter(activeConfig.documentType ?? 'markdown');
          if (!adapter) return;
          try {
            const plaintext = exportCollabRecoveryPlaintext(adapter, yDoc);
            if (plaintext === null) return;
            void window.electronAPI.collabBackup.contentChanged({
              workspacePath: activeConfig.workspacePath,
              documentId: activeConfig.documentId,
              documentType: activeConfig.documentType ?? 'markdown',
              title: activeConfig.title,
              plaintext,
              kind: 'document',
            });
          } catch (error) {
            console.warn('[CollaborativeTabEditor] Backup serialization failed:', error);
          }
        },
        onStatusChange: (status) => {
          publishCollabTransportState(filePath, status);
          setCollabOutboxState(
            filePath,
            status === 'replaying'
              ? 'replaying'
              : status === 'offline-unsynced'
                ? 'pending'
                : 'clean',
          );
          if (status === 'connected' || status === 'replaying') {
            setHasHydrated(true);
            recordInteractive('server_hydration');
          }
          collabProviderRef.current?.handleStatusChange(status);
          notifyCollabStatus(syncProvider, status);
          if (status === 'connected') {
            if (!caughtUpRecorded) {
              caughtUpRecorded = true;
              recordOfflineMetric({
                metric: 'time_to_caught_up',
                durationMs: Math.round(performance.now() - tabOpenedAt),
              });
            }
            void ensureBootstrapRevision();
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
        onRemoteUpdate: (origin) => collabProviderRef.current?.handleRemoteUpdate(origin),
        onOfflineMetric: recordOfflineMetric,
        reviewGateEnabled: false,
      });
      const awarenessUnsub = syncProvider.onAwarenessChange((states) => {
        const users = new Map<string, RemoteUser>();
        for (const [userId, state] of states) {
          users.set(userId, { name: state.user.name, color: state.user.color });
        }
        store.set(collabAwarenessAtom(filePath), users);
      });
      const collabProvider = new CollabLexicalProvider(syncProvider, {
        deferInitialSync: true,
      });
      syncProviderRef.current = syncProvider;
      collabProviderRef.current = collabProvider;
      documentSyncRegistry.register(syncProvider);
      setProviderEpoch((epoch) => epoch + 1);
      return () => {
        awarenessUnsub();
        documentSyncRegistry.unregister(syncProvider);
        collabProviderRef.current?.destroy();
        syncProvider.destroy();
        syncProviderRef.current = null;
        collabProviderRef.current = null;
        resetCollabDocumentState(filePath);
      };
    }
    let cancelled = false;
    let awarenessUnsub: (() => void) | null = null;
    let acquisition: DocumentReplicaAcquisition | null = null;
    const replicaIdentity = {
      accountId: activeConfig.accountId,
      orgId: activeConfig.orgId,
      documentId: activeConfig.documentId,
    };
    const cacheKey = buildDocumentReplicaCacheKey(
      replicaIdentity,
      activeConfig.keyCustody,
      activeConfig.orgKeyFingerprint,
    );

    const listener: DocumentReplicaCacheListener = {
      onReplicaStateChange: (state) => {
        setCollabReplicaState(filePath, state);
        const replica = replicaRef.current;
        if (state === 'ready' && replica?.wasHydratedFromStore()) {
          setHasHydrated(true);
        }
      },
      onOutboxStateChange: (state) => {
        setCollabOutboxState(filePath, state);
        if (isActiveRef.current && window.electronAPI?.setDocumentEdited) {
          window.electronAPI.setDocumentEdited(state !== 'clean');
        }
      },
      onTransportStateChange: (status) => {
        // console.log('[CollaborativeTabEditor] Transport status change:', status);
        publishCollabTransportState(filePath, status);
        if (status === 'connected' || status === 'replaying') {
          setHasHydrated(true);
          recordInteractive('server_hydration');
        }
        collabProviderRef.current?.handleStatusChange(status);
        if (syncProviderRef.current) {
          notifyCollabStatus(syncProviderRef.current, status);
        }
        if (status === 'connected') {
          if (!caughtUpRecorded) {
            caughtUpRecorded = true;
            recordOfflineMetric({
              metric: 'time_to_caught_up',
              durationMs: Math.round(performance.now() - tabOpenedAt),
            });
          }
          void ensureBootstrapRevision();
          if (isActiveRef.current && activeConfig.orgId && syncProviderRef.current) {
            void markDocViewed(
              activeConfig.documentId,
              activeConfig.orgId,
              getDocReadWatermark(syncProviderRef.current),
            );
            recordDocOpened(activeConfig.documentId);
          }
        }
      },
      onRemoteUpdate: (origin) => {
        collabProviderRef.current?.handleRemoteUpdate(origin);
      },
    };

    void getDocumentReplicaCache().acquire(
      cacheKey,
      async (events) => {
        const attachmentId = crypto.randomUUID();
        const providerAttached = window.electronAPI.documentSync.setReplicaProviderAttached(
          replicaIdentity,
          attachmentId,
          true,
        );
        const detachProvider = async () => {
          try {
            await window.electronAPI.documentSync.setReplicaProviderAttached(
              replicaIdentity,
              attachmentId,
              false,
            );
          } catch (error) {
            console.warn('[CollaborativeTabEditor] Replica-provider detach failed:', error);
          }
        };
        const replica = new LocalDocumentReplica({
          identity: replicaIdentity,
          documentType: activeConfig.documentType ?? 'markdown',
          store: new ElectronLocalReplicaStore(activeConfig.workspacePath),
          onReplicaStateChange: events.onReplicaStateChange,
          onOutboxStateChange: events.onOutboxStateChange,
          onOfflineMetric: recordOfflineMetric,
        });

        try {
          const hydrationStartedAt = performance.now();
          await Promise.all([replica.whenReady, providerAttached]);
          recordOfflineMetric({
            metric: 'replica_hydration',
            hit: replica.wasHydratedFromStore(),
            durationMs: Math.round(performance.now() - hydrationStartedAt),
          });
          const syncProvider = new DocumentSyncProvider({
            replica,
            serverUrl: activeConfig.serverUrl,
            getJwt: activeConfig.getJwt,
            orgId: activeConfig.orgId,
            keyCustody: activeConfig.keyCustody,
            documentKey: activeConfig.documentKey,
            legacyDocumentKey: activeConfig.legacyDocumentKey,
            orgKeyFingerprint: activeConfig.orgKeyFingerprint,
            userId: activeConfig.userId,
            documentId: activeConfig.documentId,
            createWebSocket: activeConfig.createWebSocket,
            onContentChanged: (yDoc) => {
              const adapter = getCollabContentAdapter(activeConfig.documentType ?? 'markdown');
              if (!adapter) return;
              try {
                const plaintext = exportCollabRecoveryPlaintext(adapter, yDoc);
                if (plaintext === null) {
                  console.warn('[CollaborativeTabEditor] Backup skipped: adapter export is not UTF-8 plaintext');
                  return;
                }
                void window.electronAPI.collabBackup.contentChanged({
                  workspacePath: activeConfig.workspacePath,
                  documentId: activeConfig.documentId,
                  documentType: activeConfig.documentType ?? 'markdown',
                  title: activeConfig.title,
                  plaintext,
                  kind: 'document',
                });
              } catch (error) {
                console.warn('[CollaborativeTabEditor] Backup serialization failed:', error);
              }
            },
            onStatusChange: events.onTransportStateChange,
            onOfflineMetric: recordOfflineMetric,
            initialPendingUpdateBase64: activeConfig.pendingUpdateBase64,
            onPendingUpdateChange: async (pendingUpdateBase64) => {
              if (replica.getState() !== 'unavailable') return;
              await window.electronAPI.documentSync.setPendingUpdate(
                activeConfig.workspacePath,
                activeConfig.orgId,
                activeConfig.documentId,
                pendingUpdateBase64,
              );
            },
            onRemoteUpdate: events.onRemoteUpdate,
            reviewGateEnabled: false,
          });
          return { replica, syncProvider, detachProvider };
        } catch (error) {
          await replica.destroy().catch(() => {});
          await detachProvider();
          throw error;
        }
      },
      listener,
    ).then((nextAcquisition) => {
      if (cancelled) {
        if (acquisitionKeyGeneration !== replicaKeyGenerationRef.current) {
          void nextAcquisition.supersede();
        } else {
          nextAcquisition.release();
        }
        return;
      }
      acquisition = nextAcquisition;
      replicaAcquisitionRef.current = nextAcquisition;
      replicaRef.current = nextAcquisition.replica;
      syncProviderRef.current = nextAcquisition.syncProvider;
      if (
        nextAcquisition.replica.wasHydratedFromStore() &&
        nextAcquisition.replica.getState() === 'ready'
      ) {
        setHasHydrated(true);
        recordInteractive('local_replica');
      }

      awarenessUnsub = nextAcquisition.syncProvider.onAwarenessChange((states) => {
        const users = new Map<string, RemoteUser>();
        for (const [userId, state] of states) {
          users.set(userId, { name: state.user.name, color: state.user.color });
        }
        store.set(collabAwarenessAtom(filePath), users);
      });

      const collabProvider = new CollabLexicalProvider(nextAcquisition.syncProvider, {
        // A durable local hit is immediately bindable. A first open still waits
        // for the server's explicit room-state response before bootstrapping.
        deferInitialSync: !(
          nextAcquisition.replica.wasHydratedFromStore() &&
          nextAcquisition.replica.getState() === 'ready'
        ),
      });
      collabProviderRef.current = collabProvider;
      // A warm provider may already be connected before this new Lexical
      // adapter exists. Re-publish its current status so the adapter and the
      // CollaborationPlugin catch-up path cannot leave an empty doc blank.
      collabProvider.handleStatusChange(nextAcquisition.syncProvider.getStatus());
      documentSyncRegistry.register(nextAcquisition.syncProvider);
      setProviderEpoch((epoch) => epoch + 1);
    }).catch((error) => {
      console.error('[CollaborativeTabEditor] Failed to acquire local replica/provider:', error);
      if (!cancelled) {
        setProviderEpoch(0);
        setCollabReplicaState(filePath, 'unavailable');
      }
    });

    return () => {
      cancelled = true;
      awarenessUnsub?.();
      if (acquisition) {
        documentSyncRegistry.unregister(acquisition.syncProvider);
        if (acquisitionKeyGeneration !== replicaKeyGenerationRef.current) {
          void acquisition.supersede();
        } else {
          acquisition.release();
        }
      }
      if (replicaAcquisitionRef.current === acquisition) {
        replicaAcquisitionRef.current = null;
      }
      syncProviderRef.current = null;
      replicaRef.current = null;
      collabProviderRef.current?.destroy();
      collabProviderRef.current = null;
      if (isActiveRef.current && window.electronAPI?.setDocumentEdited) {
        window.electronAPI.setDocumentEdited(false);
      }
      resetCollabDocumentState(filePath);
      store.set(collabAwarenessAtom(filePath), new Map());
    };
  }, [activeConfig, ensureBootstrapRevision, filePath, getDocReadWatermark, keyRotationPending, offlineReplicaEnabled, recordOfflineMetric]);

  // Build the provider factory for CollaborationPlugin
  // This function is called by CollaborationPlugin with a doc ID and yjsDocMap.
  // We return our adapter which already has the Y.Doc from DocumentSyncProvider.
  const providerFactory = useCallback((id: string, yjsDocMap: Map<string, Doc>): Provider => {
    // console.log('[CollaborativeTabEditor] providerFactory called, id:', id, 'providerReady:', !!collabProviderRef.current);
    const provider = collabProviderRef.current;
    if (!provider) {
      throw new Error('[CollaborativeTabEditor] CollabLexicalProvider not initialized');
    }

    // Register our Y.Doc in the yjsDocMap so CollaborationPlugin can find it
    const ydoc = provider.getYDoc();
    yjsDocMap.set(id, ydoc);
    // console.log('[CollaborativeTabEditor] Y.Doc registered in yjsDocMap');

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
    // NIM-1683: intentionally do NOT wire onAssetReferencesRemoved. Deleting an
    // asset the moment it leaves the *current* editor state is data-loss --
    // revision history and undo / cut-paste still reference the same
    // `collab-asset://` URI. Asset lifetime is tied to document lifetime; the
    // server reclaims all of a doc's blobs only when the document itself is
    // deleted. Leaving this unset keeps the asset-GC extension idle.
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
    if (documentType === 'markdown' || documentType === 'code') return null;
    // Look up by the share filename, which carries the extension (e.g.
    // `MyDrawing.excalidraw`). Falls back to `<title>.<documentType>` so
    // recipients of a doc shared with a bare title still get routed to
    // the right editor.
    const lookupName = activeConfig.fileExtension
      ? `document${activeConfig.fileExtension}`
      : fileName.includes('.') ? fileName : `${activeConfig.title}.${documentType}`;
    const match = customEditorRegistry.findRegistrationForFile(lookupName);
    if (!match) return null;
    if (activeConfig.editorId && match.extensionId !== activeConfig.editorId) return null;
    if (!match.collaboration?.supported) return null;
    return match;
  }, [documentType, fileName, activeConfig.editorId, activeConfig.fileExtension, activeConfig.title]);
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

  const handleSaveCodeCopy = useCallback(async (): Promise<void> => {
    const provider = syncProviderRef.current;
    const adapter = getCollabContentAdapter('code');
    if (!provider || !adapter) {
      errorNotificationService.showError(
        'Could not save a copy',
        'The collaborative code exporter is unavailable.',
      );
      return;
    }

    const preferredSuffix = activeConfig.fileExtension || adapter.fileExtensions[0] || '.txt';
    const defaultFileName = getCodeCollabExportFileName(
      activeConfig.title || fileName || 'document',
      activeConfig.fileExtension,
    );
    const content = adapter.exportToFile(provider.getYDoc());
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const result = await window.electronAPI.invoke('document-sync:export-to-file', {
      documentType: 'code',
      defaultFileName,
      fileExtensions: Array.from(new Set([preferredSuffix, ...adapter.fileExtensions])),
      bytes,
    }) as { success: boolean; cancelled?: boolean; error?: string };

    if (!result.success && !result.cancelled) {
      errorNotificationService.showError(
        'Could not save a copy',
        result.error ?? 'The file could not be exported.',
      );
    }
  }, [activeConfig.fileExtension, activeConfig.title, fileName]);

  const collabActionItems = useMemo(() => {
    const actionDisabled = localOrigin.busyAction !== null;
    return [
      ...(documentType === 'code' ? [{
        label: 'Save a Copy',
        icon: 'download',
        disabled: !hasHydrated,
        onClick: () => {
          void handleSaveCodeCopy();
        },
      }] : []),
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
  }, [documentType, handleSaveCodeCopy, hasHydrated, localOrigin, handleReuploadFromLocal]);
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

  const handleCopyCurrentDocument = useCallback(async (): Promise<void> => {
    try {
      let plaintext = getContentRef.current?.() ?? null;
      if (plaintext === null) {
        const replica = replicaRef.current;
        const adapter = getCollabContentAdapter(activeConfig.documentType ?? 'markdown');
        if (!replica || !adapter) throw new Error('No plaintext exporter is available');
        plaintext = exportCollabRecoveryPlaintext(adapter, replica.getYDoc());
      }
      if (plaintext === null) throw new Error('This editor cannot export UTF-8 text');
      await window.electronAPI.copyToClipboard(plaintext);
      errorNotificationService.showInfo(
        'Current document copied',
        'The complete current document was copied so the unsent edits can be preserved.',
        { duration: 4000 },
      );
    } catch (error) {
      errorNotificationService.showError(
        'Could not copy current document',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [activeConfig.documentType]);

  const handleDiscardLocalCopy = useCallback(async (): Promise<void> => {
    const confirm = dialogRef.current?.confirm;
    if (!confirm) {
      console.error('[CollaborativeTabEditor] DialogProvider not mounted; refusing destructive discard');
      return;
    }
    const confirmed = await confirm({
      title: 'Discard local copy?',
      message: 'This permanently deletes the local replica and its unuploaded edits, then closes the document. This cannot be undone.',
      confirmLabel: 'Discard and close',
      cancelLabel: 'Keep local copy',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      const acquisition = replicaAcquisitionRef.current;
      if (!acquisition) throw new Error('The local replica is no longer attached');
      await acquisition.discardLocalCopy();
      store.set(closeActiveTabRequestAtom, (value) => value + 1);
    } catch (error) {
      errorNotificationService.showError(
        'Could not discard local copy',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, []);

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
      <UnifiedEditorHeaderBar
        filePath={filePath}
        fileName={fileName}
        workspaceId={activeConfig.workspacePath}
        isMarkdown={documentType === 'markdown'}
        lexicalEditor={documentType === 'markdown' ? (lexicalEditor ?? undefined) : undefined}
        breadcrumbContent={(
          <CollabDocumentHeaderMeta filePath={filePath} displayPath={sharedDisplayPath} />
        )}
        showShareLinkButton={false}
        showSharedDocButton={false}
        showHistoryAction={true}
        showCommonFileActions={false}
        sharedDocumentLinkTarget={{
          documentId: activeConfig.documentId,
          orgId: activeConfig.orgId,
        }}
        extraActionItems={collabActionItems}
      />

      <CollabRecoveryBanner
        filePath={filePath}
        onCopyCurrentDocument={handleCopyCurrentDocument}
        onDiscardLocalCopy={handleDiscardLocalCopy}
      />

      {/* Editor area */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {/* NIM-949: gate editing until the room hydrates, so a server-only doc
            never presents a blank editable surface during a connection/auth blip. */}
        {providerEpoch > 0 && !hasHydrated && (
          <CollabHydrationOverlay filePath={filePath} />
        )}
        {providerEpoch === 0 ? (
          <div className="flex items-center justify-center h-full text-nim-muted">
            Connecting to document...
          </div>
        ) : documentType === 'markdown' ? (
          // Keyed by providerEpoch: a re-acquisition (HMR, key rotation) must
          // mount a FRESH CollaborationPlugin -- a surviving instance keeps
          // the destroyed provider via its one-time-init guard.
          <DocumentPathProvider key={providerEpoch} documentPath={filePath}>
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
        ) : documentType === 'code' && syncProviderRef.current ? (
          <MonacoCollabBranch
            key={providerEpoch}
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
        ) : extensionRegistration && syncProviderRef.current ? (
          <ExtensionCollabBranch
            key={providerEpoch}
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
// Built-in Monaco branch (text/code)
// ---------------------------------------------------------------------------

interface MonacoCollabBranchProps {
  syncProvider: DocumentSyncProvider;
  filePath: string;
  fileName: string;
  isActive: boolean;
  activeConfig: CollabDocumentConfig;
  createHistoryClient: () => CollabHistoryClient;
  onHistoryControllerChange: (controller: CollabHistoryController | null) => void;
  onDirtyChange?: (isDirty: boolean) => void;
}

const MonacoCollabBranch: React.FC<MonacoCollabBranchProps> = ({
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
  const unregisterControllerRef = useRef<(() => void) | null>(null);

  const syntheticName = useMemo(() => {
    const catalog = getCollaborativeDocumentTypeCatalog();
    const suffix = activeConfig.fileExtension
      ?? catalog.inferFileExtension('code', fileName)
      ?? catalog.inferFileExtension('code', activeConfig.title)
      ?? '.txt';
    return `document${suffix}`;
  }, [activeConfig.fileExtension, activeConfig.title, fileName]);

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
  }, []);

  useEffect(() => {
    void syncProvider.connect().catch((error) => {
      console.error('[MonacoCollabBranch] Failed to connect DocumentSyncProvider:', {
        documentId: activeConfig.documentId,
        error,
      });
    });
  }, [syncProvider, activeConfig.documentId]);

  const collaboration = useMemo(
    () => createCollaborationContext({
      syncProvider,
      awareness: bridgeRef.current!.awareness,
      activeConfig,
    }),
    [activeConfig, syncProvider],
  );

  useEffect(() => {
    const adapter = createRevisionAdapterFromCollabContent({
      documentType: 'code',
      getYDoc: () => syncProvider.getYDoc(),
    });
    const controller: CollabHistoryController = {
      client: createHistoryClient(),
      editorType: 'code',
      contentFormat: adapter?.contentFormat ?? 'code',
      previewKind: adapter?.previewKind ?? 'metadata-only',
      exportSnapshot: adapter ? () => adapter.exportRevisionSnapshot() : undefined,
      applySnapshot: adapter ? (bytes) => adapter.restoreRevisionSnapshot(bytes) : undefined,
      getBasisSequence: () => syncProvider.getLastSeq(),
      getStatus: () => syncProvider.getStatus(),
      waitForPendingWrites: (timeoutMs?: number) => syncProvider.waitForPendingWrites(timeoutMs),
    };

    onHistoryControllerChange(controller);
    unregisterControllerRef.current = registerCollabHistoryController(
      filePath,
      controller,
      () => bumpHistoryControllers(),
    );

    return () => {
      onHistoryControllerChange(null);
      unregisterControllerRef.current?.();
      unregisterControllerRef.current = null;
    };
  }, [bumpHistoryControllers, createHistoryClient, filePath, onHistoryControllerChange, syncProvider]);

  const themeChangeCallbackRef = useRef<((theme: string) => void) | null>(null);
  useEffect(() => {
    const unsubscribe = store.sub(themeIdAtom, () => {
      const next = store.get(themeIdAtom);
      themeChangeCallbackRef.current?.(next);
    });
    return unsubscribe;
  }, []);

  const hostWithCollaboration = useMemo(
    () => createCollabExtensionHost({
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
    [activeConfig, collaboration, fileName, filePath, isActive, onDirtyChange, setHistoryDialogFile],
  );

  return (
    <DocumentPathProvider documentPath={filePath}>
      <div className="monaco-collab-branch" style={{ flex: 1, overflow: 'hidden' }}>
        <MonacoEditor
          host={hostWithCollaboration}
          fileName={syntheticName}
          config={{ isActive }}
          collab={{ textField: 'content' }}
        />
      </div>
    </DocumentPathProvider>
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
