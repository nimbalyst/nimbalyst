interface FileTreeItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeItem[];
}

interface ClaudeForWindowsInstallation {
  isPlatformWindows: boolean;
  gitVersion?: string;
  claudeCodeVersion?: string;
}

interface HistoryTag {
  id: string;
  filePath: string;
  content: string;
  sessionId: string;
  toolUseId: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

interface ArchiveTask {
  worktreeId: string;
  worktreeName: string;
  status: 'queued' | 'pending' | 'removing-worktree' | 'completed' | 'failed';
  startTime: Date;
  error?: string;
}

interface GhCliStatus {
  installed: boolean;
  version?: string;
  authed: boolean;
  host?: string;
  user?: string;
}

interface PullRequestReviewer {
  login: string;
  state: string;
}

interface PullRequestRow {
  id: string;
  workspaceId: string;
  remote: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  mergeable: 'mergeable' | 'conflicting' | 'unknown' | null;
  commentsCount: number;
  reviewCommentsCount: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  ciStatus: 'success' | 'failure' | 'pending' | null;
  reviewers: PullRequestReviewer[];
  labels: string[];
  raw: unknown;
  etag: string | null;
  createdAt: number;
  updatedAt: number;
  fetchedAt: number;
}

interface PullRequestFileRow {
  prId: string;
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch: string | null;
  previousPath: string | null;
  fetchedAt: number;
}

interface PullRequestCommitRow {
  prId: string;
  sha: string;
  message: string;
  authorLogin: string | null;
  authoredAt: number;
  additions: number;
  deletions: number;
}

interface PullRequestCheckRow {
  prId: string;
  checkName: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null;
  detailsUrl: string | null;
  startedAt: number | null;
  completedAt: number | null;
  fetchedAt: number;
}

interface PullRequestTimelineEntry {
  id: string;
  type: 'issue_comment' | 'review' | 'review_comment';
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  body: string;
  state?: string;
  createdAt: number;
  url: string | null;
}

interface PullRequestListFilters {
  state?: 'open' | 'closed' | 'all';
  awaitingMyReview?: boolean;
  createdByMe?: boolean;
  withConflicts?: boolean;
  search?: string;
}

interface SemanticSearchResult {
  refType: string;
  refId: string;
  sourceClass: string;
  sourcePath: string;
  title: string;
  snippet: string;
  score: number;
  signals: { dense: boolean; sparse: boolean };
}

interface ElectronAPI {
  team: {
    getKeyCustodyStatus: (orgId: string) => Promise<{ success: boolean; mode?: 'legacy-e2e' | 'server-managed'; error?: string }>;
    getEncryptionMigrationStatus?: (orgId: string) => Promise<{
      success: boolean;
      migration?:
        | { status: 'migrating'; startedAt: string; documentsCompleted?: number; documentsTotal?: number; phase?: 'custody' | 'titles' | 'documents' | 'verifying' }
        | { status: 'complete'; finishedAt: string }
        | { status: 'stuck'; failedAt: string; message: string; retryAt?: string }
        | null;
    }>;
    retryEncryptionMigration?: (orgId: string) => Promise<{
      success: boolean;
      migration?: unknown;
      error?: string;
    }>;
    [method: string]: any;
  };
  organization: {
    list: () => Promise<any>;
    get: (orgId: string) => Promise<any>;
    create: (input: { name: string; workspacePath?: string; sourcePersonalOrgId?: string }) => Promise<any>;
    acceptInvitation: (orgId: string) => Promise<any>;
    listMembers: (orgId: string) => Promise<any>;
    inviteMember: (orgId: string, email: string) => Promise<any>;
    removeMember: (orgId: string, memberId: string) => Promise<any>;
    updateMemberRole: (orgId: string, memberId: string, role: string) => Promise<any>;
    listProjects: (orgId: string) => Promise<any>;
    addProject: (input: { orgId: string; workspacePath?: string; name?: string }) => Promise<any>;
    moveProject: (input: { sourceOrgId: string; projectId: string; destinationOrgId: string; dropMemberEmails?: string[] }) => Promise<any>;
    deleteOrganization: (orgId: string) => Promise<any>;
    getEncryptionStatus: (orgId: string) => Promise<any>;
    getEncryptionMigrationStatus: (orgId: string) => Promise<any>;
  };
  // Global semantic search (nimbalyst-memory). Empty/false when memory is off.
  semanticSearch: {
    isAvailable: (workspacePath: string) => Promise<boolean>;
    query: (
      workspacePath: string,
      query: string,
      k?: number,
      sourceClasses?: string[],
    ) => Promise<SemanticSearchResult[]>;
  };

  // File menu callbacks
  onFileNew: (callback: () => void) => () => void;
  onFileNewInWorkspace: (callback: () => void) => () => void;
  onAgentNewSession: (callback: () => void) => () => void;
  onFileOpen: (callback: () => void) => () => void;
  onFileSave: (callback: () => void) => () => void;
  onFileSaveAs: (callback: () => void) => () => void;
  onNewUntitledDocument: (callback: (data: { untitledName: string }) => void) => () => void;

  // Workspace callbacks
  onWorkspaceOpened: (callback: (data: { workspacePath: string; workspaceName: string; fileTree: FileTreeItem[] }) => void) => () => void;
  onOpenWorkspaceFile: (callback: (filePath: string) => void) => () => void;
  onOpenDocument: (callback: (data: { path: string }) => void) => () => void;
  onOpenWorkspaceFromCLI: (callback: (workspacePath: string) => void) => () => void;
  onWorkspaceFileTreeUpdated: (callback: (data: { fileTree: FileTreeItem[]; addedPath?: string; removedPath?: string }) => void) => () => void;

  // File event callbacks
  onFileDeleted: (callback: (data: { filePath: string }) => void) => () => void;
  onFileRenamed: (callback: (data: { oldPath: string; newPath: string }) => void) => () => void;
  onFileMoved: (callback: (data: { sourcePath: string; destinationPath: string }) => void) => () => void;
  onFileCopied: (callback: (data: { sourcePath: string; destinationPath: string }) => void) => () => void;
  onFileChangedOnDisk: (callback: (data: { path: string }) => void) => () => void;

  // UI callbacks
  onToggleSearch: (callback: () => void) => () => void;
  onToggleSearchReplace: (callback: () => void) => () => void;
  onOpenWelcomeTab: (callback: () => void) => () => void;
  onOpenPlansTab: (callback: () => void) => () => void;
  onOpenKeyboardShortcuts: (callback: () => void) => () => void;
  onOpenFeedback: (callback: () => void) => () => void;
  onThemeChange: (callback: (theme: string) => void) => () => void;
  setTitleBarOverlayColors: (colors: { color: string; symbolColor: string }) => void;
  onMcpConfigChanged: (callback: (data: { scope: 'user' | 'workspace'; workspacePath?: string }) => void) => () => void;

  // Offscreen editor IPC
  onOffscreenEditorMount: (callback: (payload: { filePath: string; workspacePath: string }) => void) => () => void;
  onOffscreenEditorUnmount: (callback: (payload: { filePath: string }) => void) => () => void;
  onOffscreenEditorCaptureScreenshotRequest: (callback: (payload: { filePath: string; selector?: string; responseChannel: string }) => void) => () => void;

  onShowAbout: (callback: () => void) => () => void;
  onViewHistory: (callback: () => void) => () => void;
  onViewWorkspaceHistory: (callback: () => void) => () => void;
  onShowPreferences?: (callback: () => void) => () => void;
  onApproveAction: (callback: () => void) => () => void;
  onRejectAction: (callback: () => void) => () => void;
  onCopyAsMarkdown: (callback: () => void) => () => void;

  // Tab callbacks
  onNextTab: (callback: () => void) => () => void;
  onPreviousTab: (callback: () => void) => () => void;

  // Session callbacks
  onLoadSessionFromManager: (callback: (data: { sessionId: string; workspacePath?: string }) => void) => () => void;

  // Theme operations
  getTheme: () => Promise<string>;
  getThemeSync: () => string;
  getResolvedThemeSync: () => string;
  getAppVersion: () => Promise<string>;
  setTheme: (theme: string) => Promise<void>;

