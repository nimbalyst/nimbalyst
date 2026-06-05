import React, { useCallback, useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { useSetAtom, useAtomValue, useAtom } from 'jotai';
import type { ConfigTheme } from '@nimbalyst/runtime';
import { useTabsActions, type TabData } from '../../contexts/TabsContext';
import { store, editorDirtyAtom, makeEditorKey } from '@nimbalyst/runtime/store';
import { fileDeletedAtomFamily } from '../../store/atoms/fileWatch';
import { pushNavigationEntryAtom, isRestoringNavigationAtom, historyDialogFileAtom } from '../../store';
import { newBrowserTabRequestAtom, newMockupRequestAtom, toggleAIChatPanelRequestAtom } from '../../store/atoms/appCommands';
import { useTabNavigation } from '../../hooks/useTabNavigation';
import { handleWorkspaceFileSelect as handleWorkspaceFileSelectUtil } from '../../utils/workspaceFileOperations';
import { createInitialFileContent, createMockupContent } from '../../utils/fileUtils';
import { getFileName } from '../../utils/pathUtils';
import { isCollabUri } from '../../utils/collabUri';
import { aiToolService } from '../../services/AIToolService';
import { editorRegistry } from '@nimbalyst/runtime/ai/EditorRegistry';
import { getExtensionLoader } from '@nimbalyst/runtime';
import { customEditorRegistry } from '../CustomEditors';
import { WorkspaceSidebar } from '../WorkspaceSidebar';
import { WorkspaceWelcome } from '../WorkspaceWelcome';
import { TabManager } from '../TabManager/TabManager';
import { TabContent } from '../TabContent/TabContent';
import { ChatSidebar, type ChatSidebarRef } from '../ChatSidebar';
import { NewFileDialog } from '../NewFileDialog';
import type { NewFileType, ExtensionFileType } from '../NewFileMenu';
import { contributionToExtensionFileType } from '../NewFileMenu';
import { WorkspaceHistoryDialog } from '../WorkspaceHistoryDialog';
import { getTextSelection } from '../UnifiedAI/TextSelectionIndicator';
import {
  collabConnectionStatusAtom,
  hasCollabUnsyncedChanges,
} from '../../store/atoms/collabEditor';
import {
  sidebarWidthAtomFamily,
  sidebarCollapsedAtomFamily,
  sidebarPreCollapseWidthAtomFamily,
  aiChatWidthAtomFamily,
  aiChatCollapsedAtomFamily,
} from '../../store/atoms/workspaceLayout';

export interface EditorModeRef {
  closeActiveTab: () => void;
  reopenLastClosedTab: () => Promise<void>;
  handleOpen: () => Promise<void>;
  handleSaveAs: () => Promise<void>;
  selectFile: (filePath: string) => Promise<void>;
  openHistoryDialog: () => void;
  toggleSidebarCollapsed: () => void;
  tabs: {
    addTab: (filePath: string, content?: string) => string | undefined;
    removeTab: (tabId: string) => void;
    switchTab: (tabId: string) => void;
    nextTab: () => void;
    previousTab: () => void;
    findTabByPath: (filePath: string) => any | undefined;
    updateTab: (tabId: string, updates: Record<string, any>) => void;
    tabs: any[];
    activeTabId: string | null;
  };
}

export interface EditorModeProps {
  workspacePath: string;
  workspaceName: string | null;
  theme: ConfigTheme;
  isActive: boolean;
  onModeChange?: (mode: string) => void;
  onGetContentReady?: (getContentFn: (() => string) | null) => void;
  onCloseWorkspace?: () => void;
  onOpenQuickSearch?: () => void;
  onSwitchToAgentMode?: (planDocumentPath?: string, sessionId?: string) => void;
}

const EditorMode = forwardRef<EditorModeRef, EditorModeProps>(function EditorMode({
  workspacePath,
  workspaceName,
  theme,
  isActive,
  onModeChange,
  onGetContentReady,
  onCloseWorkspace,
  onOpenQuickSearch,
  onSwitchToAgentMode
}, ref) {
  // Sidebar state — kept in per-workspace atom families so each open
  // project preserves its own width / collapse state when the project rail
  // hides and re-shows it.
  const [sidebarWidth, setSidebarWidth] = useAtom(sidebarWidthAtomFamily(workspacePath));
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtomFamily(workspacePath));
  const [preCollapseWidth, setPreCollapseWidth] = useAtom(sidebarPreCollapseWidthAtomFamily(workspacePath));
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);

  // Dirty state is tracked via ref to avoid re-render cascade
  // TabEditor calls setDocumentEdited directly for the macOS indicator
  const isDirtyRef = useRef(false);

  const tabsRef = useRef<any>(null);

  // Dialog states
  const [isNewFileDialogOpen, setIsNewFileDialogOpen] = useState(false);
  const [newFileDirectory, setNewFileDirectory] = useState<string | null>(null);
  const [isWorkspaceHistoryDialogOpen, setIsWorkspaceHistoryDialogOpen] = useState(false);
  const [workspaceHistoryPath, setWorkspaceHistoryPath] = useState<string | null>(null);

  // Extension file types state
  const [extensionFileTypes, setExtensionFileTypes] = useState<ExtensionFileType[]>([]);

  // AI Chat panel state — per-workspace so the rail-switch keeps each
  // project's collapse and width preferences.
  const [isAIChatCollapsed, setIsAIChatCollapsed] = useAtom(aiChatCollapsedAtomFamily(workspacePath));
  const [aiChatWidth, setAIChatWidth] = useAtom(aiChatWidthAtomFamily(workspacePath));

  // Track active tab for document context (AI needs to know current file)
  // Uses ref to avoid re-rendering EditorMode on every tab switch
  const activeTabForContextRef = useRef<TabData | null>(null);

  // Refs
  const getContentRef = useRef<(() => string) | null>(null);
  const handleSaveRef = useRef<(() => Promise<void>) | null>(null);
  const getNavigationStateRef = useRef<(() => any) | null>(null);
  const isInitializedRef = useRef<boolean>(false);
  const isResizingRef = useRef<boolean>(false);
  const chatSidebarRef = useRef<ChatSidebarRef>(null);
  const saveTabByIdRef = useRef<((tabId: string) => Promise<void>) | null>(null);

  // Get tab actions from context (doesn't subscribe to state - no re-renders)
  const tabsActions = useTabsActions();

  // Refs for imperative DOM updates - NO re-renders for tab visibility
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const welcomeContainerRef = useRef<HTMLDivElement>(null);

  // Subscribe to changes and update visibility imperatively - NO state, NO re-renders
  useEffect(() => {
    const updateVisibility = () => {
      const snapshot = tabsActions.getSnapshot();
      const hasActiveTab = snapshot.activeTabId !== null;
      if (tabsContainerRef.current) {
        tabsContainerRef.current.style.display = hasActiveTab ? 'flex' : 'none';
      }
      if (welcomeContainerRef.current) {
        welcomeContainerRef.current.style.display = hasActiveTab ? 'none' : 'flex';
      }
    };

    // Initial update
    updateVisibility();

    // Subscribe to future changes
    const unsubscribe = tabsActions.subscribe(updateVisibility);
    return unsubscribe;
  }, [tabsActions]);

  // Keep tabsRef updated with actions
  useEffect(() => {
    tabsRef.current = tabsActions;
  }, [tabsActions]);

  // Update window title and sync current file with backend when active tab changes
  // This is done imperatively to avoid re-renders in parent components
  useEffect(() => {
    const updateCurrentFileForPlugins = () => {
      const snapshot = tabsActions.getSnapshot();
      const activeTab = snapshot.activeTabId ? snapshot.tabs.get(snapshot.activeTabId) : null;

      // Expose to window for plugins
      if (typeof window !== 'undefined') {
        (window as any).currentFilePath = activeTab?.filePath || null;
        (window as any).__currentDocumentPath = activeTab?.filePath || null;
      }
    };

    // Initial update
    updateCurrentFileForPlugins();

    // Subscribe to future changes
    const unsubscribe = tabsActions.subscribe(updateCurrentFileForPlugins);
    return unsubscribe;
  }, [tabsActions]);

  // Keep activeTabForContextRef in sync with active tab (no re-render)
  useEffect(() => {
    const updateActiveTabForContext = () => {
      const snapshot = tabsActions.getSnapshot();
      const activeTab = snapshot.activeTabId ? snapshot.tabs.get(snapshot.activeTabId) : null;
      activeTabForContextRef.current = activeTab || null;
    };

    // Initial update
    updateActiveTabForContext();

    // Subscribe to future changes
    const unsubscribe = tabsActions.subscribe(updateActiveTabForContext);
    return unsubscribe;
  }, [tabsActions]);

  // Subscribe to file-deleted atoms for every currently-open tab path so the
  // EditorMode tab is closed on delete. Routes through the central atom
  // (updated by store/listeners/fileChangeListeners.ts) to keep all tab
  // systems in sync. Without this, autosave can resurrect deleted files.
  useEffect(() => {
    const subscriptions = new Map<string, () => void>();

    const refreshSubscriptions = () => {
      const snapshot = tabsActions.getSnapshot();
      const currentPaths = new Set<string>();
      for (const tab of snapshot.tabs.values()) {
        if (tab.filePath) currentPaths.add(tab.filePath);
      }

      // Drop subscriptions for tabs that closed
      for (const [path, unsub] of subscriptions) {
        if (!currentPaths.has(path)) {
          unsub();
          subscriptions.delete(path);
        }
      }

      // Add subscriptions for newly-opened tabs
      for (const path of currentPaths) {
        if (subscriptions.has(path)) continue;
        const deletedAtom = fileDeletedAtomFamily(path);
        const initial = store.get(deletedAtom);
        const unsub = store.sub(deletedAtom, () => {
          if (store.get(deletedAtom) === initial) return;
          const tab = tabsActions.findTabByPath(path);
          if (tab) {
            tabsActions.removeTab(tab.id);
          }
        });
        subscriptions.set(path, unsub);
      }
    };

    // Initial set up
    refreshSubscriptions();

    // Re-evaluate whenever tabs change
    const unsubscribeChanges = tabsActions.subscribe(refreshSubscriptions);

    return () => {
      unsubscribeChanges();
      for (const unsub of subscriptions.values()) {
        unsub();
      }
      subscriptions.clear();
    };
  }, [tabsActions]);

  // Push navigation entry when active tab changes (unified cross-mode navigation)
  const pushNavigationEntry = useSetAtom(pushNavigationEntryAtom);
  const isRestoringNavigation = useAtomValue(isRestoringNavigationAtom);
  const lastNavigationTabIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Only track navigation when this mode is active
    if (!isActive) return;

    const pushNavForActiveTab = () => {
      // Don't push while restoring (going back/forward)
      if (isRestoringNavigation) return;

      const snapshot = tabsActions.getSnapshot();
      const activeTabId = snapshot.activeTabId;
      const activeTab = activeTabId ? snapshot.tabs.get(activeTabId) : null;

      // Only push if the tab actually changed
      if (activeTabId && activeTabId !== lastNavigationTabIdRef.current && activeTab) {
        lastNavigationTabIdRef.current = activeTabId;
        pushNavigationEntry({
          mode: 'files',
          files: {
            tabId: activeTabId,
            filePath: activeTab.filePath,
          },
        });
      }
    };

    // Initial push for current tab
    pushNavForActiveTab();

    // Subscribe to future changes
    const unsubscribe = tabsActions.subscribe(pushNavForActiveTab);
    return unsubscribe;
  }, [tabsActions, isActive, pushNavigationEntry, isRestoringNavigation]);

  // Handle tab close with save for dirty tabs
  // CRITICAL: Use tabsRef.current to avoid stale closure bug
  const handleTabClose = useCallback(async (tabId: string) => {
    console.log('[EditorMode.handleTabClose] Closing tab:', tabId);
    const currentTabs = tabsRef.current;
    if (!currentTabs) {
      console.error('[EditorMode.handleTabClose] tabsRef.current is null!');
      return;
    }
    const tab = currentTabs.getTabState(tabId);
    if (!tab) {
      console.error('[EditorMode.handleTabClose] Tab not found:', tabId);
      return;
    }
    // Check dirty state from Jotai atom (the source of truth)
    const editorKey = makeEditorKey(tab.filePath);
    const isDirty = store.get(editorDirtyAtom(editorKey));
    const collabStatus = isCollabUri(tab.filePath)
      ? store.get(collabConnectionStatusAtom(tab.filePath))
      : 'disconnected';

    if (isCollabUri(tab.filePath) && hasCollabUnsyncedChanges(collabStatus)) {
      const confirmed = window.confirm(
        collabStatus === 'replaying'
          ? 'This collaborative document is still replaying local changes to the server. Close it anyway?'
          : 'This collaborative document still has local changes that have not been confirmed by the server. Close it anyway?'
      );
      if (!confirmed) {
        return;
      }
    }
    // Save dirty tabs before closing to prevent data loss
    if (isDirty && saveTabByIdRef.current) {
      await saveTabByIdRef.current(tabId);
    }
    currentTabs.removeTab(tabId);
  }, []); // No dependencies - uses refs for all mutable state


  // Get current file info imperatively from tabsActions
  // Note: This doesn't subscribe to changes - TabContent will subscribe and pass data down
  const getCurrentFileInfo = useCallback(() => {
    const store = tabsActions.getSnapshot();
    if (!store.activeTabId) return { filePath: null, fileName: null };
    const activeTab = store.tabs.get(store.activeTabId);
    return {
      filePath: activeTab?.filePath || null,
      fileName: activeTab?.fileName || null
    };
  }, [tabsActions]);

  // For effects that need current file path, we read it imperatively
  const currentFileInfo = getCurrentFileInfo();
  const currentFilePath = currentFileInfo.filePath;
  const currentFileName = currentFileInfo.fileName;

  // Expose current document path and workspace path to window for image paste/rendering
  // __workspacePath is used by MockupPlatformServiceImpl and DataModelPlatformServiceImpl
  useEffect(() => {
    (window as any).__currentDocumentPath = currentFilePath;
    (window as any).workspacePath = workspacePath;
    (window as any).__workspacePath = workspacePath;
  }, [currentFilePath, workspacePath]);

  // Dev helper: open a collaborative document from the console
  // Usage: window.__openCollabDoc('my-doc-id', 'My Document Title', '<initialContent>?', 'documentType?')
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as any).__openCollabDoc = async (
      documentId: string,
      title?: string,
      initialContent?: string,
      documentType?: string,
    ) => {
      if (!workspacePath) {
        console.error('[openCollabDoc] No workspace path');
        return;
      }
      const { openCollabDocumentViaIPC } = await import('../../utils/collabDocumentOpener');
      const tabId = await openCollabDocumentViaIPC({
        workspacePath,
        documentId,
        title,
        initialContent,
        documentType,
        addTab: tabsActions.addTab,
      });
      console.log('[openCollabDoc] Opened tab:', tabId);
      return tabId;
    };

    // Playwright-only helper: open a collab doc without going through Stytch
    // auth. Resolves the config via `document-sync:open-test` (gated by
    // PLAYWRIGHT=1 in the main process) and re-uses the same `openCollabDocument`
    // + `createProxiedWebSocket` plumbing the real share path uses. The test
    // injects `test_user_id` / `test_org_id` by wrapping the URL passed
    // through `createProxiedWebSocket` via `urlOverride` below.
    (window as any).__openCollabDocTest = async (params: {
      documentId: string;
      title?: string;
      initialContent?: string;
      documentType?: string;
      serverUrl: string;
      orgId: string;
      userId: string;
      encryptionKeyBase64: string;
      /** Optional query-string suffix appended to the WS URL (no leading ?). */
      urlExtraQuery?: string;
    }) => {
      if (!workspacePath) {
        throw new Error('[openCollabDocTest] No workspace path');
      }
      const testResult = await (window as any).electronAPI.invoke(
        'document-sync:open-test',
        {
          serverUrl: params.serverUrl,
          orgId: params.orgId,
          userId: params.userId,
          documentId: params.documentId,
          title: params.title ?? params.documentId,
          encryptionKeyBase64: params.encryptionKeyBase64,
        },
      );
      if (!testResult?.success || !testResult.config) {
        throw new Error(
          `[openCollabDocTest] document-sync:open-test failed: ${testResult?.error ?? 'unknown'}`,
        );
      }
      const cfg = testResult.config;
      // Reconstruct CryptoKey from base64.
      const binary = atob(cfg.orgKeyBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const documentKey = await crypto.subtle.importKey(
        'raw',
        bytes,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );

      const { openCollabDocument, createProxiedWebSocket } = await import(
        '../../utils/collabDocumentOpener'
      );
      const hasWsProxy = !!(window as any).electronAPI?.documentSync?.wsConnect;
      const createWebSocket = hasWsProxy
        ? (url: string) => {
            const target = params.urlExtraQuery
              ? `${url}${url.includes('?') ? '&' : '?'}${params.urlExtraQuery}`
              : url;
            return createProxiedWebSocket(target);
          }
        : undefined;

      const tabId = openCollabDocument({
        workspacePath,
        orgId: cfg.orgId,
        documentId: cfg.documentId,
        title: cfg.title,
        documentType: params.documentType,
        documentKey,
        serverUrl: cfg.serverUrl,
        userId: cfg.userId,
        userName: cfg.userName ?? 'Test User',
        userEmail: cfg.userEmail ?? 'test@test.com',
        initialContent: params.initialContent,
        urlExtraQuery: params.urlExtraQuery,
        createWebSocket,
        getJwt: async () => 'test-jwt',
        addTab: tabsActions.addTab,
      });
      console.log('[openCollabDocTest] Opened tab:', tabId);
      return tabId;
    };

    return () => {
      delete (window as any).__openCollabDoc;
      delete (window as any).__openCollabDocTest;
    };
  }, [workspacePath, tabsActions]);

  // Update MCP document state for custom editors (non-markdown files)
  // Markdown files update MCP state via useIPCHandlers when content changes,
  // but custom editors need to update when they become active
  useEffect(() => {
    if (!currentFilePath || !workspacePath) return;

    const lastDot = currentFilePath.lastIndexOf('.');
    if (lastDot <= 0) return;

    const ext = currentFilePath.substring(lastDot).toLowerCase();

    // Skip markdown files - they update MCP state via useIPCHandlers
    if (ext === '.md' || ext === '.markdown') return;

    // Longest-suffix match handles single and arbitrary-depth compound
    // extensions (.mockup.html, .reddit.watch.json, etc.)
    if (!customEditorRegistry.findRegistrationForFile(currentFilePath)) return;

    // Update MCP document state for custom editor
    if (window.electronAPI?.updateMcpDocumentState) {
      const docState = {
        content: '', // Custom editors don't use content-based MCP state
        filePath: currentFilePath,
        fileType: ext.substring(1), // Remove the dot
        workspacePath,
        cursorPosition: undefined,
        selection: undefined
      };
      window.electronAPI.updateMcpDocumentState(docState);
    }
  }, [currentFilePath, workspacePath]);

  // Build document context for AI features
  // Reads file content from disk on-demand for consistent behavior across all editor types
  // AIChat will call this when it needs it (e.g., when sending a message)
  const getDocumentContext = useCallback(async () => {
    const activeTab = activeTabForContextRef.current;
    if (!activeTab) {
      // No active tab - don't include text selection as it would be stale from a previous tab
      return {
        filePath: '',
        fileType: 'unknown',
        content: '',
        cursorPosition: undefined,
        selection: undefined,
        textSelection: undefined,
        textSelectionTimestamp: undefined
      };
    }

    const filePath = activeTab.filePath || '';
    const lowerPath = filePath.toLowerCase();
    let fileType = 'unknown';

    if (lowerPath.endsWith('.mockup.html')) {
      fileType = 'mockup';
    } else {
      const lastDot = lowerPath.lastIndexOf('.');
      if (lastDot !== -1) {
        const ext = lowerPath.substring(lastDot);
        switch (ext) {
          case '.md':
          case '.markdown':
            fileType = 'markdown';
            break;
          case '.json':
            fileType = 'json';
            break;
          case '.yaml':
          case '.yml':
            fileType = 'yaml';
            break;
          case '.js':
          case '.jsx':
          case '.ts':
          case '.tsx':
            fileType = 'javascript';
            break;
          case '.html':
            fileType = 'html';
            break;
          case '.css':
          case '.scss':
            fileType = 'css';
            break;
          case '.py':
            fileType = 'python';
            break;
          default:
            fileType = 'code';
        }
      }
    }

    // Read content from disk - the source of truth for all editor types
    let content = '';
    if (filePath && window.electronAPI) {
      try {
        const result = await window.electronAPI.readFileContent(filePath);
        if (result?.success && result.content) {
          content = result.content;
        }
      } catch (err) {
        console.error('[EditorMode] Failed to read file content for AI context:', err);
      }
    }

    const textSelectionData = getTextSelection();
    // Only include text selection if it belongs to the current file
    const textSelection = textSelectionData && textSelectionData.filePath === filePath
      ? textSelectionData
      : undefined;
    return {
      filePath,
      fileType,
      content,
      cursorPosition: undefined,
      selection: undefined,
      mockupSelection: fileType === 'mockup' ? (window as any).__mockupSelectedElement : undefined,
      mockupDrawing: fileType === 'mockup' ? (window as any).__mockupDrawing : undefined,
      mockupAnnotationTimestamp: fileType === 'mockup' ? (window as any).__mockupAnnotationTimestamp : undefined,
      textSelection,
      textSelectionTimestamp: textSelection?.timestamp
    };
  }, []);

  // Initialize tab navigation
  // NOTE: useTabNavigation will be updated to use context internally
  const navigation = useTabNavigation({
    enabled: true,
    tabs: [], // TabManager now handles this
    activeTabId: null,
    switchTab: tabsActions.switchTab
  });

  // Handle opening a file via system dialog
  const handleOpen = useCallback(async () => {
    if (!window.electronAPI) return;

    try {
      const result = await window.electronAPI.openFile();
      if (result) {
        // Close any existing tabs first (single-file mode = one tab only)
        tabsActions.closeAllTabs();

        // Create a tab for the new file
        tabsActions.addTab(result.filePath, result.content);

        // Create automatic snapshot when opening file
        if (window.electronAPI.history) {
          try {
            // Check if we have previous snapshots
            const snapshots = await window.electronAPI.history.listSnapshots(result.filePath);
            if (snapshots.length === 0) {
              // First time opening this file, create initial snapshot
              await window.electronAPI.history.createSnapshot(
                result.filePath,
                result.content,
                'auto',
                'Initial file open'
              );
            } else {
              // Check if content changed since last snapshot
              const latestSnapshot = snapshots[0];
              const lastContent = await window.electronAPI.history.loadSnapshot(
                result.filePath,
                latestSnapshot.timestamp
              );
              if (lastContent !== result.content) {
                // Content actually changed, create snapshot
                await window.electronAPI.history.createSnapshot(
                  result.filePath,
                  result.content,
                  'auto',
                  'File changed externally'
                );
              }
            }
          } catch (error) {
            console.error('Failed to create automatic snapshot:', error);
          }
        }
      }
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  }, []);

  // Handle save as
  const handleSaveAs = useCallback(async () => {
    if (!window.electronAPI || !getContentRef.current) return;

    const content = getContentRef.current();

    try {
      const result = await window.electronAPI.saveFileAs(content);
      if (result) {
        isDirtyRef.current = false;

        // Update tab state - this will automatically update currentFilePath
        const store = tabsActions.getSnapshot();
        if (store.activeTabId) {
          tabsActions.updateTab(store.activeTabId, {
            filePath: result.filePath,
            fileName: getFileName(result.filePath),
            isDirty: false,
            lastSaved: new Date()
          });
        }
      }
    } catch (error) {
      console.error('Failed to save file as:', error);
    }
  }, [tabsActions]);

  // Handle workspace file selection
  // CRITICAL: Use tabsRef.current to avoid stale closure bug
  // The tabs object changes on every render, so capturing it in a useCallback
  // leads to stale data when the callback is invoked from refs or async contexts
  const handleWorkspaceFileSelect = useCallback(async (filePath: string) => {
    const currentTabs = tabsRef.current;
    if (!currentTabs) {
      console.error('[EditorMode.handleWorkspaceFileSelect] tabsRef.current is null!');
      return;
    }
    // Use currentFilePath from tabs to also avoid stale closure
    const activeFilePath = currentTabs.activeTab?.filePath || null;
    await handleWorkspaceFileSelectUtil({
      filePath,
      currentFilePath: activeFilePath,
      tabs: currentTabs,
      isInitializedRef
    });
  }, []); // No dependencies - uses refs for all mutable state

  // Handle opening session - switches to Agent Mode since ChatSidebar manages its own single session
  const handleOpenSessionInChat = useCallback(async (sessionId: string) => {
    console.log('[EditorMode] handleOpenSessionInChat called with sessionId:', sessionId);
    // Load the session in the chat sidebar and expand it
    if (chatSidebarRef.current) {
      chatSidebarRef.current.loadSession(sessionId);
      // Expand the chat panel if it's collapsed
      if (isAIChatCollapsed) {
        setIsAIChatCollapsed(false);
      }
    }
  }, [isAIChatCollapsed]);

  // Toggle sidebar collapsed state
  const toggleSidebarCollapsed = useCallback(() => {
    if (sidebarCollapsed) {
      // Expanding - restore previous width
      setSidebarWidth(preCollapseWidth);
      setSidebarCollapsed(false);
    } else {
      // Collapsing - save current width
      setPreCollapseWidth(sidebarWidth);
      setSidebarCollapsed(true);
    }
  }, [sidebarCollapsed, sidebarWidth, preCollapseWidth]);

  // Expose methods to parent via ref
  // CRITICAL: Use tabsRef.current inside closures to avoid stale closure bugs
  // The useImperativeHandle re-runs when tabs changes, but the methods it creates
  // can still be called with stale data if tabs changes between creation and invocation
  useImperativeHandle(ref, () => ({
    closeActiveTab: () => {
      const currentTabs = tabsRef.current;
      const snapshot = currentTabs?.getSnapshot();
      const tabIdToClose = snapshot?.activeTabId;
      console.log('[EditorMode.closeActiveTab] tabIdToClose:', tabIdToClose);
      if (!tabIdToClose) {
        console.log('[EditorMode.closeActiveTab] No activeTabId to close');
        return;
      }
      // Pass the captured tab ID to handleTabClose - this is idempotent
      // because handleTabClose will no-op if the tab doesn't exist
      handleTabClose(tabIdToClose);
    },
    reopenLastClosedTab: async () => {
      const currentTabs = tabsRef.current;
      if (currentTabs) {
        await currentTabs.reopenLastClosedTab(handleWorkspaceFileSelect);
      }
    },
    handleOpen,
    handleSaveAs,
    selectFile: handleWorkspaceFileSelect,
    openHistoryDialog: () => {
      if (currentFilePath) {
        store.set(historyDialogFileAtom, currentFilePath);
      }
    },
    toggleSidebarCollapsed,
    tabs: {
      addTab: (filePath: string, content?: string) => {
        const currentTabs = tabsRef.current;
        return currentTabs?.addTab(filePath, content) ?? undefined;
      },
      removeTab: handleTabClose,
      switchTab: (tabId: string) => {
        const currentTabs = tabsRef.current;
        currentTabs?.switchTab(tabId);
      },
      findTabByPath: (filePath: string) => {
        const currentTabs = tabsRef.current;
        return currentTabs?.findTabByPath(filePath);
      },
      updateTab: (tabId: string, updates: Partial<TabData>) => {
        const currentTabs = tabsRef.current;
        currentTabs?.updateTab(tabId, updates);
      },
      nextTab: () => {
        const currentTabs = tabsRef.current;
        const snapshot = currentTabs?.getSnapshot();
        if (currentTabs && snapshot && snapshot.tabOrder.length > 1) {
          const currentIndex = snapshot.tabOrder.indexOf(snapshot.activeTabId!);
          // Don't wrap - if we're at the end, stay there
          if (currentIndex >= 0 && currentIndex < snapshot.tabOrder.length - 1) {
            const nextTabId = snapshot.tabOrder[currentIndex + 1];
            if (nextTabId) {
              currentTabs.switchTab(nextTabId);
            }
          }
        }
      },
      previousTab: () => {
        const currentTabs = tabsRef.current;
        const snapshot = currentTabs?.getSnapshot();
        if (currentTabs && snapshot && snapshot.tabOrder.length > 1) {
          const currentIndex = snapshot.tabOrder.indexOf(snapshot.activeTabId!);
          // Don't wrap - if we're at the beginning, stay there
          if (currentIndex > 0) {
            const prevTabId = snapshot.tabOrder[currentIndex - 1];
            if (prevTabId) {
              currentTabs.switchTab(prevTabId);
            }
          }
        }
      },
      // These getters read from the snapshot for current state
      get tabs() {
        const snapshot = tabsRef.current?.getSnapshot();
        if (!snapshot) return [];
        return snapshot.tabOrder.map((id: string) => snapshot.tabs.get(id)!).filter(Boolean);
      },
      get activeTabId() { return tabsRef.current?.getSnapshot()?.activeTabId ?? null; },
    }
  }), [handleOpen, handleSaveAs, handleWorkspaceFileSelect, handleTabClose, toggleSidebarCollapsed]);

  // Handle sidebar resize
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;

      const newWidth = Math.min(Math.max(200, e.clientX), 500);
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (!isResizingRef.current) return;

      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Save the width
      if (window.electronAPI && workspacePath) {
        window.electronAPI.setSidebarWidth(workspacePath, sidebarWidth);
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [sidebarWidth, workspacePath]);

  // Load sidebar width from storage
  useEffect(() => {
    if (!workspacePath || !window.electronAPI?.getSidebarWidth) return;

    const loadSidebarWidth = async () => {
      try {
        const savedWidth = await window.electronAPI.getSidebarWidth(workspacePath);
        if (savedWidth && typeof savedWidth === 'number') {
          // Clamp to the current drag-resize range so a width persisted
          // under an older, smaller floor doesn't load too narrow.
          setSidebarWidth(Math.min(Math.max(200, savedWidth), 500));
        }
      } catch (error) {
        console.error('Error loading sidebar width:', error);
      }
    };

    loadSidebarWidth();
  }, [workspacePath]);

  // Load extension file type contributions
  useEffect(() => {
    const loader = getExtensionLoader();

    const updateExtensionFileTypes = () => {
      const contributions = loader.getNewFileMenuContributions();
      const fileTypes = contributions.map(c => contributionToExtensionFileType(c.contribution));
      setExtensionFileTypes(fileTypes);
    };

    // Initial load
    updateExtensionFileTypes();

    // Subscribe to changes
    const unsubscribe = loader.subscribe(updateExtensionFileTypes);
    return unsubscribe;
  }, []);

  // Listen for file-new-in-workspace IPC event from menu (Cmd+N in files mode)
  useEffect(() => {
    if (!window.electronAPI?.onFileNewInWorkspace) return undefined;

    const cleanup = window.electronAPI.onFileNewInWorkspace(() => {
      // Set the target directory to the selected folder if one is selected
      if (selectedFolderPath) {
        setNewFileDirectory(selectedFolderPath);
      }
      setIsNewFileDialogOpen(true);
    });

    return cleanup;
  }, [selectedFolderPath]);

  // NOTE: view-history IPC event (Cmd+Y) is handled in App.tsx which gates it by active mode
  // and calls editorModeRef.openHistoryDialog()

  // Listen for view-workspace-history IPC event from menu (Cmd+Shift+H)
  useEffect(() => {
    if (!window.electronAPI?.onViewWorkspaceHistory) return undefined;

    const cleanup = window.electronAPI.onViewWorkspaceHistory(() => {
      // Open workspace history dialog for the entire workspace
      setWorkspaceHistoryPath(workspacePath);
      setIsWorkspaceHistoryDialogOpen(true);
    });

    return cleanup;
  }, [workspacePath]);

  // React to the "new mockup" command from the menu. The IPC subscription
  // lives in store/listeners/appCommandListeners.ts; here we watch the counter.
  const newMockupVersion = useAtomValue(newMockupRequestAtom);
  const newMockupInitialVersionRef = useRef(newMockupVersion);
  useEffect(() => {
    if (newMockupVersion === newMockupInitialVersionRef.current) return;
    const handleNewMockup = async () => {
      if (!workspacePath || !window.electronAPI) return;

      try {
        // Create a default mockup file name
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const fileName = `mockup-${timestamp}.mockup.html`;
        const directory = selectedFolderPath || workspacePath;
        const filePath = `${directory}/${fileName}`;

        // Create basic mockup HTML content
        const content = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mockup</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        h1 {
            color: #333;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>New Mockup</h1>
        <p>Edit this mockup using the AI chat or edit the HTML directly.</p>
    </div>
</body>
</html>`;

        await window.electronAPI.createFile(filePath, content);

        // Open the new mockup file
        await handleWorkspaceFileSelect(filePath);
      } catch (error) {
        console.error('Error creating new mockup:', error);
      }
    };

    void handleNewMockup();
  }, [newMockupVersion, workspacePath, selectedFolderPath, handleWorkspaceFileSelect]);

  // React to the "New Browser Tab" command (Cmd+Shift+B) from the menu. The IPC
  // subscription lives in store/listeners/appCommandListeners.ts; here we watch
  // the counter and open a fileless browser virtual tab, mirroring the
  // "New Browser Tab" entry in the sidebar's New File menu.
  const newBrowserTabVersion = useAtomValue(newBrowserTabRequestAtom);
  const newBrowserTabInitialVersionRef = useRef(newBrowserTabVersion);
  useEffect(() => {
    if (newBrowserTabVersion === newBrowserTabInitialVersionRef.current) return;

    // The browser extension contributes a New File menu entry that opens a
    // virtual:// tab. Reuse its virtualScheme so the command degrades to a
    // no-op when the browser extension is disabled.
    const browserTabType = extensionFileTypes.find(
      (e) =>
        e.action === 'openVirtualTab' &&
        e.virtualScheme?.startsWith('virtual://com.nimbalyst.browser/'),
    );
    if (!browserTabType?.virtualScheme) return;

    const id = `tab-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    const title = encodeURIComponent(browserTabType.displayName);
    void handleWorkspaceFileSelect(`${browserTabType.virtualScheme}${id}?title=${title}`);
  }, [newBrowserTabVersion, extensionFileTypes, handleWorkspaceFileSelect]);

  // React to "toggle AI chat panel" (Cmd+Shift+A) from the menu. The IPC
  // subscription lives in store/listeners/appCommandListeners.ts.
  // Use a ref to debounce rapid calls (can happen with menu accelerators).
  const toggleAIChatPanelVersion = useAtomValue(toggleAIChatPanelRequestAtom);
  const toggleAIChatInitialVersionRef = useRef(toggleAIChatPanelVersion);
  const toggleAIChatInProgressRef = useRef(false);
  useEffect(() => {
    if (toggleAIChatPanelVersion === toggleAIChatInitialVersionRef.current) return;
    if (toggleAIChatInProgressRef.current) {
      console.log('[EditorMode] handleToggleAIChatPanel: ignoring duplicate call');
      return;
    }
    toggleAIChatInProgressRef.current = true;
    setTimeout(() => { toggleAIChatInProgressRef.current = false; }, 100);

    console.log('[EditorMode] handleToggleAIChatPanel IPC received');
    setIsAIChatCollapsed(prev => !prev);
  }, [toggleAIChatPanelVersion]);

  // Handle new file creation with file type support
  const handleNewFile = useCallback(async (fileName: string, fileType: NewFileType) => {
    if (!workspacePath || !window.electronAPI) return;

    try {
      const directory = newFileDirectory || workspacePath;

      // Determine full filename and content based on type
      let fullFileName: string;
      let content: string;

      if (fileType === 'markdown') {
        // Add .md extension if not present
        fullFileName = fileName.endsWith('.md') || fileName.endsWith('.markdown') ? fileName : `${fileName}.md`;
        content = createInitialFileContent(fullFileName);
      } else if (fileType === 'mockup') {
        // Add .mockup.html extension if not present
        fullFileName = fileName.endsWith('.mockup.html') ? fileName : `${fileName}.mockup.html`;
        content = createMockupContent();
      } else if (fileType?.startsWith('ext:')) {
        // Extension-provided file type
        const extName = fileType.slice(4); // Remove 'ext:' prefix
        const extType = extensionFileTypes.find(e => e.extension === extName);
        if (extType) {
          fullFileName = fileName.endsWith(extName) ? fileName : `${fileName}${extName}`;
          content = extType.defaultContent ?? '';
        } else {
          // Fallback
          fullFileName = fileName;
          content = '';
        }
      } else {
        // Any type - keep filename as-is
        fullFileName = fileName;
        content = createInitialFileContent(fullFileName);
      }

      const filePath = `${directory}/${fullFileName}`;
      await window.electronAPI.createFile(filePath, content);

      // Open the new file
      await handleWorkspaceFileSelect(filePath);

      setIsNewFileDialogOpen(false);
      setNewFileDirectory(null);
    } catch (error) {
      console.error('Error creating new file:', error);
    }
  }, [workspacePath, newFileDirectory, handleWorkspaceFileSelect, extensionFileTypes]);

  return (
    <>
      {/* Main content area */}
      <div className="editor-mode__content" style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden', minWidth: 0 }}>
        {/* Left sidebar - file tree (hidden when collapsed) */}
        {!sidebarCollapsed && (
          <>
            <div style={{ width: sidebarWidth, position: 'relative' }}>
              <WorkspaceSidebar
                workspaceName={workspaceName || ''}
                workspacePath={workspacePath}
                currentFilePath={currentFilePath}
                currentView="files"
                onFileSelect={handleWorkspaceFileSelect}
                onCloseWorkspace={onCloseWorkspace || (() => {})}
                onOpenQuickSearch={onOpenQuickSearch}
                onViewWorkspaceHistory={(folderPath) => {
                  setWorkspaceHistoryPath(folderPath);
                  setIsWorkspaceHistoryDialogOpen(true);
                }}
                onSelectedFolderChange={setSelectedFolderPath}
                currentAISessionId={null}
              />
            </div>

            {/* Resize handle */}
            <div
              onMouseDown={handleMouseDown}
              className="w-1 cursor-col-resize shrink-0 relative z-10 bg-nim-secondary"
            >
              <div
                className="w-0.5 h-full mx-auto bg-nim-border transition-colors duration-200 hover:bg-nim-accent"
              />
            </div>
          </>
        )}

        {/* Center - editor tabs and content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {/* Always render both - visibility controlled imperatively via refs */}
          <div
            ref={tabsContainerRef}
            className="file-tabs-container"
            style={{ flex: 1, display: 'none', flexDirection: 'column', overflow: 'hidden' }}
          >
            <TabManager
              onTabClose={handleTabClose}
              onNewTab={() => setIsNewFileDialogOpen(true)}
              hideTabBar={false}
              isActive={isActive}
              onToggleAIChat={() => setIsAIChatCollapsed(prev => !prev)}
              isAIChatCollapsed={isAIChatCollapsed}
            >
              <TabContent
                onManualSaveReady={(saveFn) => {
                  handleSaveRef.current = saveFn;
                }}
                onSaveTabByIdReady={(saveFn) => {
                  saveTabByIdRef.current = saveFn;
                }}
                onSaveComplete={(filePath) => {
                  isDirtyRef.current = false;

                  const store = tabsActions.getSnapshot();
                  if (store.activeTabId) {
                    tabsActions.updateTab(store.activeTabId, {
                      isDirty: false,
                      lastSaved: new Date()
                    });
                  }
                }}
                onGetContentReady={(tabId, getContentFn) => {
                  // Always update - each getContentFn closure is bound to its tab's content.
                  // The conditional check was causing a race condition where content from a
                  // previous tab would be used because tabsActions.getSnapshot().activeTabId
                  // hadn't yet updated when the new tab's editor fired onGetContentReady.
                  getContentRef.current = getContentFn;
                  aiToolService.setGetContentFunction(getContentFn);
                  if (onGetContentReady) {
                    onGetContentReady(getContentFn);
                  }
                }}
                onRenameDocument={() => {
                  console.log('Rename document requested');
                }}
                onSwitchToAgentMode={onSwitchToAgentMode}
                onOpenSessionInChat={handleOpenSessionInChat}
                onTabClose={handleTabClose}
                workspaceId={workspacePath}
              />
            </TabManager>
          </div>
          <div
            ref={welcomeContainerRef}
            style={{ display: 'flex', flex: 1 }}
          >
            <WorkspaceWelcome workspaceName={workspaceName || 'Open a file to get started'} />
          </div>
        </div>

        {/* Right sidebar - AI Chat */}
        {workspacePath && (
          <ChatSidebar
            ref={chatSidebarRef}
            workspacePath={workspacePath}
            isActive={isActive}
            isCollapsed={isAIChatCollapsed}
            onToggleCollapse={() => setIsAIChatCollapsed(prev => !prev)}
            width={aiChatWidth}
            onWidthChange={setAIChatWidth}
            getDocumentContext={getDocumentContext}
            onFileOpen={handleWorkspaceFileSelect}
            onSwitchToAgentMode={onSwitchToAgentMode ? (sid?: string) => onSwitchToAgentMode(undefined, sid) : undefined}
          />
        )}
      </div>

      {/* Dialogs */}
      {isNewFileDialogOpen && (
        <NewFileDialog
          isOpen={isNewFileDialogOpen}
          onClose={() => {
            setIsNewFileDialogOpen(false);
            setNewFileDirectory(null);
          }}
          currentDirectory={newFileDirectory || workspacePath}
          workspacePath={workspacePath}
          onCreateFile={handleNewFile}
          extensionFileTypes={extensionFileTypes}
          onDirectoryChange={setNewFileDirectory}
        />
      )}

      {isWorkspaceHistoryDialogOpen && workspaceHistoryPath && (
        <WorkspaceHistoryDialog
          isOpen={isWorkspaceHistoryDialogOpen}
          onClose={() => {
            setIsWorkspaceHistoryDialogOpen(false);
            setWorkspaceHistoryPath(null);
          }}
          workspacePath={workspaceHistoryPath}
          theme={theme === 'auto' ? 'dark' : theme}
        />
      )}
    </>
  );
});

export default EditorMode;
