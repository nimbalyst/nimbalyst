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
import { useAtomValue } from 'jotai';
import { MarkdownEditor, DocumentPathProvider } from '@nimbalyst/runtime';
import { LexicalDiffHeaderAdapter } from '../UnifiedDiffHeader';
import { DocumentSyncProvider } from '@nimbalyst/runtime/sync';
import { CollabLexicalProvider } from '@nimbalyst/runtime/sync';
import type { EditorHost, ExtensionStorage } from '@nimbalyst/runtime';
import type { CollabDocumentConfig } from '../../utils/collabDocumentOpener';
import { resolveCollabConfigForUri } from '../../utils/collabDocumentOpener';
import { store, editorDirtyAtom, makeEditorKey } from '@nimbalyst/runtime/store';
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

const CollabStatusBar: React.FC<{ filePath: string; fileName: string }> = ({ filePath, fileName }) => {
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
  const [activeConfig, setActiveConfig] = useState(initialCollabConfig);
  const syncProviderRef = useRef<DocumentSyncProvider | null>(null);
  const collabProviderRef = useRef<CollabLexicalProvider | null>(null);
  const isActiveRef = useRef(isActive);
  const cursorColor = useMemo(() => randomCursorColor(), []);
  const assetService = useMemo(() => new CollabAssetService(activeConfig), [activeConfig]);
  const keyRotationEpoch = useAtomValue(collabKeyRotationEpochAtom);
  // Captured Lexical editor instance -- needed by FixedTabHeader plugins
  // (search/replace, the unified diff header, etc.) when the agent applies edits.
  const [lexicalEditor, setLexicalEditor] = useState<any | null>(null);

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
  }, [isActive]);

  useEffect(() => {
    console.log('[CollaborativeTabEditor] Creating providers, initialContent:', !!activeConfig.initialContent);

    const syncProvider = new DocumentSyncProvider({
      serverUrl: activeConfig.serverUrl,
      getJwt: activeConfig.getJwt,
      orgId: activeConfig.orgId,
      documentKey: activeConfig.documentKey,
      orgKeyFingerprint: activeConfig.orgKeyFingerprint,
      userId: activeConfig.userId,
      documentId: activeConfig.documentId,
      createWebSocket: activeConfig.createWebSocket,
      onStatusChange: (status) => {
        console.log('[CollaborativeTabEditor] Status change:', status);
        // Write to Jotai atom -- only CollabStatusBar re-renders
        store.set(collabConnectionStatusAtom(filePath), status);
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

    const collabProvider = new CollabLexicalProvider(syncProvider);

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
  }, [activeConfig, filePath]);

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
        // History not yet supported for collaborative documents
      },

      storage,

      setEditorContext(): void {},

      registerEditorAPI(): void {},

      registerMenuItems(): void {},
    };
  }, [filePath, fileName, isActive, onDirtyChange]);

  // Expose a no-op manual save function
  useEffect(() => {
    if (onManualSaveReady) {
      onManualSaveReady(async () => {
        // No-op for collaborative documents -- content syncs via Y.Doc
      });
    }
  }, [onManualSaveReady]);

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

  return (
    <div className="collaborative-tab-editor" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Connection status bar -- subscribes to Jotai atom, isolated re-renders */}
      <CollabStatusBar filePath={filePath} fileName={fileName} />

      {/* Editor area */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {!providerReadyRef.current ? (
          <div className="flex items-center justify-center h-full text-nim-muted">
            Connecting to document...
          </div>
        ) : documentType === 'markdown' ? (
          <DocumentPathProvider documentPath={filePath}>
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
                onGetContent={onGetContentReady}
                onEditorReady={setLexicalEditor}
                collaborationConfig={collaborationMemoConfig}
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
  onDirtyChange?: (isDirty: boolean) => void;
}

const ExtensionCollabBranch: React.FC<ExtensionCollabBranchProps> = ({
  registration,
  syncProvider,
  filePath,
  fileName,
  isActive,
  activeConfig,
  onDirtyChange,
}) => {
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

  const collaboration = useMemo(
    () =>
      createCollaborationContext({
        syncProvider,
        awareness: bridgeRef.current!.awareness,
        activeConfig,
      }),
    [syncProvider, activeConfig]
  );

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
      }),
    [filePath, fileName, isActive, activeConfig, collaboration, onDirtyChange]
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
