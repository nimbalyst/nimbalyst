/**
 * Jotai Store Exports
 *
 * Central export point for all Jotai atoms and utilities.
 * Re-exports shared atoms from @nimbalyst/runtime/store,
 * plus Electron-specific atoms (sessions, file tree, project state, trackers).
 *
 * @example
 * import { store, themeAtom, makeEditorKey } from '@/store';
 */

// ============================================================
// Re-export shared atoms from runtime
// These are used by extensions and are platform-agnostic
// ============================================================

// Store instance
export { store, getStore } from '@nimbalyst/runtime/store';

// EditorKey utilities
export {
  type EditorKey,
  type EditorContext,
  makeEditorKey,
  makeEditorContext,
  parseEditorKey,
  getFilePathFromKey,
  isWorktreeKey,
  isMainKey,
  getKeysForFilePath,
} from '@nimbalyst/runtime/store';

// Theme atoms
export {
  themeIdAtom,
  themeAtom,
  isDarkThemeAtom,
  themeColorsAtom,
  setThemeAtom,
  getThemeById,
  registerCustomTheme,
  type ThemeId,
  type Theme,
  type ThemeColors,
} from '@nimbalyst/runtime/store';

// Editor atoms
export {
  editorDirtyAtom,
  editorProcessingAtom,
  editorHasUnacceptedChangesAtom,
  tabIdsAtom,
  activeTabIdAtom,
  tabMetadataAtom,
  dirtyEditorCountAtom,
  hasAnyPendingReviewAtom,
  addTabAtom,
  closeTabAtom,
  reorderTabsAtom,
  type TabMetadata,
} from '@nimbalyst/runtime/store';

// ============================================================
// Electron-specific atoms
// These depend on IPC, file watchers, or other Electron features
// ============================================================

// Session atoms (Electron IPC)
export {
  sessionListAtom,
  activeSessionIdAtom,
  sessionProcessingAtom,
  sessionUnreadAtom,
  sessionLastActivityAtom,
  sessionPendingPromptAtom,
  sessionWakeupAtom,
  sessionHasPendingInteractivePromptAtom,
  agentSessionAttentionAtom,
  agentBubbleStateAtom,
  type AgentBubbleColor,
  type AgentSessionAttentionGroups,
  // Durable interactive prompts (DB-derived) - used for pending indicator
  sessionPendingPromptsAtom,
  refreshPendingPromptsAtom,
  respondToPromptAtom,
  sessionPromptAdditionsAtom,
  sessionLastReadAtom,
  sessionDraftInputAtom,
  sessionDraftHydratedAtom,
  setSessionDraftInputAtom,
  sessionDraftAttachmentsAtom,
  sessionHistoryIndexAtom,
  sessionTempInputAtom,
  navigateSessionHistoryAtom,
  resetSessionHistoryAtom,
  totalUnreadCountAtom,
  anySessionProcessingAtom,
  anyPendingInteractivePromptAtom,
  markSessionReadAtom,
  setActiveSessionAtom,
  // Session list loading
  sessionListLoadingAtom,
  sessionListWorkspaceAtom,
  sessionListRootAtom,
  sessionListChatAtom,
  showArchivedSessionsAtom,
  refreshSessionListAtom,
  initSessionList,
  addSessionFullAtom,
  updateSessionFullAtom,
  removeSessionFullAtom,
  // New registry-based atoms
  sessionRegistryAtom,
  sessionListFromRegistryAtom,
  sessionListRootFromRegistryAtom,
  // Per-session data (AISessionView owns its own data)
  sessionStoreAtom,
  sessionDataAtom, // deprecated alias
  updateSessionStoreAtom, // Unified update atom
  sessionLoadedAtom,
  sessionMessagesAtom,
  sessionTokenUsageAtom,
  sessionUpdatedAtAtom,
  sessionStatusAtom,
  sessionCurrentTeammatesAtom,
  sessionCurrentTodosAtom,
  sessionWorktreePathAtom,
  sessionDocumentContextAtom,
  sessionEffortLevelRawAtom,
  sessionThinkingModeRawAtom,
  sessionLoadingAtom,
  sessionModeAtom,
  sessionModelAtom,
  sessionArchivedAtom,
  sessionActiveAtom,
  sessionTitleAtom,
  sessionProviderAtom,
  sessionAgentRoleAtom,
  sessionPhaseAtom,
  sessionParentIdDerivedAtom,
  sessionWorktreeIdAtom,
  openSessionsAtom,
  loadSessionDataAtom,
  updateSessionDataAtom, // deprecated - use updateSessionStoreAtom
  reloadSessionDataAtom,
  cleanupSessionAtom,
  // Hierarchical session atoms (workstreams)
  sessionChildrenAtom,
  sessionActiveChildAtom,
  sessionHasChildrenAtom,
  sessionOrChildProcessingAtom,
  groupSessionStatusAtom,
  sessionParentIdAtom,
  loadSessionChildrenAtom,
  setActiveChildSessionAtom,
  createChildSessionAtom,
  // Workstream atoms (AgentMode rewrite)
  selectedWorkstreamAtom,
  setSelectedWorkstreamAtom,
  registerWorkstreamSelectedHook,
  workstreamSessionsAtom,
  setActiveSessionInWorkstreamAtom, // Wrapper that also marks as read
  workstreamProcessingAtom,
  workstreamTagsAtom,
  workstreamUnreadAtom,
  workstreamPendingPromptAtom,
  workstreamPendingInteractivePromptAtom,
  workstreamTitleAtom,
  type SessionInfo,
  type SessionMeta,
  type OpenSession,
  type WorkstreamType,
  reparentSessionAtom,
} from './atoms/sessions';

