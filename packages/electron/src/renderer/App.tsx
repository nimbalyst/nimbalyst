// Side-effect: patch window.addEventListener to guard text inputs from extension key handlers.
// MUST be the very first import so it patches before any listeners are registered.
import './hooks/useExtensionInputGuard';

// Side-effect: ensure atomFamily registry is initialized and window.__atomFamilyStats is set
import './store/debug/atomFamilyRegistry';

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { logger } from './utils/logger';
import type { LexicalCommand } from '@nimbalyst/runtime';
// aiChatBridge has been replaced by editorRegistry
// Import editor styles (CSS side-effect)
import '../../../runtime/src/editor/index.css';
// Import refactored hooks and utilities
import { useIPCHandlers } from './hooks/useIPCHandlers';
import { useWindowLifecycle } from './hooks/useWindowLifecycle';
import { useTheme } from './hooks/useTheme';
import { useConfirmDialog } from './hooks/useConfirmDialog';
import { useDialogRequestTrigger } from './hooks/useDialogRequestTrigger';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useExtensionKeybindings } from './extensions/commands/useExtensionKeybindings';
import { useOnboarding } from './hooks/useOnboarding';
// NOTE: useDocumentContext removed - we build documentContext manually now
import { handleWorkspaceFileSelect as handleWorkspaceFileSelectUtil } from './utils/workspaceFileOperations';
import { createInitialFileContent } from './utils/fileUtils';
import { aiToolService } from './services/AIToolService';
import { editorRegistry } from '@nimbalyst/runtime/ai/EditorRegistry';
import { WorkspaceWelcome } from './components/WorkspaceWelcome.tsx';
// Dialog system - new centralized dialog management
import { DialogProvider, dialogRef } from './contexts/DialogContext';
import { initializeDialogs, DIALOG_IDS } from './dialogs';
import type { ProjectSelectionData, ErrorDialogData, ExtensionProjectIntroData } from './dialogs';
import { NavigationDialogKeyboardHandler } from './components/NavigationDialogKeyboardHandler';
import { ConfirmDialog } from './components/ConfirmDialog/ConfirmDialog';
import { GlobalHistoryDialog } from './components/HistoryDialog';
// NOTE: DiscordInvitation, KeyboardShortcutsDialog, ApiKeyDialog now managed by DialogProvider
// NOTE: WindowsClaudeCodeWarning now managed by DialogProvider
// NOTE: ErrorDialog now managed by DialogProvider
import { ErrorToastContainer } from './components/ErrorToast/ErrorToast';
import { ExtensionPermissionPrompt } from './components/ExtensionPermissions/ExtensionPermissionPrompt';
import { errorNotificationService } from './services/ErrorNotificationService';
// NOTE: ProjectSelectionDialog now managed by DialogProvider
// NOTE: UnifiedOnboarding now managed by DialogProvider
import { WorkspaceManager } from './components/WorkspaceManager/WorkspaceManager.tsx';
import { AIUsageReport } from './components/AIUsageReport';
import { DatabaseBrowser } from './components/DatabaseBrowser/DatabaseBrowser';
import { DeveloperDashboard } from './components/DeveloperDashboard/DeveloperDashboard';
import { AgentMode, type AgentModeRef } from './components/AgentMode';
import { ChatSidebar, type ChatSidebarRef } from './components/ChatSidebar';
import EditorMode, { type EditorModeRef } from './components/EditorMode/EditorMode';
import { TabsProvider } from './contexts/TabsContext';
import { DocumentModelRegistry } from './services/document-model/DocumentModelRegistry';
import {
  addWorkstreamFileAtom,
  addWorkstreamTrackerAtom,
  setWorkstreamLayoutModeAtom,
  workstreamStateAtom,
} from './store/atoms/workstreamState';
import {
  addSessionFullAtom,
  setSelectedWorkstreamAtom,
  initSessionList,
} from './store/atoms/sessions';
import { NavigationGutter } from './components/NavigationGutter';
// NOTE: useTabs and useTabNavigation removed - EditorMode manages tabs now
import type { ContentMode } from './types/WindowModeTypes';
import {
  windowModeAtom,
  setWindowModeAtom,
  initWindowMode,
  settingsInitialCategoryAtom,
  settingsInitialScopeAtom,
  settingsKeyAtom,
  setSettingsInitialCategoryAtom,
  setSettingsInitialScopeAtom,
  incrementSettingsKeyAtom,
  clearSettingsNavigationAtom,
  openSettingsCommandAtom,
  // Unified navigation history
  goBackAtom,
  goForwardAtom,
  registerNavigationRestoreCallbacks,
  initNavigationHistory,
  // Session state
  sessionModeAtom,
  selectedWorkstreamAtom,
  // Session draft utilities
  setSessionDraftInputAtom,
  // File navigation
  openFileRequestAtom,
  // Session list refresh (used in test helpers)
  refreshSessionListAtom,
  sessionRegistryAtom,
  historyDialogFileAtom,
} from './store';
import { initOpenProjects } from './store/atoms/openProjects';
import { initWorkspaceStatePruner } from './store/workspaceStatePruner';
import { initActionPromptListeners } from './store/listeners/actionPromptListeners';
import { initAiCommandListeners } from './store/listeners/aiCommandListeners';
import { initAppCommandListeners } from './store/listeners/appCommandListeners';
import { initClaudeUsageListeners } from './store/listeners/claudeUsageListeners';
import { initClaudeCliTerminalListeners } from './store/listeners/claudeCliTerminalListeners';
import { initWindowFocusListeners } from './store/listeners/windowFocusListeners';
import { initCodexUsageListeners } from './store/listeners/codexUsageListeners';
import { initGeminiUsageListeners } from './store/listeners/geminiUsageListeners';
import { initFileChangeListeners } from './store/listeners/fileChangeListeners';
import { initMcpListeners } from './store/listeners/mcpListeners';
import { initMenuCommandListeners } from './store/listeners/menuCommandListeners';
import { initNetworkAvailabilityListeners } from './store/listeners/networkAvailabilityListeners';
import { initNotificationListeners } from './store/listeners/notificationListeners';
import { initExtensionPermissionListeners } from './store/listeners/extensionPermissionListeners';
import { initPermissionListeners } from './store/listeners/permissionListeners';
import { initSoundListeners } from './store/listeners/soundListeners';
import { initStytchAuthListeners } from './store/listeners/stytchAuthListeners';
import { initSyncListeners } from './store/listeners/syncListeners';
import { initThemeListener } from './store/listeners/themeListeners';
import { initThemeFallbackListener } from './store/listeners/themeFallbackListeners';
import { initTrackerSyncListeners } from './store/listeners/trackerSyncListeners';
import { initPullRequestListeners } from './store/listeners/pullRequestListeners';
import { initReadReceiptListeners } from './store/listeners/readReceiptListeners';
import { initWorktreeListeners } from './store/listeners/worktreeListeners';
import { initBlitzListeners } from './store/listeners/blitzListeners';
import { initUpdateListeners } from './store/listeners/updateListeners';
import { initWalkthroughListeners } from './store/listeners/walkthroughListeners';
import { initWakeupListeners } from './store/listeners/wakeupListener';
import { TrackerMode } from './components/TrackerMode';
import { PullRequestMode } from './components/PullRequestMode';
import { CollabMode, type CollabModeRef } from './components/CollabMode';
import { TerminalBottomPanel } from './components/TerminalBottomPanel';
import { ProjectRail } from './components/ProjectRail';
import {
  activeWorkspacePathAtom,
  multiProjectModeAtom,
  addOpenProjectAtom as addOpenProjectAction,
} from './store/atoms/openProjects';
import { registerDocumentLinkPlugin } from './plugins/registerDocumentLinkPlugin';
import { registerTrackerLinkPlugin } from './plugins/registerTrackerLinkPlugin';
import { registerAIChatPlugin } from './plugins/registerAIChatPlugin';
import { registerTrackerPlugin } from './plugins/registerTrackerPlugin';
import { registerSearchReplacePlugin } from './plugins/registerSearchReplacePlugin';
import { registerMockupPlugin } from './plugins/registerMockupPlugin';
import { registerEmbedFrame } from './components/EmbedFrame';
import { registerExtensionSystem, setExtensionWorkspacePath } from './plugins/registerExtensionSystem';
import { SettingsView } from './components/Settings/SettingsView';
import type { SettingsCategory } from './components/Settings/SettingsSidebar';
import { loadCustomTrackers } from './services/CustomTrackerLoader';
import { MockupPickerMenuHost } from './components/MockupPickerMenu';
import { ExtensionHostComponents } from './components/ExtensionHostComponents';
// ClaudeCommandsToast removed - commands now provided via extension-based claude plugins
import { UpdateToast } from './components/UpdateToast';
import { ProjectTrustToast } from './components/ProjectTrustToast';
import { getTextSelection } from './components/UnifiedAI/TextSelectionIndicator';
// NOTE: FeedbackIntakeDialog now managed by DialogProvider
import { buildFeedbackInitialDraft, type FeedbackIntakeLaunchOptions } from './components/Feedback';
import OnboardingService from './services/OnboardingService';
import { WalkthroughProvider } from './walkthroughs';
import { TipProvider } from './tips';
import {
  initializePanelRegistry,
  getPanelById,
  PanelContainer,
  electronStorageBackend,
  initializeElectronStorageBackend,
} from './extensions/panels';
import { setStorageBackend, getExtensionEditorAPI } from '@nimbalyst/runtime';
import { store, editorDirtyAtom, makeEditorKey } from '@nimbalyst/runtime/store';
import { extensionPanelAIContextAtom } from './store/atoms/extensionPanels';
import { setDiffTreeGroupByDirectoryAtom, setAgentFileScopeModeAtom, hydrateFileGutterCollapsedAtom } from './store/atoms/projectState';
import { toggleSessionHistoryCollapsedAtom, scrollToMessageAtom, initAgentModeLayout } from './store/atoms/agentMode';
import {
  developerModeAtom,
  setDeveloperFeatureSettingsAtom,
} from './store/atoms/appSettings';
import {
  agentInsertPlanReferenceRequestAtom,
  closeActiveTabRequestAtom,
  confirmCloseUnsavedRequestAtom,
  extensionMarketplaceInstallRequestAtom,
  navigationGoBackRequestAtom,
  navigationGoForwardRequestAtom,
  reopenLastClosedTabRequestAtom,
  setContentModeRequestAtom,
  showDiscordInvitationRequestAtom,
  showExtensionProjectIntroDialogRequestAtom,
  showFigmaMcpMigrationRequestAtom,
  showProjectSelectionDialogRequestAtom,
  showSessionImportDialogRequestAtom,
  showTrustToastRequestAtom,
} from './store/atoms/appCommands';
import { isCollabUri } from './utils/collabUri';
import {
  collabConnectionStatusAtom,
  hasCollabUnsyncedChanges,
} from './store/atoms/collabEditor';
import {
  initTrackerPanelLayout,
  trackerModeLayoutAtom,
} from './store/atoms/trackers';
import { prNavigateRequestAtom } from './store/atoms/pullRequests';
import {
  terminalPanelVisibleAtom,
  terminalPanelHeightAtom,
  toggleTerminalPanelAtom,
  closeTerminalPanelAtom,
  openTerminalPanelAtom,
  loadTerminalPanelState,
  resetTerminalPanelHydration,
} from './store/atoms/terminals';

logger.ui.info('App.tsx loading');
logger.ui.info('About to import NimbalystEditor');
logger.ui.info('NimbalystEditor imported');

// aiChatBridge has been replaced by editorRegistry - no global setup needed

// Logging configuration - control which categories are logged
const LOG_CONFIG = {
  AUTOSAVE: false,  // Set to true to enable autosave logging
  FILE_SYNC: false,  // File sync operations
  FILE_WATCH: false,  // File watcher events
  WORKSPACE_FILE_SELECT: false,  // Workspace file selection
  HMR: false,  // Hot Module Replacement
  AUTO_SNAPSHOT: false,  // Automatic snapshots
  IPC_LISTENERS: false,  // IPC listener setup (very verbose!)
  AI_CHAT_STATE: false,  // AI Chat state save/load
  THEME: false,  // Theme changes
  FILE_OPS: false,  // File open/save operations
  WORKSPACE_OPS: false,  // Workspace open/close operations
};

// Note: FileTreeItem and ElectronAPI interfaces are defined in electron.d.ts

// Register plugins once at module level
// These provide Electron-specific services to the plugins
let pluginsRegistered = false;
if (!pluginsRegistered) {
  registerDocumentLinkPlugin();
  registerTrackerLinkPlugin();
  registerTrackerPlugin(null); // Load built-in trackers now, custom trackers loaded in AppLayout
  registerAIChatPlugin();
  registerSearchReplacePlugin(); // Search/replace bar in fixed tab header
  registerMockupPlugin(); // Mockup embedding support
  registerEmbedFrame(); // Inline embeds of extension editors in markdown docs
  pluginsRegistered = true;
}

