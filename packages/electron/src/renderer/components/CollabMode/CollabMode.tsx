/**
 * CollabMode - Shared Documents mode.
 *
 * Top-level mode for browsing and editing collaborative documents
 * shared with the team. Layout: sidebar (doc list) + main area (collab tabs).
 *
 * Follows the same always-mounted, CSS-display-toggled pattern as
 * EditorMode, AgentMode, and TrackerMode.
 */

import React, { useCallback, useState, useEffect, useRef, useMemo, forwardRef, useImperativeHandle } from 'react';
import { useAtomValue } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { CollabSidebar } from './CollabSidebar';
import { TabsProvider, useTabsActions, useTabs, useTabNavigationShortcuts, type TabData } from '../../contexts/TabsContext';
import { TabManager } from '../TabManager/TabManager';
import { TabContent } from '../TabContent/TabContent';
import { ChatSidebar } from '../ChatSidebar';
import { useEditorMaximize } from '../../hooks/useEditorMaximize';
import { useResizeDragShield } from '../../hooks/useResizeDragShield';
import {
  getCollabConfig,
  openCollabDocumentViaIPC,
  updateCollabConfigDisplayMetadata,
} from '../../utils/collabDocumentOpener';
import {
  loadOpenCollabDocs,
  persistOpenCollabDocs,
  type PersistedCollabEntry,
} from '../../utils/collabOpenDocsPersistence';
import {
  initSharedDocuments,
  pendingCollabDocumentAtom,
  sharedDocumentsAtom,
  sharedFoldersAtom,
  type SharedDocument,
} from '../../store/atoms/collabDocuments';
import { hydrateCollabDiscovery } from '../../store/atoms/collabDiscovery';
import { SharedDocsHome } from './SharedDocsHome';
import { isCollabUri, parseCollabUri } from '../../utils/collabUri';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  getCollabNodeName,
  getSharedDocumentDisplayName,
  getSharedDocumentDisplayPath,
  getSharedDocumentDisplayPathWithFallback,
  reconcileSharedDocumentDisplayName,
} from './collabTree';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import type { SerializableDocumentContext } from '../../hooks/useDocumentContext';

interface CollabModeProps {
  workspacePath: string;
  isActive: boolean;
  onFileOpen: (path: string) => void;
}

export interface CollabModeRef {
  closeActiveTab: () => void;
  reopenLastClosedTab: () => Promise<void>;
  getActiveDocumentPath: () => string | null;
  toggleSidebarCollapsed: () => void;
}

export const CollabMode = forwardRef<CollabModeRef, CollabModeProps>(function CollabMode({
  workspacePath,
  isActive,
  onFileOpen,
}, ref) {
  // Initialize shared documents sync from TeamRoom.
  // Retry when user activates collab mode, in case the initial attempt
  // failed (e.g., encryption key not yet available, admin hadn't shared keys).
  //
  // Multi-project rail switching re-mounts CollabMode whenever the visible
  // `workspacePath` changes, but the team-sync provider is keyed by path
  // in `providersByPath` and must stay connected while the project is warm
  // — tearing it down on every switch would lose pending writes. The
  // explicit close path (`closeOpenProjectAtom` → workspaceStatePruner →
  // `pruneCollabDocumentsWorkspaceState`) is the one that destroys the
  // provider when the user actually closes the project.
  useEffect(() => {
    initSharedDocuments(workspacePath);
  }, [workspacePath]);

  useEffect(() => {
    if (isActive) {
      initSharedDocuments(workspacePath);
    }
  }, [isActive, workspacePath]);

  return (
    <TabsProvider workspacePath={workspacePath} disablePersistence>
      <CollabModeInner
        ref={ref}
        workspacePath={workspacePath}
        isActive={isActive}
        onFileOpen={onFileOpen}
      />
    </TabsProvider>
  );
});

// ---------------------------------------------------------------------------
// Persist open collab document IDs and layout in workspace state.
// ---------------------------------------------------------------------------

const COLLAB_SIDEBAR_DEFAULT = 220;
const COLLAB_SIDEBAR_MIN = 150;
const COLLAB_SIDEBAR_MAX = 400;
const COLLAB_CHAT_DEFAULT = 350;

interface CollabLayout {
  sidebarWidth: number;
  chatWidth: number;
  sidebarCollapsed: boolean;
  chatCollapsed: boolean;
}