// AIInput undo/redo history (per-session)
export {
  aiInputHistoryAtom,
  clearAIInputHistoryAtom,
  type AIInputSnapshot,
  type AIInputHistory,
} from './atoms/aiInputUndo';

// Session share state
export {
  sessionSharesMapAtom,
  sharesFetchedAtom,
  shareKeysAtom,
  sessionShareAtom,
  fetchSessionSharesAtom,
  addSessionShareAtom,
  removeSessionShareAtom,
  buildShareUrl,
  type ShareInfo,
} from './atoms/sessionShares';

// File tree atoms (Electron file watcher)
export {
  fileTreeAtom,
  rawFileTreeAtom,
  fileTreeLoadedAtom,
  gitStatusMapAtom,
  fileGitStatusAtom,
  expandedDirsAtom,
  isDirExpandedAtom,
  selectedFilePathAtom,
  selectedFolderPathAtom,
  revealRequestAtom,
  activeFilePathAtom,
  fileTreeFilterAtom,
  directoryGitStatusAtom,
  modifiedFileCountAtom,
  updateGitStatusAtom,
  toggleDirExpandedAtom,
  revealFileAtom,
  revealFolderAtom,
  openFileRequestAtom,
  // Flat virtualized file tree atoms
  flatTreeActiveFileAtom,
  fileTreeItemsAtom,
  selectedPathsAtom,
  lastSelectedPathAtom,
  focusedIndexAtom,
  dragStateAtom,
  visibleNodesAtom,
  type RevealRequest,
  type GitStatusCode,
  type FileGitStatus,
  type FileTreeItem,
  type RendererFileTreeItem,
  type DragState,
  type FlatTreeNode,
} from './atoms/fileTree';

// History dialog atom (global file-history dialog state)
export { historyDialogFileAtom } from './atoms/historyDialog';

// Tracker atoms (Electron-specific)
export {
  trackerCountsAtom,
  trackerCountAtom,
  trackerItemsAtom,
  selectedTrackerItemAtom,
  trackerFilterAtom,
  filteredTrackerItemsAtom,
  totalOpenItemsAtom,
  criticalItemsCountAtom,
  updateTrackerCountsAtom,
  updateTrackerItemsAtom,
  setTrackerFilterAtom,
  clearTrackerFilterAtom,
  type TrackerType,
  type TrackerStatus,
  type TrackerItem,
  type TrackerFilter,
} from './atoms/trackers';

