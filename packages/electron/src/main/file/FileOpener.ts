/**
 * FileOpener - Single, clean API for opening files in Nimbalyst
 *
 * This is the ONLY way files should be opened in the application.
 * All other file-opening code paths should route through this service.
 *
 * Design Principles:
 * 1. Single responsibility: Opening files and managing file state
 * 2. Window routing: Finds or creates the appropriate window
 * 3. Tab management: Handles both tab and non-tab modes
 * 4. State updates: Updates window state, watchers, analytics
 * 5. Clean errors: Throws on failures instead of returning null
 */

import { BrowserWindow, dialog } from 'electron';
import { readFileSync, existsSync } from 'fs';
import { basename, extname } from 'path';
import * as path from 'path';
import { shouldExcludeFile } from '../utils/fileFilters';
import {
  windowStates,
  getWindowId,
  createWindow,
  documentServices
} from '../window/WindowManager';
import { startFileWatcher } from './FileWatcher';
import { addWorkspaceRecentFile } from '../utils/store';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { logger } from '../utils/logger';
import { getDialogDefaultPath, rememberDialogSelection } from '../utils/dialogPaths';

const analytics = AnalyticsService.getInstance();

// Helper function to get file type from extension
function getFileType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const typeMap: Record<string, string> = {
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.txt': 'text',
    '.json': 'json',
    '.js': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.jsx': 'javascript'
  };
  return typeMap[ext] || 'other';
}

export interface OpenFileOptions {
  /** Absolute path to the file to open */
  filePath: string;

  /** Optional workspace path (for workspace-relative files) */
  workspacePath?: string;

  /** Source of the file opening action (for analytics) */
  source?: 'dialog' | 'workspace_tree' | 'ai_click' | 'drag_drop' | 'cli' | 'system' | 'tab_switch';

  /** Target window to open the file in (if not specified, uses current focused or creates new) */
  targetWindow?: BrowserWindow;

  /** If true, creates a new window instead of reusing existing */
  forceNewWindow?: boolean;

  /** If true, skips starting file watcher (for tab switching where watchers are managed separately) */
  skipFileWatcher?: boolean;

  /** If true, skips sending analytics event (for internal operations) */
  skipAnalytics?: boolean;
}

export interface OpenFileResult {
  /** The window where the file was opened */
  window: BrowserWindow;

  /** Absolute path to the file */
  filePath: string;

  /** File content */
  content: string;

  /** Whether a new window was created */
  createdNewWindow: boolean;
}

/**
 * Open a file with a file picker dialog
 */
