import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {ClaudeForWindowsInstallation} from "../main/services/CLIManager.ts";
import type { GhCliStatus } from '../main/services/GhCliDetector.ts';
import type {
  AppendLocalReplicaUpdateInput,
  AppendRemoteReplicaUpdatesInput,
  LoadedLocalReplica,
  LocalReplicaIdentity,
  LocalReplicaOutboxEntry,
  LocalReplicaOutboxState,
  LocalReplicaPendingOutbox,
  LocalReplicaStorageUsage,
  ReplaceLocalReplicaSnapshotInput,
} from '@nimbalyst/runtime/sync';

// Nimbalyst is an IDE-like application with many concurrent IPC listeners:
// - File watching, git status, AI sessions, terminals, extensions, etc.
// The default limit of 10 is far too low. Setting to 100 is reasonable for
// our use case and prevents spurious "memory leak" warnings.
// The real fix is also in place: using stable references in useEffect deps.
ipcRenderer.setMaxListeners(100);

interface ArchiveTask {
  worktreeId: string;
  worktreeName: string;
  status: 'queued' | 'pending' | 'removing-worktree' | 'completed' | 'failed';
  startTime: Date;
  error?: string;
}

// Keep stable wrapper references so sessionState.removeStateChangeListener()
// can actually detach listeners registered via onStateChange().
const sessionStateEventListenerMap = new WeakMap<(event: any) => void, (_event: any, data: any) => void>();

// Expose PLAYWRIGHT flag to renderer for test detection
if (process.env.PLAYWRIGHT === '1') {
  contextBridge.exposeInMainWorld('PLAYWRIGHT', true);
}

// Expose build mode flags to renderer for dev mode indicators
contextBridge.exposeInMainWorld('IS_OFFICIAL_BUILD', process.env.OFFICIAL_BUILD === 'true');
contextBridge.exposeInMainWorld('IS_DEV_MODE', process.env.IS_DEV_MODE === 'true');
contextBridge.exposeInMainWorld('DEV_MODE_LABEL', (() => {
  const customDir = process.env.NIMBALYST_USER_DATA_DIR;
  if (!customDir) return 'DEV MODE';
  // Extract a short label from the directory name
  // e.g. "electron-user2" -> "user2", "electron-wt-feature-collab" -> "wt-feature-collab"
  // Note: can't use require('path') here -- preload runs in a sandboxed context
  const dirName = customDir.split(/[/\\]/).pop() || '';
  const label = dirName.replace(/^@?nimbalyst[-/]?/, '').replace(/^electron-?/, '');
  return `DEV: ${label || 'alt'}`;
})());