// Agent mode atoms (session history layout)
export {
  agentModeLayoutAtom,
  sessionHistoryWidthAtom,
  sessionHistoryCollapsedAtom,
  filesEditedWidthAtom,
  collapsedGroupsAtom,
  sortOrderAtom,
  viewModeAtom,
  todoPanelCollapsedAtom,
  setAgentModeLayoutAtom,
  setSessionHistoryWidthAtom,
  setFilesEditedWidthAtom,
  toggleCollapsedGroupAtom,
  setCollapsedGroupsAtom,
  setSortOrderAtom,
  setViewModeAtom,
  toggleTodoPanelCollapsedAtom,
  initAgentModeLayout,
  type AgentModeLayout,
} from './atoms/agentMode';

// Project state atoms
export {
  projectStateAtom,
  type ProjectState,
  type PanelLayout,
  type FileTreeState,
  type ContextTabState,
  type PersistedTabInfo,
} from './atoms/projectState';

// Window mode atoms (files, agent, settings)
export {
  windowModeAtom,
  setWindowModeAtom,
  initWindowMode,
  resetWindowMode,
} from './atoms/windowMode';

// Settings navigation atoms (deep linking to settings panels)
export {
  settingsNavigationAtom,
  settingsInitialCategoryAtom,
  settingsInitialScopeAtom,
  settingsKeyAtom,
  settingsDestinationAtom,
  navigateToSettingsAtom,
  clearSettingsNavigationAtom,
  setSettingsInitialCategoryAtom,
  setSettingsInitialScopeAtom,
  setSettingsDestinationAtom,
  navigateSettingsInPlaceAtom,
  incrementSettingsKeyAtom,
  openSettingsCommandAtom,
  type SettingsScope,
  type SettingsNavigationState,
} from './atoms/settingsNavigation';

// Session editor atoms (per-session embedded editor tabs)
export {
  sessionEditorStateAtom,
  sessionTabKeysAtom,
  sessionActiveTabKeyAtom,
  sessionLayoutModeAtom,
  sessionSplitRatioAtom,
  sessionFilesSidebarVisibleAtom,
  sessionEditorVisibleAtom,
  sessionHasTabsAtom,
  sessionTabCountAtom,
  setSessionTabCountAtom,
  openFileInSessionEditorAtom,
  setSessionLayoutModeAtom,
  setSessionSplitRatioAtom,
  toggleSessionEditorAtom,
  toggleSessionFilesSidebarAtom,
  persistSessionTabs,
  initSessionEditors,
  loadSessionEditorState,
  cleanupSessionEditorState,
  type SessionLayoutMode,
  type SessionEditorState,
} from './atoms/sessionEditors';

// Unified workstream state (replaces fragmented atoms from sessions.ts)
export {
  type WorkstreamState,
  type WorkstreamLayoutMode,
  workstreamStateAtom,
  workstreamTypeAtom,
  workstreamActiveChildAtom,
  workstreamChildrenAtom,
  workstreamLayoutModeAtom,
  workstreamSplitRatioAtom,
  workstreamFilesSidebarVisibleAtom,
  workstreamOpenFilesAtom,
  workstreamActiveFileAtom,
  workstreamOpenResourcesAtom,
  workstreamActiveResourceAtom,
  workstreamWorktreeIdAtom,
  workstreamWorktreePathAtom,
  workstreamHasChildrenAtom,
  workstreamHasOpenFilesAtom,
  workstreamHasOpenResourcesAtom,
  worktreeActiveSessionAtom,
  setWorktreeActiveSessionAtom,
  setWorkstreamActiveChildAtom,
  setWorkstreamLayoutModeAtom,
  setWorkstreamSplitRatioAtom,
  toggleWorkstreamFilesSidebarAtom,
  addWorkstreamFileAtom,
  addWorkstreamTrackerAtom,
  openWorkstreamResourceAtom,
  closeWorkstreamFileAtom,
  closeWorkstreamResourceAtom,
  setWorkstreamActiveResourceAtom,
  setWorkstreamFileResourcesAtom,
  setWorkstreamResourcesAtom,
  setWorkstreamTrackerFocusAtom,
  workstreamTrackerFocusAtom,
  addWorkstreamChildAtom,
  type WorkstreamResource,
  type PersistedWorkstreamTab,
  trackerResourceId,
  isTrackerResourceId,
  fileResource,
  trackerResource,
  convertToWorkstreamAtom,
  cleanupWorkstreamAtom,
  initWorkstreamState,
  loadWorkstreamStates,
  loadWorkstreamState,
  persistWorkstreamState,
  workstreamStatesLoadedAtom,
} from './atoms/workstreamState';

