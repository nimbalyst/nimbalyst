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
import { atom, useAtomValue, useSetAtom } from 'jotai';
import { setTitleBarCreateMenuAtom } from '../../store/atoms/titleBarCreate';
import { CollabScopeResolutionError, type CollabOpenOptions, type CollabScope } from '@nimbalyst/collab-client/core';
import { createCollabDocsScopeLifecycle, pageDisplayName, sharedIndexLoadedForScopeAtom, sharedIndexUnavailableForScopeAtom } from '@nimbalyst/collab-client/docs';
import { store } from '@nimbalyst/runtime/store';
import type { CollabSidebarCreateMenu } from '@nimbalyst/collab-client/docs-ui';
import { useDocUnread } from '../../hooks/useDocUnread';
import {
  PERSONAL_PAGE_TAB_PREFIX,
  TabsProvider,
  isPersonalPageTabPath,
  useTabsActions,
  useTabs,
  useTabNavigationShortcuts,
} from '../../contexts/TabsContext';
import { TabManager } from '../TabManager/TabManager';
import { TrackerTabIssueKeyContext } from '../TabManager/trackerTabIssueKey';
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
import { activePageRow, openPageTab } from './collabPageTabs';
import { composePagesCreateMenu } from './pagesCreateMenu';
import { PagesTabHistoryButtons, usePagesTabNavigation } from './usePagesTabNavigation';
import { PagesSwipeNavigation } from './PagesSwipeNavigation';
import { TeamPagesErrorBanner } from './TeamPagesErrorBanner';
import { useCollabTabPersistence } from './useCollabTabPersistence';
import { useLocalWikiFileTabs } from './useLocalWikiFileTabs';
import { usePublishPagesTabStrip } from '../../services/pageTreeTools/pagesTabStrip';
import { PagesSidebarSections, useSectionHomeId } from './PagesSidebarSections';
import { pageHeaderRequestPendingAtom } from './pageTypeRequest';
import type { PagesSectionLane, PagesSectionView } from './pagesSectionTabs';
import {
  initSharedDocuments,
  getElectronCollabDocsSession,
  getElectronCollabHost,
  getElectronCollabHostForScopeKey,
  getPersonalCollabDocsSession,
  getPersonalCollabHost,
  getLinkableSharedDocumentsForScopeKey,
  linkableSharedDocumentsAtom,
  pendingCollabDocumentAtom,
  rebindElectronCollabHostScope,
  sharedDocumentsAtom,
  sharedFoldersAtom,
  teamPagesStartErrorAtomFamily,
  type SharedDocument,
} from '../../store/atoms/collabDocuments';
import {
  pendingCollabDocumentFailure,
  resolvePendingCollabDocument,
  type TeamScopeUnavailable,
} from './pendingCollabDocument';
import { changedDocIdsAtom } from '../../store/atoms/collabDiscovery';
import { isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';
import {
  getSharedDocumentDisplayName,
  getSharedDocumentDisplayPath,
  getSharedDocumentDisplayPathWithFallback,
  reconcileSharedDocumentDisplayName,
} from './collabTree';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { collabFileType, type SerializableDocumentContext } from '../../hooks/useDocumentContext';
import { getPagesDocumentContext, pagesDocumentIdentity } from './pagesDocumentContext';
import { categorizeTeamAnalyticsError, toStableAnalyticsCategory } from '../../../shared/analytics/teamAnalytics';
import { trackTeamAnalyticsEvent } from '../../utils/teamAnalytics';

/** Read in place of a team scope's index flag while there is no team scope. */
const NO_INDEX_ATOM = atom(false);
const NO_INDEX_FAILURE_ATOM = atom<string | null>(null);

interface CollabModeProps {
  workspacePath: string;
  isActive: boolean;
  onFileOpen: (path: string) => void;
  onPanelStateChange?: (state: { sidebarCollapsed: boolean; chatCollapsed: boolean }) => void;
}

interface CollabModeInnerProps extends CollabModeProps {
  /** The project's team scope, or null with no account, no team, or while resolving. */
  teamScope: CollabScope | null;
  /** Why `teamScope` is null once resolution stopped; null while it is still resolving. */
  teamUnavailable: TeamScopeUnavailable | null;
  /** Ask the host for the team scope again after it gave up. */
  onRetryTeamScope: () => void;
  /** This workspace's Personal pages scope; always present. */
  personalScope: CollabScope;
}

export interface CollabModeRef {
  closeActiveTab: () => void;
  reopenLastClosedTab: () => Promise<void>;
  getActiveDocumentPath: () => string | null;
  toggleSidebarCollapsed: () => void;
  toggleChatCollapsed: () => void;
  toggleEditorMaximized: () => void;
  createNewChatSession: () => Promise<void>;
  /** Creates a shared Markdown doc in the sidebar's current target folder. */
  createNewDocument: () => void;
}

export const CollabMode = forwardRef<CollabModeRef, CollabModeProps>(function CollabMode({
  workspacePath,
  isActive,
  onFileOpen,
  onPanelStateChange,
}, ref) {
  const [scope, setScope] = useState<CollabScope | null>(null);
  const [teamUnavailable, setTeamUnavailable] = useState<TeamScopeUnavailable | null>(null);
  const scopeRef = useRef<CollabScope | null>(null);
  const hostRef = useRef<ReturnType<typeof getElectronCollabHostForScopeKey> | null>(null);
  if (!hostRef.current) hostRef.current = getElectronCollabHostForScopeKey(workspacePath);
  // Desktop read-receipt hydration for the active (team) scope; a no-op
  // without one. Single-mount: the Personal section never runs it.
  useDocUnread();

  // Personal pages need no account, so their session starts with the mode and
  // is never activated: the team scope stays the window's active scope.
  const personalSession = useMemo(() => getPersonalCollabDocsSession(workspacePath), [workspacePath]);
  useEffect(() => {
    void personalSession.start().catch((error) => {
      console.error('[CollabMode] Failed to load personal pages:', error);
    });
  }, [personalSession]);

  useEffect(() => {
    const lifecycle = createCollabDocsScopeLifecycle(hostRef.current!, {
      onSessionChanged: (session) => {
        const nextScope = session?.scope ?? null;
        scopeRef.current = nextScope;
        setScope(nextScope);
        // A scope, or resolution starting over (sign-in, org change, Retry):
        // an earlier failure is no longer the answer.
        setTeamUnavailable(null);
        if (nextScope) void initSharedDocuments(nextScope);
      },
      onError: (error) => {
        // A session's start failure also lands here; `initSharedDocuments`
        // records that one against the scope.
        if (scopeRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        // Signed out, or a project with no team, is the normal Personal-only
        // state: the resolver marks both as final answers, not failures.
        if (error instanceof CollabScopeResolutionError && !error.retryable) {
          console.debug('[CollabMode] No team scope; showing Personal pages only:', message);
          setTeamUnavailable({ message, retryable: false });
          return;
        }
        // The lifecycle has stopped retrying: say so instead of waiting silently.
        console.error('[CollabMode] Failed to resolve collaboration scope:', error);
        setTeamUnavailable({ message, retryable: true });
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

  // Keyed by the workspace, not the team scope: Personal tabs outlive a team
  // scope that is still resolving, signed out, or replaced.
  return (
    <TabsProvider key={workspacePath} workspacePath={workspacePath} disablePersistence>
      <CollabModeInner
        ref={ref}
        workspacePath={workspacePath}
        teamScope={scope}
        teamUnavailable={teamUnavailable}
        onRetryTeamScope={() => {
          setTeamUnavailable(null);
          hostRef.current!.invalidateScope();
        }}
        personalScope={personalSession.scope}
        isActive={isActive}
        onFileOpen={onFileOpen}
        onPanelStateChange={onPanelStateChange}
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

const layoutPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Save collab layout to workspace state (debounced). */
function persistCollabLayout(workspacePath: string, layout: CollabLayout): void {
  const existingTimer = layoutPersistTimers.get(workspacePath);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(async () => {
    layoutPersistTimers.delete(workspacePath);
    try {
      await window.electronAPI?.invoke?.('workspace:update-state', workspacePath, {
        collabLayout: layout,
      });
    } catch (err) {
      console.warn('[CollabMode] Failed to persist layout:', err);
    }
  }, 500);
  layoutPersistTimers.set(workspacePath, timer);
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
export const CollabModeInner = forwardRef<CollabModeRef, CollabModeInnerProps>(function CollabModeInner({
  workspacePath,
  teamScope,
  teamUnavailable,
  onRetryTeamScope,
  personalScope,
  isActive,
  onFileOpen,
  onPanelStateChange,
}, ref) {
  const tabsActions = useTabsActions();
  usePublishPagesTabStrip(workspacePath, tabsActions);
  const { tabs, activeTabId } = useTabs();
  useTabNavigationShortcuts(isActive);
  // A click opens in the current tab (Cmd/Ctrl: a new one); each tab keeps Back/Forward.
  const { addTabFor, step: stepPagesHistory } = usePagesTabNavigation(isActive, workspacePath);
  const tabContentAreaRef = useRef<HTMLDivElement>(null);
  const pendingDoc = useAtomValue(pendingCollabDocumentAtom);
  const sharedDocuments = useAtomValue(sharedDocumentsAtom);
  // Opening and naming an existing link also finds other projects' pages,
  // which the window's lists leave out.
  const linkableDocuments = useAtomValue(linkableSharedDocumentsAtom);
  const sharedFolders = useAtomValue(sharedFoldersAtom);
  const unreadDocumentIds = useAtomValue(changedDocIdsAtom);

  // --- Resizable / collapsible panel state ---
  const [sidebarWidth, setSidebarWidth] = useState(COLLAB_SIDEBAR_DEFAULT);
  const [chatWidth, setChatWidth] = useState(COLLAB_CHAT_DEFAULT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const chatSidebarRef = useRef<ChatSidebarRef>(null);
  /**
   * The sidebar builds the shared-document type list (it owns the catalog
   * filtering); this republishes it for the title bar's create control.
   */
  const setTitleBarCreateMenu = useSetAtom(setTitleBarCreateMenuAtom);
  const createPrimaryRef = useRef<(() => void) | null>(null);
  const createMenusRef = useRef<{
    team: CollabSidebarCreateMenu | null;
    personal: CollabSidebarCreateMenu | null;
  }>({ team: null, personal: null });
  const publishCreateMenu = useCallback(() => {
    const menu = composePagesCreateMenu(createMenusRef.current.team, createMenusRef.current.personal, (section) => {
      void import('../../services/addFileToPages').then(({ addFileToPages }) => addFileToPages({ section, parentId: null, workspacePath }));
    });
    createPrimaryRef.current = menu?.onPrimary ?? null;
    setTitleBarCreateMenu('collab', menu);
  }, [setTitleBarCreateMenu, workspacePath]);
  const registerTeamCreateMenu = useCallback((menu: CollabSidebarCreateMenu | null) => {
    createMenusRef.current.team = menu;
    publishCreateMenu();
  }, [publishCreateMenu]);
  const registerPersonalCreateMenu = useCallback((menu: CollabSidebarCreateMenu | null) => {
    createMenusRef.current.personal = menu;
    publishCreateMenu();
  }, [publishCreateMenu]);

  useEffect(() => {
    onPanelStateChange?.({ sidebarCollapsed, chatCollapsed });
  }, [sidebarCollapsed, chatCollapsed, onPanelStateChange]);

  // A section's Search and Types are one tab each: opening one that is open
  // focuses it, otherwise it lands per the click (`addTabFor`).
  const openSectionView = useCallback((view: PagesSectionView, lane: PagesSectionLane, options?: CollabOpenOptions) => {
    openPageTab(addTabFor(options), { kind: view, artifactId: lane });
  }, [addTabFor]);

  // Refs for sidebar resize drag (avoids re-renders during drag)
  const sidebarDragRef = useRef({ startX: 0, startWidth: 0, latestWidth: sidebarWidth });
  sidebarDragRef.current.latestWidth = sidebarWidth;

  // A page click reuses the tab ID. Keep the getter's document identity too,
  // so the next page cannot send the previous page's body while loading.
  const getContentByTabIdRef = useRef<Map<string, { filePath: string; read: () => string }>>(new Map());

  const handleGetContentReady = useCallback((tabId: string, getContentFn: () => string) => {
    const tab = tabsActions.getSnapshot().tabs.get(tabId);
    if (tab) getContentByTabIdRef.current.set(tabId, { filePath: tab.filePath, read: getContentFn });
  }, [tabsActions]);

  const getDocumentContext = useCallback(async (): Promise<SerializableDocumentContext> => {
    const snapshot = tabsActions.getSnapshot();
    const activeTab = snapshot.activeTabId ? snapshot.tabs.get(snapshot.activeTabId) : undefined;
    return getPagesDocumentContext(
      activeTab,
      activeTab ? getContentByTabIdRef.current.get(activeTab.id) : undefined,
      async (filePath) => {
        const result = await window.electronAPI.readFileContent(filePath);
        if (!result?.success) throw new Error(`Could not read page context: ${filePath}`);
        return result.content ?? '';
      },
    );
  }, [tabsActions]);

  // Prune getContent entries for tabs that no longer exist.
  useEffect(() => {
    const liveTabIds = new Set(tabs.map(t => t.id));
    for (const tabId of getContentByTabIdRef.current.keys()) {
      if (!liveTabIds.has(tabId)) {
        getContentByTabIdRef.current.delete(tabId);
      }
    }
  }, [tabs]);

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
      fileType: collabFileType(activeTab.filePath),
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

  // A page header's Set type, Move, Rename or Trash is answered by the sidebar, so it opens to run them.
  const headerRequestPending = useAtomValue(pageHeaderRequestPendingAtom);
  useEffect(() => {
    if (headerRequestPending && sidebarCollapsed) toggleSidebarCollapsed();
  }, [headerRequestPending, sidebarCollapsed, toggleSidebarCollapsed]);

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

  const handleDocumentSelect = useCallback(async (
    doc: SharedDocument,
    initialContent?: string,
    analyticsSource: CollabDocumentOpenSource = 'sidebar',
    openOptions?: CollabOpenOptions,
  ) => {
    if (!teamScope) return;
    // Check if already open as a tab. A plain click navigates the current tab
    // even when another tab shows the page, so only the current tab counts.
    const candidates = openOptions && !openOptions.newTab ? tabs.filter((tab) => tab.id === activeTabId) : tabs;
    const existingTab = candidates.find((tab) => {
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
        scope: teamScope,
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
        addTab: addTabFor(openOptions),
      });
      const nextName = pageDisplayName(getSharedDocumentDisplayName(doc.title, doc.documentId), doc.documentType);
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
  }, [teamScope, tabs, activeTabId, tabsActions, addTabFor, sharedFolders, unreadDocumentIds]);

  useEffect(() => teamScope ? getElectronCollabHost(teamScope).setOpenArtifactAdapter((ref, source, options) => {
    if (ref.scope.scopeKey !== teamScope.scopeKey) return;
    // Items and types open as pages here; they never hand off to Tracker mode.
    if (ref.kind === 'tracker') {
      openPageTab(addTabFor(options), { kind: 'tracker', artifactId: ref.trackerId });
      return;
    }
    if (ref.kind === 'type') {
      openPageTab(addTabFor(options), { kind: 'type', artifactId: ref.typeId });
      return;
    }
    if (ref.kind !== 'document') return;
    const document = linkableDocuments.find((item) => item.documentId === ref.documentId);
    if (document) void handleDocumentSelect(document, undefined, source, options);
  }) : undefined, [teamScope, linkableDocuments, handleDocumentSelect, addTabFor]);

  // Local pages open as their markdown files, database pages not exported yet
  // as `personal://` tabs; items and types open as pages, the same as the team's.
  useEffect(() => getPersonalCollabHost(workspacePath).setOpenArtifactAdapter((target, _source, options) => {
    if (target.kind === 'personal-page' || target.kind === 'local-file') {
      addTabFor(options)(target.path, '', true, target.title);
      return;
    }
    openPageTab(addTabFor(options), target.kind === 'tracker'
      ? { kind: 'tracker', artifactId: target.trackerId }
      : { kind: 'type', artifactId: target.typeId });
  }), [workspacePath, addTabFor]);

  // Keep personal page tab titles in step with renames in the tree.
  const personalDocuments = useAtomValue(getPersonalCollabDocsSession(workspacePath).atoms.sharedDocuments);
  useEffect(() => {
    const titleById = new Map(personalDocuments.map((document) => [
      document.documentId,
      pageDisplayName(getSharedDocumentDisplayName(document.title, document.documentId), document.documentType),
    ]));
    for (const tab of tabs) {
      if (!isPersonalPageTabPath(tab.filePath)) continue;
      const title = titleById.get(tab.filePath.slice(PERSONAL_PAGE_TAB_PREFIX.length));
      if (title && tab.fileName !== title) tabsActions.updateTab(tab.id, { fileName: title });
    }
  }, [personalDocuments, tabs, tabsActions]);
  useLocalWikiFileTabs(workspacePath, personalDocuments, tabs, tabsActions);

  // Relationship clicks on an item page, and row clicks on a type page.
  const handleOpenTrackerPage = useCallback((trackerItemId: string, options?: CollabOpenOptions) => {
    openPageTab(addTabFor(options), { kind: 'tracker', artifactId: trackerItemId });
  }, [addTabFor]);

  const activeTabPath = activeTabId ? tabs.find(tab => tab.id === activeTabId)?.filePath ?? null : null;
  const activeCollabDocumentId = useMemo(() => {
    if (!activeTabPath || !isCollabUri(activeTabPath)) return null;
    try {
      return parseCollabUri(activeTabPath).documentId;
    } catch {
      return null;
    }
  }, [activeTabPath]);
  const activePersonalDocumentId = activeTabPath && isPersonalPageTabPath(activeTabPath)
    ? activeTabPath.slice(PERSONAL_PAGE_TAB_PREFIX.length)
    : activeTabPath ? getPersonalCollabHost(workspacePath).source().documentIdForFile(activeTabPath) : null;
  const activeRow = useMemo(() => activePageRow(activeTabPath), [activeTabPath]);

  useEffect(() => {
    if (!teamScope) return;
    for (const tab of tabs) {
      if (!isCollabUri(tab.filePath)) continue;

      let documentId: string;
      try {
        documentId = parseCollabUri(tab.filePath).documentId;
      } catch {
        continue;
      }

      const document = linkableDocuments.find(doc => doc.documentId === documentId);
      if (!document) continue;

      const nextName = reconcileSharedDocumentDisplayName(
        tab.fileName,
        document.title,
        document.documentId,
      );
      updateCollabConfigDisplayMetadata(teamScope, tab.filePath, {
        title: document.title,
        displayPath: getSharedDocumentDisplayPathWithFallback(
          document,
          sharedFolders,
          getCollabConfig(teamScope, tab.filePath)?.displayPath || tab.fileName,
        ),
      });
      if (tab.fileName !== nextName) {
        tabsActions.updateTab(tab.id, { fileName: nextName });
      }
    }
  }, [teamScope, linkableDocuments, sharedFolders, tabs, tabsActions]);

  const restored = useCollabTabPersistence({
    workspacePath,
    teamScope,
    personalScope,
    tabs,
    tabsActions,
    sharedDocuments,
    sharedFolders,
  });

  // A pending document: "Share to Team" (type + initialContent for first-share
  // seeding), a pick from an index-backed list (type), or a link (id only).
  // It ends in the page or a visible error, never a guessed editor.
  const indexLoadedAtom = useMemo(
    () => (teamScope ? sharedIndexLoadedForScopeAtom(teamScope.scopeKey) : NO_INDEX_ATOM),
    [teamScope],
  );
  const indexLoaded = useAtomValue(indexLoadedAtom);
  const indexUnavailableAtom = useMemo(
    () => (teamScope ? sharedIndexUnavailableForScopeAtom(teamScope.scopeKey) : NO_INDEX_FAILURE_ATOM),
    [teamScope],
  );
  const indexUnavailable = useAtomValue(indexUnavailableAtom);
  const teamStartError = useAtomValue(teamPagesStartErrorAtomFamily(workspacePath));
  useEffect(() => {
    if (!pendingDoc || pendingDoc.scopeKey !== workspacePath) return;
    const failure = pendingCollabDocumentFailure(pendingDoc, { teamScope, teamUnavailable, startError: teamStartError });
    if (failure) {
      store.set(pendingCollabDocumentAtom, null);
      errorNotificationService.showError('Could not open shared page', failure);
      return;
    }
    if (!isActive || !teamScope) return;

    const resolution = resolvePendingCollabDocument(pendingDoc, {
      linkableDocuments: getLinkableSharedDocumentsForScopeKey(teamScope.scopeKey),
      indexLoaded,
      indexUnavailable,
      teamProjectId: teamScope.indexConfig.teamProjectId ?? null,
      now: Date.now(),
    });
    // Re-run when the index delivers it (`linkableDocuments`, `indexLoaded`).
    if (resolution.action === 'wait') return;
    store.set(pendingCollabDocumentAtom, null);
    if (resolution.action === 'failed') {
      errorNotificationService.showError('Could not open shared page', resolution.message, { details: pendingDoc.documentId });
      return;
    }
    if (resolution.action === 'not-found') {
      errorNotificationService.showError(
        'Could not open shared page',
        "This page was not found, or you don't have access to it.",
        { details: pendingDoc.documentId },
      );
      return;
    }
    handleDocumentSelect(resolution.document, pendingDoc.initialContent, pendingDoc.analyticsSource ?? 'deep_link', pendingDoc.openOptions);
  }, [pendingDoc, isActive, handleDocumentSelect, teamScope, workspacePath, teamUnavailable, teamStartError, indexLoaded, indexUnavailable, linkableDocuments]);

  // With nothing open once restore settles, Pages lands on a Home page: the
  // team's with a team (waiting for it to sync), else Personal's. Closing the
  // last tab lands on the team's Home again, so the team area is never blank.
  const teamHomeId = useSectionHomeId(teamScope, teamScope ? getElectronCollabDocsSession(teamScope) : null);
  const personalHomeId = useSectionHomeId(null, getPersonalCollabDocsSession(workspacePath));
  const landedRef = useRef(false);
  useEffect(() => {
    if (!restored || tabs.length > 0 || (landedRef.current && !teamScope)) return;
    if (teamScope ? !teamHomeId : !personalHomeId) return;
    landedRef.current = true;
    const [host, scope, documentId] = teamScope
      ? [getElectronCollabHost(teamScope), teamScope, teamHomeId!]
      : [getPersonalCollabHost(workspacePath), personalScope, personalHomeId!];
    host.openArtifact({ kind: 'document', scope, documentId, teamProjectId: scope.indexConfig.teamProjectId ?? null }, 'sidebar');
  }, [restored, tabs.length, teamScope, teamHomeId, personalHomeId, workspacePath, personalScope]);

  // Match the send path for shared, Personal and Local wiki pages. Navigation
  // tabs have no document context, so they cannot expose another tab's selection.
  const activePageContext = useMemo(
    () => pagesDocumentIdentity(tabs.find((tab) => tab.id === activeTabId)),
    [activeTabId, tabs],
  );

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
      await tabsActions.reopenLastClosedTab();
    },
    getActiveDocumentPath: () => {
      if (!activeTabId) return null;
      const activeTab = tabs.find((tab) => tab.id === activeTabId);
      return activeTab?.filePath ?? null;
    },
    toggleSidebarCollapsed,
    toggleChatCollapsed,
    // Menu/shortcut path for the same action as double-clicking a tab. With no
    // tab open there is nothing to expand into, so only the restore direction
    // stays live.
    toggleEditorMaximized: () => {
      if (isEditorMaximized || tabs.length > 0) toggleEditorMaximized();
    },
    createNewChatSession: async () => {
      if (chatCollapsed) {
        setChatCollapsed(false);
      }
      await chatSidebarRef.current?.createNewSession();
    },
    createNewDocument: () => {
      createPrimaryRef.current?.();
    },
  }), [
    activeTabId,
    tabs,
    tabsActions,
    toggleSidebarCollapsed,
    toggleChatCollapsed,
    toggleEditorMaximized,
    isEditorMaximized,
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
            <PagesSidebarSections
              workspacePath={workspacePath}
              teamScope={teamScope}
              personalScope={personalScope}
              activeTeamDocumentId={activeCollabDocumentId}
              activePersonalDocumentId={activePersonalDocumentId}
              activeRow={activeRow}
              activeTabPath={activeTabPath}
              onOpenSectionView={openSectionView}
              registerTeamCreateMenu={registerTeamCreateMenu}
              registerPersonalCreateMenu={registerPersonalCreateMenu}
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

      {/* Center: Tabs + editor. With a team the team's Home page reopens when
          the last tab closes, so the tab strip is always present; without one
          an empty Personal section shows a hint instead. */}
      <div ref={tabContentAreaRef} className="relative flex-1 flex flex-col overflow-hidden min-h-0">
        {teamScope && teamStartError ? (
          <TeamPagesErrorBanner
            title="Team pages could not be loaded"
            message={teamStartError}
            onRetry={() => { void initSharedDocuments(teamScope); }}
          />
        ) : !teamScope && teamUnavailable?.retryable ? (
          <TeamPagesErrorBanner
            title="Team pages could not be reached"
            message={teamUnavailable.message}
            onRetry={onRetryTeamScope}
          />
        ) : null}
        {hasTabs && <PagesSwipeNavigation targetRef={tabContentAreaRef} onStep={stepPagesHistory} />}
        {!hasTabs && !teamScope && (
          <div
            className="pages-mode-empty flex-1 flex items-center justify-center text-sm text-nim-faint"
            data-testid="pages-mode-empty"
          >
            Open a page, or right-click in the sidebar and choose New page
          </div>
        )}
        {hasTabs && (
          <TrackerTabIssueKeyContext.Provider value={false}>
          <TabManager
            onTabClose={handleTabClose}
            onNewTab={() => (teamScope ? openSectionView('search', 'team') : createPrimaryRef.current?.())}
            isActive={isActive}
            onToggleAIChat={toggleChatCollapsed}
            isAIChatCollapsed={chatCollapsed}
            onTabDoubleClick={toggleEditorMaximized}
            tabBarLeading={<PagesTabHistoryButtons onStep={stepPagesHistory} />}
          >
            <TabContent
              workspaceId={workspacePath}
              collabScope={teamScope ?? undefined}
              onTabClose={handleTabClose}
              onGetContentReady={handleGetContentReady}
              documentSessionActions={documentSessionActions}
              onOpenTracker={handleOpenTrackerPage}
              trackerPageHeader
            />
          </TabManager>
          </TrackerTabIssueKeyContext.Provider>
        )}
      </div>

      {/* Right: AI Chat sidebar (resizable via ChatSidebar built-in handle,
          collapsible). Shown on every tab, including Search and Types. */}
      {hasTabs && (
        <ChatSidebar
          ref={chatSidebarRef}
          workspacePath={workspacePath}
          isActive={isActive}
          isCollapsed={chatCollapsed}
          onToggleCollapse={toggleChatCollapsed}
          documentContext={activePageContext}
          getDocumentContext={getDocumentContext}
          onFileOpen={async (filePath) => onFileOpen(filePath)}
          width={chatWidth}
          onWidthChange={handleChatWidthChange}
        />
      )}
    </div>
  );
});