export default function App() {
  // if (import.meta.env.DEV) console.log('[App] render');

   // IMPORTANT: This state must be declared before the useEffect that uses it
  // and before any conditional early returns (workspace-manager, usage-report, etc.)
  const [extensionsReady, setExtensionsReady] = useState(false);

  // Initialize dialog system (must run early, before any dialogs are opened)
  useEffect(() => {
    initializeDialogs();
    logger.ui.info('[Dialogs] Dialog system initialized');
  }, []);

  // Register custom editors and extensions based on settings
  useEffect(() => {
    const registerCustomEditors = async () => {
      try {
        // Set up storage backend for extensions BEFORE loading extensions
        setStorageBackend(electronStorageBackend);
        logger.ui.info('[Extensions] Storage backend initialized');

        // Initialize the extension system (discovers and loads extensions)
        // This MUST complete before any editors are mounted so that extension nodes
        // (like DataModelNode) are published into the runtime extension stores
        // and included in the editor's Lexical extension graph.
        await registerExtensionSystem();
        logger.ui.info('[Extensions] Extension system initialized');

        // Initialize panel registry (syncs panels from loaded extensions)
        initializePanelRegistry();
        logger.ui.info('[Extensions] Panel registry initialized');

        // NOTE: MockupLM is now registered via the extension system (com.nimbalyst.mockuplm)
        // The manifest's customEditors contribution handles registration automatically

        logger.ui.info('[CustomEditors] Custom editors registration complete');
      } catch (error) {
        logger.ui.error('[CustomEditors] Failed to register custom editors:', error);
      } finally {
        // Mark extensions as ready even on error - we don't want to block the app
        setExtensionsReady(true);
      }
    };

    registerCustomEditors();
  }, []);

  // Initialize centralized IPC listeners once at app startup
  useEffect(() => {
    // Multi-project rail state — fire-and-forget so legacy single-project
    // startup is not blocked by IPC. The rail consumers re-render when the
    // atoms hydrate.
    initOpenProjects();
    initWorkspaceStatePruner();

    // Extension-contributed agent provider ids are registered with
    // ModelIdentifier by initializeExtensionAgentProviderSync() (wired in
    // registerExtensionSystem), which re-syncs on every extension load /
    // re-scan / unload rather than only at startup.

    const cleanupActionPrompts = initActionPromptListeners();
    const cleanupAiCommands = initAiCommandListeners();
    const cleanupAppCommands = initAppCommandListeners();
    const cleanupClaude = initClaudeUsageListeners();
    const cleanupClaudeCliTerminal = initClaudeCliTerminalListeners();
    const cleanupWindowFocus = initWindowFocusListeners();
    const cleanupCodex = initCodexUsageListeners();
    const cleanupGemini = initGeminiUsageListeners();
    const cleanupFileChange = initFileChangeListeners();
    const cleanupMcp = initMcpListeners();
    const cleanupMenuCommand = initMenuCommandListeners();
    const cleanupNotification = initNotificationListeners();
    const cleanupExtensionPermission = initExtensionPermissionListeners();
    const cleanupPermission = initPermissionListeners();
    const cleanupSound = initSoundListeners();
    const cleanupStytchAuth = initStytchAuthListeners();
    const cleanupSync = initSyncListeners();
    const cleanupTheme = initThemeListener();
    const cleanupThemeFallback = initThemeFallbackListener();
    const cleanupTrackerSync = initTrackerSyncListeners();
    const cleanupWorktree = initWorktreeListeners();
    const cleanupPullRequest = initPullRequestListeners();
    const cleanupReadReceipts = initReadReceiptListeners();
    const cleanupBlitz = initBlitzListeners();
    const cleanupUpdate = initUpdateListeners();
    const cleanupWalkthrough = initWalkthroughListeners();
    const cleanupWakeup = initWakeupListeners();
    const cleanupNetworkAvailability = initNetworkAvailabilityListeners();
    return () => {
      cleanupActionPrompts?.();
      cleanupAiCommands?.();
      cleanupAppCommands?.();
      cleanupClaude?.();
      cleanupClaudeCliTerminal?.();
      cleanupWindowFocus?.();
      cleanupCodex?.();
      cleanupGemini?.();
      cleanupFileChange?.();
      cleanupMcp?.();
      cleanupMenuCommand?.();
      cleanupNotification?.();
      cleanupExtensionPermission?.();
      cleanupPermission?.();
      cleanupSound?.();
      cleanupStytchAuth?.();
      cleanupSync?.();
      cleanupTheme?.();
      cleanupThemeFallback?.();
      cleanupTrackerSync?.();
      cleanupWorktree?.();
      cleanupPullRequest?.();
      cleanupReadReceipts?.();
      cleanupBlitz?.();
      cleanupUpdate?.();
      cleanupWalkthrough?.();
      cleanupWakeup?.();
      cleanupNetworkAvailability?.();
    };
  }, []);

  // PostHog for analytics
  const posthog = usePostHog();

  // Track user activity for sync presence awareness
  useEffect(() => {
    // Throttle activity reports to max once per second
    let lastReportTime = 0;
    const throttleMs = 1000;

    const reportActivity = () => {
      const now = Date.now();
      if (now - lastReportTime > throttleMs) {
        lastReportTime = now;
        window.electronAPI?.reportUserActivity?.();
      }
    };

    // Track keyboard and mouse activity
    document.addEventListener('keydown', reportActivity);
    document.addEventListener('mousedown', reportActivity);
    document.addEventListener('mousemove', reportActivity);
    document.addEventListener('scroll', reportActivity, true);

    return () => {
      document.removeEventListener('keydown', reportActivity);
      document.removeEventListener('mousedown', reportActivity);
      document.removeEventListener('mousemove', reportActivity);
      document.removeEventListener('scroll', reportActivity, true);
    };
  }, []);

  // Check for special window modes
  const urlParams = new URLSearchParams(window.location.search);
  const windowMode = urlParams.get('mode');

  // Apply theme for ALL window modes (must run before early returns)
  const { theme, setTheme } = useTheme();

  // General confirm dialog
  const confirmDialog = useConfirmDialog();

  // Document context hook needs to be after tabs - will declare after special window modes

  // Handle special window modes
  if (windowMode === 'workspace-manager') {
    // Set window title for Workspace Manager
    React.useEffect(() => {
      if (window.electronAPI) {
        window.electronAPI.setTitle('Project Manager - Nimbalyst');
      }
    }, []);
    return <WorkspaceManager />;
  }

  if (windowMode === 'usage-report') {
    // Set window title for AI Usage Report
    React.useEffect(() => {
      if (window.electronAPI) {
        window.electronAPI.setTitle('AI Usage Report - Nimbalyst');
      }
    }, []);
    return <AIUsageReport onClose={() => window.close()} />;
  }

  if (windowMode === 'database-browser') {
    // Set window title for Database Browser
    React.useEffect(() => {
      if (window.electronAPI) {
        window.electronAPI.setTitle('Database Browser - Nimbalyst');
      }
    }, []);
    return <DatabaseBrowser />;
  }

  if (windowMode === 'developer-dashboard') {
    React.useEffect(() => {
      if (window.electronAPI) {
        window.electronAPI.setTitle('Developer Dashboard - Nimbalyst');
      }
    }, []);
    return <DeveloperDashboard />;
  }

  // IMPORTANT: These are refs, not state, to prevent re-renders when the active file changes.
  // Window title and other side effects are updated imperatively via editorModeRef.
  const currentFilePathRef = useRef<string | null>(null);
  const currentFileNameRef = useRef<string | null>(null);
  // NOTE: isDirty state removed - TabEditor owns dirty state and calls setDocumentEdited directly
  // NOTE: contentVersion removed - EditorContainer doesn't need version bumping for remounts
  // NOTE: tabStatesRef removed - TabEditor tracks its own dirty state
  const tabsRef = useRef<any>(null);  // Reference to current tabs object for use in intervals only
  const [isInitializing, setIsInitializing] = useState(true);
  // NOTE: extensionsReady state moved to top of component (before early returns)
  const [workspaceMode, setWorkspaceMode] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  // Multi-project rail integration: when the user clicks a different
  // project in the rail, the active-path atom changes. Mirror it into the
  // existing `workspacePath` useState so the rest of the App.tsx tree
  // (which is wired to that state) re-renders for the new project.
  const isMultiProjectMode = useAtomValue(multiProjectModeAtom);
  const railActivePath = useAtomValue(activeWorkspacePathAtom);
  const addOpenProject = useSetAtom(addOpenProjectAction);
  const setRailActivePath = useSetAtom(activeWorkspacePathAtom);
  // NOTE: fileTree, sidebarWidth, isNewFileDialogOpen, newFileDirectory, isHistoryDialogOpen moved to EditorMode
  // NOTE: Navigation dialogs (QuickOpen, SessionQuickOpen, PromptQuickOpen, ProjectQuickOpen) are now managed by DialogProvider
  // NOTE: isAIChatCollapsed, aiChatWidth moved to EditorMode for workspace mode
  // These are kept for potential single-file mode or agent mode use
  const [isAIChatCollapsed, setIsAIChatCollapsed] = useState(false);
  const [aiChatWidth, setAIChatWidth] = useState<number>(350);
  // NOTE: KeyboardShortcutsDialog, DiscordInvitation, FeedbackIntakeDialog, ApiKeyDialog are now managed by DialogProvider
  // NOTE: WindowsClaudeCodeWarning now managed by DialogProvider via useOnboarding hook
  const [isAIChatStateLoaded, setIsAIChatStateLoaded] = useState(false);
  // Planning mode for AI sidebar (Claude Code safety). Default ON
  const [aiPlanningModeEnabled, setAIPlanningModeEnabled] = useState<boolean>(true);
  // Force show trust toast (when user wants to change permission mode)
  const [forceShowTrustToast, setForceShowTrustToast] = useState(false);
  const [sessionToLoad, setSessionToLoad] = useState<{ sessionId: string; workspacePath?: string } | null>(null);
  const [currentAISessionId, setCurrentAISessionId] = useState<string | null>(null);
  // NOTE: diffError and projectSelection are now managed by DialogProvider

  // NOTE: UnifiedOnboarding state now managed by DialogProvider via useOnboarding hook

  // Claude commands install toast state
  // Commands toast removed - commands now provided via extension-based claude plugins

  // Settings deep link state - now using atoms
  const settingsInitialCategory = useAtomValue(settingsInitialCategoryAtom);
  const settingsInitialScope = useAtomValue(settingsInitialScopeAtom);
  const settingsKey = useAtomValue(settingsKeyAtom);
  const setSettingsInitialCategory = useSetAtom(setSettingsInitialCategoryAtom);
  const setSettingsInitialScope = useSetAtom(setSettingsInitialScopeAtom);
  const incrementSettingsKey = useSetAtom(incrementSettingsKeyAtom);
  const clearSettingsNavigation = useSetAtom(clearSettingsNavigationAtom);
  const [marketplaceInstallRequest, setMarketplaceInstallRequest] = useState<{
    extensionId: string;
    requestedAt: string;
    token: number;
  } | null>(null);

  // Active extension panel (for sidebar or fullscreen panels from extensions)
  const [activeExtensionPanel, setActiveExtensionPanel] = useState<string | null>(null);

  // Active extension bottom panel (for bottom-placement panels from extensions)
  const [activeExtensionBottomPanel, setActiveExtensionBottomPanel] = useState<string | null>(null);

  // Extension panel AI context (synced from PanelContainer when aiSupported panels are active)
  const extensionPanelAIContext = useAtomValue(extensionPanelAIContextAtom);

  // Workspace state hydration setters
  const setDiffTreeGroupByDirectory = useSetAtom(setDiffTreeGroupByDirectoryAtom);
  const setAgentFileScopeMode = useSetAtom(setAgentFileScopeModeAtom);
  const hydrateFileGutterCollapsed = useSetAtom(hydrateFileGutterCollapsedAtom);

  // Check if a fullscreen extension panel is active (hides other content modes)
  const activeFullscreenPanel = activeExtensionPanel ? getPanelById(activeExtensionPanel) : null;
  const isFullscreenPanelActive = activeFullscreenPanel?.placement === 'fullscreen';

  // Window mode - which view is active (files, agent, settings)
  const activeMode = useAtomValue(windowModeAtom);
  const developerMode = useAtomValue(developerModeAtom);
  const setActiveMode = useSetAtom(setWindowModeAtom);
  const toggleAgentCollapsed = useSetAtom(toggleSessionHistoryCollapsedAtom);
  const updateDeveloperSettings = useSetAtom(setDeveloperFeatureSettingsAtom);
  // Keep a ref for use in callbacks that might have stale closures
  const activeModeStateRef = useRef<ContentMode>(activeMode);
  useEffect(() => {
    activeModeStateRef.current = activeMode;
  }, [activeMode]);

  useEffect(() => {
    if (activeMode === 'pr-review' && !developerMode) {
      setActiveMode('files');
    }
  }, [activeMode, developerMode, setActiveMode]);

  const openMarketplaceInstallRequest = useCallback((request: { extensionId: string; requestedAt?: string }) => {
    if (!request.extensionId) return;

    setMarketplaceInstallRequest({
      extensionId: request.extensionId,
      requestedAt: request.requestedAt || new Date().toISOString(),
      token: Date.now(),
    });
    setSettingsInitialCategory('marketplace');
    incrementSettingsKey();
    setTimeout(() => setActiveMode('settings'), 0);
  }, [incrementSettingsKey, setActiveMode, setSettingsInitialCategory]);

  const clearMarketplaceInstallRequest = useCallback((token: number) => {
    setMarketplaceInstallRequest((currentRequest) => {
      if (!currentRequest || currentRequest.token !== token) return currentRequest;
      return null;
    });
  }, []);

  // Unified navigation history (cross-mode back/forward)
  const goBack = useSetAtom(goBackAtom);
  const goForward = useSetAtom(goForwardAtom);

  // Onboarding dialogs (UnifiedOnboarding, WindowsClaudeCodeWarning) - managed via DialogProvider
  useOnboarding({
    workspacePath,
    workspaceMode,
    isInitializing,
    setActiveMode,
  });

  // Expose test helpers for testing
  useEffect(() => {
    // Always expose in development
    if (import.meta.env.DEV) {
      (window as any).__testHelpers = {
        ...(window as any).__testHelpers,
        setActiveMode: (mode: any) => setActiveMode(mode),
        getActiveMode: () => activeMode,
        // Session list refresh (for E2E tests that create sessions via IPC)
        refreshSessions: () => store.set(refreshSessionListAtom),
        // Inject sessions directly into registry (for E2E tests)
        injectSessions: (sessions: any[]) => {
          const registry = new Map(store.get(sessionRegistryAtom));
          for (const s of sessions) {
            registry.set(s.id, s);
          }
          store.set(sessionRegistryAtom, registry);
        },
        // Settings deep link helpers
        openAgentPermissions: () => {
          setSettingsInitialCategory('agent-permissions');
          setSettingsInitialScope('project');
          incrementSettingsKey();
          setTimeout(() => setActiveMode('settings'), 0);
        },
        openSettings: (category?: any, scope?: 'user' | 'project') => {
          if (category) setSettingsInitialCategory(category);
          if (scope) setSettingsInitialScope(scope);
          incrementSettingsKey();
          setTimeout(() => setActiveMode('settings'), 0);
        },
        // Expose DocumentModelRegistry for multi-editor coordination tests
        documentModelRegistry: DocumentModelRegistry,
        // Look up an extension editor's imperative API by file path. Replaces
        // the legacy per-extension window globals (e.g.
        // window.__excalidraw_getEditorAPI) that E2E tests used to poke
        // editors directly.
        getExtensionEditorAPI: (filePath: string) => getExtensionEditorAPI(filePath),
        // Open a file in a real AgentMode workstream editor tab (for multi-editor
        // tests). Creates a real session via IPC, selects it as the active
        // workstream, adds the file to openFilePaths, and switches layoutMode
        // to 'split' so WorkstreamEditorTabs mounts and renders a TabEditor
        // for the file. Returns the sessionId / workstreamId.
        openFileInAgentMode: async (workspacePath: string, filePath: string) => {
          const sessionId = crypto.randomUUID();
          const result = await window.electronAPI.invoke('sessions:create', {
            session: {
              id: sessionId,
              provider: 'claude-code',
              model: 'claude-code:sonnet',
              title: 'Multi-editor Test Session',
            },
            workspaceId: workspacePath,
          });
          if (!result?.success || !result.id) {
            throw new Error('Failed to create test agent session');
          }
          store.set(addSessionFullAtom, {
            id: result.id,
            title: 'Multi-editor Test Session',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            provider: 'claude-code',
            model: 'claude-code:sonnet',
            sessionType: 'session',
            messageCount: 0,
            workspaceId: workspacePath,
            isArchived: false,
            isPinned: false,
            parentSessionId: null,
            worktreeId: null,
            childCount: 0,
            uncommittedCount: 0,
          });
          store.set(setSelectedWorkstreamAtom, {
            workspacePath,
            selection: { type: 'session', id: result.id },
          });
          store.set(addWorkstreamFileAtom, { workstreamId: result.id, filePath });
          store.set(setWorkstreamLayoutModeAtom, { workstreamId: result.id, mode: 'split' });
          return result.id;
        },
      };
      console.log('[App] Test helpers exposed, DEV mode:', import.meta.env.DEV);
    }
  }, [activeMode]);

  // Terminal bottom panel state (Jotai atoms)
  const terminalPanelVisible = useAtomValue(terminalPanelVisibleAtom);
  const terminalPanelHeight = useAtomValue(terminalPanelHeightAtom);
  const toggleTerminalPanel = useSetAtom(toggleTerminalPanelAtom);
  const closeTerminalPanel = useSetAtom(closeTerminalPanelAtom);
  const openTerminalPanel = useSetAtom(openTerminalPanelAtom);

  // Agent panel plan reference (for launching from plan status)
  const [agentPlanReference, setAgentPlanReference] = useState<string | null>(null);

  // NOTE: Onboarding check and handlers moved to useOnboarding hook

  // Load custom trackers when workspace is available
  useEffect(() => {
    if (workspacePath) {
      loadCustomTrackers(workspacePath);
    }
  }, [workspacePath]);

  // Initialize storage backend for extensions when workspace path changes
  useEffect(() => {
    initializeElectronStorageBackend(workspacePath);
  }, [workspacePath]);

  // Load diff tree state from workspace state
  // NOTE: activeMode is restored by initWindowMode() in the initial load effect
  useEffect(() => {
    if (!workspacePath || !window.electronAPI?.invoke) return;

    window.electronAPI.invoke('workspace:get-state', workspacePath)
      .then(state => {
        // Hydrate diff tree grouping state into Jotai atom
        if (state?.diffTreeGroupByDirectory !== undefined) {
          setDiffTreeGroupByDirectory({ groupByDirectory: state.diffTreeGroupByDirectory, workspacePath });
        }
        // Hydrate agent file scope mode into Jotai atom
        if (state?.agentFileScopeMode !== undefined) {
          setAgentFileScopeMode({ fileScopeMode: state.agentFileScopeMode, workspacePath });
        }
        // Gutter icon visibility is now a GLOBAL preference (see
        // appSettings gutterCustomizationAtom, hydrated at startup); the
        // legacy per-project hiddenGutterButtons is only read by the one-shot
        // migration in main. Do not hydrate it here.
        // Hydrate FileGutter collapsed state per type into Jotai atom
        if (state?.fileGutterCollapsed) {
          hydrateFileGutterCollapsed(state.fileGutterCollapsed);
        }
      })
      .catch(error => {
        console.error('[App] Failed to load workspace state:', error);
      });
  }, [workspacePath, setDiffTreeGroupByDirectory, setAgentFileScopeMode, hydrateFileGutterCollapsed]);

  // Save active mode when it changes
  useEffect(() => {
    // console.log('[App Layout] Active mode changed to:', activeMode, 'workspacePath:', workspacePath);

    if (!workspacePath || !window.electronAPI?.invoke) return;

    const updates = { activeMode };
    // console.log('[App Layout] Saving updates:', JSON.stringify(updates));
    window.electronAPI.invoke('workspace:update-state', workspacePath, updates)
      .then((result) => {
        // console.log('[App Layout] Successfully saved active mode:', activeMode, 'result:', result);
      })
      .catch(error => {
        console.error('[ContentMode] Failed to save active mode:', error);
      });
  }, [activeMode, workspacePath]);

  // Initialize tracker panel state from workspace state
  useEffect(() => {
    if (workspacePath) {
      initTrackerPanelLayout(workspacePath);
    }
  }, [workspacePath]);

  // Load terminal panel state from terminal store into Jotai atoms
  useEffect(() => {
    if (!workspacePath) return;
    resetTerminalPanelHydration();
    void loadTerminalPanelState(workspacePath);
  }, [workspacePath]);


  // Register aiToolService methods on aiChatBridge for runtime to use
  useEffect(() => {
    aiToolService.registerBridgeMethods();
  }, []);

  // Debug: Log computed layout dimensions after render
  useEffect(() => {
    // Use setTimeout to ensure DOM has updated
    const timeout = setTimeout(() => {
      const rootContainer = document.querySelector('[data-layout="root-container"]') as HTMLElement;
      const navGutter = document.querySelector('.navigation-gutter') as HTMLElement;
      const mainColumnContainer = document.querySelector('[data-layout="main-column-container"]') as HTMLElement;
      const topContentRow = document.querySelector('[data-layout="top-content-row"]') as HTMLElement;
      const centerContentWrapper = document.querySelector('[data-layout="center-content-wrapper"]') as HTMLElement;
      const filesModeWrapper = document.querySelector('[data-layout="files-mode-wrapper"]') as HTMLElement;
      const agentModeWrapper = document.querySelector('[data-layout="agent-mode-wrapper"]') as HTMLElement;
      const fileTabsContainer = document.querySelector('.file-tabs-container') as HTMLElement;
      const bottomPanelContainer = document.querySelector('.bottom-panel-container') as HTMLElement;

      const logDimensions = (name: string, el: HTMLElement | null) => {
        if (!el) return { found: false };
        const styles = window.getComputedStyle(el);
        return {
          found: true,
          height: el.clientHeight,
          offsetTop: el.offsetTop,
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          flex: styles.flex,
          overflow: styles.overflow,
          minHeight: styles.minHeight,
          position: styles.position,
          top: styles.top,
          transform: styles.transform,
          margin: styles.margin
        };
      };

      // console.log('[App Layout] === FULL LAYOUT DIMENSIONS ===');
      // console.log('[App Layout] Window height:', window.innerHeight);
      // console.log('[App Layout] Active mode:', activeMode, '| Bottom panel:', bottomPanel);
      // console.log('[App Layout] ---');
      // console.log('[App Layout] root-container:', logDimensions('root', rootContainer));
      // console.log('[App Layout] navigation-gutter:', logDimensions('nav', navGutter));
      // console.log('[App Layout] main-column-container:', logDimensions('main-col', mainColumnContainer));
      // console.log('[App Layout] top-content-row:', logDimensions('top-row', topContentRow));
      // console.log('[App Layout] center-content-wrapper:', logDimensions('center', centerContentWrapper));
      // console.log('[App Layout] files-mode-wrapper:', logDimensions('files-wrapper', filesModeWrapper));
      // console.log('[App Layout] agent-mode-wrapper:', logDimensions('agent-wrapper', agentModeWrapper));
      // console.log('[App Layout] file-tabs-container:', logDimensions('tabs', fileTabsContainer));
      // console.log('[App Layout] bottom-panel-container:', logDimensions('bottom', bottomPanelContainer));

      // Calculate totals
      const topRowHeight = topContentRow?.clientHeight || 0;
      const bottomPanelHeight = bottomPanelContainer?.clientHeight || 0;
      const total = topRowHeight + bottomPanelHeight;
      const mainColHeight = mainColumnContainer?.clientHeight || 0;

      // console.log('[App Layout] ---');
      // console.log('[App Layout] MATH CHECK:');
      // console.log('[App Layout]   top-content-row height:', topRowHeight);
      // console.log('[App Layout]   bottom-panel height:', bottomPanelHeight);
      // console.log('[App Layout]   TOTAL:', total);
      // console.log('[App Layout]   main-column-container height:', mainColHeight);
      // console.log('[App Layout]   DIFFERENCE:', total - mainColHeight, (total === mainColHeight ? '✓ OK' : '✗ MISMATCH!'));
      //
      // // Check viewport positions
      // console.log('[App Layout] ---');
      // console.log('[App Layout] VIEWPORT POSITIONS (getBoundingClientRect):');
      if (fileTabsContainer) {
        const rect = fileTabsContainer.getBoundingClientRect();
        // console.log('[App Layout]   file-tabs-container: top=' + rect.top + ', visible=' + (rect.top >= 0));
      }
      if (topContentRow) {
        const rect = topContentRow.getBoundingClientRect();
        // console.log('[App Layout]   top-content-row: top=' + rect.top + ', visible=' + (rect.top >= 0));
      }
      // console.log('[App Layout] ================================');
    }, 100);

    return () => clearTimeout(timeout);
  }, [activeMode]);

  // NOTE: Tab management moved to EditorMode. App.tsx no longer maintains tabs.
  // Current file info is stored in refs to prevent re-renders.

  // Declare refs needed by hooks below
  const getContentRef = useRef<(() => string) | null>(null);

  // Build document context for AI features - reads from refs, stable object reference
  // Components that need to use this should call getLatestContent() to get current state
  const documentContext = useMemo(() => ({
    get filePath() { return currentFilePathRef.current || ''; },
    fileType: 'markdown' as const,
    content: '', // Don't call getContentRef during render - getLatestContent will be called when needed
    cursorPosition: undefined,
    selection: undefined,
    getLatestContent: () => getContentRef.current?.() || '',
    get textSelection() { return getTextSelection() ?? undefined; },
    get textSelectionTimestamp() { return getTextSelection()?.timestamp ?? undefined; }
  }), []); // Empty deps - never recreates, reads from refs

  // Build extension panel context for AI features (when an aiSupported panel is active)
  // This provides extension-specific context (e.g., database name, schema) to the AI chat
  const extensionPanelDocumentContext = useMemo(() => {
    if (!extensionPanelAIContext) return undefined;
    return {
      filePath: `extension:${extensionPanelAIContext.panelId}`,
      fileType: 'extension-panel' as const,
      content: JSON.stringify(extensionPanelAIContext.context, null, 2),
      cursorPosition: undefined,
      selection: undefined,
      getLatestContent: () => JSON.stringify(extensionPanelAIContext.context, null, 2),
      // Extension-specific metadata
      extensionId: extensionPanelAIContext.extensionId,
      panelId: extensionPanelAIContext.panelId,
      panelTitle: extensionPanelAIContext.panelTitle,
    };
  }, [extensionPanelAIContext]);
  const searchCommandRef = useRef<LexicalCommand<undefined> | null>(null);
  const isInitializedRef = useRef<boolean>(false);
  const chatSidebarRef = useRef<ChatSidebarRef>(null);
  const agentModeRef = useRef<AgentModeRef>(null);
  const editorModeRef = useRef<EditorModeRef>(null);
  const collabModeRef = useRef<CollabModeRef | null>(null);

  // NOTE: autoSaveIntervalRef and autoSaveCancellationRef removed - EditorContainer handles autosave now
  const activeSavesRef = useRef<Set<string>>(new Set());
  const lastSavePathRef = useRef<string | null>(null);
  const lastChangeTimeRef = useRef<number>(0);  // Track when content last changed for debouncing
  // NOTE: sidebarRef and isResizingRef moved to EditorMode

  // Window lifecycle hook - handles mount/unmount and beforeunload
  useWindowLifecycle({
    tabsRef,
    getContentRef,
    currentFilePathRef,
  });

  useEffect(() => {
    if (!window.electronAPI?.setDocumentEdited) return;

    const syncWindowEditedState = () => {
      const snapshot = tabsRef.current?.getSnapshot?.();
      const tabs = snapshot
        ? snapshot.tabOrder
          .map((tabId: string) => snapshot.tabs.get(tabId))
          .filter(Boolean)
        : [];

      const hasUnsavedOrUnsyncedTabs = tabs.some((tab: any) => {
        if (!tab?.filePath) return false;
        const isDirty = store.get(editorDirtyAtom(makeEditorKey(tab.filePath)));
        if (isDirty) return true;
        if (!isCollabUri(tab.filePath)) return false;
        const status = store.get(collabConnectionStatusAtom(tab.filePath));
        return hasCollabUnsyncedChanges(status);
      });

      window.electronAPI?.setDocumentEdited(hasUnsavedOrUnsyncedTabs);
    };

    syncWindowEditedState();
    const interval = setInterval(syncWindowEditedState, 500);
    return () => clearInterval(interval);
  }, []);

  // NOTE: useHMRStateRestoration removed - no longer needed now that TabEditor
  // manages all editor state and useTabs persists tabs to localStorage. During HMR, tabs will
  // be restored from localStorage and editors recreated from tab content.

  // Prepare AI chat state loading
  useEffect(() => {
    setIsAIChatStateLoaded(false);
  }, []);

  // NOTE: Sidebar width loading moved to EditorMode

  // Expose workspacePath and currentFilePath globally for plugins
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).workspacePath = workspacePath;
    }
    // Update extension system with workspace path for MCP tool registration
    setExtensionWorkspacePath(workspacePath);
  }, [workspacePath]);

  // NOTE: currentFilePath is now exposed to window via EditorMode's imperative updates
  // The ref is updated when tabs change, and EditorMode handles the window exposure

  // NOTE: Sidebar resize handlers moved to EditorMode


  // Handle new file (legacy - used in single-file mode)
  const handleNew = useCallback(() => {
    // Reset refs for new file
    currentFilePathRef.current = null;
    currentFileNameRef.current = null;

    // Note: In workspace mode, this is handled by EditorMode via 'file-new-in-workspace' event
  }, []);

  // Handle open file - delegate to EditorMode in workspace mode
  const handleOpen = useCallback(async () => {
    if (workspaceMode && editorModeRef.current) {
      await editorModeRef.current.handleOpen();
    } else {
      // TODO: Handle single-file mode if needed
      console.warn('handleOpen called but not in workspace mode');
    }
  }, [workspaceMode]);

  // Handle save as - delegate to EditorMode in workspace mode
  const handleSaveAs = useCallback(async () => {
    if (workspaceMode && editorModeRef.current) {
      await editorModeRef.current.handleSaveAs();
    } else {
      // TODO: Handle single-file mode if needed
      console.warn('handleSaveAs called but not in workspace mode');
    }
  }, [workspaceMode]);

  // Manual save function provided by EditorContainer
  const handleSaveRef = useRef<(() => Promise<void>) | null>(null);

  // Handle close workspace
  const handleCloseWorkspace = useCallback(async () => {
    // NOTE: EditorContainer handles saving dirty files automatically
    // Close the window
    window.close();
  }, []);

  // Handle switch to agent mode - extracted to useCallback to prevent EditorMode re-renders
  const handleSwitchToAgentMode = useCallback((planDocumentPath?: string, sessionId?: string) => {
    console.log('[App] handleSwitchToAgentMode called:', { planDocumentPath, sessionId, workspacePath });
    // Switch to agent mode first
    setActiveMode('agent');

    // Wait for next tick to ensure AgentMode is mounted/visible
    setTimeout(() => {
      if (planDocumentPath) {
        // Create new session with @ file reference to the document
        if (agentModeRef.current?.createNewSession) {
          const relativePath = workspacePath && planDocumentPath.startsWith(workspacePath + '/')
            ? planDocumentPath.slice(workspacePath.length + 1)
            : planDocumentPath;
          console.log('[App] Creating session with draft:', `@${relativePath} `);
          agentModeRef.current.createNewSession(`@${relativePath} `);
        } else {
          console.warn('[App] agentModeRef.current?.createNewSession not available');
        }
      } else if (sessionId && agentModeRef.current) {
        // Load existing session
        console.log('Load session:', sessionId);
        agentModeRef.current.openSessionInTab(sessionId);
      }
    }, 100);
  }, [workspacePath]);

  // Open the feedback intake dialog. Shared by the gutter button, the Help menu,
  // and any future entry points (e.g. error toasts that say "Report this").
  const handleOpenFeedback = useCallback(() => {
    if (!dialogRef.current) return;
    dialogRef.current.open(DIALOG_IDS.FEEDBACK_INTAKE, {
      onLaunch: ({ kind, mayGatherLogs, shouldCreateMockup }: FeedbackIntakeLaunchOptions) => {
        const draft = `${buildFeedbackInitialDraft(kind, {
          mayGatherLogs,
          shouldCreateMockup,
        })}\n`;

        if (activeModeStateRef.current !== 'agent') {
          setActiveMode('agent');
        }
        setTimeout(() => {
          agentModeRef.current?.createNewSession?.(draft);
        }, 100);
      },
    });
  }, []);

  // Wrapper for workspace file selection - delegates to EditorMode
  // CRITICAL: Use activeModeStateRef.current to avoid stale closure bugs
  // This function is passed to AgenticPanel and stored in callbacks that may have stale references
  const handleWorkspaceFileSelect = useCallback(async (filePath: string) => {
    const currentMode = activeModeStateRef.current;

    // CRITICAL: If workspacePath is null, something is very wrong
    if (!workspacePath) {
      console.error('[App.handleWorkspaceFileSelect] ERROR: workspacePath is null/undefined! Cannot open file.');
      return;
    }

    // Switch to files mode if needed
    if (currentMode !== 'files') {
      setActiveMode('files');
    }

    // Delegate to EditorMode
    if (editorModeRef.current) {
      await editorModeRef.current.selectFile(filePath);
    } else {
      console.error('[App.handleWorkspaceFileSelect] editorModeRef.current is null! This should never happen if workspacePath is set.');
    }
  }, [workspacePath]); // Only workspacePath - activeMode is read from ref

  // Configure aiToolService with handleWorkspaceFileSelect
  useEffect(() => {
    aiToolService.setHandleWorkspaceFileSelectFunction(handleWorkspaceFileSelect);
  }, [handleWorkspaceFileSelect]);

  // Expose for E2E tests
  useEffect(() => {
    (window as any).__handleWorkspaceFileSelect = handleWorkspaceFileSelect;
    (window as any).__workspacePath = workspacePath;
    (window as any).__editorRegistry = editorRegistry;
    return () => {
      delete (window as any).__handleWorkspaceFileSelect;
      delete (window as any).__workspacePath;
      delete (window as any).__editorRegistry;
    };
  }, [handleWorkspaceFileSelect, workspacePath]);

  // Subscribe to openFileRequestAtom (breadcrumb clicks from any mode)
  useEffect(() => {
    const unsub = store.sub(openFileRequestAtom, () => {
      const req = store.get(openFileRequestAtom);
      if (req) {
        handleWorkspaceFileSelect(req.path);
        store.set(openFileRequestAtom, null);
      }
    });
    return unsub;
  }, [handleWorkspaceFileSelect]);

  // File opener - delegates to EditorMode in workspace mode
  useEffect(() => {
    const fileOpener = async (filePath: string, content: string, switchToTab: boolean) => {
      if (workspaceMode && editorModeRef.current && switchToTab) {
        await editorModeRef.current.selectFile(filePath);
      }
    };
    editorRegistry.setFileOpener(fileOpener);
  }, [workspaceMode]);

  // Welcome tab - no-op in workspace mode (workspace always shows file tree)
  const openWelcomeTab = useCallback(async () => {
    // No-op: workspace mode doesn't use welcome tabs, always shows file tree
  }, []);

  // Register unified navigation restore callbacks
  // These are called when goBack/goForward restores a navigation entry
  useEffect(() => {
    registerNavigationRestoreCallbacks({
      setMode: (mode) => {
        setActiveMode(mode);
      },
      restoreFiles: (state) => {
        // Switch to files mode and select the tab
        if (editorModeRef.current) {
          editorModeRef.current.selectFile(state.filePath);
        }
      },
      restoreAgent: (state) => {
        // Switch to agent mode and select the session
        if (agentModeRef.current) {
          agentModeRef.current.openSessionInTab(state.workstreamId);
        }
      },
      restoreTracker: (state) => {
        // Restore tracker mode view state
        store.set(trackerModeLayoutAtom, (current) => ({
          ...current,
          selectedType: state.selectedType,
          viewMode: state.viewMode,
        }));
      },
      restoreSettings: (state) => {
        // Switch to settings mode and select the category
        setSettingsInitialCategory(state.category as any);
        setSettingsInitialScope(state.scope);
        incrementSettingsKey();
      },
    });
  }, []);

  // React to openSettingsCommandAtom (used by tips to navigate to settings).
  // anchor: optional data-testid the consumer wants scrolled into view once the
  // selected panel renders. We poll briefly because the panel mounts on a
  // separate React commit and may not be in the DOM on the first frame.
  const openSettingsCommand = useAtomValue(openSettingsCommandAtom);
  const openSettingsCommandProcessedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!openSettingsCommand || openSettingsCommand.timestamp === openSettingsCommandProcessedRef.current) return;
    openSettingsCommandProcessedRef.current = openSettingsCommand.timestamp;

    setSettingsInitialCategory(openSettingsCommand.category);
    if (openSettingsCommand.scope) setSettingsInitialScope(openSettingsCommand.scope);
    incrementSettingsKey();
    setTimeout(() => setActiveMode('settings'), 0);

    const anchor = openSettingsCommand.anchor;
    if (anchor) {
      let attempts = 0;
      const tryScroll = () => {
        const el = document.querySelector(`[data-testid="${anchor}"]`);
        if (el instanceof HTMLElement) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (attempts++ < 20) setTimeout(tryScroll, 50);
      };
      setTimeout(tryScroll, 50);
    }
  }, [openSettingsCommand, setSettingsInitialCategory, setSettingsInitialScope, incrementSettingsKey]);

  // Custom event dispatched by the runtime-side CodexAuthRequiredWidget. Lives
  // in renderer because the widget cannot reach the renderer's jotai store
  // directly across the package boundary.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ anchor?: string }>).detail;
      store.set(openSettingsCommandAtom, {
        category: 'openai-codex',
        scope: 'user',
        anchor: detail?.anchor ?? 'codex-auth-section',
        timestamp: Date.now(),
      });
    };
    window.addEventListener('nimbalyst:open-codex-auth-settings', handler);
    return () => window.removeEventListener('nimbalyst:open-codex-auth-settings', handler);
  }, []);

  // React to unified navigation back/forward commands. The IPC subscriptions
  // live in store/listeners/appCommandListeners.ts.
  const navigationGoBackVersion = useAtomValue(navigationGoBackRequestAtom);
  const navigationGoForwardVersion = useAtomValue(navigationGoForwardRequestAtom);
  const navigationGoBackInitialRef = useRef(navigationGoBackVersion);
  const navigationGoForwardInitialRef = useRef(navigationGoForwardVersion);
  useEffect(() => {
    if (navigationGoBackVersion === navigationGoBackInitialRef.current) return;
    console.log('[App] navigation:go-back received, using unified navigation');
    goBack();
  }, [navigationGoBackVersion, goBack]);
  useEffect(() => {
    if (navigationGoForwardVersion === navigationGoForwardInitialRef.current) return;
    console.log('[App] navigation:go-forward received, using unified navigation');
    goForward();
  }, [navigationGoForwardVersion, goForward]);

  // Listen for mouse back/forward button clicks (unified navigation)
  useEffect(() => {
    const handleMouseButton = (event: MouseEvent) => {
      // Mouse button 3 = back, button 4 = forward (side buttons on mice)
      // See: https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/button
      if (event.button === 3) {
        event.preventDefault();
        event.stopPropagation();
        goBack();
      } else if (event.button === 4) {
        event.preventDefault();
        event.stopPropagation();
        goForward();
      }
    };

    // Use auxclick which is specifically designed for non-primary mouse buttons
    document.addEventListener('auxclick', handleMouseButton);

    return () => {
      document.removeEventListener('auxclick', handleMouseButton);
    };
  }, [goBack, goForward]);

  // React to extension marketplace install requests. The IPC subscription
  // lives in store/listeners/appCommandListeners.ts. On startup, also drain
  // any request the main process queued before the listener was ready.
  const extensionMarketplaceRequest = useAtomValue(extensionMarketplaceInstallRequestAtom);
  useEffect(() => {
    if (!extensionMarketplaceRequest) return;
    openMarketplaceInstallRequest(extensionMarketplaceRequest.request);
  }, [extensionMarketplaceRequest, openMarketplaceInstallRequest]);
  useEffect(() => {
    void window.electronAPI.invoke('extension-marketplace:consume-pending-install-request').then((result) => {
      if (result?.success && result.data?.extensionId) {
        openMarketplaceInstallRequest(result.data);
      }
    }).catch((error) => {
      console.warn('[App] Failed to consume pending marketplace install request:', error);
    });
  }, [openMarketplaceInstallRequest]);

  // React to menu IPC commands. The subscriptions live in
  // store/listeners/appCommandListeners.ts.
  const setContentModeRequest = useAtomValue(setContentModeRequestAtom);
  useEffect(() => {
    if (!setContentModeRequest) return;
    setActiveMode(setContentModeRequest.mode as ContentMode);
  }, [setContentModeRequest]);

  const agentInsertPlanReferenceRequest = useAtomValue(agentInsertPlanReferenceRequestAtom);
  useEffect(() => {
    if (!agentInsertPlanReferenceRequest) return;
    console.log('[App] handleInsertPlanReference called with path:', agentInsertPlanReferenceRequest.planPath);
    setAgentPlanReference(agentInsertPlanReferenceRequest.planPath);
  }, [agentInsertPlanReferenceRequest]);

  const showProjectSelectionDialogRequest = useAtomValue(showProjectSelectionDialogRequestAtom);
  useEffect(() => {
    if (!showProjectSelectionDialogRequest) return;
    const { data } = showProjectSelectionDialogRequest;
    console.log('[App] handleShowProjectSelectionDialog called with data:', data);
    if (!dialogRef.current) return;
    dialogRef.current.open<ProjectSelectionData>(DIALOG_IDS.PROJECT_SELECTION, {
      filePath: data.filePath,
      fileName: data.fileName,
      suggestedWorkspace: data.suggestedWorkspace,
      onSelectProject: async (selectedWorkspacePath) => {
        await window.electronAPI.invoke('project-selected', {
          filePath: data.filePath,
          workspacePath: selectedWorkspacePath
        });
      },
      onCancel: () => {
        window.electronAPI.invoke('project-selection-cancelled', {
          filePath: data.filePath
        });
      }
    });
  }, [showProjectSelectionDialogRequest]);

  // Listen for agent-new-session IPC event (Cmd+N in agent mode)
  useEffect(() => {
    // console.log('[App] Setting up IPC listener for agent-new-session');
    if (!window.electronAPI?.onAgentNewSession) {
      console.log('[App] electronAPI.onAgentNewSession not available');
      return;
    }

    const handleAgentNewSession = () => {
      console.log('[App] Received agent-new-session event');
      if (agentModeRef.current) {
        agentModeRef.current.createNewSession();
      } else {
        console.warn('[App] agentModeRef not available');
      }
    };

    const cleanup = window.electronAPI.onAgentNewSession(handleAgentNewSession);

    return () => {
      // console.log('[App] Cleaning up agent-new-session listener');
      cleanup();
    };
  }, []);

  // React to "show Discord invitation" command. The IPC subscription lives
  // in store/listeners/appCommandListeners.ts.
  const showDiscordInvitationVersion = useAtomValue(showDiscordInvitationRequestAtom);
  const showDiscordInvitationInitialRef = useRef(showDiscordInvitationVersion);
  useEffect(() => {
    if (showDiscordInvitationVersion === showDiscordInvitationInitialRef.current) return;
    console.log('[App] Received show-discord-invitation event');
    if (!dialogRef.current) return;
    dialogRef.current.open(DIALOG_IDS.DISCORD_INVITATION, {
      onDismiss: () => {
        // No additional action needed - dialog will close automatically
      }
    });
  }, [showDiscordInvitationVersion]);

  // NOTE: Windows Claude Code warning and onboarding IPC listeners moved to useOnboarding hook
  // NOTE: show-commands-toast IPC listener removed - commands now via extension-based plugins

  // React to "show trust toast" command (Developer menu). The IPC subscription
  // lives in store/listeners/appCommandListeners.ts.
  const showTrustToastVersion = useAtomValue(showTrustToastRequestAtom);
  const showTrustToastInitialRef = useRef(showTrustToastVersion);
  useEffect(() => {
    if (showTrustToastVersion === showTrustToastInitialRef.current) return;
    setForceShowTrustToast(true);
  }, [showTrustToastVersion]);

  // React to "show session import dialog" command (Developer menu). The IPC
  // subscription lives in store/listeners/appCommandListeners.ts.
  const showSessionImportDialogVersion = useAtomValue(showSessionImportDialogRequestAtom);
  // Fires once per increment, deferred until a workspace is ready. Consuming the
  // version on fire stops the dialog re-opening on every workspace switch (#480);
  // the previous inline effect never updated its ref and depended on
  // workspacePath, so each folder change re-ran it and re-opened the dialog.
  useDialogRequestTrigger(
    showSessionImportDialogVersion,
    Boolean(workspacePath),
    useCallback(() => {
      if (!workspacePath) return;
      dialogRef.current?.open(DIALOG_IDS.SESSION_IMPORT, { workspacePath });
    }, [workspacePath]),
  );

  // React to "show extension project intro dialog" requests. The IPC
  // subscription lives in store/listeners/appCommandListeners.ts. The
  // request carries a requestId we use to send the response back.
  const showExtensionProjectIntroDialogRequest = useAtomValue(showExtensionProjectIntroDialogRequestAtom);
  useEffect(() => {
    if (!showExtensionProjectIntroDialogRequest) return;
    const { requestId } = showExtensionProjectIntroDialogRequest;
    const channel = `extension-project-intro-dialog-response:${requestId}`;

    if (!dialogRef.current) {
      window.electronAPI?.send?.(channel, { action: 'cancel' });
      return;
    }

    dialogRef.current.open<ExtensionProjectIntroData>(DIALOG_IDS.EXTENSION_PROJECT_INTRO, {
      onContinue: () => {
        window.electronAPI?.send?.(channel, { action: 'continue' });
      },
      onDontShowAgain: () => {
        window.electronAPI?.send?.(channel, { action: 'dont-show-again' });
      },
      onCancel: () => {
        window.electronAPI?.send?.(channel, { action: 'cancel' });
      },
    });
  }, [showExtensionProjectIntroDialogRequest]);

  // NOTE: Commands toast check removed - commands now via extension-based plugins

  // Show Figma MCP migration warning toast.
  // Figma restricts OAuth client registration to approved clients, so mcp-remote gets 403.
  // Users need to reconfigure using the PAT-based template instead.
  const showFigmaMcpMigrationToast = useCallback((force = false) => {
    const show = () => {
      errorNotificationService.showWarning(
        'Figma MCP Server Needs Reconfiguration',
        'Your current Figma MCP configuration will not work in Nimbalyst. Figma does not allow OAuth based MCP in certain apps.\n\nTo fix it, open the MCP settings and do the following:\n\n1. Remove the existing OAuth Figma MCP configuration.\n2. Add a new Figma MCP config from the Nimbalyst MCP template.\n3. Add your Personal Access Token to the MCP config.',
        {
          duration: 0,
          action: {
            label: 'Open MCP Settings',
            onClick: () => {
              store.set(openSettingsCommandAtom, { category: 'mcp-servers', timestamp: Date.now() });
            },
          },
        }
      );
    };

    if (force) {
      show();
      return;
    }

    // On startup, only show if user has a broken Figma OAuth config
    window.electronAPI.invoke('mcp-config:read-user').then((config: any) => {
      const servers = config?.mcpServers || {};
      const hasBrokenFigma = Object.values(servers).some((server: any) => {
        const args: string[] = server.args || [];
        const hasInArgs = args.some((arg: string) => arg.includes('mcp.figma.com'));
        const hasInUrl = typeof server.url === 'string' && server.url.includes('mcp.figma.com');
        return hasInArgs || hasInUrl;
      });
      if (hasBrokenFigma) show();
    }).catch(() => {
      // Silently ignore - not critical
    });
  }, []);

  // Check on startup
  useEffect(() => {
    if (!window.electronAPI?.invoke) return;
    showFigmaMcpMigrationToast();
  }, [showFigmaMcpMigrationToast]);

  // React to "show figma mcp migration" command (Developer menu). The IPC
  // subscription lives in store/listeners/appCommandListeners.ts.
  const showFigmaMcpMigrationVersion = useAtomValue(showFigmaMcpMigrationRequestAtom);
  const showFigmaMcpMigrationInitialRef = useRef(showFigmaMcpMigrationVersion);
  useEffect(() => {
    if (showFigmaMcpMigrationVersion === showFigmaMcpMigrationInitialRef.current) return;
    showFigmaMcpMigrationToast(true);
  }, [showFigmaMcpMigrationVersion, showFigmaMcpMigrationToast]);

  // Update window title to reflect the active workspace.
  // The agent-mode early-return that used to live here was a holdover from
  // when AgenticPanel set the title itself; nothing does that today, and
  // the multi-project rail can switch the active workspace while the user
  // is in agent mode, leaving the title bar stuck on the previous
  // project's name.
  useEffect(() => {
    if (!window.electronAPI) return;

    let title = 'Nimbalyst';
    if (workspaceMode && workspaceName) {
      title = `${workspaceName} - Nimbalyst`;
    }

    window.electronAPI.setTitle(title);
  }, [workspaceMode, workspaceName, activeMode]);

  // Keyboard shortcuts (Cmd+E, Cmd+K, Cmd+Y, bottom panel shortcuts, terminal toggle, Cmd+Alt+W)
  useKeyboardShortcuts({
    activeMode,
    workspaceMode,
    setActiveMode,
    activeModeStateRef,
    editorModeRef,
    agentModeRef,
    toggleAgentCollapsed,
    isFullscreenPanelActive,
    exitFullscreenPanel: () => setActiveExtensionPanel(null),
  });

  // Extension-contributed keybindings (reads from manifests, fires commands via registry)
  useExtensionKeybindings();

  // Listen for extension panel toggle commands (dispatched by ExtensionCommandRegistry)
  useEffect(() => {
    const handleTogglePanel = (e: Event) => {
      const panelId = (e as CustomEvent).detail?.panelId;
      if (typeof panelId === 'string') {
        setActiveExtensionBottomPanel(prev => prev === panelId ? null : panelId);
      }
    };

    window.addEventListener('nimbalyst:toggle-panel', handleTogglePanel);
    return () => window.removeEventListener('nimbalyst:toggle-panel', handleTogglePanel);
  }, []);

  // Listen for terminal:show events (from worktree terminal button)
  useEffect(() => {
    const handleTerminalShow = () => {
      openTerminalPanel();
    };

    window.addEventListener('terminal:show', handleTerminalShow);
    return () => window.removeEventListener('terminal:show', handleTerminalShow);
  }, [openTerminalPanel]);

  // Listen for tracker item navigation events (from TrackerToolWidget in transcript)
  useEffect(() => {
    const handleNavigateTrackerItem = (e: Event) => {
      const itemId = (e as CustomEvent).detail?.itemId;
      if (typeof itemId !== 'string') return;

      // Contextual navigation: in Agent Mode with a workstream selected, open
      // the tracker as a workstream resource tab (statefully attached to the
      // workstream) instead of switching the whole window to Tracker Mode.
      const currentMode = activeModeStateRef.current;
      const selection = workspacePath
        ? store.get(selectedWorkstreamAtom(workspacePath))
        : null;
      if (currentMode === 'agent' && selection?.id) {
        const workstreamId = selection.id;
        const layout = store.get(workstreamStateAtom(workstreamId)).layoutMode;
        if (layout === 'transcript') {
          // Editor strip not mounted: seed openResources so the mount-time
          // restore projects the tracker tab, then reveal the strip.
          store.set(addWorkstreamTrackerAtom, { workstreamId, trackerItemId: itemId });
          store.set(setWorkstreamLayoutModeAtom, { workstreamId, mode: 'split' });
        } else {
          // Already mounted: open imperatively. TabsContext is authoritative
          // once mounted; the persist effect mirrors the change to openResources.
          window.dispatchEvent(
            new CustomEvent('nimbalyst:workstream-open-tracker', {
              detail: { workstreamId, trackerItemId: itemId },
            })
          );
        }
        return;
      }

      // Default: switch to Tracker Mode and select the item.
      setActiveMode('tracker');
      store.set(trackerModeLayoutAtom, (current) => ({
        ...current,
        selectedItemId: itemId,
      }));
    };

    window.addEventListener('nimbalyst:navigate-tracker-item', handleNavigateTrackerItem);
    return () => window.removeEventListener('nimbalyst:navigate-tracker-item', handleNavigateTrackerItem);
  }, [setActiveMode, workspacePath]);

  // Listen for PR navigation events (from tracker detail / session panels) —
  // the PR-view leg of the PR ↔ tracker ↔ session navigation triangle.
  useEffect(() => {
    const handleNavigatePr = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail?.remote === 'string' && typeof detail?.prNumber === 'number') {
        setActiveMode('pr-review');
        store.set(prNavigateRequestAtom, {
          remote: detail.remote,
          prNumber: detail.prNumber,
          version: detail.version ?? Date.now(),
        });
      }
    };

    window.addEventListener('nimbalyst:navigate-pr', handleNavigatePr);
    return () => window.removeEventListener('nimbalyst:navigate-pr', handleNavigatePr);
  }, [setActiveMode]);

  // Host hook for converting a legacy inline tracker embed into a real tracked
  // item. The runtime TrackerPlugin (platform-agnostic) calls this to create
  // the canonical item, then replaces the inline node with a reference chip.
  // Mirrors the quick-add creation path in TrackerMainView.
  useEffect(() => {
    if (!workspacePath) {
      delete (window as any).__nimbalystCreateTrackerItem;
      return;
    }
    (window as any).__nimbalystCreateTrackerItem = async (item: {
      type: string;
      title: string;
      status?: string;
      priority?: string;
      description?: string;
      owner?: string;
      tags?: string[];
    }): Promise<{ id: string; issueKey?: string } | null> => {
      try {
        const prefix = (item.type || 'itm').substring(0, 3);
        const id = `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
        const result = await window.electronAPI.documentService.createTrackerItem({
          id,
          type: item.type,
          title: item.title || `New ${item.type}`,
          status: item.status || 'to-do',
          priority: item.priority || 'medium',
          description: item.description,
          owner: item.owner,
          tags: item.tags,
          workspace: workspacePath,
        });
        if (!result.success || !result.item) return null;
        return { id: result.item.id ?? id, issueKey: result.item.issueKey };
      } catch (error) {
        console.error('[App] Convert inline tracker -> create failed:', error);
        return null;
      }
    };
    return () => {
      delete (window as any).__nimbalystCreateTrackerItem;
    };
  }, [workspacePath]);

  // Listen for open-ai-session events (from rebase/merge conflict resolution)
  useEffect(() => {
    const handleOpenAiSession = async (event: CustomEvent<{ sessionId: string; workspacePath: string; draftInput?: string }>) => {
      const { sessionId, workspacePath: eventWorkspacePath, draftInput } = event.detail;

      // Set the draft input BEFORE navigating so it's ready when the session mounts
      // This is the canonical pattern for creating sessions with initial prompts
      if (draftInput) {
        store.set(setSessionDraftInputAtom, {
          sessionId,
          draftInput,
          workspacePath: eventWorkspacePath,
          persist: true,
        });
      }

      // Switch to agent mode if needed
      if (activeMode !== 'agent') {
        setActiveMode('agent');
      }

      // Open the session using the AgentMode ref
      if (agentModeRef.current) {
        await agentModeRef.current.openSessionInTab(sessionId);
      }
    };

    window.addEventListener('open-ai-session', handleOpenAiSession as unknown as EventListener);
    return () => window.removeEventListener('open-ai-session', handleOpenAiSession as unknown as EventListener);
  }, [activeMode]);

  // Save AI Chat state when it changes (but only after initial load)
  useEffect(() => {
    if (!workspacePath || !workspaceMode || !isAIChatStateLoaded) return;
    if (!window.electronAPI?.invoke) return;

    const saveAIChatState = async () => {
      try {
        const aiPanelState = {
          collapsed: isAIChatCollapsed,
          width: aiChatWidth,
          currentSessionId: currentAISessionId || undefined,
          planningModeEnabled: aiPlanningModeEnabled,
        };
        if (LOG_CONFIG.AI_CHAT_STATE) console.log('[AI_CHAT] Saving AI Chat state:', aiPanelState);
        await window.electronAPI.invoke('workspace:update-state', workspacePath, {
          aiPanel: aiPanelState
        });
      } catch (error) {
        console.error('[AI_CHAT] Failed to save AI Chat state:', error);
      }
    };

    saveAIChatState();
  }, [isAIChatCollapsed, aiChatWidth, currentAISessionId, aiPlanningModeEnabled, isAIChatStateLoaded, workspacePath, workspaceMode]);

  // Handle QuickOpen file selection - delegates to EditorMode and switches mode if needed
  const handleQuickOpenFileSelect = useCallback(async (filePath: string) => {
    // Switch to files mode if we're in a different mode
    if (activeMode !== 'files') {
      setActiveMode('files');
    }

    // Delegate to EditorMode's file selection handler
    if (editorModeRef.current) {
      await editorModeRef.current.selectFile(filePath);
    }
  }, [activeMode]);

  // Handle QuickOpen folder selection - switches to files mode so the file tree is visible
  const handleQuickOpenFolderSelect = useCallback(() => {
    if (activeMode !== 'files') {
      setActiveMode('files');
    }
  }, [activeMode]);

  // Handle SessionQuickOpen session selection - switches to agent mode and opens session
  const handleSessionQuickOpenSelect = useCallback(async (sessionId: string) => {
    // Switch to agent mode
    if (activeMode !== 'agent') {
      setActiveMode('agent');
    }

    // Open session in AgentMode (kanban exit is handled globally by
    // onWorkstreamSelectedCallbackAtom in setSelectedWorkstreamAtom)
    if (agentModeRef.current) {
      await agentModeRef.current.openSessionInTab(sessionId);
    }
  }, [activeMode]);

  // Handle PromptQuickOpen session selection - opens session and scrolls to the selected prompt
  const handlePromptQuickOpenSelect = useCallback(async (sessionId: string, messageTimestamp?: number) => {
    // Switch to agent mode
    if (activeMode !== 'agent') {
      setActiveMode('agent');
    }

    // Set scroll target before opening the session so the transcript picks it up once loaded
    if (messageTimestamp) {
      store.set(scrollToMessageAtom, { sessionId, timestamp: messageTimestamp });
    }

    // Open session in AgentMode
    if (agentModeRef.current) {
      await agentModeRef.current.openSessionInTab(sessionId);
    }
  }, [activeMode]);

  // NOTE: handleCreateNewFile and handleRestoreFromHistory moved to EditorMode

  // NOTE: File path sync with backend is now handled imperatively by EditorMode
  // when the active tab changes. See EditorMode's subscription to tabsActions.

  // NOTE: EditorContainer now handles all autosave functionality with per-editor timers
  // Old autosave useEffects removed - see EditorContainer.tsx lines 218-281

  // NOTE: Periodic snapshot functionality moved to EditorContainer

  // NOTE: EditorContainer handles all content loading for tabs
  // This useEffect is no longer needed - removed to avoid conflicts

  // Load initial state on mount
  useEffect(() => {
    const loadInitialState = async () => {
      try {
        // Load window initial state
        if (window.electronAPI?.getInitialState) {
          const initialState = await window.electronAPI.getInitialState();
          if (initialState && initialState.mode === 'workspace') {
            // Set workspace state immediately
            setWorkspaceMode(true);
            setWorkspacePath(initialState.workspacePath ?? null);
            setWorkspaceName(initialState.workspaceName ?? null);
            // NOTE: fileTree loading moved to EditorMode

            // Initialize window mode from workspace state (await to prevent flash of wrong mode)
            if (initialState.workspacePath) {
              await initWindowMode(initialState.workspacePath);
              // Initialize unified navigation history
              await initNavigationHistory(initialState.workspacePath);

              // Seed the multi-project rail: this window's primary
              // workspace is always represented in the rail (visible only
              // when multiProjectMode is on, hidden otherwise).
              addOpenProject({
                path: initialState.workspacePath,
                name: initialState.workspaceName ?? initialState.workspacePath,
                openedAt: Date.now(),
              });
            }
          }
        }
      } catch (error) {
        console.error('[INIT] Failed to load initial state:', error);
      } finally {
        setIsInitializing(false);
      }
    };

    loadInitialState();
  }, [addOpenProject]);

  // Multi-project rail switch: when the rail's active path changes, mirror
  // it into the legacy `workspacePath` useState so the rest of the App
  // tree re-renders for the new project. Only fires when the user
  // explicitly clicks a different project — initial load is handled above.
  useEffect(() => {
    if (!isMultiProjectMode) return;
    if (!railActivePath) return;
    if (railActivePath === workspacePath) return;

    setWorkspacePath(railActivePath);
    setWorkspaceName(railActivePath.split(/[\\/]/).filter(Boolean).pop() ?? railActivePath);

    // `activeSessionIdAtom` is cleared automatically on every flip of
    // `activeWorkspacePathAtom` by the subscriber attached in
    // `initOpenProjects` (`attachWorkspaceSwitchCleanup`). AgentMode's
    // mount effect repopulates the global from the new workspace's
    // `selectedWorkstreamAtom` if it has a selection.

    // Re-init navigation history for the newly visible project.
    initNavigationHistory(railActivePath).catch((err) => {
      console.error('[INIT] Failed to init navigation history on rail switch:', err);
    });
    initWindowMode(railActivePath).catch((err) => {
      console.error('[INIT] Failed to init window mode on rail switch:', err);
    });
    // Pre-warm the agent layout family and session registry for the new
    // path so AgentMode's mount effect isn't the only initializer. Both
    // helpers are idempotent — running them again from AgentMode is safe.
    initAgentModeLayout(railActivePath).catch((err) => {
      console.error('[INIT] Failed to init agent layout on rail switch:', err);
    });
    initSessionList(railActivePath).catch((err) => {
      console.error('[INIT] Failed to init session list on rail switch:', err);
    });
  }, [isMultiProjectMode, railActivePath, workspacePath]);


  // Mode-aware tab navigation handlers
  const handleNextTab = () => {
    if (activeMode === 'agent') {
      agentModeRef.current?.nextTab?.();
    } else {
      editorModeRef.current?.tabs?.nextTab?.();
    }
  };

  const handlePreviousTab = () => {
    if (activeMode === 'agent') {
      agentModeRef.current?.previousTab?.();
    } else {
      editorModeRef.current?.tabs?.previousTab?.();
    }
  };

  // Set up IPC listeners
  // IPC handlers hook - sets up all IPC communication with main process
  useIPCHandlers({
    // Handlers
    handleNew,
    handleOpen,
    handleSave: async () => {
      // Delegate to TabEditor's manual save via TabContent
      if (handleSaveRef.current) {
        await handleSaveRef.current();
      }
    },
    handleSaveAs,
    handleWorkspaceFileSelect,
    openWelcomeTab,
    openFeedback: handleOpenFeedback,
    handleNextTab,
    handlePreviousTab,

    // State
    activeMode,

    // State setters
    setIsApiKeyDialogOpen: () => {}, // Unused - ApiKeyDialog now managed by DialogProvider
    setWorkspaceMode,
    setWorkspacePath,
    setWorkspaceName,
    setIsAIChatCollapsed,
    setAIChatWidth,
    setIsAIChatStateLoaded,
    setSessionToLoad,
    setIsKeyboardShortcutsDialogOpen: () => {}, // Unused - KeyboardShortcutsDialog now managed by DialogProvider
    setAIPlanningMode: setAIPlanningModeEnabled,
    setTheme,

    // Refs
    isInitializedRef,
    getContentRef,
    searchCommandRef,
    editorModeRef,
    collabModeRef,
    currentFilePathRef,
    currentFileNameRef,

    // State values
    workspaceMode,
    workspacePath,
    sessionToLoad,

    // Config
    LOG_CONFIG,
  });

  // Handle AI tool createDocument requests
  useEffect(() => {
    const handleCreateDocument = async (event: CustomEvent) => {
      const { correlationId, filePath, initialContent, switchToFile } = event.detail;
      console.log('[AI Tool] createDocument request received:', { correlationId, filePath, switchToFile });

      try {
        if (!window.electronAPI) {
          throw new Error('Electron API not available');
        }

        // Create the document via IPC
        console.log('[AI Tool] Invoking IPC create-document with:', filePath);
        const result = await window.electronAPI.invoke('create-document', filePath, initialContent);
        console.log('[AI Tool] IPC result:', result);

        if (result.success) {
          // Switch to the new file if requested
          if (switchToFile && result.filePath) {
            console.log('[AI Tool] Switching to new file:', result.filePath);
            await handleWorkspaceFileSelect(result.filePath);
          }

          // Send success response
          console.log('[AI Tool] Sending success response');
          window.dispatchEvent(new CustomEvent('aiToolResponse:createDocument', {
            detail: {
              correlationId,
              success: true,
              filePath: result.filePath
            }
          }));
        } else {
          throw new Error(result.error || 'Failed to create document');
        }
      } catch (error) {
        console.error('[AI Tool] Error creating document:', error);
        // Send error response
        window.dispatchEvent(new CustomEvent('aiToolResponse:createDocument', {
          detail: {
            correlationId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }));
      }
    };

    window.addEventListener('aiToolRequest:createDocument', handleCreateDocument as unknown as EventListener);

    return () => {
      window.removeEventListener('aiToolRequest:createDocument', handleCreateDocument as unknown as EventListener);
    };
  }, [handleWorkspaceFileSelect]);

  logger.ui.info('Rendering App with config:', {
    currentFilePath: currentFilePathRef.current,
    currentFileName: currentFileNameRef.current,
    theme
  });

  logger.ui.info('About to render NimbalystEditor');

  // Debug: expose values for testing (in useEffect to run after state updates)
  // NOTE: These are set imperatively and may not update on every render
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__tabPreferencesEnabled__ = true;
      (window as any).__currentFilePath__ = currentFilePathRef.current;
      (window as any).__currentFileName__ = currentFileNameRef.current;
      (window as any).__workspaceMode__ = workspaceMode;
    }
  }, [workspaceMode]); // Only re-run when workspaceMode changes

  // React to "confirm close (unsaved)" command. The IPC subscription lives
  // in store/listeners/appCommandListeners.ts.
  const confirmCloseUnsavedVersion = useAtomValue(confirmCloseUnsavedRequestAtom);
  const confirmCloseUnsavedInitialRef = useRef(confirmCloseUnsavedVersion);
  useEffect(() => {
    if (confirmCloseUnsavedVersion === confirmCloseUnsavedInitialRef.current) return;
    if (!window.electronAPI) return;

    const handleConfirmClose = async () => {
      console.log('[WINDOW CLOSE] Has unsaved changes');
      const activeFilePath = currentFilePathRef.current;
      const activeCollabStatus = activeFilePath && isCollabUri(activeFilePath)
        ? store.get(collabConnectionStatusAtom(activeFilePath))
        : null;
      const activeCollabUnsynced = !!activeCollabStatus && hasCollabUnsyncedChanges(activeCollabStatus);

      if (activeCollabUnsynced) {
        const confirmed = await confirmDialog.confirm({
          title: 'Unsynced Collaborative Changes',
          message: activeCollabStatus === 'replaying'
            ? 'This collaborative document is still replaying local changes to the server. Closing now may delay recovery until you reopen it.'
            : 'This collaborative document has local changes that have not been confirmed by the server yet. Closing now will keep them queued locally, but they will not sync until you reopen the document and reconnect.',
          confirmLabel: 'Close Anyway',
          cancelLabel: 'Keep Editing',
          destructive: true
        });

        if (confirmed) {
          window.electronAPI?.send?.('close-window-discard');
        }
        return;
      }

      const confirmed = await confirmDialog.confirm({
        title: 'Unsaved Changes',
        message: 'Do you want to save the changes you made? Your changes will be lost if you don\'t save them.',
        confirmLabel: 'Save',
        cancelLabel: 'Don\'t Save',
        destructive: false
      });

      if (confirmed) {
        // Save
        if (handleSaveRef.current) {
          await handleSaveRef.current();
        }
        window.electronAPI?.send?.('close-window-save');
      } else {
        // Discard
        window.electronAPI?.send?.('close-window-discard');
      }
    };

    void handleConfirmClose();
  }, [confirmCloseUnsavedVersion, confirmDialog]);

  // React to close-active-tab from the menu. IPC subscription lives in
  // store/listeners/appCommandListeners.ts.
  // Guard against duplicate IPC calls (React StrictMode can cause double-mounting).
  const closeTabInProgressRef = useRef(false);
  const closeActiveTabVersion = useAtomValue(closeActiveTabRequestAtom);
  const closeActiveTabInitialRef = useRef(closeActiveTabVersion);
  useEffect(() => {
    if (closeActiveTabVersion === closeActiveTabInitialRef.current) return;
    if (closeTabInProgressRef.current) {
      console.log('[App] handleCloseActiveTab: ignoring duplicate call');
      return;
    }
    closeTabInProgressRef.current = true;
    setTimeout(() => { closeTabInProgressRef.current = false; }, 100);

    console.log('[App] handleCloseActiveTab IPC received, activeMode:', activeModeStateRef.current);
    if (activeModeStateRef.current === 'agent') {
      console.log('[App] Routing to agentModeRef.closeActiveTab()');
      agentModeRef.current?.closeActiveTab();
    } else if (activeModeStateRef.current === 'files') {
      console.log('[App] Routing to editorModeRef.closeActiveTab()');
      editorModeRef.current?.closeActiveTab();
    } else if (activeModeStateRef.current === 'collab') {
      console.log('[App] Routing to collabModeRef.closeActiveTab()');
      collabModeRef.current?.closeActiveTab();
    }
  }, [closeActiveTabVersion]);

  // React to reopen-last-closed-tab from the menu.
  const reopenLastClosedTabVersion = useAtomValue(reopenLastClosedTabRequestAtom);
  const reopenLastClosedTabInitialRef = useRef(reopenLastClosedTabVersion);
  useEffect(() => {
    if (reopenLastClosedTabVersion === reopenLastClosedTabInitialRef.current) return;
    if (activeModeStateRef.current === 'agent') {
      agentModeRef.current?.reopenLastClosedSession?.();
    } else if (activeModeStateRef.current === 'files') {
      editorModeRef.current?.reopenLastClosedTab?.();
    } else if (activeModeStateRef.current === 'collab') {
      collabModeRef.current?.reopenLastClosedTab?.();
    }
  }, [reopenLastClosedTabVersion]);

  // view-history IPC fires when the user picks Edit > View Local History (Cmd+Y).
  // On macOS, the menu accelerator preempts the renderer keydown event, so the
  // IPC path is the canonical one. Open the global history dialog for whichever
  // file is currently active (FilesMode or AgentMode -- both modes maintain
  // window.__currentDocumentPath as the active file).
  const setHistoryDialogFile = useSetAtom(historyDialogFileAtom);
  useEffect(() => {
    if (!window.electronAPI?.onViewHistory) return undefined;
    return window.electronAPI.onViewHistory(() => {
      const activeFilePath = (window as unknown as { __currentDocumentPath?: string | null }).__currentDocumentPath;
      if (activeFilePath) {
        setHistoryDialogFile(activeFilePath);
      }
    });
  }, [setHistoryDialogFile]);

  // Intercept external link clicks and open in default browser
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      // Find if we clicked on a link or inside a link
      let target = event.target as HTMLElement | null;
      while (target && target !== document.body) {
        if (target.tagName === 'A') {
          const anchor = target as HTMLAnchorElement;
          const href = anchor.getAttribute('href');

          // Check if it's an external link (http:// or https://)
          if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
            event.preventDefault();
            event.stopPropagation();

            // Open in default browser
            window.electronAPI.openExternal(href).catch((error) => {
              logger.ui.error('Failed to open external link:', error);
            });
            return;
          }

          // In-document anchor link: scroll to the matching id inside the
          // active editor scroll container, NOT the whole document. Multiple
          // files can be open; we want the heading inside the same editor.
          if (href && href.startsWith('#') && href.length > 1) {
            let targetId: string;
            try {
              targetId = decodeURIComponent(href.slice(1));
            } catch {
              targetId = href.slice(1);
            }
            const scrollContainer = anchor.closest('.editor-scroller');
            const scope: ParentNode = scrollContainer ?? document;
            const escapedId =
              typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                ? CSS.escape(targetId)
                : targetId.replace(/([\]"\\().:;'#[])/g, '\\$1');
            const targetElement = scope.querySelector(`#${escapedId}`);
            if (targetElement) {
              event.preventDefault();
              event.stopPropagation();
              targetElement.scrollIntoView({ block: 'start', behavior: 'smooth' });
              return;
            }
          }
          break;
        }
        target = target.parentElement;
      }
    };

    document.addEventListener('click', handleClick, true);

    return () => {
      document.removeEventListener('click', handleClick, true);
    };
  }, []);

  // Show nothing while initializing - let HTML/CSS background show through
  // Wait for both initial state and extensions to be ready before rendering editors
  // This ensures extension nodes (like DataModelNode) are published into the runtime extension stores
  if (isInitializing || !extensionsReady) {
    return <div className="h-screen" />;
  }

  return (
    <DialogProvider workspacePath={workspacePath || undefined}>
    {/* Navigation dialog keyboard shortcuts - must be inside DialogProvider */}
    <NavigationDialogKeyboardHandler
      workspaceMode={workspaceMode}
      workspacePath={workspacePath}
      currentFilePath={currentFilePathRef.current}
      onFileSelect={handleQuickOpenFileSelect}
      onFolderSelect={handleQuickOpenFolderSelect}
      onSessionSelect={handleSessionQuickOpenSelect}
      onPromptSelect={handlePromptQuickOpenSelect}
      documentContext={{
        content: getContentRef.current ? getContentRef.current() : '',
        filePath: currentFilePathRef.current || undefined
      }}
    />
    <WalkthroughProvider currentMode={activeMode}>
    <TipProvider currentMode={activeMode} workspacePath={workspacePath || undefined}>
    <div data-layout="root-container" className="h-screen flex flex-row">
      {/* Far-left: project rail (Discord-style) — visible only when
          multi-project mode is enabled in settings. */}
      <ProjectRail />
      {/* Left: Navigation Gutter - full height */}
      <NavigationGutter
        contentMode={activeMode}
        onContentModeChange={setActiveMode}
        onOpenHistory={() => {
          // Switch to agent mode instead of opening old session manager
          setActiveMode('agent');
        }}
        onToggleTerminalPanel={() => {
          toggleTerminalPanel();
          if (!terminalPanelVisible) {
            setActiveExtensionBottomPanel(null); // Close extension bottom panel when opening terminal
          }
        }}
        terminalPanelVisible={terminalPanelVisible}
        workspacePath={workspacePath}
        onOpenSettings={() => {
          setActiveMode('settings');
        }}
        onNavigateSettings={(scope, category) => {
          if (category) setSettingsInitialCategory(category);
          setSettingsInitialScope(scope);
          incrementSettingsKey();
          setTimeout(() => setActiveMode('settings'), 0);
        }}
        onOpenPermissions={() => {
          // Deep link to agent permissions settings
          setSettingsInitialCategory('agent-permissions');
          setSettingsInitialScope('project');
          incrementSettingsKey(); // Force SettingsView remount
          setTimeout(() => setActiveMode('settings'), 0);
        }}
        onOpenFeedback={handleOpenFeedback}
        onChangeTrustMode={() => {
          // Show the trust toast so user can pick a new mode
          setForceShowTrustToast(true);
        }}
        activeExtensionPanel={activeExtensionPanel}
        onExtensionPanelChange={setActiveExtensionPanel}
        activeExtensionBottomPanel={activeExtensionBottomPanel}
        onExtensionBottomPanelChange={(panelId) => {
          setActiveExtensionBottomPanel(panelId);
          if (panelId) {
            // Close other bottom panels for mutual exclusivity
            closeTerminalPanel();
          }
        }}
        onToggleFilesCollapsed={() => {
          editorModeRef.current?.toggleSidebarCollapsed();
        }}
        onToggleAgentCollapsed={() => {
          toggleAgentCollapsed();
        }}
        onToggleCollabCollapsed={() => {
          collabModeRef.current?.toggleSidebarCollapsed();
        }}
      />

      {/* Right: Main content area + Bottom Panel */}
      <div data-layout="main-column-container" className="flex-1 flex flex-col overflow-hidden">
        {/* Top: Main content (sidebar + editor/agent + AI chat) */}
        <div data-layout="top-content-row" className="flex-1 flex flex-row min-h-0">
          {/* Center: Editor/Agent/Settings area */}
          <div data-layout="center-content-wrapper" className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Files Mode - always mounted, visibility controlled by display */}
            <div
              data-layout="files-mode-wrapper"
              className={`flex-1 flex-row overflow-hidden min-h-0 ${
                activeMode === 'files' && !isFullscreenPanelActive ? 'flex' : 'hidden'
              }`}
            >
              {/* Extension Sidebar Panel (when active) */}
              {activeExtensionPanel && (() => {
                const panel = getPanelById(activeExtensionPanel);
                if (panel && panel.placement === 'sidebar' && workspacePath) {
                  return (
                    <div
                      data-layout="extension-panel-sidebar"
                      className="w-[280px] min-w-[200px] max-w-[400px] flex flex-col border-r border-nim overflow-hidden"
                    >
                      <PanelContainer
                        panel={panel}
                        workspacePath={workspacePath}
                        onOpenFile={handleWorkspaceFileSelect}
                        onOpenPanel={(panelId) => setActiveExtensionPanel(panelId)}
                        onClose={() => setActiveExtensionPanel(null)}
                      />
                    </div>
                  );
                }
                return null;
              })()}

              {/* Main content (file tree + editor) */}
              {workspacePath ? (
                <TabsProvider
                  workspacePath={workspacePath}
                >
                  <EditorMode
                    ref={editorModeRef}
                    workspacePath={workspacePath}
                    workspaceName={workspaceName}
                    theme={theme}
                    isActive={activeMode === 'files'}
                    onModeChange={setActiveMode as (mode: string) => void}
                    onGetContentReady={(getContentFn) => {
                      getContentRef.current = getContentFn;
                    }}
                    onCloseWorkspace={handleCloseWorkspace}
                    onOpenQuickSearch={() => {
                      if (dialogRef.current && workspacePath) {
                        dialogRef.current.open(DIALOG_IDS.UNIFIED_QUICK_OPEN, {
                          workspacePath,
                          currentFilePath: currentFilePathRef.current,
                          initialTab: 'files',
                          onFileSelect: handleQuickOpenFileSelect,
                          onFolderSelect: handleQuickOpenFolderSelect,
                          onSessionSelect: handleSessionQuickOpenSelect,
                          onPromptSelect: handlePromptQuickOpenSelect,
                        });
                      }
                    }}
                    onSwitchToAgentMode={handleSwitchToAgentMode}
                  />
                </TabsProvider>
              ) : (
                <WorkspaceWelcome workspaceName="Open a workspace to get started" />
              )}
            </div>

            {/* Agent Mode - always mounted, visibility controlled by display */}
            <div
              data-layout="agent-mode-wrapper"
              className={`flex-1 flex-col overflow-hidden min-h-0 ${
                activeMode === 'agent' && !isFullscreenPanelActive ? 'flex' : 'hidden'
              }`}
            >
              {workspacePath ? (
                <AgentMode
                  ref={agentModeRef}
                  workspacePath={workspacePath}
                  workspaceName={workspaceName || ''}
                  isActive={activeMode === 'agent'}
                  onFileOpen={handleWorkspaceFileSelect}
                  onOpenQuickSearch={() => {
                    if (dialogRef.current && workspacePath) {
                      dialogRef.current.open(DIALOG_IDS.UNIFIED_QUICK_OPEN, {
                        workspacePath,
                        currentFilePath: currentFilePathRef.current,
                        initialTab: 'sessions',
                        onFileSelect: handleQuickOpenFileSelect,
                        onFolderSelect: handleQuickOpenFolderSelect,
                        onSessionSelect: handleSessionQuickOpenSelect,
                        onPromptSelect: handlePromptQuickOpenSelect,
                      });
                    }
                  }}
                  onSwitchToAgentMode={handleSwitchToAgentMode}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-nim-muted">
                  <div className="text-center">
                    <p>Agent mode requires a workspace</p>
                    <p className="mt-2 text-sm">Open a workspace to use agent features</p>
                  </div>
                </div>
              )}
            </div>

            {/* Tracker Mode - always mounted, visibility controlled by display */}
            <div
              data-layout="tracker-mode-wrapper"
              className={`flex-1 flex-col overflow-hidden min-h-0 ${
                activeMode === 'tracker' && !isFullscreenPanelActive ? 'flex' : 'hidden'
              }`}
            >
              {workspacePath && (
                <TrackerMode
                  workspacePath={workspacePath}
                  workspaceName={workspaceName || ''}
                  isActive={activeMode === 'tracker'}
                  onSwitchToFilesMode={() => setActiveMode('files')}
                />
              )}
            </div>

            {/* PR Review Mode - always mounted, visibility controlled by display */}
            <div
              data-layout="pr-review-mode-wrapper"
              className={`flex-1 flex-col overflow-hidden min-h-0 ${
                activeMode === 'pr-review' && developerMode && !isFullscreenPanelActive
                  ? 'flex'
                  : 'hidden'
              }`}
            >
              {workspacePath && developerMode && (
                <PullRequestMode
                  workspacePath={workspacePath}
                  workspaceName={workspaceName || ''}
                  isActive={activeMode === 'pr-review'}
                  onSwitchToFilesMode={() => setActiveMode('files')}
                />
              )}
            </div>

            {/* Collab Mode - always mounted, visibility controlled by display */}
            <div
              data-layout="collab-mode-wrapper"
              className={`flex-1 flex-col overflow-hidden min-h-0 ${
                activeMode === 'collab' && !isFullscreenPanelActive ? 'flex' : 'hidden'
              }`}
            >
              {workspacePath && (
                <CollabMode
                  ref={collabModeRef}
                  workspacePath={workspacePath}
                  isActive={activeMode === 'collab'}
                  onFileOpen={handleWorkspaceFileSelect}
                />
              )}
            </div>

            {/* Extension Fullscreen Panel Mode */}
            {activeExtensionPanel && (() => {
              const panel = getPanelById(activeExtensionPanel);
              if (panel && panel.placement === 'fullscreen' && workspacePath) {
                return (
                  <div
                    data-layout="extension-panel-fullscreen"
                    className="flex-1 flex flex-row overflow-hidden min-h-0"
                  >
                    {/* Extension panel content */}
                    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                      <PanelContainer
                        panel={panel}
                        workspacePath={workspacePath}
                        onOpenFile={handleWorkspaceFileSelect}
                        onOpenPanel={(panelId) => setActiveExtensionPanel(panelId)}
                        onClose={() => setActiveExtensionPanel(null)}
                      />
                    </div>
                    {/* AI Chat Panel (for aiSupported panels) */}
                    {panel.aiSupported && (
                      <div
                        data-layout="extension-ai-chat"
                        className="w-[400px] min-w-[320px] max-w-[600px] flex flex-col border-l border-nim overflow-hidden"
                      >
                        <ChatSidebar
                          ref={chatSidebarRef}
                          workspacePath={workspacePath}
                          documentContext={extensionPanelDocumentContext}
                          onFileOpen={handleWorkspaceFileSelect}
                        />
                      </div>
                    )}
                  </div>
                );
              }
              return null;
            })()}

            {/* Settings Mode - conditionally rendered for now */}
            {activeMode === 'settings' && !isFullscreenPanelActive && (
              <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                <SettingsView
                  key={settingsKey}
                  workspacePath={workspacePath}
                  workspaceName={workspaceName}
                  initialCategory={settingsInitialCategory}
                  initialScope={settingsInitialScope}
                  marketplaceInstallRequest={marketplaceInstallRequest}
                  onMarketplaceInstallRequestHandled={clearMarketplaceInstallRequest}
                  onClose={() => {
                    setActiveMode('files');
                    // Clear initial settings state so next open uses defaults
                    clearSettingsNavigation();
                  }}
                />
              </div>
            )}
          </div>
        </div>

        {/* Bottom: Terminal Bottom Panel - spans width after nav gutter */}
        {workspacePath && (
          <TerminalBottomPanel
            workspacePath={workspacePath}
          />
        )}

        {/* Bottom: Extension Bottom Panel - spans width after nav gutter */}
        {activeExtensionBottomPanel && workspacePath && (() => {
          const panel = getPanelById(activeExtensionBottomPanel);
          if (panel && panel.placement === 'bottom') {
            return (
              <div
                className="bottom-panel-container overflow-hidden"
              >
                <PanelContainer
                  panel={panel}
                  workspacePath={workspacePath}
                  onOpenFile={handleWorkspaceFileSelect}
                  onOpenPanel={(panelId) => setActiveExtensionPanel(panelId)}
                  onClose={() => setActiveExtensionBottomPanel(null)}
                />
              </div>
            );
          }
          return null;
        })()}
      </div>

      {/* Navigation dialogs (QuickOpen, SessionQuickOpen, PromptQuickOpen, ProjectQuickOpen) */}
      {/* are now managed by DialogProvider and rendered automatically */}

      {/* KeyboardShortcutsDialog, ApiKeyDialog, ProjectSelectionDialog, ErrorDialog are now managed by DialogProvider */}
      <GlobalHistoryDialog theme={theme === 'auto' ? 'dark' : theme} workspacePath={workspacePath || undefined} />
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.options.title}
        message={confirmDialog.options.message}
        confirmLabel={confirmDialog.options.confirmLabel}
        cancelLabel={confirmDialog.options.cancelLabel}
        destructive={confirmDialog.options.destructive}
        onConfirm={confirmDialog.handleConfirm}
        onCancel={confirmDialog.handleCancel}
      />
      {/* DiscordInvitation is now managed by DialogProvider */}
      {/* WindowsClaudeCodeWarning is now managed by DialogProvider via useOnboarding hook */}
      {/* UnifiedOnboarding is now managed by DialogProvider via useOnboarding hook */}
      {/* ClaudeCommandsToast removed - commands now via extension-based plugins */}
      <ErrorToastContainer />
      <MockupPickerMenuHost />
      <ExtensionHostComponents />
      <ExtensionPermissionPrompt />
      <UpdateToast />
      <ProjectTrustToast
        workspacePath={workspacePath}
        onOpenSettings={() => {
          setSettingsInitialCategory('agent-permissions');
          setSettingsInitialScope('project');
          incrementSettingsKey();
          setTimeout(() => setActiveMode('settings'), 0);
        }}
        forceShow={forceShowTrustToast}
        onDismiss={() => setForceShowTrustToast(false)}
      />
      {/* FeedbackIntakeDialog is now managed by DialogProvider */}
    </div>
    </TipProvider>
    </WalkthroughProvider>
    </DialogProvider>
  );
}