export async function openFileWithDialog(sourceWindow: BrowserWindow): Promise<OpenFileResult | null> {
  const result = await dialog.showOpenDialog(sourceWindow, {
    defaultPath: getDialogDefaultPath({ window: sourceWindow }),
    properties: ['openFile'],
    filters: [
      { name: 'Markdown Files', extensions: ['md', 'markdown'] },
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  rememberDialogSelection(result.filePaths[0], 'file');

  return openFile({
    filePath: result.filePaths[0],
    source: 'dialog',
    targetWindow: sourceWindow
  });
}

/**
 * Main file opening function - single source of truth for opening files
 *
 * This function:
 * 1. Validates the file exists
 * 2. Finds or creates the appropriate window
 * 3. Loads the file content
 * 4. Updates window state
 * 5. Starts file watcher
 * 6. Updates recent files
 * 7. Sends analytics
 *
 * @throws Error if file doesn't exist or can't be read
 */
export async function openFile(options: OpenFileOptions): Promise<OpenFileResult> {
  const {
    filePath,
    workspacePath,
    source = 'system',
    targetWindow,
    forceNewWindow,
    skipFileWatcher = false,
    skipAnalytics = false
  } = options;

  // Validate file exists
  if (!existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  // Reject binary/unsupported file types (Office docs, images, etc.)
  // Note: Extensions can register custom editors for file types
  if (shouldExcludeFile(filePath)) {
    const ext = extname(filePath).toLowerCase();
    throw new Error(`Cannot open ${ext} files. Nimbalyst does not support that file type yet.`);
  }

  // Determine target window
  let window: BrowserWindow;
  let createdNewWindow = false;

  if (forceNewWindow) {
    window = createWindow(true, false);
    createdNewWindow = true;
  } else if (targetWindow && !targetWindow.isDestroyed()) {
    window = targetWindow;
  } else if (workspacePath) {
    // Find existing workspace window
    const workspaceWindow = findWorkspaceWindow(workspacePath);
    if (workspaceWindow) {
      window = workspaceWindow;
    } else {
      window = createWindow(true, false);
      createdNewWindow = true;
    }
  } else {
    // Use focused window or create new
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) {
      window = focused;
    } else {
      window = createWindow(true, false);
      createdNewWindow = true;
    }
  }

  // Read file content
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.error('[FileOpener] Failed to read file:', error);
    throw new Error(`Failed to read file: ${filePath}`);
  }

  // Get window ID
  const windowId = getWindowId(window);
  if (windowId === null) {
    throw new Error('Failed to get window ID');
  }

  // Get or create window state
  let state = windowStates.get(windowId);
  if (!state) {
    state = {
      mode: workspacePath ? 'workspace' : 'document',
      filePath: null,
      documentEdited: false,
      workspacePath: workspacePath || null
    };
    windowStates.set(windowId, state);
  }

  // Update state
  state.filePath = filePath;
  state.documentEdited = false;
  if (workspacePath && !state.workspacePath) {
    state.workspacePath = workspacePath;
  }

  // Start file watcher (unless skipped for tab switching)
  if (!skipFileWatcher) {
    try {
      await startFileWatcher(window, filePath);
    } catch (error) {
      console.warn('[FileOpener] Failed to start file watcher:', error);
      // Non-fatal - continue
    }
  }

  // Add to recent files if in workspace
  if (workspacePath) {
    addWorkspaceRecentFile(workspacePath, filePath);
  }

  // Update macOS represented filename
  if (process.platform === 'darwin') {
    window.setRepresentedFilename(filePath);
  }

  // Send analytics (unless skipped)
  if (!skipAnalytics) {
    analytics.sendEvent('file_opened', {
      source,
      fileType: getFileType(filePath),
      hasWorkspace: !!workspacePath
    });
  }

  // Note: We don't focus here - let macOS handle window ordering naturally.
  // User-initiated actions that need focus (menu, notifications) handle it themselves.

  console.log('[FileOpener] Opened file:', JSON.stringify({
    filePath: basename(filePath),
    window: windowId,
    workspace: workspacePath ? basename(workspacePath) : null,
    source
  }));

  return {
    window,
    filePath,
    content,
    createdNewWindow
  };
}

/**
 * Find a workspace window for the given workspace path
 */
function findWorkspaceWindow(workspacePath: string): BrowserWindow | null {
  for (const [windowId, state] of windowStates) {
    if (state?.workspacePath === workspacePath && state.mode === 'workspace') {
      const window = BrowserWindow.getAllWindows().find(w => getWindowId(w) === windowId);
      if (window && !window.isDestroyed()) {
        return window;
      }
    }
  }
  return null;
}

/**
 * Open a file in a new window (convenience function)
 */
export async function openFileInNewWindow(filePath: string, workspacePath?: string): Promise<OpenFileResult> {
  return openFile({
    filePath,
    workspacePath,
    source: 'system',
    forceNewWindow: true
  });
}

/**
 * Open a workspace-relative file in the appropriate workspace window
 */
export async function openWorkspaceFile(
  workspacePath: string,
  relativePath: string,
  source: OpenFileOptions['source'] = 'workspace_tree'
): Promise<OpenFileResult> {
  const absolutePath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(workspacePath, relativePath);

  return openFile({
    filePath: absolutePath,
    workspacePath,
    source
  });
}