let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;

/** Save collab layout to workspace state (debounced). */
function persistCollabLayout(workspacePath: string, layout: CollabLayout): void {
  if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
  layoutPersistTimer = setTimeout(async () => {
    try {
      await window.electronAPI?.invoke?.('workspace:update-state', workspacePath, {
        collabLayout: layout,
      });
    } catch (err) {
      console.warn('[CollabMode] Failed to persist layout:', err);
    }
  }, 500);
}

/** Load collab layout from workspace state. */
async function loadCollabLayout(workspacePath: string): Promise<CollabLayout> {
  try {
    const state = await window.electronAPI?.invoke?.('workspace:get-state', workspacePath);
    return {
      sidebarWidth: state?.collabLayout?.sidebarWidth ?? COLLAB_SIDEBAR_DEFAULT,
      chatWidth: state?.collabLayout?.chatWidth ?? COLLAB_CHAT_DEFAULT,
      sidebarCollapsed: state?.collabLayout?.sidebarCollapsed ?? false,
      chatCollapsed: state?.collabLayout?.chatCollapsed ?? false,
    };
  } catch {
    return {
      sidebarWidth: COLLAB_SIDEBAR_DEFAULT,
      chatWidth: COLLAB_CHAT_DEFAULT,
      sidebarCollapsed: false,
      chatCollapsed: false,
    };
  }
}

/**
 * Inner component that has access to TabsProvider context.
 */