// Capture console logs in development
if (process.env.NODE_ENV !== 'production') {
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug
  };

  const captureLog = (level: string, ...args: any[]) => {
    // Still log to original console
    originalConsole[level as keyof typeof originalConsole](...args);

    // Send to main process for file logging
    const timestamp = new Date().toISOString();
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    ipcRenderer.send('console-log', {
      timestamp,
      level,
      message,
      source: 'renderer'
    });
  };

  console.log = (...args) => captureLog('log', ...args);
  console.warn = (...args) => captureLog('warn', ...args);
  console.error = (...args) => captureLog('error', ...args);
  console.info = (...args) => captureLog('info', ...args);
  console.debug = (...args) => captureLog('debug', ...args);
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  onFileNew: (callback: () => void) => {
    ipcRenderer.on('file-new', callback);
    return () => ipcRenderer.removeListener('file-new', callback);
  },
  onFileNewInWorkspace: (callback: () => void) => {
    ipcRenderer.on('file-new-in-workspace', callback);
    return () => ipcRenderer.removeListener('file-new-in-workspace', callback);
  },
  onAgentNewSession: (callback: () => void) => {
    ipcRenderer.on('agent-new-session', callback);
    return () => ipcRenderer.removeListener('agent-new-session', callback);
  },
  onFileOpen: (callback: () => void) => {
    ipcRenderer.on('file-open', callback);
    return () => ipcRenderer.removeListener('file-open', callback);
  },
  onWorkspaceOpened: (callback: (data: { workspacePath: string; workspaceName: string; fileTree: any[] }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('workspace-opened', handler);
    return () => ipcRenderer.removeListener('workspace-opened', handler);
  },
  onOpenWorkspaceFile: (callback: (filePath: string) => void) => {
    const handler = (_event: any, filePath: string) => callback(filePath);
    ipcRenderer.on('open-workspace-file', handler);
    return () => ipcRenderer.removeListener('open-workspace-file', handler);
  },
  onOpenDocument: (callback: (data: { path: string }) => void) => {
    const handler = (_event: any, data: { path: string }) => callback(data);
    ipcRenderer.on('open-document', handler);
    return () => ipcRenderer.removeListener('open-document', handler);
  },
  onOpenWorkspaceFromCLI: (callback: (workspacePath: string) => void) => {
    const handler = (_event: any, workspacePath: string) => callback(workspacePath);
    ipcRenderer.on('open-workspace-from-cli', handler);
    return () => ipcRenderer.removeListener('open-workspace-from-cli', handler);
  },
  onFileSave: (callback: () => void) => {
    ipcRenderer.on('file-save', callback);
    return () => ipcRenderer.removeListener('file-save', callback);
  },
  onFileSaveAs: (callback: () => void) => {
    ipcRenderer.on('file-save-as', callback);
    return () => ipcRenderer.removeListener('file-save-as', callback);
  },
  onNewUntitledDocument: (callback: (data: { untitledName: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('new-untitled-document', handler);
    return () => ipcRenderer.removeListener('new-untitled-document', handler);
  },
  onToggleSearch: (callback: () => void) => {
    ipcRenderer.on('toggle-search', callback);
    return () => ipcRenderer.removeListener('toggle-search', callback);
  },
  onToggleSearchReplace: (callback: () => void) => {
    ipcRenderer.on('toggle-search-replace', callback);
    return () => ipcRenderer.removeListener('toggle-search-replace', callback);
  },
  onOpenWelcomeTab: (callback: () => void) => {
    ipcRenderer.on('open-welcome-tab', callback);
    return () => ipcRenderer.removeListener('open-welcome-tab', callback);
  },
  onOpenPlansTab: (callback: () => void) => {
    ipcRenderer.on('open-plans-tab', callback);
    return () => ipcRenderer.removeListener('open-plans-tab', callback);
  },
  onOpenKeyboardShortcuts: (callback: () => void) => {
    ipcRenderer.on('open-keyboard-shortcuts', callback);
    return () => ipcRenderer.removeListener('open-keyboard-shortcuts', callback);
  },
  onOpenFeedback: (callback: () => void) => {
    ipcRenderer.on('open-feedback', callback);
    return () => ipcRenderer.removeListener('open-feedback', callback);
  },
  onFileDeleted: (callback: (data: { filePath: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('file-deleted', handler);
    return () => ipcRenderer.removeListener('file-deleted', handler);
  },
  onThemeChange: (callback: (theme: string) => void) => {
    const handler = (_event: any, theme: string) => callback(theme);
    ipcRenderer.on('theme-change', handler);
    return () => ipcRenderer.removeListener('theme-change', handler);
  },
  onMcpConfigChanged: (callback: (data: { scope: 'user' | 'workspace'; workspacePath?: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('mcp-config-changed', handler);
    return () => ipcRenderer.removeListener('mcp-config-changed', handler);
  },
  // Offscreen editor IPC
  onOffscreenEditorMount: (callback: (payload: { filePath: string; workspacePath: string }) => void) => {
    const handler = (_event: any, payload: any) => callback(payload);
    ipcRenderer.on('offscreen-editor:mount', handler);
    return () => ipcRenderer.removeListener('offscreen-editor:mount', handler);
  },
  onOffscreenEditorUnmount: (callback: (payload: { filePath: string }) => void) => {
    const handler = (_event: any, payload: any) => callback(payload);
    ipcRenderer.on('offscreen-editor:unmount', handler);
    return () => ipcRenderer.removeListener('offscreen-editor:unmount', handler);
  },
  onOffscreenEditorCaptureScreenshotRequest: (callback: (payload: { filePath: string; selector?: string; responseChannel: string }) => void) => {
    const handler = (_event: any, payload: any) => callback(payload);
    ipcRenderer.on('offscreen-editor:capture-screenshot-request', handler);
    return () => ipcRenderer.removeListener('offscreen-editor:capture-screenshot-request', handler);
  },
  onShowAbout: (callback: () => void) => {
    ipcRenderer.on('show-about', callback);
    return () => ipcRenderer.removeListener('show-about', callback);
  },
  onViewHistory: (callback: () => void) => {
    ipcRenderer.on('view-history', callback);
    return () => ipcRenderer.removeListener('view-history', callback);
  },
  onViewWorkspaceHistory: (callback: () => void) => {
    ipcRenderer.on('view-workspace-history', callback);
    return () => ipcRenderer.removeListener('view-workspace-history', callback);
  },

  onNextTab: (callback: () => void) => {
    ipcRenderer.on('next-tab', callback);
    return () => ipcRenderer.removeListener('next-tab', callback);
  },

  onPreviousTab: (callback: () => void) => {
    ipcRenderer.on('previous-tab', callback);
    return () => ipcRenderer.removeListener('previous-tab', callback);
  },

  onApproveAction: (callback: () => void) => {
    ipcRenderer.on('approve-action', callback);
    return () => ipcRenderer.removeListener('approve-action', callback);
  },

  onRejectAction: (callback: () => void) => {
    ipcRenderer.on('reject-action', callback);
    return () => ipcRenderer.removeListener('reject-action', callback);
  },

  onCopyAsMarkdown: (callback: () => void) => {
    ipcRenderer.on('copy-as-markdown', callback);
    return () => ipcRenderer.removeListener('copy-as-markdown', callback);
  },

  onLoadSessionFromManager: (callback: (data: { sessionId: string; workspacePath?: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('load-session-from-manager', handler);
    return () => ipcRenderer.removeListener('load-session-from-manager', handler);
  },

  // Theme operations
  getTheme: () => ipcRenderer.invoke('get-theme'),
  getThemeSync: () => {
    try {
      const theme = ipcRenderer.sendSync('get-theme-sync');
      // console.log('[preload] getThemeSync returned:', theme);
      return theme;
    } catch (err) {
      console.error('[preload] getThemeSync error:', err);
      return 'light';
    }
  },
  getResolvedThemeSync: () => {
    try {
      return ipcRenderer.sendSync('get-resolved-theme-sync');
    } catch (err) {
      console.error('[preload] getResolvedThemeSync error:', err);
      return 'light';
    }
  },
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  setTheme: (theme: string) => ipcRenderer.invoke('set-theme', theme),

  // File operations
  openFile: () => ipcRenderer.invoke('open-file'),
  openFileDialog: (options?: {
    title?: string;
    buttonLabel?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    defaultPath?: string;
  }) => ipcRenderer.invoke('dialog:openFile', options),
  saveFile: (content: string, filePath: string, lastKnownContent?: string) => {
    if (!filePath) {
      throw new Error('saveFile requires a filePath parameter. Use saveFileAs for save dialogs.');
    }
    return ipcRenderer.invoke('save-file', content, filePath, lastKnownContent);
  },
  saveFileAs: (content: string) => ipcRenderer.invoke('save-file-as', content),
  showErrorDialog: (title: string, message: string) => ipcRenderer.invoke('show-error-dialog', title, message),

  // Export operations
  showSaveDialogPdf: (options: { defaultPath?: string }) =>
    ipcRenderer.invoke('export:showSaveDialogPdf', options) as Promise<string | null>,
  exportHtmlToPdf: (options: {
    html: string;
    outputPath: string;
    pageSize?: 'A4' | 'Letter' | 'Legal';
    landscape?: boolean;
    generateDocumentOutline?: boolean;
    generateTaggedPDF?: boolean;
    margins?: { top?: number; bottom?: number; left?: number; right?: number };
  }) => ipcRenderer.invoke('export:htmlToPdf', options) as Promise<{ success: boolean; error?: string }>,
  exportSessionToHtml: (options: { sessionId: string }) =>
    ipcRenderer.invoke('export:sessionToHtml', options) as Promise<{ success: boolean; filePath?: string; error?: string }>,
  exportSessionToClipboard: (options: { sessionId: string }) =>
    ipcRenderer.invoke('export:sessionToClipboard', options) as Promise<{ success: boolean; error?: string }>,

  // Share operations
  shareSessionAsLink: (options: { sessionId: string; expirationDays?: number; personalOrgId?: string }) =>
    ipcRenderer.invoke('share:sessionAsLink', options) as Promise<{ success: boolean; url?: string; shareId?: string; isUpdate?: boolean; encryptionKey?: string; owningPersonalOrgId?: string; error?: string }>,
  getShareAccountOptions: (options: { contentType: 'session' | 'file'; sessionId?: string; filePath?: string }) =>
    ipcRenderer.invoke('share:get-account-options', options) as Promise<{ success: boolean; accounts?: Array<{ personalOrgId: string; email: string; isSyncAccount: boolean; sessionStatus: 'active' | 'expired' }>; defaultPersonalOrgId?: string; defaultSource?: 'workspace-binding' | 'sync-account' | 'only-account'; error?: string }>,
  listShares: () =>
    ipcRenderer.invoke('share:list') as Promise<{ success: boolean; shares?: Array<{ shareId: string; sessionId: string; title: string; sizeBytes: number; createdAt: string; expiresAt: string | null; viewCount: number; owningPersonalOrgId: string }>; error?: string }>,
  deleteShare: (options: { shareId: string; sessionId?: string; owningPersonalOrgId?: string }) =>
    ipcRenderer.invoke('share:delete', options) as Promise<{ success: boolean; error?: string }>,
  getShareKeys: () =>
    ipcRenderer.invoke('share:getKeys') as Promise<Record<string, string>>,
  shareFileAsLink: (options: { filePath: string; expirationDays?: number; personalOrgId?: string }) =>
    ipcRenderer.invoke('share:fileAsLink', options) as Promise<{ success: boolean; url?: string; shareId?: string; isUpdate?: boolean; encryptionKey?: string; owningPersonalOrgId?: string; error?: string }>,
  getShareExpirationPreference: () =>
    ipcRenderer.invoke('share:getExpirationPreference') as Promise<number>,
  setShareExpirationPreference: (days: number) =>
    ipcRenderer.invoke('share:setExpirationPreference', days) as Promise<void>,

  // Window operations
  setDocumentEdited: (edited: boolean) => ipcRenderer.send('set-document-edited', edited),
  setTitle: (title: string) => ipcRenderer.send('set-title', title),
  /** Report user activity for sync presence awareness */
  reportUserActivity: () => ipcRenderer.send('user-activity'),
  /** Set the idle threshold for sync presence (in milliseconds). For testing, use 10000 (10 seconds). */
  setSyncIdleThreshold: (ms: number) => ipcRenderer.invoke('sync:set-idle-threshold', ms),
  /** Set sleep prevention mode: 'off', 'always', or 'pluggedIn'. */
  setSyncPreventSleep: (mode: 'off' | 'always' | 'pluggedIn') => ipcRenderer.invoke('sync:set-prevent-sleep', mode),

  // Get initial window state
  getInitialState: () => ipcRenderer.invoke('get-initial-state'),
  // Workspace operations
  getFolderContents: (dirPath: string) => ipcRenderer.invoke('get-folder-contents', dirPath),
  refreshFolderContents: (folderPath: string) => ipcRenderer.invoke('refresh-folder-contents', folderPath),
  createFile: (filePath: string, content: string) => ipcRenderer.invoke('create-file', filePath, content),
  createFolder: (folderPath: string) => ipcRenderer.invoke('create-folder', folderPath),
  switchWorkspaceFile: (filePath: string) => ipcRenderer.invoke('switch-workspace-file', filePath),
  readFileContent: (filePath: string, options?: { binary?: boolean }) => ipcRenderer.invoke('read-file-content', filePath, options),

  // File context menu operations
  renameFile: (oldPath: string, newName: string) => ipcRenderer.invoke('rename-file', oldPath, newName),
  deleteFile: (filePath: string) => ipcRenderer.invoke('delete-file', filePath),
  openInDefaultApp: (filePath: string) => ipcRenderer.invoke('open-in-default-app', filePath),
  openInExternalEditor: (filePath: string) => ipcRenderer.invoke('open-in-external-editor', filePath),
  openSessionManager: (filterWorkspace?: string) => ipcRenderer.invoke('open-session-manager', filterWorkspace),
  showInFinder: (filePath: string) => ipcRenderer.invoke('show-in-finder', filePath),
  moveFile: (sourcePath: string, targetPath: string) => ipcRenderer.invoke('move-file', sourcePath, targetPath),
  copyFile: (sourcePath: string, targetPath: string) => ipcRenderer.invoke('copy-file', sourcePath, targetPath),
  // Electron 32 removed File.path; renderers must call webUtils.getPathForFile()
  // (only available in preload). Returns '' if Electron cannot resolve a path
  // for the File (e.g. synthetic blobs).
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  copyToClipboard: (text: string) => ipcRenderer.invoke('copy-to-clipboard', text),
  copyImageToClipboard: (payload: { filePath?: string; dataUrl?: string }) =>
    ipcRenderer.invoke('copy-image-to-clipboard', payload),
  readClipboard: () => ipcRenderer.invoke('read-from-clipboard'),

  // File change event listeners
  onFileRenamed: (callback: (data: { oldPath: string; newPath: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('file-renamed', handler);
    return () => ipcRenderer.removeListener('file-renamed', handler);
  },

  onFileMoved: (callback: (data: { sourcePath: string; destinationPath: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('file-moved', handler);
    return () => ipcRenderer.removeListener('file-moved', handler);
  },

  onFileCopied: (callback: (data: { sourcePath: string; destinationPath: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('file-copied', handler);
    return () => ipcRenderer.removeListener('file-copied', handler);
  },

  onWorkspaceFileTreeUpdated: (callback: (data: { fileTree: any[]; addedPath?: string; removedPath?: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('workspace-file-tree-updated', handler);
    return () => ipcRenderer.removeListener('workspace-file-tree-updated', handler);
  },

  onFileChangedOnDisk: (callback: (data: { path: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('file-changed-on-disk', handler);
    return () => ipcRenderer.removeListener('file-changed-on-disk', handler);
  },

  // Settings operations
  getSidebarWidth: (workspacePath: string) => ipcRenderer.invoke('get-sidebar-width', workspacePath),
  setSidebarWidth: (workspacePath: string, width: number) => ipcRenderer.send('set-sidebar-width', { workspacePath, width }),
  // AI Chat state has been moved to unified workspace state - use invoke('workspace:get-state', path) instead

  // QuickOpen operations
  buildQuickOpenCache: (workspacePath: string) => ipcRenderer.invoke('build-quick-open-cache', workspacePath),
  searchWorkspaceFiles: (workspacePath: string, query: string) => ipcRenderer.invoke('search-workspace-files', workspacePath, query),
  searchWorkspaceFileNames: (workspacePath: string, query: string, options?: { fileMask?: string | null }) =>
    ipcRenderer.invoke('search-workspace-file-names', workspacePath, query, options),
  searchWorkspaceFileContent: (workspacePath: string, query: string) => ipcRenderer.invoke('search-workspace-file-content', workspacePath, query),
  getRecentWorkspaceFiles: (workspacePath?: string) => ipcRenderer.invoke('get-recent-workspace-files', workspacePath),
  addToWorkspaceRecentFiles: (filePath: string) => ipcRenderer.send('add-to-workspace-recent-files', filePath),

  // Tab state has been moved to unified workspace state - use invoke('workspace:get-state', path) instead

  // History operations
  history: {
    createSnapshot: (filePath: string, state: string, type: string, description?: string) =>
      ipcRenderer.invoke('history:create-snapshot', filePath, state, type, description),
    listSnapshots: (filePath: string) =>
      ipcRenderer.invoke('history:list-snapshots', filePath),
    loadSnapshot: (filePath: string, timestamp: string) =>
      ipcRenderer.invoke('history:load-snapshot', filePath, timestamp),
    deleteSnapshot: (filePath: string, timestamp: string) =>
      ipcRenderer.invoke('history:delete-snapshot', filePath, timestamp),
    getPendingTags: (filePath?: string) =>
      ipcRenderer.invoke('history:get-pending-tags', filePath),
    createTag: (workspacePath: string, filePath: string, tagId: string, content: string, sessionId: string, toolUseId: string) =>
      ipcRenderer.invoke('history:create-tag', workspacePath, filePath, tagId, content, sessionId, toolUseId),
    getTag: (filePath: string, tagId: string) =>
      ipcRenderer.invoke('history:get-tag', filePath, tagId),
    updateTagStatus: (filePath: string, tagId: string, status: string, workspacePath?: string) =>
      ipcRenderer.invoke('history:update-tag-status', filePath, tagId, status, workspacePath),
    updateTagContent: (filePath: string, tagId: string, content: string) =>
      ipcRenderer.invoke('history:update-tag-content', filePath, tagId, content),
    getPendingCount: (workspacePath: string) =>
      ipcRenderer.invoke('history:get-pending-count', workspacePath),
    getPendingCountForSession: (workspacePath: string, sessionId: string) =>
      ipcRenderer.invoke('history:get-pending-count-for-session', workspacePath, sessionId),
    getPendingFilesForSession: (workspacePath: string, sessionId: string) =>
      ipcRenderer.invoke('history:get-pending-files-for-session', workspacePath, sessionId),
    clearAllPending: (workspacePath: string) =>
      ipcRenderer.invoke('history:clear-all-pending', workspacePath),
    clearPendingForSession: (workspacePath: string, sessionId: string) =>
      ipcRenderer.invoke('history:clear-pending-for-session', workspacePath, sessionId),
    onPendingCountChanged: (callback: (data: { workspacePath: string; count: number }) => void) => {
      const handler = (_event: any, data: { workspacePath: string; count: number }) => callback(data);
      ipcRenderer.on('history:pending-count-changed', handler);
      return () => ipcRenderer.removeListener('history:pending-count-changed', handler);
    },
    onPendingCleared: (callback: (data: { workspacePath: string; sessionId?: string; clearedFiles: string[] }) => void) => {
      const handler = (_event: any, data: { workspacePath: string; sessionId?: string; clearedFiles: string[] }) => callback(data);
      ipcRenderer.on('history:pending-cleared', handler);
      return () => ipcRenderer.removeListener('history:pending-cleared', handler);
    },
  },

  // Session operations
  session: {
    create: (filePath: string, type: string, source?: any) =>
      ipcRenderer.invoke('session:create', filePath, type, source),
    load: (sessionId: string) =>
      ipcRenderer.invoke('session:load', sessionId),
    save: (session: any) =>
      ipcRenderer.invoke('session:save', session),
    delete: (sessionId: string) =>
      ipcRenderer.invoke('session:delete', sessionId),
    getActive: (filePath: string) =>
      ipcRenderer.invoke('session:get-active', filePath),
    setActive: (filePath: string, sessionId: string, type: string) =>
      ipcRenderer.invoke('session:set-active', filePath, sessionId, type),
    checkConflicts: (session: any, currentMarkdownHash: string) =>
      ipcRenderer.invoke('session:check-conflicts', session, currentMarkdownHash),
    resolveConflict: (session: any, resolution: string, newBaseHash?: string) =>
      ipcRenderer.invoke('session:resolve-conflict', session, resolution, newBaseHash),
    createCheckpoint: (sessionId: string, state: string) =>
      ipcRenderer.invoke('session:create-checkpoint', sessionId, state),
  },

  // Session state tracking operations
  sessionState: {
    getTrackedSessionIds: () =>
      ipcRenderer.invoke('ai-session-state:get-tracked'),
    getRunningSessionIds: () =>
      ipcRenderer.invoke('ai-session-state:get-running'),
    getSessionState: (sessionId: string) =>
      ipcRenderer.invoke('ai-session-state:get-state', sessionId),
    isSessionActive: (sessionId: string) =>
      ipcRenderer.invoke('ai-session-state:is-active', sessionId),
    subscribe: (workspacePath?: string | string[]) =>
      ipcRenderer.invoke('ai-session-state:subscribe', workspacePath),
    unsubscribe: () =>
      ipcRenderer.invoke('ai-session-state:unsubscribe'),
    startSession: (sessionId: string, workspacePath?: string) =>
      ipcRenderer.invoke('ai-session-state:start', sessionId, workspacePath),
    updateActivity: (sessionId: string, status?: string, isStreaming?: boolean) =>
      ipcRenderer.invoke('ai-session-state:update-activity', sessionId, status, isStreaming),
    endSession: (sessionId: string) =>
      ipcRenderer.invoke('ai-session-state:end', sessionId),
    interruptSession: (sessionId: string) =>
      ipcRenderer.invoke('ai-session-state:interrupt', sessionId),
    onStateChange: (callback: (event: any) => void) => {
      const existing = sessionStateEventListenerMap.get(callback);
      if (existing) {
        ipcRenderer.removeListener('ai-session-state:event', existing);
      }
      const handler = (_event: any, data: any) => callback(data);
      sessionStateEventListenerMap.set(callback, handler);
      ipcRenderer.on('ai-session-state:event', handler);
    },
    removeStateChangeListener: (callback: (event: any) => void) => {
      const handler = sessionStateEventListenerMap.get(callback);
      if (!handler) return;
      ipcRenderer.removeListener('ai-session-state:event', handler);
      sessionStateEventListenerMap.delete(callback);
    },
  },

  // AI operations (new unified interface)
  aiHasApiKey: () => ipcRenderer.invoke('ai:hasApiKey'),
  aiInitialize: (provider?: string, apiKey?: string) => ipcRenderer.invoke('ai:initialize', provider, apiKey),
  aiCreateSession: (provider: 'claude' | 'claude-code' | 'claude-code-cli' | 'openai' | 'openai-codex' | 'opencode' | 'copilot-cli' | 'lmstudio', documentContext?: any, workspacePath?: string, modelId?: string, sessionType?: string, worktreeId?: string) => {
    // console.log('[Preload] aiCreateSession called:', { provider, workspacePath, sessionType, worktreeId });
    return ipcRenderer.invoke('ai:createSession', provider, documentContext, workspacePath, modelId, sessionType, worktreeId);
  },
  aiSendMessage: (message: string, documentContext?: any, sessionId?: string, workspacePath?: string) =>
    ipcRenderer.invoke('ai:sendMessage', message, documentContext, sessionId, workspacePath),
  aiGetSessions: (workspacePath?: string) => ipcRenderer.invoke('ai:getSessions', workspacePath),
  aiLoadSession: (sessionId: string, workspacePath?: string, trackAsResume?: boolean) => ipcRenderer.invoke('ai:loadSession', sessionId, workspacePath, trackAsResume),
  aiClearSession: () => ipcRenderer.invoke('ai:clearSession'),
  aiUpdateSessionMessages: (sessionId: string, messages: any[], workspacePath?: string) =>
    ipcRenderer.invoke('ai:updateSessionMessages', sessionId, messages, workspacePath),
  aiSaveDraftInput: (sessionId: string, draftInput: string, workspacePath?: string) =>
    ipcRenderer.invoke('ai:saveDraftInput', sessionId, draftInput, workspacePath),
  aiDeleteSession: (sessionId: string, workspacePath?: string) => ipcRenderer.invoke('ai:deleteSession', sessionId, workspacePath),

  // Flat-key settings (see shared/settings/keys.ts and main/services/SettingsService.ts).
  // settingsGetAll seeds every atom at startup; settingsSet is the only write path.
  // settings:changed is broadcast from main on every mutation.
  settingsGetAll: () => ipcRenderer.invoke('settings:getAll'),
  settingsSet: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
  settingsDelete: (key: string) => ipcRenderer.invoke('settings:delete', key),
  onSettingsChanged: (callback: (payload: { key: string; value: unknown }) => void) => {
    const handler = (_event: any, payload: { key: string; value: unknown }) => callback(payload);
    ipcRenderer.on('settings:changed', handler);
    return () => ipcRenderer.removeListener('settings:changed', handler);
  },

  getAISettings: () => ipcRenderer.invoke('ai:getSettings'),
  saveAISettings: (settings: any) => ipcRenderer.invoke('ai:saveSettings', settings),
  testAIConnection: (provider: 'claude' | 'claude-code' | 'openai' | 'lmstudio') => ipcRenderer.invoke('ai:testConnection', provider),
  getAIModels: () => ipcRenderer.invoke('ai:getModels'),
  // Aliases for consistency with component naming
  aiGetSettings: () => ipcRenderer.invoke('ai:getSettings'),
  aiSaveSettings: (settings: any) => ipcRenderer.invoke('ai:saveSettings', settings),
  aiTestConnection: (provider: string, workspacePath?: string) =>
    ipcRenderer.invoke('ai:testConnection', provider, workspacePath),
  aiGetModels: () => ipcRenderer.invoke('ai:getModels'),
  aiGetAllModels: () => ipcRenderer.invoke('ai:getAllModels'),
  aiClearModelCache: () => ipcRenderer.invoke('ai:clearModelCache'),
  aiRefreshSessionProvider: (sessionId: string) => ipcRenderer.invoke('ai:refreshSessionProvider', sessionId),

  // CLI management
  cliCheckInstallation: (tool: string) => ipcRenderer.invoke('cli:checkInstallation', tool),
  cliInstall: (tool: string, options: any) => ipcRenderer.invoke('cli:install', tool, options),
  cliUninstall: (tool: string) => ipcRenderer.invoke('cli:uninstall', tool),
  cliUpgrade: (tool: string) => ipcRenderer.invoke('cli:upgrade', tool),
  cliCheckNpmAvailable: () => ipcRenderer.invoke('cli:checkNpmAvailable'),
  cliInstallNodeJs: () => ipcRenderer.invoke('cli:installNodeJs'),
  cliCheckClaudeCodeWindowsInstallation: (): Promise<ClaudeForWindowsInstallation> => ipcRenderer.invoke('cli:checkClaudeCodeWindowsInstallation'),

  // AI event listeners (new)
  onAIStreamResponse: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('ai:streamResponse', handler);
    return () => ipcRenderer.removeListener('ai:streamResponse', handler);
  },
  onAIError: (callback: (error: any) => void) => {
    const handler = (_event: any, error: any) => callback(error);
    ipcRenderer.on('ai:error', handler);
    return () => ipcRenderer.removeListener('ai:error', handler);
  },
  onAIApplyDiff: (callback: (data: { replacements: any[], resultChannel: string, targetFilePath?: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('ai:applyDiff', handler);
    return () => ipcRenderer.removeListener('ai:applyDiff', handler);
  },
  onAIStreamEditStart: (callback: (config: any) => void) => {
    const handler = (_event: any, config: any) => callback(config);
    ipcRenderer.on('ai:streamEditStart', handler);
    return () => ipcRenderer.removeListener('ai:streamEditStart', handler);
  },
  onAIStreamEditContent: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('ai:streamEditContent', handler);
    return () => ipcRenderer.removeListener('ai:streamEditContent', handler);
  },
  onAIStreamEditEnd: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('ai:streamEditEnd', handler);
    return () => ipcRenderer.removeListener('ai:streamEditEnd', handler);
  },
  onAIPerformanceMetrics: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('ai:performanceMetrics', handler);
    return () => ipcRenderer.removeListener('ai:performanceMetrics', handler);
  },
  onAIGetDocumentContent: (callback: (data: { resultChannel: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('ai:getDocumentContent', handler);
    return () => ipcRenderer.removeListener('ai:getDocumentContent', handler);
  },
  onAIUpdateFrontmatter: (callback: (data: { updates: Record<string, any>, resultChannel: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('ai:updateFrontmatter', handler);
    return () => ipcRenderer.removeListener('ai:updateFrontmatter', handler);
  },
  onAICreateDocument: (callback: (data: { filePath: string; initialContent?: string; switchToFile?: boolean; resultChannel: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('ai:createDocument', handler);
    return () => ipcRenderer.removeListener('ai:createDocument', handler);
  },

  // AI result senders
  sendAIApplyDiffResult: (resultChannel: string, result: any) => {
    ipcRenderer.send(resultChannel, result);
  },
  sendAIGetDocumentContentResult: (resultChannel: string, result: any) => {
    ipcRenderer.send(resultChannel, result);
  },
  sendAIUpdateFrontmatterResult: (resultChannel: string, result: any) => {
    ipcRenderer.send(resultChannel, result);
  },
  sendAICreateDocumentResult: (resultChannel: string, result: any) => {
    ipcRenderer.send(resultChannel, result);
  },

  // Additional AI operations that weren't in the first block
  aiCancelRequest: (sessionId: string) => ipcRenderer.invoke('ai:cancelRequest', sessionId),
  aiApplyEdit: (edit: any) => ipcRenderer.invoke('ai:applyEdit', edit),
  onAIEditRequest: (callback: (edit: any) => void) => {
    const handler = (_event: any, edit: any) => callback(edit);
    ipcRenderer.on('ai:editRequest', handler);
    return () => ipcRenderer.removeListener('ai:editRequest', handler);
  },

  // MCP Server operations
  onMcpApplyDiff: (callback: (data: { replacements: any[], resultChannel: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('mcp:applyDiff', handler);
    return () => ipcRenderer.removeListener('mcp:applyDiff', handler);
  },
  onMcpStreamContent: (callback: (data: { streamId: string, content: string, position: string, insertAfter?: string, mode?: string, targetFilePath?: string, resultChannel: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('mcp:streamContent', handler);
    return () => ipcRenderer.removeListener('mcp:streamContent', handler);
  },
  onMcpReadCollabDoc: (callback: (data: { targetFilePath: string, resultChannel: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('mcp:readCollabDoc', handler);
    return () => ipcRenderer.removeListener('mcp:readCollabDoc', handler);
  },
  sendMcpReadCollabDocResult: (resultChannel: string, result: { success: boolean; content?: string; error?: string }) => {
    ipcRenderer.send(resultChannel, result);
  },
  // Shared-index (first-class shared folders + documents) MCP operations.
  onMcpCreateSharedDoc: (callback: (data: { title: string, documentType?: string, parentFolderId?: string | null, folderPath?: string, initialContent?: string, resultChannel: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('mcp:createSharedDoc', handler);
    return () => ipcRenderer.removeListener('mcp:createSharedDoc', handler);
  },
  onMcpCreateSharedFolder: (callback: (data: { name: string, parentFolderId?: string | null, folderPath?: string, resultChannel: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('mcp:createSharedFolder', handler);
    return () => ipcRenderer.removeListener('mcp:createSharedFolder', handler);
  },
  onMcpMoveSharedItem: (callback: (data: { itemId: string, kind: 'doc' | 'folder', newParentFolderId?: string | null, folderPath?: string, resultChannel: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('mcp:moveSharedItem', handler);
    return () => ipcRenderer.removeListener('mcp:moveSharedItem', handler);
  },
  onMcpRenameSharedItem: (callback: (data: { itemId: string, kind: 'doc' | 'folder', newName: string, resultChannel: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('mcp:renameSharedItem', handler);
    return () => ipcRenderer.removeListener('mcp:renameSharedItem', handler);
  },
  onMcpDeleteSharedItem: (callback: (data: { itemId: string, kind: 'doc' | 'folder', resultChannel: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('mcp:deleteSharedItem', handler);
    return () => ipcRenderer.removeListener('mcp:deleteSharedItem', handler);
  },
  // Generic reply for all shared-index tools; the result payload varies per tool
  // (documentId / folderId / removedCount) but always carries { success, error? }.
  sendMcpCollabIndexResult: (resultChannel: string, result: { success: boolean; error?: string; [key: string]: unknown }) => {
    ipcRenderer.send(resultChannel, result);
  },
  onMcpNavigateTo: (callback: (data: { line: number, column: number }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('mcp:navigateTo', handler);
    return () => ipcRenderer.removeListener('mcp:navigateTo', handler);
  },
  sendMcpApplyDiffResult: (resultChannel: string, result: any) => {
    // Ensure result has the required structure
    const safeResult = {
      success: result?.success ?? false,
      error: result?.error || (result?.success === false ? 'Unknown error' : undefined)
    };
    ipcRenderer.send(resultChannel, safeResult);
  },
  sendMcpStreamContentResult: (resultChannel: string, result: any) => {
    // Ensure result has the required structure
    const safeResult = {
      success: result?.success ?? false,
      error: result?.error || (result?.success === false ? 'Unknown error' : undefined)
    };
    ipcRenderer.send(resultChannel, safeResult);
  },
  updateMcpDocumentState: (state: any) =>
    ipcRenderer.send('mcp:updateDocumentState', state),
  clearMcpDocumentState: () => ipcRenderer.invoke('mcp:clearDocumentState'),

  // Git commit proposal - widget renders directly from tool call data
  // Response sent via messages:respond-to-prompt channel

  // Extension tool registration for MCP
  registerExtensionTools: (workspacePath: string, tools: any[]) =>
    ipcRenderer.send('mcp:registerExtensionTools', { workspacePath, tools }),
  onExecuteExtensionTool: (callback: (data: { toolName: string; args: any; resultChannel: string; context: any }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('mcp:executeExtensionTool', handler);
    return () => ipcRenderer.removeListener('mcp:executeExtensionTool', handler);
  },
  sendExtensionToolResult: (resultChannel: string, result: any) =>
    ipcRenderer.send(resultChannel, result),

  // AI object wrapper for cleaner component access
  ai: {
    hasApiKey: () => ipcRenderer.invoke('ai:hasApiKey'),
    initialize: (provider?: string, apiKey?: string) => ipcRenderer.invoke('ai:initialize', provider, apiKey),
    createSession: (provider: 'claude' | 'claude-code' | 'claude-code-cli' | 'openai' | 'openai-codex' | 'lmstudio', documentContext?: any, workspacePath?: string, modelId?: string, sessionType?: string, worktreeId?: string) =>
      ipcRenderer.invoke('ai:createSession', provider, documentContext, workspacePath, modelId, sessionType, worktreeId),
    sendMessage: (message: string, documentContext?: any, sessionId?: string, workspacePath?: string) =>
      ipcRenderer.invoke('ai:sendMessage', message, documentContext, sessionId, workspacePath),
    getSessions: (workspacePath?: string) => ipcRenderer.invoke('ai:getSessions', workspacePath),
    getSessionList: (workspacePath?: string) => ipcRenderer.invoke('ai:getSessionList', workspacePath),
    loadSession: (sessionId: string, workspacePath?: string, trackAsResume?: boolean) => ipcRenderer.invoke('ai:loadSession', sessionId, workspacePath, trackAsResume),
    clearSession: () => ipcRenderer.invoke('ai:clearSession'),
    updateSessionMessages: (sessionId: string, messages: any[], workspacePath?: string) =>
      ipcRenderer.invoke('ai:updateSessionMessages', sessionId, messages, workspacePath),
    saveDraftInput: (sessionId: string, draftInput: string, workspacePath?: string) =>
      ipcRenderer.invoke('ai:saveDraftInput', sessionId, draftInput, workspacePath),
    deleteSession: (sessionId: string, workspacePath?: string) => ipcRenderer.invoke('ai:deleteSession', sessionId, workspacePath),
    getSettings: () => ipcRenderer.invoke('ai:getSettings'),
    saveSettings: (settings: any) => ipcRenderer.invoke('ai:saveSettings', settings),
    testConnection: (provider: string) => ipcRenderer.invoke('ai:testConnection', provider),
    getModels: () => ipcRenderer.invoke('ai:getModels'),

    // Session Manager specific methods
    getAllSessions: () => ipcRenderer.invoke('session-manager:get-all-sessions'),
    openSessionInWindow: (sessionId: string, workspacePath?: string) =>
      ipcRenderer.invoke('session-manager:open-session', sessionId, workspacePath),
    exportSession: (session: any) => ipcRenderer.invoke('session-manager:export-session', session),

    // Full-text search index management
    // FTS index - TODO: migrate to canonical transcript events
    getFtsIndexStatus: (_workspaceId: string) =>
      Promise.resolve({ indexExists: true, messageCount: 0 }) as Promise<{ indexExists: boolean; messageCount: number; error?: string }>,
    buildFtsIndex: () =>
      Promise.resolve({ success: true }) as Promise<{ success: boolean; error?: string }>,

    // Canonical transcript queries
    listUserPrompts: (workspacePath: string, limit?: number) =>
      ipcRenderer.invoke('transcript:list-user-prompts', workspacePath, limit) as Promise<{ success: boolean; prompts: any[] }>,
    getTailMessages: (sessionId: string, count?: number) =>
      ipcRenderer.invoke('transcript:get-tail-messages', sessionId, count) as Promise<any[]>,
  },

  // Workspace Manager
  workspaceManager: {
    getRecentWorkspaces: () => ipcRenderer.invoke('workspace-manager:get-recent-workspaces'),
    getWorkspaceStats: (workspacePath: string) => ipcRenderer.invoke('workspace-manager:get-workspace-stats', workspacePath),
    openFolderDialog: () => ipcRenderer.invoke('workspace-manager:open-folder-dialog'),
    createWorkspaceDialog: () => ipcRenderer.invoke('workspace-manager:create-workspace-dialog'),
    openWorkspace: (workspacePath: string, options?: { forceNewWindow?: boolean }) =>
      ipcRenderer.invoke('workspace-manager:open-workspace', workspacePath, options),
    removeRecent: (workspacePath: string) => ipcRenderer.invoke('workspace-manager:remove-recent', workspacePath),
    getOpenWorkspaces: () => ipcRenderer.invoke('workspace-manager:get-open-workspaces') as Promise<string[]>,
  },

  // Project Migration (move/rename)
  projectMigration: {
    canMove: (oldPath: string) => ipcRenderer.invoke('project:can-move', oldPath) as Promise<{ canMove: boolean; reason?: string }>,
    move: (oldPath: string, newPath: string) => ipcRenderer.invoke('project:move', oldPath, newPath) as Promise<{ success: boolean; error?: string; newPath?: string }>,
    rename: (oldPath: string, newName: string) => ipcRenderer.invoke('project:rename', oldPath, newName) as Promise<{ success: boolean; error?: string; newPath?: string }>,
  },


  // Document Service
  documentService: {
    list: () => ipcRenderer.invoke('document-service:list'),
    search: (query: string) => ipcRenderer.invoke('document-service:search', query),
    get: (id: string) => ipcRenderer.invoke('document-service:get', id),
    getByPath: (path: string) => ipcRenderer.invoke('document-service:get-by-path', path),
    open: (id: string, fallback?: { path?: string; name?: string }) => ipcRenderer.invoke('document-service:open', { documentId: id, fallback }),
    watch: () => ipcRenderer.send('document-service:watch'),
    onDocumentsChanged: (callback: (documents: any[]) => void) => {
      const handler = (_event: any, documents: any[]) => callback(documents);
      ipcRenderer.on('document-service:documents-changed', handler);
      return () => ipcRenderer.removeListener('document-service:documents-changed', handler);
    },
    loadVirtual: (virtualPath: string) => ipcRenderer.invoke('document-service:load-virtual', virtualPath),
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
    }) => ipcRenderer.invoke('document-service:create-tracker-item', item) as Promise<{ success: boolean; item?: any; error?: string }>,
    updateTrackerItem: (payload: {
      itemId: string;
      updates: Record<string, any>;
      syncMode?: string;
    }) => ipcRenderer.invoke('document-service:update-tracker-item', payload) as Promise<{ success: boolean; item?: any; error?: string }>,
    setTrackerItemShared: (payload: {
      itemId: string;
      shared: boolean;
    }) => ipcRenderer.invoke('document-service:set-tracker-item-shared', payload) as Promise<{ success: boolean; item?: any; error?: string }>,
    updateTrackerItemContent: (payload: {
      itemId: string;
      content: any;
    }) => ipcRenderer.invoke('document-service:tracker-item-update-content', payload) as Promise<{ success: boolean; error?: string }>,
    getTrackerItemContent: (payload: {
      itemId: string;
    }) => ipcRenderer.invoke('document-service:tracker-item-get-content', payload) as Promise<{ success: boolean; content?: any; error?: string }>,
    getTrackerBodyCacheForDetail: (payload: {
      itemId: string;
    }) => ipcRenderer.invoke('document-service:get-tracker-body-cache-for-detail', payload) as Promise<{
      success: boolean;
      row?: { bodyVersion: number; content: any } | null;
      error?: string;
    }>,
    archiveTrackerItem: (payload: {
      itemId: string;
      archive: boolean;
    }) => ipcRenderer.invoke('document-service:tracker-item-archive', payload) as Promise<{ success: boolean; item?: any; error?: string }>,
    deleteTrackerItem: (payload: {
      itemId: string;
    }) => ipcRenderer.invoke('document-service:tracker-item-delete', payload) as Promise<{ success: boolean; error?: string }>,
    updateTrackerItemInFile: (payload: {
      itemId: string;
      updates: Record<string, any>;
    }) => ipcRenderer.invoke('document-service:tracker-item-update-in-file', payload) as Promise<{ success: boolean; item?: any; error?: string }>,
    importTrackerItemFromFile: (payload: {
      relativePath: string;
      skipDuplicates?: boolean;
    }) => ipcRenderer.invoke('document-service:tracker-item-import-file', payload) as Promise<{ success: boolean; item?: any; skipped?: boolean; error?: string }>,
    bulkImportTrackerItems: (payload: {
      directory: string;
      skipDuplicates?: boolean;
      recursive?: boolean;
    }) => ipcRenderer.invoke('document-service:tracker-item-bulk-import', payload) as Promise<{ success: boolean; imported?: number; skipped?: number; errors?: string[]; error?: string }>,
  },

  // Tracker Sync
  trackerSync: {
    getStatus: () => ipcRenderer.invoke('tracker-sync:get-status') as Promise<{ status: string; projectId: string | null; active: boolean }>,
    connect: (workspacePath: string) => ipcRenderer.invoke('tracker-sync:connect', { workspacePath }) as Promise<{ success: boolean; status?: string; projectId?: string; error?: string }>,
    disconnect: () => ipcRenderer.invoke('tracker-sync:disconnect') as Promise<{ success: boolean }>,
    upsertItem: (item: any) => ipcRenderer.invoke('tracker-sync:upsert-item', { item }) as Promise<{ success: boolean; error?: string }>,
    deleteItem: (itemId: string) => ipcRenderer.invoke('tracker-sync:delete-item', { itemId }) as Promise<{ success: boolean; error?: string }>,
    // Epic H2 admin action: migrate this workspace's team to server-managed key
    // custody and re-upload local tracker data as plaintext.
    migrateToServerManaged: (orgId: string, workspacePath?: string) => ipcRenderer.invoke('tracker-sync:migrate-to-server-managed', { orgId, workspacePath }) as Promise<{ success: boolean; orgId?: string; itemsMarked?: number; schemasMarked?: number; workspacesMarked?: string[]; error?: string }>,
    onStatusChanged: (callback: (status: string) => void) => {
      const handler = (_event: any, status: string) => callback(status);
      ipcRenderer.on('tracker-sync:status-changed', handler);
      return () => ipcRenderer.removeListener('tracker-sync:status-changed', handler);
    },
    onItemUpserted: (callback: (data: { itemId: string; type: string; title: string; status: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('tracker-sync:item-upserted', handler);
      return () => ipcRenderer.removeListener('tracker-sync:item-upserted', handler);
    },
    onItemDeleted: (callback: (data: { itemId: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('tracker-sync:item-deleted', handler);
      return () => ipcRenderer.removeListener('tracker-sync:item-deleted', handler);
    },
  },

  // Global semantic search (nimbalyst-memory engine). Returns empty / false when
  // the memory extension is disabled so the Quick Open Search tab can hide.
  semanticSearch: {
    isAvailable: (workspacePath: string) =>
      ipcRenderer.invoke('semantic-search:available', workspacePath) as Promise<boolean>,
    query: (workspacePath: string, query: string, k?: number, sourceClasses?: string[]) =>
      ipcRenderer.invoke('semantic-search:query', workspacePath, query, k, sourceClasses) as Promise<
        Array<{
          refType: string;
          refId: string;
          sourceClass: string;
          sourcePath: string;
          title: string;
          snippet: string;
          score: number;
          signals: { dense: boolean; sparse: boolean };
        }>
      >,
  },

  // Tracker Schema (main-process authority)
  trackerSchema: {
    getAll: () => ipcRenderer.invoke('tracker-schema:get-all') as Promise<any[]>,
    get: (type: string) => ipcRenderer.invoke('tracker-schema:get', type) as Promise<any | null>,
    getRoleField: (type: string, role: string) => ipcRenderer.invoke('tracker-schema:get-role-field', type, role) as Promise<string | null>,
    getFieldByRole: (type: string, role: string) => ipcRenderer.invoke('tracker-schema:get-field-by-role', type, role) as Promise<any | null>,
    onChanged: (callback: (schemas: any[]) => void) => {
      const handler = (_event: any, schemas: any[]) => callback(schemas);
      ipcRenderer.on('tracker-schema:changed', handler);
      return () => ipcRenderer.removeListener('tracker-schema:changed', handler);
    },
  },

  // Plaintext recovery copies for collaborative content
  collabBackup: {
    contentChanged: (payload: {
      workspacePath: string;
      documentId: string;
      documentType: string;
      title?: string;
      plaintext: string;
      kind?: 'document' | 'body';
    }) => ipcRenderer.invoke('collab-backup:content-changed', payload) as Promise<{ success: boolean; scheduled?: boolean; error?: string }>,
    backupAll: (workspacePath: string) => ipcRenderer.invoke('collab-backup:backup-all', { workspacePath }) as Promise<any>,
    list: (workspacePath: string) => ipcRenderer.invoke('collab-backup:list', { workspacePath }) as Promise<any>,
    restore: (workspacePath: string, documentId: string, force?: boolean) => ipcRenderer.invoke('collab-backup:restore', { workspacePath, documentId, force }) as Promise<{ success: boolean; error?: string }>,
  },

  // Document Sync (collaborative editing)
  documentSync: {
    open: (
      workspacePath: string,
      documentId: string,
      title?: string,
      documentType?: string,
    ) =>
      ipcRenderer.invoke('document-sync:open', { workspacePath, documentId, title, documentType }) as Promise<{
        success: boolean;
        config?: {
          orgId: string;
          documentId: string;
          title: string;
          documentType?: string;
          orgKeyBase64: string;
          orgKeyFingerprint?: string;
          serverUrl: string;
          accountId: string;
          userId: string;
          userName?: string;
          userEmail?: string;
          pendingUpdateBase64?: string;
        };
        error?: string;
      }>,
    setPendingUpdate: (
      workspacePath: string,
      orgId: string,
      documentId: string,
      pendingUpdateBase64: string | null
    ) =>
      ipcRenderer.invoke('document-sync:set-pending-update', {
        workspacePath,
        orgId,
        documentId,
        pendingUpdateBase64,
      }) as Promise<{ success: boolean; error?: string }>,
    replicaLoad: (workspacePath: string, identity: LocalReplicaIdentity) =>
      ipcRenderer.invoke('document-sync:replica-load', { workspacePath, identity }) as Promise<LoadedLocalReplica | null>,
    replicaAppendLocal: (workspacePath: string, input: AppendLocalReplicaUpdateInput) =>
      ipcRenderer.invoke('document-sync:replica-append-local', { workspacePath, input }) as Promise<void>,
    onReplicaLocalUpdate: (callback: (payload: {
      identity: LocalReplicaIdentity;
      updateId: string;
      update: Uint8Array;
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: {
        identity: LocalReplicaIdentity;
        updateId: string;
        update: Uint8Array;
      }) => callback(payload);
      ipcRenderer.on('document-sync:replica-local-update', handler);
      return () => ipcRenderer.removeListener('document-sync:replica-local-update', handler);
    },
    replicaAppendRemote: (workspacePath: string, input: AppendRemoteReplicaUpdatesInput) =>
      ipcRenderer.invoke('document-sync:replica-append-remote', { workspacePath, input }) as Promise<void>,
    replicaSetOutboxState: (
      workspacePath: string,
      identity: LocalReplicaIdentity,
      batchIds: string[],
      state: LocalReplicaOutboxState,
      lastErrorCode?: string | null,
    ) => ipcRenderer.invoke('document-sync:replica-set-outbox-state', {
      workspacePath, identity, batchIds, state, lastErrorCode,
    }) as Promise<void>,
    replicaClaimOutbox: (
      workspacePath: string,
      identity: LocalReplicaIdentity,
      batchIds: string[],
    ) => ipcRenderer.invoke('document-sync:replica-claim-outbox', {
      workspacePath, identity, batchIds,
    }) as Promise<boolean>,
    replicaLoadOutbox: (
      workspacePath: string,
      identity: LocalReplicaIdentity,
    ) => ipcRenderer.invoke('document-sync:replica-load-outbox', {
      workspacePath, identity,
    }) as Promise<LocalReplicaOutboxEntry[]>,
    replicaRecordOutboxError: (
      workspacePath: string,
      identity: LocalReplicaIdentity,
      batchIds: string[],
      errorCode: string,
    ) => ipcRenderer.invoke('document-sync:replica-record-outbox-error', {
      workspacePath, identity, batchIds, errorCode,
    }) as Promise<void>,
    replicaAckOutbox: (
      workspacePath: string,
      identity: LocalReplicaIdentity,
      batchIds: string[],
      serverSequence: number,
    ) => ipcRenderer.invoke('document-sync:replica-ack-outbox', {
      workspacePath, identity, batchIds, serverSequence,
    }) as Promise<void>,
    replicaReplaceSnapshot: (workspacePath: string, input: ReplaceLocalReplicaSnapshotInput) =>
      ipcRenderer.invoke('document-sync:replica-replace-snapshot', { workspacePath, input }) as Promise<boolean>,
    replicaMarkIncomplete: (workspacePath: string, identity: LocalReplicaIdentity) =>
      ipcRenderer.invoke('document-sync:replica-mark-incomplete', { workspacePath, identity }) as Promise<void>,
    replicaMarkComplete: (workspacePath: string, identity: LocalReplicaIdentity) =>
      ipcRenderer.invoke('document-sync:replica-mark-complete', { workspacePath, identity }) as Promise<void>,
    replicaQuarantine: (workspacePath: string, identity: LocalReplicaIdentity, reason: string) =>
      ipcRenderer.invoke('document-sync:replica-quarantine', { workspacePath, identity, reason }) as Promise<void>,
    replicaResetForCleanHydration: (workspacePath: string, identity: LocalReplicaIdentity) =>
      ipcRenderer.invoke('document-sync:replica-reset-clean-hydration', { workspacePath, identity }) as Promise<void>,
    replicaDiscard: (workspacePath: string, identity: LocalReplicaIdentity) =>
      ipcRenderer.invoke('document-sync:replica-discard', { workspacePath, identity }) as Promise<void>,
    replicaPurgeAccount: (workspacePath: string, accountId: string) =>
      ipcRenderer.invoke('document-sync:replica-purge-account', { workspacePath, accountId }) as Promise<void>,
    replicaPurgeOrg: (workspacePath: string, accountId: string, orgId: string) =>
      ipcRenderer.invoke('document-sync:replica-purge-org', { workspacePath, accountId, orgId }) as Promise<void>,
    replicaStorageUsage: (workspacePath: string, accountId: string) =>
      ipcRenderer.invoke('document-sync:replica-storage-usage', { workspacePath, accountId }) as Promise<LocalReplicaStorageUsage>,
    replicaListPendingOutboxes: (workspacePath: string, accountId?: string) =>
      ipcRenderer.invoke('document-sync:replica-list-pending-outboxes', { workspacePath, accountId }) as Promise<LocalReplicaPendingOutbox[]>,
    setReplicaProviderAttached: (
      identity: LocalReplicaIdentity,
      attachmentId: string,
      attached: boolean,
    ) => ipcRenderer.invoke('document-sync:replica-provider-attached', {
      identity, attachmentId, attached,
    }) as Promise<void>,
    seedSharedDocument: (
      workspacePath: string,
      documentId: string,
      documentType: string,
      content: string,
    ) =>
      ipcRenderer.invoke('document-sync:seed-shared-document', {
        workspacePath,
        documentId,
        documentType,
        content,
      }) as Promise<{ success: boolean; error?: string }>,
    // Forward a serializable collab adapter descriptor so the main process can
    // rebuild the adapter (dynamic main-process adapters for any extension).
    registerCollabAdapterDescriptor: (descriptor: unknown) =>
      ipcRenderer.invoke('collab-adapter:register-descriptor', descriptor) as Promise<{
        success: boolean;
        error?: string;
      }>,
    getLocalOrigin: (workspacePath: string, documentId: string) =>
      ipcRenderer.invoke('document-sync:get-local-origin', {
        workspacePath,
        documentId,
      }) as Promise<{
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
      }>,
    saveLocalOrigin: (payload: {
      workspacePath: string;
      documentId: string;
      documentType: string;
      sourceFilePath: string;
      lastLocalContentHash: string | null;
      lastCollabContentHash: string | null;
    }) =>
      ipcRenderer.invoke('document-sync:save-local-origin', payload) as Promise<{
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
      }>,
    relinkLocalOrigin: (payload: {
      workspacePath: string;
      documentId: string;
      documentType: string;
      sourceFilePath: string;
    }) =>
      ipcRenderer.invoke('document-sync:relink-local-origin', payload) as Promise<{
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
      }>,
    clearLocalOrigin: (workspacePath: string, documentId: string) =>
      ipcRenderer.invoke('document-sync:clear-local-origin', {
        workspacePath,
        documentId,
      }) as Promise<{ success: boolean; error?: string }>,
    reuploadLocalOrigin: (payload: {
      workspacePath: string;
      documentId: string;
      forceOverwriteShared?: boolean;
    }) =>
      ipcRenderer.invoke('document-sync:reupload-local-origin', payload) as Promise<{
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
      }>,
    findLocalOriginLink: (workspacePath: string, sourceFilePath: string) =>
      ipcRenderer.invoke('document-sync:find-local-origin-link', {
        workspacePath,
        sourceFilePath,
      }) as Promise<{
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
      }>,
    getJwt: (orgId: string, forceRefresh?: boolean) =>
      ipcRenderer.invoke('document-sync:get-jwt', { orgId, forceRefresh }) as Promise<{
        success: boolean;
        jwt?: string;
        error?: string;
      }>,
    resolveIndexConfig: (workspacePath: string) =>
      ipcRenderer.invoke('document-sync:resolve-index-config', { workspacePath }) as Promise<{
        success: boolean;
        config?: {
          orgId: string;
          orgKeyBase64: string;
          orgKeyFingerprint: string | null;
          serverUrl: string;
          userId: string;
        };
        error?: string;
      }>,
    // WebSocket proxy: create WebSocket connections in main process (Node.js)
    // to work around Cloudflare blocking browser WebSocket upgrades
    wsConnect: (url: string) =>
      ipcRenderer.invoke('document-sync:ws-connect', { url }) as Promise<{
        success: boolean;
        wsId?: string;
        error?: string;
      }>,
    wsSend: (wsId: string, data: string) =>
      ipcRenderer.invoke('document-sync:ws-send', { wsId, data }) as Promise<{
        success: boolean;
        error?: string;
      }>,
    wsClose: (wsId: string) =>
      ipcRenderer.invoke('document-sync:ws-close', { wsId }) as Promise<{
        success: boolean;
      }>,
    onWsEvent: (callback: (data: {
      wsId: string;
      type: 'open' | 'message' | 'close' | 'error';
      data?: string;
      code?: number;
      reason?: string;
      error?: string;
    }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('document-sync:ws-event', handler);
      return () => ipcRenderer.removeListener('document-sync:ws-event', handler);
    },
    // Personal document sync (mobile markdown sync)
    isPersonalSyncAvailable: () =>
      ipcRenderer.invoke('document-sync:is-personal-sync-available') as Promise<{ available: boolean }>,
    getSyncId: (filePath: string, workspacePath: string) =>
      ipcRenderer.invoke('document-sync:get-sync-id', { filePath, workspacePath }) as Promise<{
        success: boolean;
        syncId?: string;
        error?: string;
      }>,
    resolvePersonalConfig: (filePath: string, workspacePath: string) =>
      ipcRenderer.invoke('document-sync:resolve-personal-config', { filePath, workspacePath }) as Promise<{
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
      }>,
    getPersonalJwt: () =>
      ipcRenderer.invoke('document-sync:get-personal-jwt') as Promise<{
        success: boolean;
        jwt?: string;
        error?: string;
      }>,

    // Collaborative document attachments
    closeDoc: (documentId: string) =>
      ipcRenderer.invoke('document-sync:close-doc', { documentId }) as Promise<{
        success: boolean;
        error?: string;
      }>,
    uploadAsset: (payload: {
      orgId: string;
      documentId: string;
      fileBytes: ArrayBuffer;
      mimeType: string;
      fileName: string;
    }) =>
      ipcRenderer.invoke('document-sync:upload-asset', payload) as Promise<{
        success: boolean;
        assetId?: string;
        uri?: string;
        queued?: boolean;
        error?: string;
      }>,
    migrateLocalAssets: (payload: {
      workspacePath: string;
      orgId: string;
      documentId: string;
      sourceFilePath: string;
      markdown: string;
    }) =>
      ipcRenderer.invoke('document-sync:migrate-local-assets', payload) as Promise<{
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
      }>,
    gcAssets: (payload: {
      orgId: string;
      documentId: string;
      removedUris: string[];
    }) =>
      ipcRenderer.invoke('document-sync:gc-assets', payload) as Promise<{
        success: boolean;
        requested?: number;
        deleted?: number;
        failed?: number;
        skipped?: number;
        error?: string;
      }>,
  },

  // Worktree operations
  worktreeCreate: (workspacePath: string, options?: { name?: string; baseBranch?: string }) =>
    ipcRenderer.invoke('worktree:create', workspacePath, options),
  worktreeGetStatus: (worktreePath: string, options?: { fetchFirst?: boolean }) =>
    ipcRenderer.invoke('worktree:get-status', worktreePath, options),
  worktreeGetByPath: (worktreePath: string) =>
    ipcRenderer.invoke('worktree:get-by-path', worktreePath),
  worktreeDelete: (worktreeId: string, workspacePath: string) =>
    ipcRenderer.invoke('worktree:delete', worktreeId, workspacePath),
  worktreeList: (workspacePath: string) =>
    ipcRenderer.invoke('worktree:list', workspacePath),
  worktreeGet: (id: string) =>
    ipcRenderer.invoke('worktree:get', id),
  worktreeRebase: (worktreePath: string) =>
    ipcRenderer.invoke('worktree:rebase', worktreePath),
  worktreeArchive: (worktreeId: string, workspacePath: string) =>
    ipcRenderer.invoke('worktree:archive', worktreeId, workspacePath),
  worktreeListGitignored: (worktreePath: string) =>
    ipcRenderer.invoke('worktree:list-gitignored', worktreePath),
  worktreeCleanGitignored: (worktreePath: string) =>
    ipcRenderer.invoke('worktree:clean-gitignored', worktreePath),

  // PR review panel — gh CLI status (Phase A of issue #307)
  ghCliStatus: () => ipcRenderer.invoke('pr:gh-status'),
  ghCliRefreshStatus: () => ipcRenderer.invoke('pr:gh-refresh-status'),
  onGhCliStatusChanged: (callback: (status: GhCliStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: GhCliStatus) => callback(status);
    ipcRenderer.on('pr:gh-status-changed', handler);
    return () => ipcRenderer.removeListener('pr:gh-status-changed', handler);
  },

  // PR review panel — GitHub API via `gh api` (Phase C of issue #307)
  prDetectRemote: (workspacePath: string) =>
    ipcRenderer.invoke('pr:detect-remote', workspacePath),
  prList: (workspaceId: string, remote: string, filters?: unknown) =>
    ipcRenderer.invoke('pr:list', workspaceId, remote, filters),
  prGet: (workspaceId: string, remote: string, number: number) =>
    ipcRenderer.invoke('pr:get', workspaceId, remote, number),
  prFiles: (workspaceId: string, remote: string, number: number) =>
    ipcRenderer.invoke('pr:files', workspaceId, remote, number),
  prFileContents: (workspaceId: string, remote: string, ref: string, path: string) =>
    ipcRenderer.invoke('pr:file-contents', workspaceId, remote, ref, path),
  prCommits: (workspaceId: string, remote: string, number: number) =>
    ipcRenderer.invoke('pr:commits', workspaceId, remote, number),
  prChecks: (workspaceId: string, remote: string, number: number) =>
    ipcRenderer.invoke('pr:checks', workspaceId, remote, number),
  prConversation: (workspaceId: string, remote: string, number: number) =>
    ipcRenderer.invoke('pr:conversation', workspaceId, remote, number),
  prConversationRefresh: (workspaceId: string, remote: string, number: number) =>
    ipcRenderer.invoke('pr:conversation', workspaceId, remote, number, true),
  prReviewThreads: (workspaceId: string, remote: string, number: number) =>
    ipcRenderer.invoke('pr:review-threads', workspaceId, remote, number),
  prRefresh: (workspaceId: string, remote: string, number?: number) =>
    ipcRenderer.invoke('pr:refresh', workspaceId, remote, number),

  // PR review panel — review/merge actions + access control (issue #307)
  prPermissions: (workspaceId: string, remote: string, number: number) =>
    ipcRenderer.invoke('pr:permissions', workspaceId, remote, number),
  prApprove: (workspaceId: string, remote: string, number: number, body?: string) =>
    ipcRenderer.invoke('pr:approve', workspaceId, remote, number, body),
  prComment: (workspaceId: string, remote: string, number: number, body: string) =>
    ipcRenderer.invoke('pr:comment', workspaceId, remote, number, body),
  prMerge: (
    workspaceId: string,
    remote: string,
    number: number,
    method: string,
    commitTitle?: string,
    commitMessage?: string,
  ) => ipcRenderer.invoke('pr:merge', workspaceId, remote, number, method, commitTitle, commitMessage),

  // PR review panel — polling scheduler (Phase D of issue #307)
  prStartPolling: (workspacePath: string, workspaceId: string, remote: string) =>
    ipcRenderer.invoke('pr:start-polling', workspacePath, workspaceId, remote),
  prStopPolling: (workspacePath: string) =>
    ipcRenderer.invoke('pr:stop-polling', workspacePath),
  prPollNow: (workspacePath: string) =>
    ipcRenderer.invoke('pr:poll-now', workspacePath),
  prFocus: (workspacePath: string, focused: boolean) =>
    ipcRenderer.send('pr:focus', { workspacePath, focused }),
  prOpenWorktree: (workspacePath: string, remote: string, number: number) =>
    ipcRenderer.invoke('pr:open-worktree', workspacePath, remote, number),

  // PR review panel — per-project gh account selection (issue #307)
  prGhAccounts: () => ipcRenderer.invoke('pr:gh-accounts'),
  prGetAccountConfig: (workspacePath?: string) =>
    ipcRenderer.invoke('pr:get-account-config', workspacePath),
  prSetDefaultAccount: (login: string | null) =>
    ipcRenderer.invoke('pr:set-default-account', login),
  prSetAccountOverride: (workspacePath: string, login: string | null) =>
    ipcRenderer.invoke('pr:set-account-override', workspacePath, login),
  onPrListUpdated: (callback: (payload: { workspacePath: string; remote: string }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { workspacePath: string; remote: string },
    ) => callback(payload);
    ipcRenderer.on('pr:list-updated', handler);
    return () => ipcRenderer.removeListener('pr:list-updated', handler);
  },

  // Archive progress operations
  archive: {
    getTasks: () => ipcRenderer.invoke('archive:get-tasks'),
    onProgress: (callback: (tasks: ArchiveTask[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, tasks: ArchiveTask[]) => callback(tasks);
      ipcRenderer.on('archive:progress', handler);
      return () => ipcRenderer.removeListener('archive:progress', handler);
    },
  },

  // Open external links
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openThirdPartyNotices: () => ipcRenderer.invoke('legal:open-third-party-notices'),

  // Image operations
  openImageInDefaultApp: (imagePath: string) => ipcRenderer.invoke('image:open-in-default-app', imagePath),
  startImageDrag: (imagePath: string) => ipcRenderer.invoke('image:start-drag', imagePath),

  // analytics
  analytics: {
    allowedToSendAnalytics: () => ipcRenderer.invoke('analytics:allowed'),
    getDistinctId: () => ipcRenderer.invoke('analytics:get-distinct-id'),
    optIn: () => ipcRenderer.invoke('analytics:opt-in'),
    optOut: () => ipcRenderer.invoke('analytics:opt-out'),
    setSessionId: (sessionId: string) => ipcRenderer.invoke('analytics:set-session-id', sessionId),
  },

  // Feature usage tracking (local UX decisions -- tips, walkthroughs, onboarding)
  featureUsage: {
    record: (feature: string) => ipcRenderer.invoke('feature-usage:record', feature),
    get: (feature: string) => ipcRenderer.invoke('feature-usage:get', feature),
    getCount: (feature: string) => ipcRenderer.invoke('feature-usage:get-count', feature),
    getAll: () => ipcRenderer.invoke('feature-usage:get-all'),
  },

  // Credentials (for sync and mobile pairing)
  credentials: {
    get: () => ipcRenderer.invoke('credentials:get'),
    reset: () => ipcRenderer.invoke('credentials:reset'),
    generateQRPayload: (serverUrl: string) =>
      ipcRenderer.invoke('credentials:generate-qr-payload', serverUrl),
    isSecure: () => ipcRenderer.invoke('credentials:is-secure'),
  },

  // Network utilities
  network: {
    getLocalIP: () => ipcRenderer.invoke('network:get-local-ip'),
  },

  // Environment utilities
  environment: {
    /** Get the enhanced PATH that Nimbalyst uses for spawning processes (includes custom paths, detected paths, system paths) */
    getEnhancedPath: () => ipcRenderer.invoke('environment:get-enhanced-path') as Promise<string>,
  },

  // Stytch Authentication (for account-based sync)
  stytch: {
    getAuthState: () => ipcRenderer.invoke('stytch:get-auth-state'),
    getAccounts: () => ipcRenderer.invoke('stytch:get-accounts'),
    getSyncAccount: () => ipcRenderer.invoke('stytch:get-sync-account'),
    setSyncAccount: (personalOrgId: string) =>
      ipcRenderer.invoke('stytch:set-sync-account', personalOrgId),
    isAuthenticated: () => ipcRenderer.invoke('stytch:is-authenticated'),
    signInWithGoogle: () => ipcRenderer.invoke('stytch:sign-in-google'),
    sendMagicLink: (email: string) =>
      ipcRenderer.invoke('stytch:send-magic-link', email),
    signOut: (forceOfflinePurge = false) =>
      ipcRenderer.invoke('stytch:sign-out', forceOfflinePurge),
    addAccount: () => ipcRenderer.invoke('stytch:add-account'),
    removeAccount: (personalOrgId: string, forceOfflinePurge = false) =>
      ipcRenderer.invoke('stytch:remove-account', personalOrgId, forceOfflinePurge),
    deleteAccount: (personalOrgId?: string) => ipcRenderer.invoke('stytch:delete-account', personalOrgId),
    getSessionJwt: () => ipcRenderer.invoke('stytch:get-session-jwt'),
    refreshSession: () => ipcRenderer.invoke('stytch:refresh-session'),
    subscribeAuthState: () => ipcRenderer.invoke('stytch:subscribe-auth-state'),
    onAuthStateChange: (callback: (state: any) => void) => {
      const handler = (_event: any, state: any) => callback(state);
      ipcRenderer.on('stytch:auth-state-changed', handler);
      return () => ipcRenderer.removeListener('stytch:auth-state-changed', handler);
    },
    // Dev only: switch between test and live Stytch environments
    switchEnvironment: (environment: 'development' | 'production') =>
      ipcRenderer.invoke('stytch:switch-environment', environment),
  },

  // Team Management (all member ops take explicit orgId -- per-workspace, not global)
  team: {
    list: () => ipcRenderer.invoke('team:list'),
    /** Open (or focus + retarget) the dedicated org-management window. */
    openManagementWindow: (target?: { orgId?: string; workspacePath?: string }) =>
      ipcRenderer.invoke('team-window:open', target),
    findForWorkspace: (workspacePath: string) => ipcRenderer.invoke('team:find-for-workspace', workspacePath),
    get: (orgId: string) => ipcRenderer.invoke('team:get', orgId),
    create: (name: string, workspacePath?: string, accountOrgId?: string) => ipcRenderer.invoke('team:create', name, workspacePath, accountOrgId),
    // Epic H3 P0: add a project to an EXISTING org (distinct from create, which
    // mints a new org). Returns { projectId, teamProjectId }.
    addProject: (orgId: string, workspacePath?: string, name?: string) => ipcRenderer.invoke('team:add-project', orgId, workspacePath, name),
    // Epic H3 P0/A: enumerate every project in an org (member-gated).
    listProjects: (orgId: string) => ipcRenderer.invoke('team:list-projects', orgId),
    // Epic H3 P3: move-project wizard. Preview is read-only; move is destructive (admin on both orgs).
    moveProjectPreview: (srcOrgId: string, projectId: string, destOrgId: string) =>
      ipcRenderer.invoke('team:move-project-preview', srcOrgId, projectId, destOrgId),
    moveProject: (srcOrgId: string, projectId: string, destOrgId: string, dropMemberEmails?: string[]) =>
      ipcRenderer.invoke('team:move-project', srcOrgId, projectId, destOrgId, dropMemberEmails),
    // Epic H3 P4: merge this org into another (move all projects + roster union + optional delete).
    mergeOrg: (drainedOrgId: string, survivorOrgId: string, deleteDrained: boolean, dropMemberEmails?: string[]) =>
      ipcRenderer.invoke('team:merge-org', drainedOrgId, survivorOrgId, deleteDrained, dropMemberEmails),
    acceptInvite: (orgId: string) => ipcRenderer.invoke('team:accept-invite', orgId),
    listMembers: (orgId: string) => ipcRenderer.invoke('team:list-members', orgId),
    invite: (orgId: string, email: string) => ipcRenderer.invoke('team:invite', orgId, email),
    removeMember: (orgId: string, memberId: string) => ipcRenderer.invoke('team:remove-member', orgId, memberId),
    deleteTeam: (orgId: string) => ipcRenderer.invoke('team:delete', orgId),
    updateRole: (orgId: string, memberId: string, role: string) => ipcRenderer.invoke('team:update-role', orgId, memberId, role),
    getGitRemote: (workspacePath: string) => ipcRenderer.invoke('team:get-git-remote', workspacePath),
    ensureOrgKey: (orgId: string) => ipcRenderer.invoke('team:ensure-org-key', orgId),
    getOrgKeyStatus: (orgId: string) => ipcRenderer.invoke('team:get-org-key-status', orgId),
    // Epic H2: current key-custody mode for the team (legacy-e2e | server-managed).
    getKeyCustodyStatus: (orgId: string) => ipcRenderer.invoke('team:get-key-custody-status', orgId) as Promise<{ success: boolean; mode?: 'legacy-e2e' | 'server-managed'; dekFingerprint?: string | null; error?: string }>,
    getEncryptionMigrationStatus: (orgId: string) => ipcRenderer.invoke('team:get-encryption-migration-status', orgId) as Promise<{
      success: boolean;
      migration?:
        | { status: 'migrating'; startedAt: string }
        | { status: 'complete'; finishedAt: string }
        | { status: 'stuck'; failedAt: string; message: string }
        | null;
    }>,
    listKeyEnvelopes: (orgId: string) => ipcRenderer.invoke('team:list-key-envelopes', orgId),
    setProjectIdentity: (orgId: string, workspacePath: string) => ipcRenderer.invoke('team:set-project-identity', orgId, workspacePath),
    clearProjectIdentity: (orgId: string) => ipcRenderer.invoke('team:clear-project-identity', orgId),
    ensureWorkspaceKey: (workspacePath: string) => ipcRenderer.invoke('team:ensure-workspace-key', workspacePath),
    getMemberFingerprint: (orgId: string, memberId: string) => ipcRenderer.invoke('team:get-member-fingerprint', orgId, memberId),
    getMyFingerprint: (orgId: string) => ipcRenderer.invoke('team:get-my-fingerprint', orgId),
    verifyMember: (orgId: string, memberId: string, fingerprint: string) => ipcRenderer.invoke('team:verify-member', orgId, memberId, fingerprint),
    revokeMemberTrust: (orgId: string, memberId: string) => ipcRenderer.invoke('team:revoke-member-trust', orgId, memberId),
    reshareKey: (orgId: string, memberId: string) => ipcRenderer.invoke('team:reshare-key', orgId, memberId),
    refreshMyKey: (orgId: string) => ipcRenderer.invoke('team:refresh-my-key', orgId),
    autoWrapNewMembers: (orgId: string) => ipcRenderer.invoke('team:auto-wrap-new-members', orgId),
    // NIM-913: admin repair — force re-wrap the current org key for all members.
    rewrapAllMemberKeys: (orgId: string) => ipcRenderer.invoke('team:rewrap-all-member-keys', orgId),
  },

  // Typed organization facade. The legacy `team` bridge remains as a
  // compatibility adapter while settings and older extensions migrate.
  organization: {
    list: () => ipcRenderer.invoke('team:list'),
    get: (orgId: string) => ipcRenderer.invoke('team:get', orgId),
    create: (input: { name: string; workspacePath?: string; sourcePersonalOrgId?: string }) =>
      ipcRenderer.invoke('team:create', input.name, input.workspacePath, input.sourcePersonalOrgId),
    acceptInvitation: (orgId: string) => ipcRenderer.invoke('team:accept-invite', orgId),
    listMembers: (orgId: string) => ipcRenderer.invoke('team:list-members', orgId),
    inviteMember: (orgId: string, email: string) => ipcRenderer.invoke('team:invite', orgId, email),
    removeMember: (orgId: string, memberId: string) => ipcRenderer.invoke('team:remove-member', orgId, memberId),
    updateMemberRole: (orgId: string, memberId: string, role: string) => ipcRenderer.invoke('team:update-role', orgId, memberId, role),
    listProjects: (orgId: string) => ipcRenderer.invoke('team:list-projects', orgId),
    addProject: (input: { orgId: string; workspacePath?: string; name?: string }) =>
      ipcRenderer.invoke('team:add-project', input.orgId, input.workspacePath, input.name),
    moveProject: (input: { sourceOrgId: string; projectId: string; destinationOrgId: string; dropMemberEmails?: string[] }) =>
      ipcRenderer.invoke('team:move-project', input.sourceOrgId, input.projectId, input.destinationOrgId, input.dropMemberEmails),
    deleteOrganization: (orgId: string) => ipcRenderer.invoke('team:delete', orgId),
    getEncryptionStatus: (orgId: string) => ipcRenderer.invoke('team:get-key-custody-status', orgId),
    getEncryptionMigrationStatus: (orgId: string) => ipcRenderer.invoke('team:get-encryption-migration-status', orgId),
  },

  // Epic H1: org / project access model. `canAccess` is the single client-side
  // permission check; `syncProjection` refreshes the local org/member/grant
  // projection from the server; project-access grant/revoke/list manage the
  // per-project member set.
  org: {
    canAccess: (input: { orgId?: string | null; projectId?: string | null; action: 'view' | 'edit' | 'admin' }) =>
      ipcRenderer.invoke('org:can-access', input),
    syncProjection: () => ipcRenderer.invoke('org:sync-projection'),
    grantProjectAccess: (orgId: string, projectId: string, userId: string, projectRole: string) =>
      ipcRenderer.invoke('org:grant-project-access', orgId, projectId, userId, projectRole),
    revokeProjectAccess: (orgId: string, projectId: string, userId: string) =>
      ipcRenderer.invoke('org:revoke-project-access', orgId, projectId, userId),
    listProjectAccess: (orgId: string, projectId: string) =>
      ipcRenderer.invoke('org:list-project-access', orgId, projectId),
    // Live write-through from TeamSync DO broadcasts into the local projection.
    applyProjectAccess: (projectId: string, userId: string, projectRole: string | null) =>
      ipcRenderer.invoke('org:apply-project-access', projectId, userId, projectRole),
    applyMemberUpserted: (orgId: string, userId: string, email: string | null, role: string) =>
      ipcRenderer.invoke('org:apply-member-upserted', orgId, userId, email, role),
    applyMemberRoleChanged: (orgId: string, userId: string, role: string) =>
      ipcRenderer.invoke('org:apply-member-role-changed', orgId, userId, role),
    applyMemberRemoved: (orgId: string, userId: string) =>
      ipcRenderer.invoke('org:apply-member-removed', orgId, userId),
  },

  // Extensions API
  extensions: {
    listInstalled: () => ipcRenderer.invoke('extensions:list-installed'),
    getAllSettings: () => ipcRenderer.invoke('extensions:get-all-settings'),
    getEnabled: (extensionId: string, defaultEnabled?: boolean) => ipcRenderer.invoke('extensions:get-enabled', extensionId, defaultEnabled),
    setEnabled: (extensionId: string, enabled: boolean) => ipcRenderer.invoke('extensions:set-enabled', extensionId, enabled),
    setClaudePluginEnabled: (extensionId: string, enabled: boolean) => ipcRenderer.invoke('extensions:set-claude-plugin-enabled', extensionId, enabled),
    setAgentWorkflowsEnabled: (extensionId: string, enabled: boolean) => ipcRenderer.invoke('extensions:set-agent-workflows-enabled', extensionId, enabled),
    getClaudePluginCommands: () => ipcRenderer.invoke('extensions:get-claude-plugin-commands') as Promise<Array<{
      extensionId: string;
      extensionName: string;
      pluginName: string;
      pluginNamespace: string;
      commandName: string;
      description: string;
    }>>,
    // Configuration with scope support (user = global, workspace = per-project)
    getConfig: (extensionId: string, scope?: 'user' | 'workspace', workspacePath?: string) =>
      ipcRenderer.invoke('extensions:get-config', extensionId, scope, workspacePath),
    setConfig: (extensionId: string, key: string, value: unknown, scope?: 'user' | 'workspace', workspacePath?: string) =>
      ipcRenderer.invoke('extensions:set-config', extensionId, key, value, scope, workspacePath),
    setConfigBulk: (extensionId: string, configuration: Record<string, unknown>, scope?: 'user' | 'workspace', workspacePath?: string) =>
      ipcRenderer.invoke('extensions:set-config-bulk', extensionId, configuration, scope, workspacePath),

    // Extension Development Kit (EDK) - Hot-loading API
    devInstall: (extensionPath: string) =>
      ipcRenderer.invoke('extensions:dev-install', extensionPath) as Promise<{ success: boolean; extensionId?: string; symlinkPath?: string; error?: string }>,
    devUninstall: (extensionId: string) =>
      ipcRenderer.invoke('extensions:dev-uninstall', extensionId) as Promise<{ success: boolean; error?: string }>,
    devReload: (extensionId: string, extensionPath: string) =>
      ipcRenderer.invoke('extensions:dev-reload', extensionId, extensionPath) as Promise<{ success: boolean; error?: string }>,
    devUnload: (extensionId: string) =>
      ipcRenderer.invoke('extensions:dev-unload', extensionId) as Promise<{ success: boolean; error?: string }>,

    // Listen for hot-reload messages from main process
    onDevReload: (callback: (data: { extensionId: string; extensionPath: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('extension:dev-reload', handler);
      return () => ipcRenderer.removeListener('extension:dev-reload', handler);
    },
    onDevUnload: (callback: (data: { extensionId: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('extension:dev-unload', handler);
      return () => ipcRenderer.removeListener('extension:dev-unload', handler);
    },

    // Privileged-capability permissions (Phase 4)
    permissions: {
      listDescriptors: () => ipcRenderer.invoke('ext-permissions:list-descriptors'),
      listEffective: (workspacePath?: string) =>
        ipcRenderer.invoke('ext-permissions:list-effective', workspacePath),
      listAtScope: (scope: 'workspace' | 'global', workspacePath?: string) =>
        ipcRenderer.invoke('ext-permissions:list-at-scope', scope, workspacePath),
      listEnabledModules: (workspacePath?: string) =>
        ipcRenderer.invoke('ext-permissions:list-enabled-modules', workspacePath),
      isModuleEnabled: (args: {
        extensionId: string;
        moduleId: string;
        declaredPermissions: string[];
        workspacePath?: string;
      }) => ipcRenderer.invoke('ext-permissions:is-module-enabled', args),
      grantModule: (args: {
        extensionId: string;
        moduleId: string;
        permissions: string[];
        scope: 'workspace' | 'global';
        workspacePath?: string;
      }) => ipcRenderer.invoke('ext-permissions:grant-module', args),
      revokeModule: (args: {
        extensionId: string;
        moduleId: string;
        scope: 'workspace' | 'global';
        workspacePath: string;
      }) => ipcRenderer.invoke('ext-permissions:revoke-module', args),
      handleUninstall: (args: { extensionId: string; workspacePath?: string }) =>
        ipcRenderer.invoke('ext-permissions:handle-uninstall', args),
      listHostState: () => ipcRenderer.invoke('ext-permissions:list-host-state'),
      usageSummary: () => ipcRenderer.invoke('ext-permissions:usage-summary'),
      usageEventsForModule: (args: { extensionId: string; moduleId: string }) =>
        ipcRenderer.invoke('ext-permissions:usage-events-for-module', args),
      usageEventsAll: () => ipcRenderer.invoke('ext-permissions:usage-events-all'),
      onStateChanged: (
        callback: (handle: {
          extensionId: string;
          moduleId: string;
          workspacePath: string;
          state: unknown;
        }) => void
      ) => {
        const handler = (_event: any, data: any) => callback(data);
        ipcRenderer.on('ext-permissions:state-changed', handler);
        return () => ipcRenderer.removeListener('ext-permissions:state-changed', handler);
      },
      // Prompt bridge - renderer subscribes, shows modal, resolves
      onPromptRaised: (
        callback: (request: {
          id: string;
          extensionId: string;
          extensionName: string;
          moduleId: string;
          purpose: string;
          declaredPermissions: string[];
          workspacePath: string;
          reason: { kind: 'first-use' } | { kind: 're-prompt-update'; addedPermissions: string[]; existingScopes: Array<'workspace' | 'global'> };
          raisedAt: number;
        }) => void
      ) => {
        const handler = (_event: any, data: any) => callback(data);
        ipcRenderer.on('ext-permission-prompt:raise', handler);
        return () => ipcRenderer.removeListener('ext-permission-prompt:raise', handler);
      },
      onPromptResolved: (callback: (data: { promptId: string }) => void) => {
        const handler = (_event: any, data: any) => callback(data);
        ipcRenderer.on('ext-permission-prompt:resolved', handler);
        return () => ipcRenderer.removeListener('ext-permission-prompt:resolved', handler);
      },
      resolvePrompt: (
        promptId: string,
        resolution: { decision: 'enable-workspace' | 'enable-global' | 'not-now' }
      ) => ipcRenderer.send('ext-permission-prompt:resolve', { promptId, resolution }),
      listPendingPrompts: () => ipcRenderer.invoke('ext-permission-prompt:list-pending'),
    },
  },

  // Claude Code API
  claudeCode: {
    getSettings: () => ipcRenderer.invoke('claudeCode:get-settings') as Promise<{ projectCommandsEnabled: boolean; userCommandsEnabled: boolean; apiUpstreamUrl?: string }>,
    setProjectCommandsEnabled: (enabled: boolean) => ipcRenderer.invoke('claudeCode:set-project-commands-enabled', enabled),
    setUserCommandsEnabled: (enabled: boolean) => ipcRenderer.invoke('claudeCode:set-user-commands-enabled', enabled),
    setApiUpstreamUrl: (url: string) => ipcRenderer.invoke('claudeCode:set-api-upstream-url', url) as Promise<{ success: true } | { success: false; error: string }>,
    // User-level environment variables (~/.claude/settings.json)
    getEnv: () => ipcRenderer.invoke('claudeSettings:get-env') as Promise<Record<string, string>>,
    setEnv: (env: Record<string, string>) => ipcRenderer.invoke('claudeSettings:set-env', env) as Promise<{ success: boolean }>,
  },

  agentWorkflows: {
    getSettings: () => ipcRenderer.invoke('agentWorkflows:get-settings') as Promise<{
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
    }>,
    setSourceSettings: (updates: {
      workspaceClaudeCompatibilityEnabled?: boolean;
      includeProjectClaudeSources?: boolean;
      includeUserClaudeSources?: boolean;
      extensionWorkflowsEnabled?: boolean;
    }) => ipcRenderer.invoke('agentWorkflows:set-source-settings', updates),
    setExportSettings: (updates: {
      codexEnabled?: boolean;
      claudeGeneratedExtensionWorkflowsEnabled?: boolean;
    }) => ipcRenderer.invoke('agentWorkflows:set-export-settings', updates),
  },

  // Extension Development Kit (EDK) API
  extensionDevTools: {
    isEnabled: () => ipcRenderer.invoke('extensionDevTools:is-enabled') as Promise<boolean>,
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('extensionDevTools:set-enabled', enabled) as Promise<void>,
    getLogs: (filter?: {
      extensionId?: string;
      lastSeconds?: number;
      logLevel?: 'error' | 'warn' | 'info' | 'debug' | 'all';
      source?: 'renderer' | 'main' | 'build' | 'all';
    }) => ipcRenderer.invoke('extensionDevTools:get-logs', filter) as Promise<{
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
    }>,
    clearLogs: (extensionId?: string) => ipcRenderer.invoke('extensionDevTools:clear-logs', extensionId) as Promise<void>,
    getProcessInfo: () => ipcRenderer.invoke('extensionDevTools:get-process-info') as Promise<{
      startTime: number;
      uptimeSeconds: number;
    }>,
  },

  // Git operations (real-time status events)
  git: {
    // Listen for git status changes (staging, unstaging, etc.)
    onStatusChanged: (callback: (data: { workspacePath: string }) => void) => {
      const handler = (_event: any, data: { workspacePath: string }) => callback(data);
      ipcRenderer.on('git:status-changed', handler);
      return () => ipcRenderer.removeListener('git:status-changed', handler);
    },
    // Listen for new commits detected (from any source: Nimbalyst, CLI, VS Code, etc.)
    onCommitDetected: (callback: (data: {
      workspacePath: string;
      commitHash: string;
      commitMessage: string;
      committedFiles: string[];
    }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('git:commit-detected', handler);
      return () => ipcRenderer.removeListener('git:commit-detected', handler);
    },
    // Clear git status cache (forces refresh on next query)
    clearStatusCache: (workspacePath?: string) =>
      ipcRenderer.invoke('git:clear-status-cache', workspacePath),
  },

  // Terminal operations
  terminal: {
    // New terminal store API
    create: (workspacePath: string, options?: { cwd?: string; worktreeId?: string; title?: string }) =>
      ipcRenderer.invoke('terminal:create', { workspacePath, ...options }),
    list: (workspacePath: string) =>
      ipcRenderer.invoke('terminal:list', workspacePath),
    get: (workspacePath: string, terminalId: string) =>
      ipcRenderer.invoke('terminal:get', workspacePath, terminalId),
    update: (workspacePath: string, terminalId: string, updates: { title?: string; cwd?: string }) =>
      ipcRenderer.invoke('terminal:update', workspacePath, terminalId, updates),
    delete: (workspacePath: string, terminalId: string) =>
      ipcRenderer.invoke('terminal:delete', workspacePath, terminalId),
    setActive: (workspacePath: string, terminalId: string | undefined) =>
      ipcRenderer.invoke('terminal:set-active', workspacePath, terminalId),
    getActive: (workspacePath: string) =>
      ipcRenderer.invoke('terminal:get-active', workspacePath),
    setTabOrder: (workspacePath: string, tabOrder: string[]) =>
      ipcRenderer.invoke('terminal:set-tab-order', workspacePath, tabOrder),
    getWorkspaceState: (workspacePath: string) =>
      ipcRenderer.invoke('terminal:get-workspace-state', workspacePath),

    // Panel state (per-workspace)
    getPanelState: (workspacePath: string) =>
      ipcRenderer.invoke('terminal:get-panel-state', workspacePath),
    updatePanelState: (workspacePath: string, updates: { panelHeight?: number; panelVisible?: boolean }) =>
      ipcRenderer.invoke('terminal:update-panel-state', workspacePath, updates),
    setPanelVisible: (workspacePath: string, visible: boolean) =>
      ipcRenderer.invoke('terminal:set-panel-visible', workspacePath, visible),
    setPanelHeight: (workspacePath: string, height: number) =>
      ipcRenderer.invoke('terminal:set-panel-height', workspacePath, height),

    // PTY operations
    initialize: (terminalId: string, options: { workspacePath: string; cwd?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('terminal:initialize', terminalId, options),
    // Launch the genuine `claude` CLI for a claude-code-cli session (NIM-806).
    // terminalId IS the Nimbalyst session id; idempotent.
    ensureClaudeCliSession: (payload: {
      sessionId: string;
      workspacePath: string;
      cwd?: string;
      model?: string;
      resumeSessionId?: string;
      cols?: number;
      rows?: number;
    }) => ipcRenderer.invoke('claude-cli:ensure-session', payload),
    // Whether the genuine `claude` CLI is installed (NIM-852). The transcript
    // checks this for a claude-code-cli session to show an install notice and
    // skip the spawn, rather than producing a cryptic `command not found`.
    isClaudeCliInstalled: (): Promise<boolean> =>
      ipcRenderer.invoke('claude-cli:is-installed'),
    // Submit a claude-code-cli prompt (NIM-806) — composes the PTY line (prompt +
    // inline attachment paths), writes it to the terminal, and logs the clean
    // typed prompt (+ attachment chips) as the transcript user row in the main
    // process. Replaces the prior log-only `logClaudeCliUserPrompt`.
    submitClaudeCliPrompt: (payload: {
      sessionId: string;
      workspacePath: string;
      prompt: string;
      attachments?: unknown[];
      // NIM-818: active-doc/selection context for the PTY context block.
      documentContext?: unknown;
    }) => ipcRenderer.invoke('claude-cli:submit-prompt', payload),
    // Switch a running claude-code-cli session's model via `/model` (NIM-806).
    setClaudeCliModel: (sessionId: string, model: string) =>
      ipcRenderer.invoke('claude-cli:set-model', { sessionId, model }),
    // Stop a claude-code-cli turn with escalation (NIM-814): Ctrl-C → Ctrl-C →
    // SIGINT, re-checking the PID turn state between steps.
    interruptClaudeCli: (sessionId: string) =>
      ipcRenderer.invoke('claude-cli:interrupt', sessionId),
    isActive: (terminalId: string) =>
      ipcRenderer.invoke('terminal:is-active', terminalId),
    write: (terminalId: string, data: string) =>
      ipcRenderer.invoke('terminal:write', terminalId, data),
    resize: (terminalId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:resize', terminalId, cols, rows),
    updateRenderState: (
      terminalId: string,
      updates: { workspacePath?: string; cols?: number; rows?: number; cursorX?: number; cursorY?: number; screenLines?: string[] }
    ) => ipcRenderer.invoke('terminal:update-render-state', terminalId, updates),
    getScrollback: (terminalId: string) =>
      ipcRenderer.invoke('terminal:get-scrollback', terminalId),
    getRestoreSnapshot: (workspacePath: string, terminalId: string) =>
      ipcRenderer.invoke('terminal:get-restore-snapshot', workspacePath, terminalId),
    clearScrollback: (terminalId: string) =>
      ipcRenderer.invoke('terminal:clear-scrollback', terminalId),
    destroy: (terminalId: string) =>
      ipcRenderer.invoke('terminal:destroy', terminalId),
    getInfo: (terminalId: string) =>
      ipcRenderer.invoke('terminal:get-info', terminalId),
    getAvailableShells: () =>
      ipcRenderer.invoke('terminal:get-available-shells'),

    // Events
    onOutput: (callback: (data: { sessionId: string; data: string; sequence: number }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('terminal:output', handler);
      return () => ipcRenderer.removeListener('terminal:output', handler);
    },
    onExited: (callback: (data: { sessionId: string; exitCode: number }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('terminal:exited', handler);
      return () => ipcRenderer.removeListener('terminal:exited', handler);
    },
    onCommandRunning: (callback: (data: { terminalId: string; isRunning: boolean }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('terminal:command-running', handler);
      return () => ipcRenderer.removeListener('terminal:command-running', handler);
    },

    // Legacy API (deprecated, for backward compatibility)
    /** @deprecated Use terminal.create instead */
    createSession: (workspacePath: string, options?: { cwd?: string; worktreeId?: string; worktreePath?: string }) =>
      ipcRenderer.invoke('terminal:create-session', { workspacePath, ...options }),
  },

  // Generic IPC methods for services that need them
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
  send: (channel: string, ...args: any[]) => ipcRenderer.send(channel, ...args),
  on: (channel: string, callback: (...args: any[]) => void) => {
    const handler = (_event: any, ...args: any[]) => callback(...args);

    // Increase max listeners for document service channels that may have multiple watchers
    if (channel.startsWith('document-service:')) {
      const currentMax = ipcRenderer.getMaxListeners();
      if (currentMax !== 0 && currentMax < 50) {
        ipcRenderer.setMaxListeners(50);
      }
    }

    ipcRenderer.on(channel, handler);
    // Store mapping from callback to handler for proper removal
    if (!(window as any).__ipcHandlers) {
      (window as any).__ipcHandlers = new WeakMap();
    }
    (window as any).__ipcHandlers.set(callback, { channel, handler });
    return () => ipcRenderer.removeListener(channel, handler);
  },
  off: (channel: string, callback: (...args: any[]) => void) => {
    // Look up the actual handler that was registered
    const handlerInfo = (window as any).__ipcHandlers?.get(callback);
    if (handlerInfo && handlerInfo.channel === channel) {
      ipcRenderer.removeListener(channel, handlerInfo.handler);
      (window as any).__ipcHandlers.delete(callback);
    } else {
      // Fallback: try to remove callback directly (won't work but maintains backward compat)
      ipcRenderer.removeListener(channel, callback);
    }
  }
});