// File mention atoms (for @ file mentions in AIInput)
export {
  fileMentionOptionsAtom,
  documentsLoadingAtom,
  searchFileMentionAtom,
  selectFileMentionAtom,
  clearFileMentionSearchAtom,
  type FileMentionReference,
} from './atoms/fileMention';

// Session mention atoms (for @@ session mentions in AIInput)
export {
  sessionMentionOptionsAtom,
  searchSessionMentionAtom,
} from './atoms/sessionMention';

// Unified navigation history (cross-mode back/forward)
export {
  pushNavigationEntryAtom,
  goBackAtom,
  goForwardAtom,
  canGoBackAtom,
  canGoForwardAtom,
  isRestoringNavigationAtom,
  currentNavigationEntryAtom,
  registerNavigationRestoreCallbacks,
  initNavigationHistory,
  clearNavigationHistory,
  type NavigationEntry,
  type FilesNavigationState,
  type AgentNavigationState,
  type SettingsHistoryState,
} from './atoms/navigationHistory';

// Session transcript atoms (centralized state for SessionTranscript)
// Note: ExitPlanMode uses inline widget, no atom needed
export {
  sessionErrorAtom,
  sessionQueuedPromptsAtom,
  type QueuedPrompt,
} from './atoms/sessionTranscript';

// Session transcript listeners (centralized IPC handlers)
export {
  initSessionTranscriptListeners,
  loadInitialQueuedPrompts,
  clearSessionError,
} from './listeners/sessionTranscriptListeners';

// File tree listeners (centralized IPC handlers)
export {
  initFileTreeListeners,
  refreshFileTree,
} from './listeners/fileTreeListeners';

// Session files atoms (file edits, git status, worktree changes)
export {
  sessionFileEditsAtom,
  sessionGitStatusAtom,
  sessionPendingReviewFilesAtom,
  workspaceUncommittedFilesAtom,
  worktreeChangedFilesAtom,
  worktreeGitStatusAtom,
  workstreamFileEditsAtom,
  workstreamGitStatusAtom,
  workstreamPendingReviewFilesAtom,
  clearSessionFileStateAtom,
  type FileEditWithSession,
  type WorktreeChangedFile,
  type WorktreeGitStatus,
} from './atoms/sessionFiles';

// Voice mode atoms (transcript capture, token usage)
export {
  pendingVoiceCommandAtom,
  voiceActiveSessionIdAtom,
  voiceTranscriptEntriesAtom,
  voiceCurrentUserTextAtom,
  voiceTokenUsageAtom,
  voiceSessionStartTimeAtom,
  voiceWorkspacePathAtom,
  voiceDbSessionIdAtom,
  voiceLastReportedFileAtom,
  type PendingVoiceCommand,
  type VoiceTranscriptEntry,
  type VoiceTokenUsage,
} from './atoms/voiceModeState';

// Voice mode listeners (centralized IPC handlers)
export {
  initVoiceModeListeners,
  setVoiceActiveSession,
  clearVoiceActiveSession,
  persistAndClearVoiceSession,
} from './listeners/voiceModeListeners';
