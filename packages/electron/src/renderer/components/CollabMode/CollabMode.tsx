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
import type { CollabScope } from '@nimbalyst/collab-client/core';
import { createCollabDocsScopeLifecycle } from '@nimbalyst/collab-client/docs';
import { store } from '@nimbalyst/runtime/store';
import { CollabSidebar } from '@nimbalyst/collab-client/docs-ui';
import { ElectronCollabDocsUIProvider } from './ElectronCollabDocsUIProvider';
import { TabsProvider, useTabsActions, useTabs, useTabNavigationShortcuts, type TabData } from '../../contexts/TabsContext';
import { TabManager } from '../TabManager/TabManager';
import { TabContent } from '../TabContent/TabContent';
import type { DocumentSessionActions } from '../TabEditor/DocumentSessionControl';
import { ChatSidebar, type ChatSidebarRef } from '../ChatSidebar';
import { useEditorMaximize } from '../../hooks/useEditorMaximize';
import { useResizeDragShield } from '../../hooks/useResizeDragShield';
import {
  getCollabConfig,
  openCollabDocumentViaIPC,
  updateCollabConfigDisplayMetadata,
  type CollabDocumentOpenSource,
} from '../../utils/collabDocumentOpener';
import {
  loadOpenCollabDocs,
  persistOpenCollabDocs,
  type PersistedCollabEntry,
} from '../../utils/collabOpenDocsPersistence';
import {
  initSharedDocuments,
  getElectronCollabHost,
  getElectronCollabHostForScopeKey,
  getSharedDocumentsForScope,
  pendingCollabDocumentAtom,
  rebindElectronCollabHostScope,
  sharedDocumentsAtom,
  sharedFoldersAtom,
  type SharedDocument,
} from '../../store/atoms/collabDocuments';
import { changedDocIdsAtom } from '../../store/atoms/collabDiscovery';
import { SHARED_HOME_TAB_URI, SHARED_HOME_TAB_TITLE, isSharedHomeTab } from './sharedHomeTab';
import {
  SHARED_FEEDBACK_TAB_TITLE,
  SHARED_FEEDBACK_TAB_URI,
  isSharedFeedbackTab,
} from './sharedFeedbackTab';
import { SharedFeedbackTabButton } from './Feedback';
import { isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';
import {
  getCollabNodeName,
  getSharedDocumentDisplayName,
  getSharedDocumentDisplayPath,
  getSharedDocumentDisplayPathWithFallback,
  reconcileSharedDocumentDisplayName,
} from './collabTree';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import type { SerializableDocumentContext } from '../../hooks/useDocumentContext';
import { getTextSelection } from '../UnifiedAI/TextSelectionIndicator';
import { getActiveEditorContextItems } from '../../stores/editorContextStore';
import { categorizeTeamAnalyticsError, toStableAnalyticsCategory } from '../../../shared/analytics/teamAnalytics';
import { trackTeamAnalyticsEvent } from '../../utils/teamAnalytics';

interface CollabModeProps {
  workspacePath: string;
  isActive: boolean;
  onFileOpen: (path: string) => void;
  onPanelStateChange?: (state: { sidebarCollapsed: boolean; chatCollapsed: boolean }) => void;
}

interface CollabModeInnerProps extends Omit<CollabModeProps, 'workspacePath'> {
  scope: CollabScope;
}

export interface CollabModeRef {
  closeActiveTab: () => void;
  reopenLastClosedTab: () => Promise<void>;
  getActiveDocumentPath: () => string | null;
  toggleSidebarCollapsed: () => void;
  toggleChatCollapsed: () => void;
  createNewChatSession: () => Promise<void>;
}

export const CollabMode = forwardRef<CollabModeRef, CollabModeProps>(function CollabMode({
  workspacePath,
  isActive,
  onFileOpen,
  onPanelStateChange,
}, ref) {
  const [scope, setScope] = useState<CollabScope | null>(null);
  const scopeRef = useRef<CollabScope | null>(null);
  const hostRef = useRef<ReturnType<typeof getElectronCollabHostForScopeKey> | null>(null);
  if (!hostRef.current) hostRef.current = getElectronCollabHostForScopeKey(workspacePath);

  useEffect(() => {
    const lifecycle = createCollabDocsScopeLifecycle(hostRef.current!, {
      onSessionChanged: (session) => {
        const nextScope = session?.scope ?? null;
        scopeRef.current = nextScope;
        setScope(nextScope);
        if (nextScope) void initSharedDocuments(nextScope);
      },
      onError: (error) => {
        console.error('[CollabMode] Failed to resolve collaboration scope:', error);
      },
    });
    lifecycle.start();
    return () => lifecycle.dispose();
  }, []);

  useEffect(() => {
    rebindElectronCollabHostScope(hostRef.current!, workspacePath);
  }, [workspacePath]);

  useEffect(() => {
    if (isActive && scopeRef.current) void initSharedDocuments(scopeRef.current);
  }, [isActive]);

  if (!scope) {
    return <div className="collab-mode flex-1 min-h-0" />;
  }

  return (
    <TabsProvider key={scope.scopeKey} workspacePath={scope.scopeKey} disablePersistence>
      <ElectronCollabDocsUIProvider scope={scope}>
        <CollabModeInner
          ref={ref}
          scope={scope}
          isActive={isActive}
          onFileOpen={onFileOpen}
          onPanelStateChange={onPanelStateChange}
        />
      </ElectronCollabDocsUIProvider>
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

const layoutPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Save collab layout to workspace state (debounced). */
function persistCollabLayout(scope: CollabScope, layout: CollabLayout): void {
  const existingTimer = layoutPersistTimers.get(scope.scopeKey);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(async () => {
    layoutPersistTimers.delete(scope.scopeKey);
    try {
      await window.electronAPI?.invoke?.('workspace:update-state', scope.scopeKey, {
        collabLayout: layout,
      });
    } catch (err) {
      console.warn('[CollabMode] Failed to persist layout:', err);
    }
  }, 500);
  layoutPersistTimers.set(scope.scopeKey, timer);
}

/** Load collab layout from workspace state. */
async function loadCollabLayout(scope: CollabScope): Promise<CollabLayout> {
  try {
    const state = await window.electronAPI?.invoke?.('workspace:get-state', scope.scopeKey);
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
export const CollabModeInner = forwardRef<CollabModeRef, CollabModeInnerProps>(function CollabModeInner({
  scope,
  isActive,
  onFileOpen,
  onPanelStateChange,
}, ref) {
  const tabsActions = useTabsActions();
  const { tabs, activeTabId } = useTabs();
  useTabNavigationShortcuts(isActive);
  const pendingDoc = useAtomValue(pendingCollabDocumentAtom);
  const sharedDocuments = useAtomValue(sharedDocumentsAtom);
  const sharedFolders = useAtomValue(sharedFoldersAtom);
  const unreadDocumentIds = useAtomValue(changedDocIdsAtom);
  const [restored, setRestored] = useState(false);

  // --- Resizable / collapsible panel state ---
  const [sidebarWidth, setSidebarWidth] = useState(COLLAB_SIDEBAR_DEFAULT);
  const [chatWidth, setChatWidth] = useState(COLLAB_CHAT_DEFAULT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const chatSidebarRef = useRef<ChatSidebarRef>(null);

  useEffect(() => {
    onPanelStateChange?.({ sidebarCollapsed, chatCollapsed });
  }, [sidebarCollapsed, chatCollapsed, onPanelStateChange]);

  // The Shared Docs Home is a singleton virtual tab (NIM-1790). Opening it
  // dedupes by URI, so this focuses the existing tab if present.
  const openSharedHomeTab = useCallback((switchToTab = true) => {
    tabsActions.addTab(SHARED_HOME_TAB_URI, '', switchToTab, SHARED_HOME_TAB_TITLE);
  }, [tabsActions]);

  // The feedback list is a singleton tab for the same reason the home is: it is
  // a surface over the whole shared area rather than one document, and a second
  // copy of it would be a second copy of the same list.
  const openSharedFeedbackTab = useCallback(() => {
    tabsActions.addTab(SHARED_FEEDBACK_TAB_URI, '', true, SHARED_FEEDBACK_TAB_TITLE);
  }, [tabsActions]);

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

    // Include the current text selection so the agent gets the "+ selection"
    // context, but only if it belongs to this collab document. Mirrors
    // EditorMode.getDocumentContext for regular files.
    const textSelectionData = getTextSelection();
    const textSelection = textSelectionData && textSelectionData.filePath === activeTab.filePath
      ? textSelectionData
      : undefined;

    return {
      filePath: activeTab.filePath,
      fileType: 'collab-markdown',
      content,
      textSelection,
      textSelectionTimestamp: textSelection?.timestamp,
      // Extension-provided selection context (e.g. a spreadsheet's selected
      // cells) for the active collab document. Mirrors EditorMode; without it a
      // collaborative spreadsheet's "+ selection" never reaches the agent.
      editorContextItems: getActiveEditorContextItems(activeTab.filePath),
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
      workspacePath: scope.scopeKey,
      cursorPosition: undefined,
      selection: undefined,
    });
  }, [isActive, activeTabId, tabs, scope.scopeKey]);

  // Load persisted layout on mount
  useEffect(() => {
    let cancelled = false;
    loadCollabLayout(scope).then((layout) => {
      if (cancelled) return;
      setSidebarWidth(layout.sidebarWidth);
      setChatWidth(layout.chatWidth);
      setSidebarCollapsed(layout.sidebarCollapsed);
      setChatCollapsed(layout.chatCollapsed);
    });
    return () => { cancelled = true; };
  }, [scope]);

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
      persistCollabLayout(scope, {
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
    persistCollabLayout(scope, { sidebarWidth, chatWidth: newWidth, sidebarCollapsed, chatCollapsed });
  }, [scope, sidebarWidth, sidebarCollapsed, chatCollapsed]);

  // --- Collapse toggles (left document tree + right chat panel) ---
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      persistCollabLayout(scope, { sidebarWidth, chatWidth, sidebarCollapsed: next, chatCollapsed });
      return next;
    });
  }, [scope, sidebarWidth, chatWidth, chatCollapsed]);

  const toggleChatCollapsed = useCallback(() => {
    setChatCollapsed((prev) => {
      const next = !prev;
      persistCollabLayout(scope, { sidebarWidth, chatWidth, sidebarCollapsed, chatCollapsed: next });
      return next;
    });
  }, [scope, sidebarWidth, chatWidth, sidebarCollapsed]);

  // Double-click a tab to maximize the editor (collapse doc list + AI chat).
  // Second double-click restores the exact prior collapse state.
  const { isMaximized: isEditorMaximized, toggle: toggleEditorMaximized, clearMaximize: clearEditorMaximized } =
    useEditorMaximize<{ sidebar: boolean; chat: boolean }>({
      scopeKey: scope.scopeKey,
      snapshot: () => ({ sidebar: sidebarCollapsed, chat: chatCollapsed }),
      maximize: () => {
        setSidebarCollapsed(true);
        setChatCollapsed(true);
        persistCollabLayout(scope, { sidebarWidth, chatWidth, sidebarCollapsed: true, chatCollapsed: true });
      },
      restore: (snap) => {
        setSidebarCollapsed(snap.sidebar);
        setChatCollapsed(snap.chat);
        persistCollabLayout(scope, { sidebarWidth, chatWidth, sidebarCollapsed: snap.sidebar, chatCollapsed: snap.chat });
      },
    });

  // If the user manually reopens a panel while maximized, drop the stale
  // restore snapshot so the next double-click re-maximizes from scratch.
  useEffect(() => {
    if (isEditorMaximized && !(sidebarCollapsed && chatCollapsed)) {
      clearEditorMaximized();
    }
  }, [isEditorMaximized, sidebarCollapsed, chatCollapsed, clearEditorMaximized]);

  const handleDocumentSelect = useCallback(async (
    doc: SharedDocument,
    initialContent?: string,
    analyticsSource: CollabDocumentOpenSource = 'sidebar',
  ) => {
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
      trackTeamAnalyticsEvent('collab_document_opened', {
        surface: 'desktop',
        source: analyticsSource,
        actorType: analyticsSource === 'agent_tool' ? 'agent' : 'user',
        documentType: toStableAnalyticsCategory(doc.documentType),
        editorCategory: doc.editorId?.startsWith('builtin.monaco')
          ? 'monaco'
          : doc.editorId?.startsWith('builtin.lexical') || doc.documentType === 'markdown'
            ? 'lexical'
            : 'extension',
        wasUnread: unreadDocumentIds.has(doc.documentId),
        connectionPath: 'resume',
      });
      return;
    }

    // Open as collab tab
    try {
      const tabId = await openCollabDocumentViaIPC({
        scope,
        documentId: doc.documentId,
        title: doc.title,
        displayPath: getSharedDocumentDisplayPath(doc, sharedFolders),
        documentType: doc.documentType,
        metadataVersion: doc.metadataVersion,
        fileExtension: doc.fileExtension,
        editorId: doc.editorId,
        analyticsSource,
        analyticsActorType: analyticsSource === 'agent_tool' ? 'agent' : 'user',
        analyticsWasUnread: unreadDocumentIds.has(doc.documentId),
        initialContent,
        addTab: tabsActions.addTab,
      });
      const nextName = getSharedDocumentDisplayName(doc.title, doc.documentId);
      if (tabsActions.getTabState(tabId)?.fileName !== nextName) {
        tabsActions.updateTab(tabId, { fileName: nextName });
      }
    } catch (error) {
      trackTeamAnalyticsEvent('collab_operation_failed', {
        surface: 'desktop',
        operation: 'open_document',
        source: analyticsSource,
        actorType: analyticsSource === 'agent_tool' ? 'agent' : 'user',
        documentType: toStableAnalyticsCategory(doc.documentType),
        errorCategory: categorizeTeamAnalyticsError('document', error),
      });
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
  }, [scope, tabs, tabsActions, sharedFolders, unreadDocumentIds]);

  useEffect(() => getElectronCollabHost(scope).setOpenArtifactAdapter((ref, source) => {
    if (ref.kind !== 'document' || ref.scope.scopeKey !== scope.scopeKey) return;
    const document = sharedDocuments.find((item) => item.documentId === ref.documentId);
    if (document) void handleDocumentSelect(document, undefined, source);
  }), [scope, sharedDocuments, handleDocumentSelect]);

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
      updateCollabConfigDisplayMetadata(scope, tab.filePath, {
        title: document.title,
        displayPath: getSharedDocumentDisplayPathWithFallback(
          document,
          sharedFolders,
          getCollabConfig(scope, tab.filePath)?.displayPath || tab.fileName,
        ),
      });
      if (tab.fileName !== nextName) {
        tabsActions.updateTab(tab.id, { fileName: nextName });
      }
    }
  }, [scope, sharedDocuments, sharedFolders, tabs, tabsActions]);

  // Persist open document entries, including tab order and pinned state,
  // whenever tabs change.
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
          const registeredPath = getCollabConfig(scope, t.filePath)?.displayPath;
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
            isPinned: t.isPinned,
          };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is PersistedCollabEntry => entry !== null);
    persistOpenCollabDocs(scope, entries);
  }, [tabs, sharedDocuments, sharedFolders, scope, restored]);

  // Restore previously open collab documents on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const savedEntries = await loadOpenCollabDocs(scope);
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
            scope,
            documentId: entry.documentId,
            title: entry.displayPath ? getCollabNodeName(entry.displayPath) : undefined,
            displayPath: entry.displayPath,
            documentType: entry.documentType,
            metadataVersion: entry.metadataVersion,
            fileExtension: entry.fileExtension,
            editorId: entry.editorId,
            analyticsSource: 'restart_restore',
            isPinned: entry.isPinned,
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
  }, [scope]); // TabsProvider is keyed by scope; tabsActions is stable per mount.

  // Auto-open a pending document. Set by "Share to Team" (carries title +
  // initialContent for first-share seeding) and by deep links (documentId
  // only -- title arrives later via the shared-docs sync, which the
  // sharedDocuments rename effect picks up).
  useEffect(() => {
    if (
      !pendingDoc
      || !isActive
      || pendingDoc.scopeKey !== scope.scopeKey
      || pendingDoc.orgId !== scope.orgId
    ) return;

    const docs = getSharedDocumentsForScope(scope);
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
          teamProjectId: scope.indexConfig.teamProjectId ?? null,
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
    handleDocumentSelect(docToOpen, pendingDoc.initialContent, pendingDoc.analyticsSource ?? 'deep_link');
  }, [pendingDoc, isActive, handleDocumentSelect, scope]);

  // Ensure the singleton Shared Docs Home tab exists once restore settles, so
  // the shared area always lands on the list-view home (replaces the old
  // empty-state card hub). Switch to it only when nothing else is open.
  useEffect(() => {
    if (!restored) return;
    const snapshot = tabsActions.getSnapshot();
    const hasHome = Array.from(snapshot.tabs.values()).some((t) => isSharedHomeTab(t.filePath));
    if (!hasHome) {
      openSharedHomeTab(snapshot.tabs.size === 0);
    }
  }, [restored, openSharedHomeTab, tabsActions]);

  // Reopen the home tab if the user closes the last remaining tab, so the
  // shared area never falls back to a blank pane.
  useEffect(() => {
    if (!restored) return;
    if (tabs.length === 0) {
      openSharedHomeTab(true);
    }
  }, [restored, tabs.length, openSharedHomeTab]);

  const activeTabIsHome = useMemo(() => {
    if (!activeTabId) return false;
    const tab = tabs.find((t) => t.id === activeTabId);
    return tab ? isSharedHomeTab(tab.filePath) : false;
  }, [activeTabId, tabs]);

  const activeTabIsFeedback = useMemo(() => {
    if (!activeTabId) return false;
    const tab = tabs.find((t) => t.id === activeTabId);
    return tab ? isSharedFeedbackTab(tab.filePath) : false;
  }, [activeTabId, tabs]);

  // File path of the active collab document, so the chat panel scopes its
  // "+ selection" chips to the doc the user is actually looking at. Without a
  // currentFilePath the chip row falls back to "most recent" and leaks a stale
  // selection from a previously-active tab (e.g. a spreadsheet's cells still
  // showing after switching to a markdown doc). Empty for the Shared Docs Home.
  const activeCollabFilePath = useMemo(() => {
    if (!activeTabId) return '';
    const tab = tabs.find((t) => t.id === activeTabId);
    return tab && isCollabUri(tab.filePath) ? tab.filePath : '';
  }, [activeTabId, tabs]);

  // The header-bar session chip acts on the chat sidebar this mode already
  // owns. Deliberately no `openInAgentMode` — a shared document isn't a file
  // Agent mode can open.
  const documentSessionActions = useMemo<DocumentSessionActions>(() => ({
    openInChat: (sessionId: string) => {
      setChatCollapsed(false);
      chatSidebarRef.current?.loadSession(sessionId);
    },
    startNew: () => {
      setChatCollapsed(false);
      void chatSidebarRef.current?.createNewSession();
    },
  }), []);

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
    toggleChatCollapsed,
    createNewChatSession: async () => {
      if (chatCollapsed) {
        setChatCollapsed(false);
      }
      await chatSidebarRef.current?.createNewSession();
    },
  }), [
    activeTabId,
    tabs,
    tabsActions,
    toggleSidebarCollapsed,
    toggleChatCollapsed,
    chatCollapsed,
  ]);

  const hasTabs = tabs.length > 0;

  return (
    <div className="collab-mode flex-1 flex flex-row overflow-hidden min-h-0">
      {/* Left: Document sidebar (resizable; hidden when collapsed via the
          Shared Docs nav-gutter icon, matching Files/Agent modes) */}
      {!sidebarCollapsed && (
        <>
          <div style={{ width: sidebarWidth, minWidth: COLLAB_SIDEBAR_MIN, maxWidth: COLLAB_SIDEBAR_MAX }} className="shrink-0">
            <CollabSidebar
              activeDocumentId={activeCollabDocumentId}
              onShowHome={() => openSharedHomeTab(true)}
              homeActive={activeTabIsHome}
              headerActions={(
                <SharedFeedbackTabButton
                  active={activeTabIsFeedback}
                  onOpen={openSharedFeedbackTab}
                />
              )}
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

      {/* Center: Tabs + editor. The Shared Docs Home is itself a (singleton)
          tab now, so the tab strip is always present. */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {hasTabs && (
          <TabManager
            onTabClose={handleTabClose}
            onNewTab={() => openSharedHomeTab(true)}
            isActive={isActive}
            onToggleAIChat={toggleChatCollapsed}
            isAIChatCollapsed={chatCollapsed}
            onTabDoubleClick={toggleEditorMaximized}
          >
            <TabContent
              workspaceId={scope.scopeKey}
              collabScope={scope}
              onTabClose={handleTabClose}
              onGetContentReady={handleGetContentReady}
              documentSessionActions={documentSessionActions}
            />
          </TabManager>
        )}
      </div>

      {/* Right: AI Chat sidebar (resizable via ChatSidebar built-in handle,
          collapsible). Shown on every tab, including the Shared Docs Home. */}
      {hasTabs && (
        <ChatSidebar
          ref={chatSidebarRef}
          workspacePath={scope.scopeKey}
          isActive={isActive}
          isCollapsed={chatCollapsed}
          onToggleCollapse={toggleChatCollapsed}
          documentContext={{ filePath: activeCollabFilePath }}
          getDocumentContext={getDocumentContext}
          onFileOpen={async (filePath) => onFileOpen(filePath)}
          width={chatWidth}
          onWidthChange={handleChatWidthChange}
        />
      )}
    </div>
  );
});