  // File operations
  openFile: () => Promise<{ filePath: string; content: string } | null>;
  openFileDialog: (options?: {
    title?: string;
    buttonLabel?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    defaultPath?: string;
  }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  saveFile: (content: string, filePath: string, lastKnownContent?: string) => Promise<{ success: boolean; filePath: string; conflict?: boolean; diskContent?: string } | null>;
  saveFileAs: (content: string) => Promise<{ success: boolean; filePath: string } | null>;
  showErrorDialog: (title: string, message: string) => Promise<void>;
  showSaveDialogPdf: (options: { defaultPath?: string }) => Promise<string | null>;
  exportHtmlToPdf: (options: {
    html: string;
    outputPath: string;
    pageSize?: 'A4' | 'Letter' | 'Legal';
    landscape?: boolean;
    generateDocumentOutline?: boolean;
    generateTaggedPDF?: boolean;
    margins?: { top?: number; bottom?: number; left?: number; right?: number };
  }) => Promise<{ success: boolean; error?: string }>;
  exportSessionToHtml: (options: { sessionId: string }) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  exportSessionToClipboard: (options: { sessionId: string }) => Promise<{ success: boolean; error?: string }>;

  // Share operations
  shareSessionAsLink: (options: { sessionId: string; expirationDays?: number; personalOrgId?: string }) => Promise<{ success: boolean; url?: string; shareId?: string; isUpdate?: boolean; encryptionKey?: string; owningPersonalOrgId?: string; error?: string }>;
  getShareAccountOptions: (options: { contentType: 'session' | 'file'; sessionId?: string; filePath?: string }) => Promise<{ success: boolean; accounts?: Array<{ personalOrgId: string; email: string; isSyncAccount: boolean; sessionStatus: 'active' | 'expired' }>; defaultPersonalOrgId?: string; defaultSource?: 'workspace-binding' | 'sync-account' | 'only-account'; error?: string }>;
  listShares: () => Promise<{ success: boolean; shares?: Array<{ shareId: string; sessionId: string; title: string; sizeBytes: number; createdAt: string; expiresAt: string | null; viewCount: number; owningPersonalOrgId: string }>; error?: string }>;
  deleteShare: (options: { shareId: string; sessionId?: string; owningPersonalOrgId?: string }) => Promise<{ success: boolean; error?: string }>;
  getShareKeys: () => Promise<Record<string, string>>;
  shareFileAsLink: (options: { filePath: string; expirationDays?: number; personalOrgId?: string }) => Promise<{ success: boolean; url?: string; shareId?: string; isUpdate?: boolean; encryptionKey?: string; owningPersonalOrgId?: string; error?: string }>;
  getShareExpirationPreference: () => Promise<number>;
  setShareExpirationPreference: (days: number) => Promise<void>;

  setDocumentEdited: (edited: boolean) => void;
  setTitle: (title: string) => void;
  sendToMainWindow?: (channel: string, data: unknown) => Promise<void>;
  reportUserActivity?: () => void;

  // Get initial window state
  getInitialState: () => Promise<{
    mode: string;
    workspacePath?: string;
    workspaceName?: string;
    activeWorkspacePath?: string | null;
    openProjectPaths?: string[];
  } | null>;

  // Workspace operations
  getFolderContents: (dirPath: string) => Promise<FileTreeItem[]>;
  refreshFolderContents: (folderPath: string) => Promise<FileTreeItem[]>;
  createFile: (filePath: string, content: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  createFolder: (folderPath: string) => Promise<{ success: boolean; error?: string }>;
  switchWorkspaceFile: (filePath: string) => Promise<{ filePath: string; content: string } | { error: string } | null>;
  readFileContent: (filePath: string, options?: { binary?: boolean }) => Promise<
    | { success: true; content: string; isBinary: true }
    | { success: true; content: string; isBinary: false; detectedEncoding?: BufferEncoding }
    | { success: false; error: string }
    | null
  >;

  // File context menu operations
  renameFile: (oldPath: string, newName: string) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  deleteFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  openInDefaultApp: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  openInExternalEditor: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  openSessionManager: (filterWorkspace?: string) => Promise<void>;
  showInFinder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  moveFile: (sourcePath: string, targetPath: string) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  copyFile: (sourcePath: string, targetPath: string) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  getPathForFile: (file: File) => string;
  copyToClipboard: (text: string) => Promise<{ success: boolean }>;
  copyImageToClipboard: (payload: { filePath?: string; dataUrl?: string }) => Promise<{ success: boolean; error?: string }>;
  readClipboard: () => Promise<{ success: boolean; text?: string }>;

  // Settings operations
  getSidebarWidth: (workspacePath: string) => Promise<number>;
  setSidebarWidth: (workspacePath: string, width: number) => void;

  // QuickOpen operations
  buildQuickOpenCache: (workspacePath: string) => Promise<{ success: boolean; fileCount?: number; error?: string }>;
  searchWorkspaceFiles: (workspacePath: string, query: string) => Promise<any[]>;
  searchWorkspaceFileNames: (workspacePath: string, query: string, options?: { fileMask?: string | null }) => Promise<any[]>;
  searchWorkspaceFileContent: (workspacePath: string, query: string) => Promise<any[]>;
  getRecentWorkspaceFiles: (workspacePath?: string) => Promise<string[]>;
  addToWorkspaceRecentFiles: (filePath: string) => void;

  // History operations
  history: {
    createSnapshot: (filePath: string, state: string, type: string, description?: string) => Promise<void>;
    listSnapshots: (filePath: string) => Promise<any[]>;
    loadSnapshot: (filePath: string, timestamp: string) => Promise<string>;
    deleteSnapshot: (filePath: string, timestamp: string) => Promise<void>;
    getPendingTags: (filePath?: string) => Promise<HistoryTag[]>;
    createTag: (workspacePath: string, filePath: string, tagId: string, content: string, sessionId: string, toolUseId: string) => Promise<void>;
    getTag: (filePath: string, tagId: string) => Promise<HistoryTag | null>;
    updateTagStatus: (filePath: string, tagId: string, status: string, workspacePath?: string) => Promise<void>;
    updateTagContent: (filePath: string, tagId: string, content: string) => Promise<void>;
    getPendingCount: (workspacePath: string) => Promise<number>;
    getPendingCountForSession: (workspacePath: string, sessionId: string) => Promise<number>;
    getPendingFilesForSession: (workspacePath: string, sessionId: string) => Promise<string[]>;
    clearAllPending: (workspacePath: string) => Promise<void>;
    clearPendingForSession: (workspacePath: string, sessionId: string) => Promise<void>;
    onPendingCountChanged: (callback: (data: { workspacePath: string; count: number }) => void) => () => void;
    onPendingCleared: (callback: (data: { workspacePath: string; sessionId?: string; clearedFiles: string[] }) => void) => () => void;
  };

  // Session operations
  session: {
    create: (filePath: string, type: string, source?: any) => Promise<any>;
    load: (sessionId: string) => Promise<any>;
    save: (session: any) => Promise<void>;
    delete: (sessionId: string) => Promise<void>;
    getActive: (filePath: string) => Promise<any>;
    setActive: (filePath: string, sessionId: string, type: string) => Promise<void>;
    checkConflicts: (session: any, currentMarkdownHash: string) => Promise<any>;
    resolveConflict: (session: any, resolution: string, newBaseHash?: string) => Promise<void>;
    createCheckpoint: (sessionId: string, state: string) => Promise<void>;
  };

  // Session state tracking operations
  sessionState: {
    getTrackedSessionIds: () => Promise<{ success: boolean; sessionIds: string[]; error?: string }>;
    getRunningSessionIds: () => Promise<{ success: boolean; sessionIds: string[]; error?: string }>;
    getSessionState: (sessionId: string) => Promise<any>;
    isSessionActive: (sessionId: string) => Promise<boolean>;
    subscribe: (workspacePath?: string | string[]) => Promise<void>;
    unsubscribe: () => Promise<void>;
    startSession: (sessionId: string, workspacePath?: string) => Promise<void>;
    updateActivity: (sessionId: string, status?: string, isStreaming?: boolean) => Promise<void>;
    endSession: (sessionId: string) => Promise<void>;
    interruptSession: (sessionId: string) => Promise<void>;
    onStateChange: (callback: (event: any) => void) => void;
    removeStateChangeListener: (callback: (event: any) => void) => void;
  };

  // AI operations (flat methods)
  aiHasApiKey: () => Promise<boolean>;
  aiInitialize: (provider?: string, apiKey?: string) => Promise<any>;
  aiCreateSession: (provider: 'claude' | 'claude-code' | 'claude-code-cli' | 'openai' | 'openai-codex' | 'opencode' | 'copilot-cli' | 'lmstudio', documentContext?: any, workspacePath?: string, modelId?: string, sessionType?: string, worktreeId?: string) => Promise<any>;
  aiSendMessage: (message: string, documentContext?: any, sessionId?: string, workspacePath?: string) => Promise<any>;
  aiGetSessions: (workspacePath?: string) => Promise<any>;
  aiLoadSession: (sessionId: string, workspacePath?: string, trackAsResume?: boolean) => Promise<any>;
  aiClearSession: () => Promise<any>;
  aiUpdateSessionMessages: (sessionId: string, messages: any[], workspacePath?: string) => Promise<{ success: boolean; error?: string }>;
  aiSaveDraftInput: (sessionId: string, draftInput: string, workspacePath?: string) => Promise<{ success: boolean; error?: string }>;
  aiDeleteSession: (sessionId: string, workspacePath?: string) => Promise<{ success: boolean }>;
  aiCancelRequest: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
  aiApplyEdit: (edit: any) => Promise<any>;

  // Flat-key settings -- single read-everything snapshot, single per-key write,
  // single per-key broadcast. See shared/settings/keys.ts for the registry.
  settingsGetAll: () => Promise<Record<string, unknown>>;
  settingsSet: (key: string, value: unknown) => Promise<{ ok: true }>;
  settingsDelete: (key: string) => Promise<{ ok: true }>;
  onSettingsChanged: (callback: (payload: { key: string; value: unknown }) => void) => () => void;
  onAppSettingsChanged: (callback: (payload: { key: string; value: unknown }) => void) => () => void;

  getAISettings: () => Promise<any>;
  saveAISettings: (settings: any) => Promise<void>;
  testAIConnection: (provider: 'claude' | 'claude-code' | 'openai' | 'lmstudio') => Promise<any>;
  getAIModels: () => Promise<{ success: boolean; models: any[]; grouped: Record<string, any[]> }>;
  aiGetSettings: () => Promise<any>;
  aiSaveSettings: (settings: any) => Promise<void>;
  aiTestConnection: (provider: string, workspacePath?: string) => Promise<any>;
  aiGetModels: () => Promise<{ success: boolean; models: any[]; grouped: Record<string, any[]> }>;
  aiGetAllModels: () => Promise<any>;
  aiClearModelCache: () => Promise<void>;
  aiRefreshSessionProvider: (sessionId: string) => Promise<void>;

  // AI event listeners
  onAIStreamResponse: (callback: (data: any) => void) => () => void;
  onAIError: (callback: (error: any) => void) => () => void;
  onAIApplyDiff: (callback: (data: { replacements: any[], resultChannel: string, targetFilePath?: string }) => void) => () => void;
  onAIStreamEditStart: (callback: (config: any) => void) => () => void;
  onAIStreamEditContent: (callback: (data: any) => void) => () => void;
  onAIStreamEditEnd: (callback: (data: any) => void) => () => void;
  onAIPerformanceMetrics: (callback: (data: any) => void) => () => void;
  onAIGetDocumentContent: (callback: (data: { filePath?: string, resultChannel: string }) => void) => () => void;
  onAIUpdateFrontmatter: (callback: (data: { filePath?: string, updates: Record<string, any>, resultChannel: string }) => void) => () => void;
  onAICreateDocument: (callback: (data: { filePath: string; initialContent?: string; switchToFile?: boolean; resultChannel: string }) => void) => () => void;
  onAIEditRequest: (callback: (edit: any) => void) => () => void;

  // AI result senders
  sendAIApplyDiffResult: (resultChannel: string, result: any) => void;
  sendAIGetDocumentContentResult: (resultChannel: string, result: any) => void;
  sendAIUpdateFrontmatterResult: (resultChannel: string, result: any) => void;
  sendAICreateDocumentResult: (resultChannel: string, result: any) => void;

  // CLI management
  cliCheckInstallation: (tool: string) => Promise<{ installed: boolean; version?: string; path?: string }>;
  cliInstall: (tool: string, options?: any) => Promise<{ success: boolean; error?: string }>;
  cliUninstall: (tool: string) => Promise<{ success: boolean; error?: string }>;
  cliUpgrade: (tool: string) => Promise<{ success: boolean; error?: string }>;
  cliCheckNpmAvailable: () => Promise<{ available: boolean; version?: string }>;
  cliInstallNodeJs: () => Promise<{ success: boolean; error?: string }>;
  cliCheckClaudeCodeWindowsInstallation: () => Promise<ClaudeForWindowsInstallation>;

  // MCP Server operations
  onMcpApplyDiff: (callback: (data: { replacements: any[], resultChannel: string, targetFilePath?: string }) => void) => () => void;
  onMcpStreamContent: (callback: (data: { streamId: string, content: string, position: string, insertAfter?: string, mode?: string, targetFilePath?: string, resultChannel: string }) => void) => () => void;
  onMcpNavigateTo: (callback: (data: { line: number, column: number }) => void) => () => void;
  onMcpReadCollabDoc: (callback: (data: { targetFilePath: string, resultChannel: string }) => void) => () => void;
  sendMcpApplyDiffResult: (resultChannel: string, result: any) => void;
  sendMcpStreamContentResult: (resultChannel: string, result: any) => void;
  sendMcpReadCollabDocResult: (resultChannel: string, result: { success: boolean; content?: string; error?: string }) => void;
  onMcpCreateSharedDoc: (callback: (data: { title: string, documentType?: string, parentFolderId?: string | null, folderPath?: string, initialContent?: string, resultChannel: string }) => void) => () => void;
  onMcpCreateSharedFolder: (callback: (data: { name: string, parentFolderId?: string | null, folderPath?: string, resultChannel: string }) => void) => () => void;
  onMcpMoveSharedItem: (callback: (data: { itemId: string, kind: 'doc' | 'folder', newParentFolderId?: string | null, folderPath?: string, resultChannel: string }) => void) => () => void;
  onMcpRenameSharedItem: (callback: (data: { itemId: string, kind: 'doc' | 'folder', newName: string, resultChannel: string }) => void) => () => void;
  onMcpDeleteSharedItem: (callback: (data: { itemId: string, kind: 'doc' | 'folder', resultChannel: string }) => void) => () => void;
  sendMcpCollabIndexResult: (resultChannel: string, result: { success: boolean; error?: string; [key: string]: unknown }) => void;
  updateMcpDocumentState: (state: any) => void;
  clearMcpDocumentState: () => Promise<void>;

  // Git commit proposal IPC removed - now uses unified messages:respond-to-prompt channel

  // Extension tool registration for MCP
  registerExtensionTools: (workspacePath: string, tools: any[]) => void;
  onExecuteExtensionTool: (callback: (data: { toolName: string; args: any; resultChannel: string; context: any }) => void) => () => void;
  sendExtensionToolResult: (resultChannel: string, result: any) => void;

  // AI object wrapper
  ai: {
    hasApiKey: () => Promise<boolean>;
    initialize: (provider?: string, apiKey?: string) => Promise<any>;
    createSession: (provider: 'claude' | 'claude-code' | 'claude-code-cli' | 'openai' | 'openai-codex' | 'lmstudio', documentContext?: any, workspacePath?: string, modelId?: string, sessionType?: string, worktreeId?: string) => Promise<any>;
    sendMessage: (message: string, documentContext?: any, sessionId?: string, workspacePath?: string) => Promise<any>;
    getSessions: (workspacePath?: string) => Promise<any>;
    getSessionList: (workspacePath?: string) => Promise<any>;
    loadSession: (sessionId: string, workspacePath?: string, trackAsResume?: boolean) => Promise<any>;
    clearSession: () => Promise<any>;
    updateSessionMessages: (sessionId: string, messages: any[], workspacePath?: string) => Promise<{ success: boolean; error?: string }>;
    saveDraftInput: (sessionId: string, draftInput: string, workspacePath?: string) => Promise<{ success: boolean; error?: string }>;
    deleteSession: (sessionId: string, workspacePath?: string) => Promise<{ success: boolean }>;
    getSettings: () => Promise<any>;
    saveSettings: (settings: any) => Promise<void>;
    testConnection: (provider: string) => Promise<any>;
    getModels: () => Promise<{ success: boolean; models: any[]; grouped: Record<string, any[]> }>;
    getAllSessions: () => Promise<any>;
    openSessionInWindow: (sessionId: string, workspacePath?: string) => Promise<void>;
    exportSession: (session: any) => Promise<any>;
    // Full-text search index management
    getFtsIndexStatus: (workspaceId: string) => Promise<{ indexExists: boolean; messageCount: number; error?: string }>;
    buildFtsIndex: () => Promise<{ success: boolean; error?: string }>;
    // Canonical transcript queries
    listUserPrompts: (workspacePath: string, limit?: number) => Promise<{ success: boolean; prompts: any[] }>;
    // Transcript peek (lazy-loaded tail messages for preview)
    getTailMessages: (sessionId: string, count?: number) => Promise<any[]>;
  };

  // Workspace Manager operations
  workspaceManager: {
    getRecentWorkspaces: () => Promise<any[]>;
    getWorkspaceStats: (workspacePath: string) => Promise<any>;
    openFolderDialog: () => Promise<{ success: true; path: string } | { success: false }>;
    createWorkspaceDialog: () => Promise<{ success: true; path: string } | { success: false; error?: string }>;
    openWorkspace: (workspacePath: string) => Promise<{ success: boolean }>;
    removeRecent: (workspacePath: string) => Promise<{ success: boolean }>;
    getOpenWorkspaces: () => Promise<string[]>;
  };

  // Project Migration (move/rename)
  projectMigration: {
    canMove: (oldPath: string) => Promise<{ canMove: boolean; reason?: string }>;
    move: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string; newPath?: string }>;
    rename: (oldPath: string, newName: string) => Promise<{ success: boolean; error?: string; newPath?: string }>;
  };

  // Document Service
  documentService: {
    list: () => Promise<any[]>;
    search: (query: string) => Promise<any[]>;
    get: (id: string) => Promise<any>;
    getByPath: (path: string) => Promise<any>;
    open: (id: string, fallback?: { path?: string; name?: string }) => Promise<void>;
    watch: () => void;
    onDocumentsChanged: (callback: (documents: any[]) => void) => () => void;
    loadVirtual: (virtualPath: string) => Promise<any>;
    createTrackerItem: (item: {
      id: string;
      type: string;
      title: string;
      status: string;
      priority: string;
      workspace: string;
      description?: string;
      owner?: string;
      tags?: string[];
      customFields?: Record<string, any>;
      syncMode?: string;
      content?: any;
      source?: string;
      sourceRef?: string;
    }) => Promise<{ success: boolean; item?: any; error?: string }>;
    updateTrackerItem: (payload: {
      itemId: string;
      updates: Record<string, any>;
      syncMode?: string;
    }) => Promise<{ success: boolean; item?: any; error?: string }>;
    setTrackerItemShared: (payload: {
      itemId: string;
      shared: boolean;
    }) => Promise<{ success: boolean; item?: any; error?: string }>;
    updateTrackerItemContent: (payload: {
      itemId: string;
      content: any;
    }) => Promise<{ success: boolean; error?: string }>;
    getTrackerItemContent: (payload: {
      itemId: string;
    }) => Promise<{ success: boolean; content?: any; error?: string }>;
    getTrackerBodyCacheForDetail: (payload: {
      itemId: string;
    }) => Promise<{
      success: boolean;
      row?: { bodyVersion: number; content: any } | null;
      error?: string;
    }>;
    archiveTrackerItem: (payload: {
      itemId: string;
      archive: boolean;
    }) => Promise<{ success: boolean; item?: any; error?: string }>;
    deleteTrackerItem: (payload: {
      itemId: string;
    }) => Promise<{ success: boolean; error?: string }>;
    updateTrackerItemInFile: (payload: {
      itemId: string;
      updates: Record<string, any>;
    }) => Promise<{ success: boolean; item?: any; error?: string }>;
    importTrackerItemFromFile: (payload: {
      relativePath: string;
      skipDuplicates?: boolean;
    }) => Promise<{ success: boolean; item?: any; skipped?: boolean; error?: string }>;
    bulkImportTrackerItems: (payload: {
      directory: string;
      skipDuplicates?: boolean;
      recursive?: boolean;
    }) => Promise<{ success: boolean; imported?: number; skipped?: number; errors?: string[]; error?: string }>;
  };

  // analytics
  analytics: {
    allowedToSendAnalytics: () => Promise<boolean>;
    getDistinctId: () => Promise<string>;
    optIn: () => Promise<void>;
    optOut: () => Promise<void>;
    setSessionId: (sessionId: string) => Promise<void>;
  };

  // Feature usage tracking (local UX decisions)
  featureUsage: {
    record: (feature: string) => Promise<{ count: number; firstUsed: string; lastUsed: string }>;
    get: (feature: string) => Promise<{ count: number; firstUsed: string; lastUsed: string } | undefined>;
    getCount: (feature: string) => Promise<number>;
    getAll: () => Promise<Record<string, { count: number; firstUsed: string; lastUsed: string }>>;
  };

  // Per-tool usage (tip targeting rollup + AI Usage Report Tools tab)
  toolUsage: {
    getRollup: () => Promise<Record<string, { count: number; firstUsed: string; lastUsed: string }>>;
    getReport: (workspaceId?: string) => Promise<{
      topTools: Array<{ toolName: string; mcpServer: string | null; count: number; errorCount: number }>;
      byKind: { builtin: number; mcp: number };
      byProvider: Array<{ provider: string; count: number }>;
      overTime: Array<{ day: string; count: number }>;
      byProject: Array<{ projectPath: string; count: number }>;
    }>;
    backfill: () => Promise<{ sessionsProcessed: number; toolCallsCounted: number }>;
  };

  // Credentials (for E2E encryption key management)
  credentials: {
    get: () => Promise<{ encryptionKeySeed: string; createdAt: number; isSecure: boolean }>;
    reset: () => Promise<{ encryptionKeySeed: string; createdAt: number; isSecure: boolean }>;
    generateQRPayload: (serverUrl: string) => Promise<{
      version: number;
      serverUrl: string;
      encryptionKeySeed: string;
    }>;
    isSecure: () => Promise<boolean>;
  };

  // Network utilities
  network: {
    getLocalIP: () => Promise<string | null>;
  };

  // Environment utilities
  environment: {
    /** Get the enhanced PATH that Nimbalyst uses for spawning processes */
    getEnhancedPath: () => Promise<string>;
  };

  // Stytch Authentication (for account-based sync)
  stytch: {
    getAuthState: () => Promise<{
      isAuthenticated: boolean;
      user: {
        user_id: string;
        emails: Array<{ email_id: string; email: string; verified: boolean }>;
        name?: { first_name?: string; last_name?: string };
        created_at: string;
        status: 'active' | 'pending';
      } | null;
      sessionToken: string | null;
      sessionJwt: string | null;
    }>;
    isAuthenticated: () => Promise<boolean>;
    signInWithGoogle: () => Promise<{ success: boolean; error?: string }>;
    sendMagicLink: (email: string) => Promise<{ success: boolean; error?: string }>;
    signOut: (forceOfflinePurge?: boolean) => Promise<{
      success: boolean;
      requiresOfflinePurgeConfirmation?: boolean;
      pendingDocumentCount?: number;
    }>;
    deleteAccount: (personalOrgId?: string) => Promise<{ success: boolean; error?: string }>;
    getSessionJwt: () => Promise<string | null>;
    refreshSession: () => Promise<boolean>;
    subscribeAuthState: () => Promise<any>;
    onAuthStateChange: (callback: (state: any) => void) => () => void;
    switchEnvironment: (environment: 'development' | 'production') => Promise<{ success: boolean; error?: string }>;
    getAccounts: () => Promise<Array<{
      personalOrgId: string;
      personalUserId: string | null;
      email: string | null;
      userName?: string;
      isSyncAccount: boolean;
      sessionStatus: 'active' | 'expired';
    }>>;
    getSyncAccount: () => Promise<{
      personalOrgId: string;
      personalUserId: string | null;
      email: string | null;
      userName?: string;
      isSyncAccount: boolean;
      sessionStatus: 'active' | 'expired';
    } | null>;
    setSyncAccount: (personalOrgId: string) => Promise<{ success: boolean }>;
    addAccount: () => Promise<{ success: boolean; error?: string }>;
    removeAccount: (personalOrgId: string, forceOfflinePurge?: boolean) => Promise<{
      success: boolean;
      error?: string;
      requiresOfflinePurgeConfirmation?: boolean;
      pendingDocumentCount?: number;
    }>;
  };

  // Extensions API
  extensions: {
    listInstalled: () => Promise<Array<{ id: string; path: string; manifest: any; name: string; enabled: boolean }>>;
    getAllSettings: () => Promise<Record<string, { enabled: boolean; claudePluginEnabled?: boolean; agentWorkflowsEnabled?: boolean }>>;
    getEnabled: (extensionId: string, defaultEnabled?: boolean) => Promise<boolean>;
    setEnabled: (extensionId: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    setClaudePluginEnabled: (extensionId: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    setAgentWorkflowsEnabled: (extensionId: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    getClaudePluginCommands: () => Promise<Array<{
      extensionId: string;
      extensionName: string;
      pluginName: string;
      pluginNamespace: string;
      commandName: string;
      description: string;
    }>>;
    getConfig: (extensionId: string, scope?: 'user' | 'workspace', workspacePath?: string) => Promise<Record<string, unknown>>;
    setConfig: (extensionId: string, key: string, value: unknown, scope?: 'user' | 'workspace', workspacePath?: string) => Promise<{ success: boolean; error?: string }>;
    setConfigBulk: (extensionId: string, configuration: Record<string, unknown>, scope?: 'user' | 'workspace', workspacePath?: string) => Promise<{ success: boolean; error?: string }>;
    devInstall: (extensionPath: string) => Promise<{ success: boolean; extensionId?: string; symlinkPath?: string; error?: string }>;
    devUninstall: (extensionId: string) => Promise<{ success: boolean; error?: string }>;
    devReload: (extensionId: string, extensionPath: string) => Promise<{ success: boolean; error?: string }>;
    devUnload: (extensionId: string) => Promise<{ success: boolean; error?: string }>;
    onDevReload: (callback: (data: { extensionId: string; extensionPath: string }) => void) => () => void;
    onDevUnload: (callback: (data: { extensionId: string }) => void) => () => void;

    permissions: {
      listDescriptors: () => Promise<Array<{
        id: string;
        label: string;
        description: string;
        risk: 'low' | 'elevated' | 'high';
      }>>;
      listEffective: (workspacePath?: string) => Promise<Array<PermissionGrantRow>>;
      listAtScope: (scope: 'workspace' | 'global', workspacePath?: string) => Promise<Array<PermissionGrantRow>>;
      listEnabledModules: (workspacePath?: string) => Promise<Array<{
        extensionId: string;
        moduleId: string;
        scopes: Array<'workspace' | 'global'>;
      }>>;
      isModuleEnabled: (args: {
        extensionId: string;
        moduleId: string;
        declaredPermissions: string[];
        workspacePath?: string;
      }) => Promise<boolean>;
      grantModule: (args: {
        extensionId: string;
        moduleId: string;
        permissions: string[];
        scope: 'workspace' | 'global';
        workspacePath?: string;
      }) => Promise<{ success: boolean; grants: Array<PermissionGrantRow> }>;
      revokeModule: (args: {
        extensionId: string;
        moduleId: string;
        scope: 'workspace' | 'global';
        workspacePath: string;
      }) => Promise<{ success: boolean; removedRows: number }>;
      handleUninstall: (args: { extensionId: string; workspacePath?: string }) => Promise<{ success: boolean }>;
      listHostState: () => Promise<Array<ModuleHandleRow>>;
      usageSummary: () => Promise<Array<UsageSummaryRow>>;
      usageEventsForModule: (args: { extensionId: string; moduleId: string }) => Promise<Array<UsageEventRow>>;
      usageEventsAll: () => Promise<Array<UsageEventRow>>;
      onStateChanged: (callback: (handle: ModuleHandleRow) => void) => () => void;
      onPromptRaised: (
        callback: (request: PermissionPromptRequestRow) => void
      ) => () => void;
      onPromptResolved: (callback: (data: { promptId: string }) => void) => () => void;
      resolvePrompt: (
        promptId: string,
        resolution: { decision: 'enable-workspace' | 'enable-global' | 'not-now' }
      ) => void;
      listPendingPrompts: () => Promise<Array<PermissionPromptRequestRow>>;
    };
  };

  // Claude Code API
  claudeCode: {
    getSettings: () => Promise<{ projectCommandsEnabled: boolean; userCommandsEnabled: boolean; apiUpstreamUrl?: string }>;
    setProjectCommandsEnabled: (enabled: boolean) => Promise<void>;
    setUserCommandsEnabled: (enabled: boolean) => Promise<void>;
    setApiUpstreamUrl: (url: string) => Promise<{ success: true } | { success: false; error: string }>;
    getEnv: () => Promise<Record<string, string>>;
    setEnv: (env: Record<string, string>) => Promise<void>;
  };

  agentWorkflows: {
    getSettings: () => Promise<{
      sourceSettings: {
        workspaceClaudeCompatibilityEnabled: boolean;
        includeProjectClaudeSources: boolean;
        includeUserClaudeSources: boolean;
        extensionWorkflowsEnabled: boolean;
      };
      exportSettings: {
        codexEnabled: boolean;
        claudeGeneratedExtensionWorkflowsEnabled: boolean;
      };
    }>;
    setSourceSettings: (updates: {
      workspaceClaudeCompatibilityEnabled?: boolean;
      includeProjectClaudeSources?: boolean;
      includeUserClaudeSources?: boolean;
      extensionWorkflowsEnabled?: boolean;
    }) => Promise<{
      workspaceClaudeCompatibilityEnabled: boolean;
      includeProjectClaudeSources: boolean;
      includeUserClaudeSources: boolean;
      extensionWorkflowsEnabled: boolean;
    }>;
    setExportSettings: (updates: {
      codexEnabled?: boolean;
      claudeGeneratedExtensionWorkflowsEnabled?: boolean;
    }) => Promise<{
      codexEnabled: boolean;
      claudeGeneratedExtensionWorkflowsEnabled: boolean;
    }>;
  };

  // Extension Development Kit (EDK) API
  extensionDevTools: {
    isEnabled: () => Promise<boolean>;
    setEnabled: (enabled: boolean) => Promise<void>;
    getLogs: (filter?: {
      extensionId?: string;
      lastSeconds?: number;
      logLevel?: 'error' | 'warn' | 'info' | 'debug' | 'all';
      source?: 'renderer' | 'main' | 'build' | 'all';
    }) => Promise<{
      logs: Array<{
        timestamp: number;
        level: 'error' | 'warn' | 'info' | 'debug';
        source: 'renderer' | 'main' | 'build';
        extensionId?: string;
        message: string;
        stack?: string;
        line?: number;
        sourceFile?: string;
      }>;
      stats: {
        totalEntries: number;
        byLevel: Record<'error' | 'warn' | 'info' | 'debug', number>;
        bySource: Record<'renderer' | 'main' | 'build', number>;
      };
    }>;
    clearLogs: (extensionId?: string) => Promise<void>;
    getProcessInfo: () => Promise<{ startTime: number; uptimeSeconds: number }>;
  };

  // Git operations (real-time status events)
  git?: {
    onStatusChanged?: (callback: (data: { workspacePath: string }) => void) => () => void;
    onCommitDetected?: (callback: (data: {
      workspacePath: string;
      commitHash: string;
      commitMessage: string;
      committedFiles: string[];
    }) => void) => () => void;
    clearStatusCache?: (workspacePath?: string) => Promise<{ success: boolean }>;
  };

  // Terminal operations
  terminal: {
    // Terminal instance types
    TerminalInstance: {
      id: string;
      title: string;
      shellName: string;
      shellPath: string;
      cwd: string;
      worktreeId?: string;
      createdAt: number;
      lastActiveAt: number;
      historyFile?: string;
      cols?: number;
      rows?: number;
      cursorX?: number;
      cursorY?: number;
      screenLines?: string[];
    };
    WorkspaceTerminalState: {
      terminals: Record<string, ElectronAPI['terminal']['TerminalInstance']>;
      activeTerminalId?: string;
      tabOrder: string[];
    };
    TerminalPanelState: {
      panelHeight: number;
      panelVisible: boolean;
    };

    // New terminal store API
    create: (workspacePath: string, options?: { cwd?: string; worktreeId?: string; title?: string; source?: 'panel' | 'worktree' }) => Promise<{
      success: boolean;
      terminalId?: string;
      shell?: { name: string; path: string };
      instance?: ElectronAPI['terminal']['TerminalInstance'];
      error?: string;
    }>;
    list: (workspacePath: string) => Promise<ElectronAPI['terminal']['TerminalInstance'][]>;
    get: (workspacePath: string, terminalId: string) => Promise<ElectronAPI['terminal']['TerminalInstance'] | undefined>;
    update: (workspacePath: string, terminalId: string, updates: { title?: string; cwd?: string }) => Promise<{
      success: boolean;
      terminal?: ElectronAPI['terminal']['TerminalInstance'];
    }>;
    delete: (workspacePath: string, terminalId: string) => Promise<{ success: boolean }>;
    setActive: (workspacePath: string, terminalId: string | undefined) => Promise<{ success: boolean }>;
    getActive: (workspacePath: string) => Promise<string | undefined>;
    setTabOrder: (workspacePath: string, tabOrder: string[]) => Promise<{ success: boolean }>;
    getWorkspaceState: (workspacePath: string) => Promise<ElectronAPI['terminal']['WorkspaceTerminalState']>;

    // Panel state (per-workspace)
    getPanelState: (workspacePath: string) => Promise<ElectronAPI['terminal']['TerminalPanelState']>;
    updatePanelState: (workspacePath: string, updates: { panelHeight?: number; panelVisible?: boolean }) => Promise<ElectronAPI['terminal']['TerminalPanelState']>;
    setPanelVisible: (workspacePath: string, visible: boolean) => Promise<{ success: boolean }>;
    setPanelHeight: (workspacePath: string, height: number) => Promise<{ success: boolean }>;

    // PTY operations
    initialize: (terminalId: string, options: { workspacePath: string; cwd?: string; cols?: number; rows?: number }) => Promise<{ success: boolean; alreadyActive?: boolean; error?: string }>;
    ensureClaudeCliSession: (payload: { sessionId: string; workspacePath: string; cwd?: string; model?: string; resumeSessionId?: string; cols?: number; rows?: number }) => Promise<{ success: boolean; alreadyActive?: boolean; error?: string; claudeNotInstalled?: boolean }>;
    isClaudeCliInstalled: () => Promise<boolean>;
    submitClaudeCliPrompt: (payload: { sessionId: string; workspacePath: string; prompt: string; attachments?: unknown[]; documentContext?: unknown }) => Promise<{ success: boolean }>;
    setClaudeCliModel: (sessionId: string, model: string) => Promise<{ success: boolean; cliArg: string }>;
    interruptClaudeCli: (sessionId: string) => Promise<{ success: boolean; resolvedAfter?: 'first-interrupt' | 'second-interrupt' | 'sigint' | 'unresolved' }>;
    isActive: (terminalId: string) => Promise<boolean>;
    write: (terminalId: string, data: string) => Promise<void>;
    resize: (terminalId: string, cols: number, rows: number) => Promise<void>;
    updateRenderState: (
      terminalId: string,
      updates: { workspacePath?: string; cols?: number; rows?: number; cursorX?: number; cursorY?: number; screenLines?: string[] }
    ) => Promise<{ success: boolean }>;
    getScrollback: (terminalId: string) => Promise<string>;
    getRestoreSnapshot: (workspacePath: string, terminalId: string) => Promise<{
      terminalId: string;
      scrollback: string;
      sequence: number;
      cols: number;
      rows: number;
      cursorX?: number;
      cursorY?: number;
      screenLines?: string[];
      cwd: string;
      shellName: string;
    }>;
    clearScrollback: (terminalId: string) => Promise<void>;
    destroy: (terminalId: string) => Promise<void>;
    getInfo: (terminalId: string) => Promise<any>;
    getAvailableShells: () => Promise<Array<{
      name: string;
      path: string;
      args: string[];
      provider?: string;
      bootstrapMode?: 'zsh' | 'bash' | 'powershell' | 'none';
      cwdMode?: 'native' | 'wsl';
    }>>;

    // Events
    onOutput: (callback: (data: { sessionId: string; data: string; sequence: number }) => void) => () => void;
    onExited: (callback: (data: { sessionId: string; exitCode: number }) => void) => () => void;
    onCommandRunning: (callback: (data: { terminalId: string; isRunning: boolean }) => void) => () => void;

    // Legacy API (deprecated)
    /** @deprecated Use terminal.create instead */
    createSession: (workspacePath: string, options?: { cwd?: string; worktreeId?: string; worktreePath?: string }) => Promise<{ success: boolean; sessionId: string; error?: string }>;
  };

  // Plaintext recovery copies for collaborative content
  collabBackup: {
    contentChanged: (payload: {
      workspacePath: string;
      documentId: string;
      documentType: string;
      title?: string;
      plaintext: string;
      kind?: 'document' | 'body';
    }) => Promise<{ success: boolean; scheduled?: boolean; error?: string }>;
    backupAll: (workspacePath: string) => Promise<{
      success: boolean;
      orgId: string;
      projectId: string | null;
      total: number;
      backedUp: number;
      skipped: number;
      failures: Array<{ documentId: string; error: string }>;
    }>;
    list: (workspacePath: string) => Promise<{
      orgId: string;
      projectId: string | null;
      updatedAt: string;
      documents: Record<string, unknown>;
    } | null>;
    restore: (workspacePath: string, documentId: string, force?: boolean) => Promise<{ success: boolean; error?: string }>;
  };

  // Document Sync (collaborative editing)
  documentSync: {
    open: (
      workspacePath: string,
      documentId: string,
      title?: string,
      documentType?: string,
    ) => Promise<{
      success: boolean;
      config?: {
        orgId: string;
        documentId: string;
        title: string;
        documentType?: string;
        keyCustody?: 'legacy-e2e' | 'server-managed';
        orgKeyBase64: string;
        /** Legacy org key for reading pre-migration rows in server-managed mode (NIM-878). */
        legacyOrgKeyBase64?: string;
        /** All candidate legacy org-key epochs for pre-migration rows that may span rotations (NIM-959). */
        legacyOrgKeysBase64?: string[];
        orgKeyFingerprint?: string;
        serverUrl: string;
        accountId: string;
        userId: string;
        userName?: string;
        userEmail?: string;
        urlExtraQuery?: string;
        pendingUpdateBase64?: string;
      };
      error?: string;
    }>;
    setPendingUpdate: (
      workspacePath: string,
      orgId: string,
      documentId: string,
      pendingUpdateBase64: string | null
    ) => Promise<{
      success: boolean;
      error?: string;
    }>;
    replicaLoad: (
      workspacePath: string,
      identity: import('@nimbalyst/runtime/sync').LocalReplicaIdentity,
    ) => Promise<import('@nimbalyst/runtime/sync').LoadedLocalReplica | null>;
    replicaAppendLocal: (
      workspacePath: string,
      input: import('@nimbalyst/runtime/sync').AppendLocalReplicaUpdateInput,
    ) => Promise<void>;
    onReplicaLocalUpdate: (callback: (payload: {
      identity: import('@nimbalyst/runtime/sync').LocalReplicaIdentity;
      updateId: string;
      update: Uint8Array;
    }) => void) => () => void;
    replicaAppendRemote: (
      workspacePath: string,
      input: import('@nimbalyst/runtime/sync').AppendRemoteReplicaUpdatesInput,
    ) => Promise<void>;
    replicaSetOutboxState: (
      workspacePath: string,
      identity: import('@nimbalyst/runtime/sync').LocalReplicaIdentity,
      batchIds: string[],
      state: import('@nimbalyst/runtime/sync').LocalReplicaOutboxState,
      lastErrorCode?: string | null,
    ) => Promise<void>;
    replicaClaimOutbox: (
      workspacePath: string,
      identity: import('@nimbalyst/runtime/sync').LocalReplicaIdentity,
      batchIds: string[],
    ) => Promise<boolean>;
    replicaLoadOutbox: (
      workspacePath: string,
      identity: import('@nimbalyst/runtime/sync').LocalReplicaIdentity,
    ) => Promise<import('@nimbalyst/runtime/sync').LocalReplicaOutboxEntry[]>;
    replicaRecordOutboxError: (
      workspacePath: string,
      identity: import('@nimbalyst/runtime/sync').LocalReplicaIdentity,
      batchIds: string[],
      errorCode: string,
    ) => Promise<void>;
    replicaAckOutbox: (
      workspacePath: string,
      identity: import('@nimbalyst/runtime/sync').LocalReplicaIdentity,
      batchIds: string[],
      serverSequence: number,
    ) => Promise<void>;
    replicaReplaceSnapshot: (
      workspacePath: string,
      input: import('@nimbalyst/runtime/sync').ReplaceLocalReplicaSnapshotInput,
    ) => Promise<boolean>;
    replicaMarkIncomplete: (
      workspacePath: string,
      identity: import('@nimbalyst/runtime/sync').LocalReplicaIdentity,
    ) => Promise<void>;
    replicaMarkComplete: (
      workspacePath: string,
      identity: import('@nimbalyst/runtime/sync').LocalReplicaIdentity,
    ) => Promise<void>;
    replicaQuarantine: (
      workspacePath: string,
      identity: import('@nimbalyst/runtime/sync').LocalReplicaIdentity,
      reason: string,
    ) => Promise<void>;
    replicaResetForCleanHydration: (
      workspacePath: string,
      identity: import('@nimbalyst/runtime/sync').LocalReplicaIdentity,
    ) => Promise<void>;
    replicaDiscard: (
      workspacePath: string,
      identity: import('@nimbalyst/runtime/sync').LocalReplicaIdentity,
    ) => Promise<void>;
    replicaPurgeAccount: (workspacePath: string, accountId: string) => Promise<void>;
    replicaPurgeOrg: (workspacePath: string, accountId: string, orgId: string) => Promise<void>;
    replicaStorageUsage: (
      workspacePath: string,
      accountId: string,
    ) => Promise<import('@nimbalyst/runtime/sync').LocalReplicaStorageUsage>;
    replicaListPendingOutboxes: (
      workspacePath: string,
      accountId?: string,
    ) => Promise<import('@nimbalyst/runtime/sync').LocalReplicaPendingOutbox[]>;
    setReplicaProviderAttached: (
      identity: import('@nimbalyst/runtime/sync').LocalReplicaIdentity,
      attachmentId: string,
      attached: boolean,
    ) => Promise<void>;
    seedSharedDocument: (
      workspacePath: string,
      documentId: string,
      documentType: string,
      content: string
    ) => Promise<{
      success: boolean;
      error?: string;
    }>;
    getLocalOrigin: (workspacePath: string, documentId: string) => Promise<{
      success: boolean;
      binding?: {
        orgId: string;
        documentId: string;
        gitRemoteHash: string | null;
        workspacePathHash: string | null;
        relativePath: string;
        documentType: string;
        sourceBasename: string;
        lastLocalContentHash: string | null;
        lastCollabContentHash: string | null;
        lastSyncedAt: string | null;
        lastSeenMtimeMs: number | null;
        lastSeenSizeBytes: number | null;
        resolutionStatus: 'resolved' | 'missing' | 'relinked' | 'conflict';
        resolutionError: string | null;
        createdAt: string;
        updatedAt: string;
        resolvedPath: string | null;
      } | null;
      error?: string;
    }>;
    saveLocalOrigin: (payload: {
      workspacePath: string;
      documentId: string;
      documentType: string;
      sourceFilePath: string;
      lastLocalContentHash: string | null;
      lastCollabContentHash: string | null;
    }) => Promise<{
      success: boolean;
      binding?: {
        orgId: string;
        documentId: string;
        gitRemoteHash: string | null;
        workspacePathHash: string | null;
        relativePath: string;
        documentType: string;
        sourceBasename: string;
        lastLocalContentHash: string | null;
        lastCollabContentHash: string | null;
        lastSyncedAt: string | null;
        lastSeenMtimeMs: number | null;
        lastSeenSizeBytes: number | null;
        resolutionStatus: 'resolved' | 'missing' | 'relinked' | 'conflict';
        resolutionError: string | null;
        createdAt: string;
        updatedAt: string;
        resolvedPath: string | null;
      } | null;
      error?: string;
    }>;
    relinkLocalOrigin: (payload: {
      workspacePath: string;
      documentId: string;
      documentType: string;
      sourceFilePath: string;
    }) => Promise<{
      success: boolean;
      binding?: {
        orgId: string;
        documentId: string;
        gitRemoteHash: string | null;
        workspacePathHash: string | null;
        relativePath: string;
        documentType: string;
        sourceBasename: string;
        lastLocalContentHash: string | null;
        lastCollabContentHash: string | null;
        lastSyncedAt: string | null;
        lastSeenMtimeMs: number | null;
        lastSeenSizeBytes: number | null;
        resolutionStatus: 'resolved' | 'missing' | 'relinked' | 'conflict';
        resolutionError: string | null;
        createdAt: string;
        updatedAt: string;
        resolvedPath: string | null;
      } | null;
      error?: string;
    }>;
    clearLocalOrigin: (workspacePath: string, documentId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    reuploadLocalOrigin: (payload: {
      workspacePath: string;
      documentId: string;
      forceOverwriteShared?: boolean;
    }) => Promise<{
      success: boolean;
      status: 'noop' | 'uploaded' | 'conflict' | 'missing-source' | 'unsupported' | 'error';
      conflictKind?: 'missing-baseline' | 'shared-ahead' | 'diverged';
      message?: string;
      binding?: {
        orgId: string;
        documentId: string;
        gitRemoteHash: string | null;
        workspacePathHash: string | null;
        relativePath: string;
        documentType: string;
        sourceBasename: string;
        lastLocalContentHash: string | null;
        lastCollabContentHash: string | null;
        lastSyncedAt: string | null;
        lastSeenMtimeMs: number | null;
        lastSeenSizeBytes: number | null;
        resolutionStatus: 'resolved' | 'missing' | 'relinked' | 'conflict';
        resolutionError: string | null;
        createdAt: string;
        updatedAt: string;
        resolvedPath: string | null;
      } | null;
      migration?: { okCount: number; failedCount: number };
      lastEditorId?: string | null;
      lastEditedAt?: number | null;
    }>;
    findLocalOriginLink: (workspacePath: string, sourceFilePath: string) => Promise<{
      success: boolean;
      binding?: {
        orgId: string;
        documentId: string;
        gitRemoteHash: string | null;
        workspacePathHash: string | null;
        relativePath: string;
        documentType: string;
        sourceBasename: string;
        lastLocalContentHash: string | null;
        lastCollabContentHash: string | null;
        lastSyncedAt: string | null;
        lastSeenMtimeMs: number | null;
        lastSeenSizeBytes: number | null;
        resolutionStatus: 'resolved' | 'missing' | 'relinked' | 'conflict';
        resolutionError: string | null;
        createdAt: string;
        updatedAt: string;
        resolvedPath: string | null;
      } | null;
      error?: string;
    }>;
    getJwt: (orgId: string, forceRefresh?: boolean) => Promise<{
      success: boolean;
      jwt?: string;
      error?: string;
    }>;
    resolveIndexConfig: (workspacePath: string) => Promise<{
      success: boolean;
      config?: {
        orgId: string;
        teamProjectId?: string | null;
        keyCustody?: 'legacy-e2e' | 'server-managed';
        orgKeyBase64: string;
        /** Legacy org-key epochs (current + archived) for reading/healing pre-migration ciphertext titles in server-managed mode (NIM-906/910). */
        legacyOrgKeysBase64?: string[];
        orgKeyFingerprint: string | null;
        serverUrl: string;
        userId: string;
        personalOrgId?: string;
        userName?: string;
        userEmail?: string;
      };
      error?: string;
    }>;
    // WebSocket proxy (Cloudflare blocks browser WS upgrades; proxy through main process)
    wsConnect: (url: string) => Promise<{ success: boolean; wsId?: string; error?: string }>;
    wsSend: (wsId: string, data: string) => Promise<{ success: boolean; error?: string }>;
    wsClose: (wsId: string) => Promise<{ success: boolean }>;
    onWsEvent: (callback: (data: {
      wsId: string;
      type: 'open' | 'message' | 'close' | 'error';
      data?: string;
      code?: number;
      reason?: string;
      error?: string;
    }) => void) => () => void;
    // Personal document sync (mobile markdown sync)
    isPersonalSyncAvailable: () => Promise<{ available: boolean }>;
    getSyncId: (filePath: string, workspacePath: string) => Promise<{ success: boolean; syncId?: string; error?: string }>;
    resolvePersonalConfig: (filePath: string, workspacePath: string) => Promise<{
      success: boolean;
      config?: {
        serverUrl: string;
        orgId: string;
        userId: string;
        encryptionKeyBase64: string;
        syncId: string;
        userName: string;
      };
      error?: string;
    }>;
    getPersonalJwt: () => Promise<{ success: boolean; jwt?: string; error?: string }>;

    // Collaborative document attachments
    closeDoc: (documentId: string) => Promise<{ success: boolean; error?: string }>;
    uploadAsset: (payload: {
      orgId: string;
      documentId: string;
      fileBytes: ArrayBuffer;
      mimeType: string;
      fileName: string;
    }) => Promise<{ success: boolean; assetId?: string; uri?: string; queued?: boolean; error?: string }>;
    migrateLocalAssets: (payload: {
      workspacePath: string;
      orgId: string;
      documentId: string;
      sourceFilePath: string;
      markdown: string;
    }) => Promise<{
      success: boolean;
      rewrittenMarkdown?: string;
      results?: Array<
        | { ref: string; status: 'ok'; uri: string; bytes: number }
        | { ref: string; status: 'missing' }
        | { ref: string; status: 'rejected'; reason: string }
        | { ref: string; status: 'skipped'; reason: string }
        | { ref: string; status: 'failed'; error: string }
      >;
      error?: string;
    }>;
    gcAssets: (payload: {
      orgId: string;
      documentId: string;
      removedUris: string[];
    }) => Promise<{
      success: boolean;
      requested?: number;
      deleted?: number;
      failed?: number;
      skipped?: number;
      error?: string;
    }>;
  };

  // Worktree operations
  worktreeCreate: (workspacePath: string, options?: { name?: string; baseBranch?: string }) => Promise<{
    success: boolean;
    error?: string;
    worktree?: {
      id: string;
      name: string;
      path: string;
      branch: string;
      baseBranch: string;
      projectPath: string;
      createdAt: number;
      updatedAt?: number;
    };
  }>;
  worktreeGetStatus: (worktreePath: string, options?: { fetchFirst?: boolean }) => Promise<{
    success: boolean;
    error?: string;
    status?: {
      hasUncommittedChanges: boolean;
      modifiedFileCount: number;
      commitsAhead: number;
      commitsBehind: number;
      isMerged: boolean;
      uniqueCommitsAhead?: number;
    };
  }>;
  worktreeGetByPath: (worktreePath: string) => Promise<{
    success: boolean;
    error?: string;
    worktree?: {
      id: string;
      name: string;
      displayName?: string;
      path: string;
      branch: string;
      baseBranch: string;
      projectPath: string;
      createdAt: number;
      updatedAt?: number;
      isPinned?: boolean;
      isArchived?: boolean;
    } | null;
  }>;
  worktreeDelete: (worktreeId: string, workspacePath: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  worktreeList: (workspacePath: string) => Promise<{
    success: boolean;
    error?: string;
    worktrees?: Array<{
      id: string;
      name: string;
      path: string;
      branch: string;
      baseBranch: string;
      projectPath: string;
      createdAt: number;
      updatedAt?: number;
    }>;
  }>;
  worktreeGet: (id: string) => Promise<{
    success: boolean;
    error?: string;
    worktree?: {
      id: string;
      name: string;
      path: string;
      branch: string;
      baseBranch: string;
      projectPath: string;
      createdAt: number;
      updatedAt?: number;
    } | null;
  }>;
  worktreeRebase: (worktreePath: string) => Promise<{
    success: boolean;
    error?: string;
    message?: string;
    conflictedFiles?: string[];
    conflictingCommits?: { ours: string[]; theirs: string[] };
    untrackedFiles?: string[];
  }>;
  worktreeArchive: (worktreeId: string, workspacePath: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  worktreeListGitignored: (worktreePath: string) => Promise<{
    success: boolean;
    error?: string;
    files: string[];
    count: number;
  }>;
  worktreeCleanGitignored: (worktreePath: string) => Promise<{
    success: boolean;
    error?: string;
    removed?: string[];
    count?: number;
  }>;

  // PR review panel — gh CLI status (Phase A of issue #307)
  ghCliStatus: () => Promise<{
    success: boolean;
    error?: string;
    data?: GhCliStatus;
  }>;
  ghCliRefreshStatus: () => Promise<{
    success: boolean;
    error?: string;
    data?: GhCliStatus;
  }>;
  onGhCliStatusChanged: (callback: (status: GhCliStatus) => void) => () => void;

  // PR review panel — GitHub API (Phase C of issue #307)
  prDetectRemote: (workspacePath: string) => Promise<{
    success: boolean;
    error?: string;
    data?: { remote: string; host: string } | null;
  }>;
  prList: (
    workspaceId: string,
    remote: string,
    filters?: PullRequestListFilters,
  ) => Promise<{ success: boolean; error?: string; data?: PullRequestRow[] }>;
  prGet: (
    workspaceId: string,
    remote: string,
    number: number,
  ) => Promise<{ success: boolean; error?: string; data?: PullRequestRow }>;
  prFiles: (
    workspaceId: string,
    remote: string,
    number: number,
  ) => Promise<{ success: boolean; error?: string; data?: PullRequestFileRow[] }>;
  prFileContents: (
    workspaceId: string,
    remote: string,
    ref: string,
    path: string,
  ) => Promise<{ success: boolean; error?: string; data?: { content: string } }>;
  prCommits: (
    workspaceId: string,
    remote: string,
    number: number,
  ) => Promise<{ success: boolean; error?: string; data?: PullRequestCommitRow[] }>;
  prChecks: (
    workspaceId: string,
    remote: string,
    number: number,
  ) => Promise<{ success: boolean; error?: string; data?: PullRequestCheckRow[] }>;
  prConversation: (
    workspaceId: string,
    remote: string,
    number: number,
  ) => Promise<{ success: boolean; error?: string; data?: PullRequestTimelineEntry[] }>;
  prConversationRefresh: (
    workspaceId: string,
    remote: string,
    number: number,
  ) => Promise<{ success: boolean; error?: string; data?: PullRequestTimelineEntry[] }>;
  prReviewThreads: (
    workspaceId: string,
    remote: string,
    number: number,
  ) => Promise<{
    success: boolean;
    error?: string;
    data?: {
      threads: Array<{
        id: string;
        isResolved: boolean;
        isOutdated: boolean;
        path: string | null;
        line: number | null;
        comments: Array<{
          id: string;
          authorLogin: string | null;
          body: string;
          createdAt: number;
          url: string | null;
        }>;
      }>;
      truncated: boolean;
    };
  }>;
  prRefresh: (
    workspaceId: string,
    remote: string,
    number?: number,
  ) => Promise<{ success: boolean; error?: string; data?: { fetchedAt: number } }>;

  // PR review panel — review/merge actions + access control (issue #307)
  prPermissions: (
    workspaceId: string,
    remote: string,
    number: number,
  ) => Promise<{
    success: boolean;
    error?: string;
    data?: {
      viewerLogin: string | null;
      canApprove: boolean;
      canMerge: boolean;
      mergeMethods: { squash: boolean; merge: boolean; rebase: boolean };
      mergeable: boolean | null;
      mergeableState: string | null;
      state: 'open' | 'closed' | 'merged';
      isDraft: boolean;
    };
  }>;
  prApprove: (
    workspaceId: string,
    remote: string,
    number: number,
    body?: string,
  ) => Promise<{ success: boolean; error?: string; data?: { ok: boolean } }>;
  prComment: (
    workspaceId: string,
    remote: string,
    number: number,
    body: string,
  ) => Promise<{ success: boolean; error?: string; data?: { ok: boolean } }>;
  prMerge: (
    workspaceId: string,
    remote: string,
    number: number,
    method: 'merge' | 'squash' | 'rebase',
    commitTitle?: string,
    commitMessage?: string,
  ) => Promise<{ success: boolean; error?: string; data?: { merged: boolean; sha: string | null } }>;

  // PR review panel — polling scheduler (Phase D of issue #307)
  prStartPolling: (
    workspacePath: string,
    workspaceId: string,
    remote: string,
  ) => Promise<{ success: boolean; error?: string; data?: { started: boolean } }>;
  prStopPolling: (
    workspacePath: string,
  ) => Promise<{ success: boolean; error?: string; data?: { stopped: boolean } }>;
  prPollNow: (
    workspacePath: string,
  ) => Promise<{ success: boolean; error?: string; data?: { ok: boolean } }>;
  prFocus: (workspacePath: string, focused: boolean) => void;
  onPrListUpdated: (
    callback: (payload: { workspacePath: string; remote: string }) => void,
  ) => () => void;
  prOpenWorktree: (
    workspacePath: string,
    remote: string,
    number: number,
  ) => Promise<{
    success: boolean;
    error?: string;
    data?: {
      id: string;
      name: string;
      path: string;
      branch: string;
      prNumber?: number;
      prRemote?: string;
      prUrl?: string;
    };
  }>;

  // PR review panel — per-project gh account selection (issue #307)
  prGhAccounts: () => Promise<{
    success: boolean;
    error?: string;
    data?: Array<{ login: string; host: string; active: boolean }>;
  }>;
  prGetAccountConfig: (workspacePath?: string) => Promise<{
    success: boolean;
    error?: string;
    data?: { defaultAccount: string | null; override: string | null; effective: string | null };
  }>;
  prSetDefaultAccount: (
    login: string | null,
  ) => Promise<{ success: boolean; error?: string; data?: { ok: boolean } }>;
  prSetAccountOverride: (
    workspacePath: string,
    login: string | null,
  ) => Promise<{ success: boolean; error?: string; data?: { ok: boolean } }>;

  // Archive progress operations
  archive: {
    getTasks: () => Promise<{
      success: boolean;
      tasks: ArchiveTask[];
      error?: string;
    }>;
    onProgress: (callback: (tasks: ArchiveTask[]) => void) => () => void;
  };

  // Open external links
  openExternal: (url: string) => Promise<void>;
  openThirdPartyNotices: () => Promise<{ success: boolean; error?: string }>;

  // Image operations
  openImageInDefaultApp: (imagePath: string) => Promise<{ success: boolean; error?: string }>;
  startImageDrag: (imagePath: string) => Promise<{ success: boolean; error?: string }>;

  // Generic IPC methods for services
  invoke: (channel: string, ...args: any[]) => Promise<any>;
  send: (channel: string, ...args: any[]) => void;
  /**
   * Subscribe to an IPC channel. Call the returned closure to unsubscribe.
   *
   * There is no `off(channel, callback)` counterpart on purpose: contextBridge
   * re-proxies the callback on every crossing, so identity-based removal never
   * matches and the listener leaks (issue #943 / NIM-2019).
   */
  on: (channel: string, callback: (...args: any[]) => void) => () => void;
}

interface InstalledExtension {
  id: string;
  path: string;
  manifest: any;
  name: string;
  enabled: boolean;
}

// Privileged-capability permission types (Phase 4)
interface PermissionGrantRow {
  extensionId: string;
  moduleId: string;
  permissionId: string;
  scope: 'workspace' | 'global';
  workspacePath?: string;
  grantedAt: number;
  grantedBy: 'user';
  permissionVersion: number;
}

interface ModuleHandleRow {
  extensionId: string;
  moduleId: string;
  workspacePath: string;
  state: unknown;
}

interface UsageSummaryRow {
  extensionId: string;
  moduleId: string;
  permissionId: string;
  total: number;
  allowed: number;
  denied: number;
  lastAt?: number;
}

interface UsageEventRow {
  extensionId: string;
  moduleId: string;
  permissionId: string;
  timestamp: number;
  outcome: 'allowed' | 'denied';
  method?: string;
}

interface PermissionPromptRequestRow {
  id: string;
  extensionId: string;
  extensionName: string;
  moduleId: string;
  purpose: string;
  declaredPermissions: string[];
  workspacePath: string;
  reason:
    | { kind: 'first-use' }
    | { kind: 're-prompt-update'; addedPermissions: string[]; existingScopes: Array<'workspace' | 'global'> };
  raisedAt: number;
}

interface Window {
  electronAPI: ElectronAPI;
  electron: ElectronAPI; // Alias for compatibility
  PLAYWRIGHT?: boolean;
  IS_OFFICIAL_BUILD?: boolean;
  IS_DEV_MODE?: boolean;
  DEV_MODE_LABEL?: string;
}