const CollabModeInner = forwardRef<CollabModeRef, CollabModeProps>(function CollabModeInner({
  workspacePath,
  isActive,
  onFileOpen,
}, ref) {
  const tabsActions = useTabsActions();
  const { tabs, activeTabId } = useTabs();
  useTabNavigationShortcuts(isActive);
  const pendingDoc = useAtomValue(pendingCollabDocumentAtom);
  const sharedDocuments = useAtomValue(sharedDocumentsAtom);
  const sharedFolders = useAtomValue(sharedFoldersAtom);
  const [restored, setRestored] = useState(false);

  // --- Resizable / collapsible panel state ---
  const [sidebarWidth, setSidebarWidth] = useState(COLLAB_SIDEBAR_DEFAULT);
  const [chatWidth, setChatWidth] = useState(COLLAB_CHAT_DEFAULT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  // Discovery hub overlay: shown over open tabs when the user clicks "Home".
  // With no tabs, the hub is the empty state and this flag is irrelevant.
  const [showHome, setShowHome] = useState(false);

  // Refs for sidebar resize drag (avoids re-renders during drag)
  const sidebarDragRef = useRef({ startX: 0, startWidth: 0, latestWidth: sidebarWidth });
  sidebarDragRef.current.latestWidth = sidebarWidth;

  // Track active tab and its getContent function so the right-pane chat can
  // pull a fresh snapshot of the live (Yjs-synced) document on each message.
  // Refs avoid re-rendering CollabMode on every tab switch / keystroke.
  const activeTabForContextRef = useRef<TabData | null>(null);
  const getContentByTabIdRef = useRef<Map<string, () => string>>(new Map());

  const handleGetContentReady = useCallback((tabId: string, getContentFn: () => string) => {
    getContentByTabIdRef.current.set(tabId, getContentFn);
  }, []);

  const getDocumentContext = useCallback(async (): Promise<SerializableDocumentContext> => {
    const activeTab = activeTabForContextRef.current;
    if (!activeTab || !isCollabUri(activeTab.filePath)) {
      return {
        filePath: '',
        fileType: 'unknown',
        content: '',
      };
    }

    // Read the latest content directly from the live Lexical editor for this
    // tab. This reflects whatever Yjs has merged into the local Y.Doc, which
    // is the source of truth for shared docs (the file does NOT exist on
    // disk, so window.electronAPI.readFileContent is not appropriate here).
    let content = '';
    const getContentFn = getContentByTabIdRef.current.get(activeTab.id);
    if (getContentFn) {
      try {
        content = getContentFn() ?? '';
      } catch (err) {
        console.error('[CollabMode] Failed to read collab doc content:', err);
      }
    }

    return {
      filePath: activeTab.filePath,
      fileType: 'collab-markdown',
      content,
    };
  }, []);

  // Keep activeTabForContextRef in sync with the currently active tab and
  // prune getContent entries for tabs that no longer exist.
  useEffect(() => {
    const activeTab = activeTabId ? tabs.find(t => t.id === activeTabId) : null;
    activeTabForContextRef.current = activeTab || null;

    const liveTabIds = new Set(tabs.map(t => t.id));
    for (const tabId of getContentByTabIdRef.current.keys()) {
      if (!liveTabIds.has(tabId)) {
        getContentByTabIdRef.current.delete(tabId);
      }
    }
  }, [tabs, activeTabId]);

  // Tell the MCP layer about the active collab document so applyDiff /
  // applyCollabDocEdit can resolve the collab:// URI to this window.
  // We only push state while collab mode is active to avoid clobbering
  // EditorMode's filesystem-backed entries.
  useEffect(() => {
    if (!isActive) return;
    const activeTab = activeTabId ? tabs.find(t => t.id === activeTabId) : null;
    if (!activeTab || !isCollabUri(activeTab.filePath)) return;
    if (!window.electronAPI?.updateMcpDocumentState) return;

    window.electronAPI.updateMcpDocumentState({
      content: '',
      filePath: activeTab.filePath,
      fileType: 'collab-markdown',
      workspacePath,
      cursorPosition: undefined,
      selection: undefined,
    });
  }, [isActive, activeTabId, tabs, workspacePath]);

  // Load persisted layout on mount
  useEffect(() => {
    let cancelled = false;
    loadCollabLayout(workspacePath).then((layout) => {
      if (cancelled) return;
      setSidebarWidth(layout.sidebarWidth);
      setChatWidth(layout.chatWidth);
      setSidebarCollapsed(layout.sidebarCollapsed);
      setChatCollapsed(layout.chatCollapsed);
    });
    return () => { cancelled = true; };
  }, [workspacePath]);

  // Hydrate favorites + discovery prefs (tree filter, unread-bubble visibility)
  // from workspace state so the hub and sidebar reflect saved choices.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.invoke?.('workspace:get-state', workspacePath)
      .then((state: any) => {
        if (cancelled) return;
        hydrateCollabDiscovery(workspacePath, state?.collabDiscovery);
      })
      .catch(() => { /* best-effort; defaults apply */ });
    return () => { cancelled = true; };
  }, [workspacePath]);

  // --- Sidebar resize handlers ---
  const startSidebarResizeDrag = useResizeDragShield({
    onMove: (event) => {
      const delta = event.clientX - sidebarDragRef.current.startX;
      const newWidth = Math.max(COLLAB_SIDEBAR_MIN, Math.min(COLLAB_SIDEBAR_MAX, sidebarDragRef.current.startWidth + delta));
      sidebarDragRef.current.latestWidth = newWidth;
      setSidebarWidth(newWidth);
    },
    onEnd: () => {
      // Persist after drag ends
      persistCollabLayout(workspacePath, {
        sidebarWidth: sidebarDragRef.current.latestWidth,
        chatWidth,
        sidebarCollapsed,
        chatCollapsed,
      });
    },
  });

  const handleSidebarPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    sidebarDragRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
      latestWidth: sidebarWidth,
    };
    startSidebarResizeDrag(event);
  }, [sidebarWidth, startSidebarResizeDrag]);

  // --- Chat sidebar resize handler (via ChatSidebar's onWidthChange) ---
  const handleChatWidthChange = useCallback((newWidth: number) => {
    setChatWidth(newWidth);
    persistCollabLayout(workspacePath, { sidebarWidth, chatWidth: newWidth, sidebarCollapsed, chatCollapsed });
  }, [workspacePath, sidebarWidth, sidebarCollapsed, chatCollapsed]);

  // --- Collapse toggles (left document tree + right chat panel) ---
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      persistCollabLayout(workspacePath, { sidebarWidth, chatWidth, sidebarCollapsed: next, chatCollapsed });
      return next;
    });
  }, [workspacePath, sidebarWidth, chatWidth, chatCollapsed]);

  const toggleChatCollapsed = useCallback(() => {
    setChatCollapsed((prev) => {
      const next = !prev;
      persistCollabLayout(workspacePath, { sidebarWidth, chatWidth, sidebarCollapsed, chatCollapsed: next });
      return next;
    });
  }, [workspacePath, sidebarWidth, chatWidth, sidebarCollapsed]);

  // Double-click a tab to maximize the editor (collapse doc list + AI chat).
  // Second double-click restores the exact prior collapse state.
  const { isMaximized: isEditorMaximized, toggle: toggleEditorMaximized, clearMaximize: clearEditorMaximized } =
    useEditorMaximize<{ sidebar: boolean; chat: boolean }>({
      scopeKey: workspacePath,
      snapshot: () => ({ sidebar: sidebarCollapsed, chat: chatCollapsed }),
      maximize: () => {
        setSidebarCollapsed(true);
        setChatCollapsed(true);
        persistCollabLayout(workspacePath, { sidebarWidth, chatWidth, sidebarCollapsed: true, chatCollapsed: true });
      },
      restore: (snap) => {
        setSidebarCollapsed(snap.sidebar);
        setChatCollapsed(snap.chat);
        persistCollabLayout(workspacePath, { sidebarWidth, chatWidth, sidebarCollapsed: snap.sidebar, chatCollapsed: snap.chat });
      },
    });

  // If the user manually reopens a panel while maximized, drop the stale
  // restore snapshot so the next double-click re-maximizes from scratch.
  useEffect(() => {
    if (isEditorMaximized && !(sidebarCollapsed && chatCollapsed)) {
      clearEditorMaximized();
    }
  }, [isEditorMaximized, sidebarCollapsed, chatCollapsed, clearEditorMaximized]);

  const handleDocumentSelect = useCallback(async (doc: SharedDocument, initialContent?: string) => {
    // Opening a doc dismisses the discovery hub overlay.
    setShowHome(false);
    // Check if already open as a tab
    const existingTab = tabs.find((tab) => {
      if (!isCollabUri(tab.filePath)) return false;
      try {
        return parseCollabUri(tab.filePath).documentId === doc.documentId;
      } catch {
        return false;
      }
    });
    if (existingTab) {
      tabsActions.switchTab(existingTab.id);
      const nextName = reconcileSharedDocumentDisplayName(
        existingTab.fileName,
        doc.title,
        doc.documentId,
      );
      if (existingTab.fileName !== nextName) {
        tabsActions.updateTab(existingTab.id, { fileName: nextName });
      }
      return;
    }

    // Open as collab tab
    try {
      const tabId = await openCollabDocumentViaIPC({
        workspacePath,
        documentId: doc.documentId,
        title: doc.title,
        displayPath: getSharedDocumentDisplayPath(doc, sharedFolders),
        documentType: doc.documentType,
        metadataVersion: doc.metadataVersion,
        fileExtension: doc.fileExtension,
        editorId: doc.editorId,
        initialContent,
        addTab: tabsActions.addTab,
      });
      const nextName = getSharedDocumentDisplayName(doc.title, doc.documentId);
      if (tabsActions.getTabState(tabId)?.fileName !== nextName) {
        tabsActions.updateTab(tabId, { fileName: nextName });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[CollabMode] Failed to open shared document:', {
        documentId: doc.documentId,
        title: doc.title,
        error,
      });
      errorNotificationService.showError(
        'Failed to open shared document',
        message,
        { details: doc.title || doc.documentId }
      );
    }
  }, [workspacePath, tabs, tabsActions, sharedFolders]);

  const activeCollabDocumentId = useMemo(() => {
    if (!activeTabId) return null;
    const activeTab = tabs.find(tab => tab.id === activeTabId);
    if (!activeTab || !isCollabUri(activeTab.filePath)) return null;

    try {
      return parseCollabUri(activeTab.filePath).documentId;
    } catch {
      return null;
    }
  }, [activeTabId, tabs]);

  useEffect(() => {
    for (const tab of tabs) {
      if (!isCollabUri(tab.filePath)) continue;

      let documentId: string;
      try {
        documentId = parseCollabUri(tab.filePath).documentId;
      } catch {
        continue;
      }

      const document = sharedDocuments.find(doc => doc.documentId === documentId);
      if (!document) continue;

      const nextName = reconcileSharedDocumentDisplayName(
        tab.fileName,
        document.title,
        document.documentId,
      );
      updateCollabConfigDisplayMetadata(tab.filePath, {
        title: document.title,
        displayPath: getSharedDocumentDisplayPathWithFallback(
          document,
          sharedFolders,
          getCollabConfig(tab.filePath)?.displayPath || tab.fileName,
        ),
      });
      if (tab.fileName !== nextName) {
        tabsActions.updateTab(tab.id, { fileName: nextName });
      }
    }
  }, [sharedDocuments, sharedFolders, tabs, tabsActions]);

  // Persist open document entries (id + documentType) whenever tabs change.
  // documentType is required at restore time so the right editor is mounted;
  // without it CollaborativeTabEditor falls back to markdown for everything
  // and renders an Excalidraw / mockup Y.Doc as blank.
  useEffect(() => {
    if (!restored) return; // Don't persist until we've finished restoring
    const docsById = new Map<string, SharedDocument>();
    for (const d of sharedDocuments) docsById.set(d.documentId, d);

    const entries: PersistedCollabEntry[] = tabs
      .filter((t) => isCollabUri(t.filePath))
      .map<PersistedCollabEntry | null>((t) => {
        try {
          const { documentId } = parseCollabUri(t.filePath);
          const document = docsById.get(documentId);
          const registeredPath = getCollabConfig(t.filePath)?.displayPath;
          const displayPath = document
            ? getSharedDocumentDisplayPathWithFallback(
                document,
                sharedFolders,
                registeredPath || t.fileName,
              )
            : registeredPath || t.fileName;
          return {
            documentId,
            documentType: document?.documentType ?? 'markdown',
            metadataVersion: document?.metadataVersion,
            fileExtension: document?.fileExtension,
            editorId: document?.editorId,
            displayPath,
          };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is PersistedCollabEntry => entry !== null);
    persistOpenCollabDocs(workspacePath, entries);
  }, [tabs, sharedDocuments, sharedFolders, workspacePath, restored]);

  // Restore previously open collab documents on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const savedEntries = await loadOpenCollabDocs(workspacePath);
      if (cancelled || savedEntries.length === 0) {
        setRestored(true);
        return;
      }

      // Open each saved document. We don't need to wait for sharedDocumentsAtom
      // because openCollabDocumentViaIPC resolves auth/keys via IPC directly.
      // Use the last-known logical path as a warm display fallback. Legacy
      // entries have no path and render a neutral placeholder until index sync.
      for (const entry of savedEntries) {
        if (cancelled) break;
        try {
          await openCollabDocumentViaIPC({
            workspacePath,
            documentId: entry.documentId,
            title: entry.displayPath ? getCollabNodeName(entry.displayPath) : undefined,
            displayPath: entry.displayPath,
            documentType: entry.documentType,
            metadataVersion: entry.metadataVersion,
            fileExtension: entry.fileExtension,
            editorId: entry.editorId,
            addTab: tabsActions.addTab,
          });
        } catch (err) {
          console.warn('[CollabMode] Failed to restore collab document:', entry.documentId, err);
        }
      }
      setRestored(true);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]); // Only run on mount (tabsActions is stable ref-based)

  // Auto-open a pending document. Set by "Share to Team" (carries title +
  // initialContent for first-share seeding) and by deep links (documentId
  // only -- title arrives later via the shared-docs sync, which the
  // sharedDocuments rename effect picks up).
  useEffect(() => {
    if (!pendingDoc || !isActive) return;

    const docs = store.get(sharedDocumentsAtom);
    const found = docs.find(d => d.documentId === pendingDoc.documentId);

    // Prefer the synced doc (it has the canonical title), but fall back to
    // a synthetic doc so cold-start deep links still open immediately.
    const docToOpen: SharedDocument = found
      ? {
          ...found,
          ...(pendingDoc.documentType ? { documentType: pendingDoc.documentType } : {}),
          ...(pendingDoc.metadataVersion === 2 ? {
            metadataVersion: 2 as const,
            fileExtension: pendingDoc.fileExtension,
            editorId: pendingDoc.editorId,
          } : {}),
        }
      : {
          documentId: pendingDoc.documentId,
          title: '',
          documentType: pendingDoc.documentType ?? 'markdown',
          metadataVersion: pendingDoc.metadataVersion,
          fileExtension: pendingDoc.fileExtension,
          editorId: pendingDoc.editorId,
          createdBy: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

    store.set(pendingCollabDocumentAtom, null);
    handleDocumentSelect(docToOpen, pendingDoc.initialContent);
  }, [pendingDoc, isActive, handleDocumentSelect]);

  const handleTabClose = useCallback((tabId: string) => {
    tabsActions.removeTab(tabId);
  }, [tabsActions]);

  useImperativeHandle(ref, () => ({
    closeActiveTab: () => {
      if (activeTabId) {
        tabsActions.removeTab(activeTabId);
      }
    },
    reopenLastClosedTab: async () => {
      await tabsActions.reopenLastClosedTab(async () => {});
    },
    getActiveDocumentPath: () => {
      if (!activeTabId) return null;
      const activeTab = tabs.find((tab) => tab.id === activeTabId);
      return activeTab?.filePath ?? null;
    },
    toggleSidebarCollapsed,
  }), [activeTabId, tabs, tabsActions, toggleSidebarCollapsed]);

  const hasTabs = tabs.length > 0;

  return (
    <div className="collab-mode flex-1 flex flex-row overflow-hidden min-h-0">
      {/* Left: Document sidebar (resizable; hidden when collapsed via the
          Shared Docs nav-gutter icon, matching Files/Agent modes) */}
      {!sidebarCollapsed && (
        <>
          <div style={{ width: sidebarWidth, minWidth: COLLAB_SIDEBAR_MIN, maxWidth: COLLAB_SIDEBAR_MAX }} className="shrink-0">
            <CollabSidebar
              workspacePath={workspacePath}
              onDocumentSelect={handleDocumentSelect}
              activeDocumentId={activeCollabDocumentId}
              onShowHome={() => setShowHome(true)}
              homeActive={showHome || !hasTabs}
            />
          </div>

          {/* Left resize handle */}
          <div
            onPointerDown={handleSidebarPointerDown}
            className="collab-mode-sidebar-resize-handle w-1 cursor-col-resize shrink-0 relative z-10 bg-nim-secondary"
            data-testid="collab-mode-sidebar-resize-handle"
            role="separator"
            aria-label="Resize shared documents sidebar"
            aria-orientation="vertical"
          >
            <div className="w-0.5 h-full mx-auto bg-nim-border transition-colors duration-200 hover:bg-nim-accent" />
          </div>
        </>
      )}

      {/* Center: Tabs + editor */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {hasTabs ? (
          <TabManager
            onTabClose={handleTabClose}
            onNewTab={() => {}}
            isActive={isActive}
            onToggleAIChat={toggleChatCollapsed}
            isAIChatCollapsed={chatCollapsed}
            onTabDoubleClick={toggleEditorMaximized}
          >
            <>
              <TabContent
                workspaceId={workspacePath}
                onTabClose={handleTabClose}
                onGetContentReady={handleGetContentReady}
              />
              {/* Discovery hub overlay — reachable while tabs are open.
                  Rendered as a sibling so TabContent is never re-mounted. */}
              {showHome && (
                <div className="collab-home-overlay absolute inset-0 z-20 flex flex-col bg-nim">
                  <div className="flex items-center justify-end px-3 py-1.5 border-b border-nim shrink-0">
                    <button
                      type="button"
                      className="flex items-center gap-1 text-[12px] text-nim-muted hover:text-nim bg-transparent border-none cursor-pointer px-2 py-1 rounded hover:bg-nim-hover"
                      onClick={() => setShowHome(false)}
                      title="Back to editor"
                    >
                      <MaterialSymbol icon="close" size={16} />
                      Back to editor
                    </button>
                  </div>
                  <SharedDocsHome workspacePath={workspacePath} onDocumentSelect={handleDocumentSelect} />
                </div>
              )}
            </>
          </TabManager>
        ) : (
          /* No tabs open: the discovery hub is the full-bleed empty state */
          <SharedDocsHome workspacePath={workspacePath} onDocumentSelect={handleDocumentSelect} />
        )}
      </div>

      {/* Right: AI Chat sidebar (resizable via ChatSidebar built-in handle, collapsible) */}
      {hasTabs && (
        <ChatSidebar
          workspacePath={workspacePath}
          isActive={isActive}
          isCollapsed={chatCollapsed}
          onToggleCollapse={toggleChatCollapsed}
          getDocumentContext={getDocumentContext}
          onFileOpen={async (filePath) => onFileOpen(filePath)}
          width={chatWidth}
          onWidthChange={handleChatWidthChange}
        />
      )}
    </div>
  );
});
