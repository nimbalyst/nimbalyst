import { BrowserWindow, dialog, app } from 'electron';
import { join, basename } from 'path';
import { getPreloadPath } from '../utils/appPaths';
import { existsSync, mkdirSync, statSync } from 'fs';
import { readdir } from 'fs/promises';
import { resolveEntryType } from '../utils/FileTree';
import { shouldExcludeDir } from '../utils/fileFilters';
import { getRecentItems, addToRecentItems, store, getWorkspaceWindowState, getTheme } from '../utils/store';
import { createWindow, findWindowByWorkspace, windowStates } from './WindowManager';
import { safeHandle } from '../utils/ipcRegistry';
import { getBackgroundColor } from '../theme/ThemeManager';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { GitStatusService } from '../services/GitStatusService';
import { getMcpConfigService } from '../index';
import { autoMatchTeamForWorkspace } from '../services/TeamService';
import { initializeTrackerSync } from '../services/TrackerSyncManager';
import { updateTrackerSchemaWorkspace } from '../services/TrackerSchemaService';

let workspaceManagerWindow: BrowserWindow | null = null;

// Track whether the WorkspaceManager is closing because a project was opened
// (vs user manually closing it with the close button)
let workspaceManagerClosingForProject = false;

// Track whether the WorkspaceManager was manually closed by the user
// Used to prevent reopening it when it was the last window
let workspaceManagerManuallyClosed = false;

/**
 * Returns true if the WorkspaceManager was manually closed by the user.
 * Used by window-all-closed handler to decide whether to show it again.
 * Resets the flag after reading.
 */
export function wasWorkspaceManagerManuallyClosed(): boolean {
  const result = workspaceManagerManuallyClosed;
  // Reset the flag after reading
  workspaceManagerManuallyClosed = false;
  return result;
}

// Helper function to bucket file counts for analytics
function bucketFileCount(count: number): string {
  if (count <= 10) return '1-10';
  if (count <= 50) return '11-50';
  if (count <= 100) return '51-100';
  return '100+';
}

async function hasSubfolders(workspacePath: string): Promise<boolean> {
  try {
    const entries = await readdir(workspacePath, { withFileTypes: true });
    return entries.some(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  } catch (error) {
    return false;
  }
}

export function createWorkspaceManagerWindow() {
  // If window already exists, check if it's healthy
  if (workspaceManagerWindow && !workspaceManagerWindow.isDestroyed()) {
    // Check if the window content is corrupted
    workspaceManagerWindow.webContents.executeJavaScript(`
      document.body && document.body.textContent && document.body.textContent.length > 0
    `).then(isHealthy => {
      if (isHealthy) {
        workspaceManagerWindow?.focus();
      } else {
        // Window content is corrupted, recreate it
        console.warn('[WorkspaceManager] Window content corrupted, recreating window');
        workspaceManagerWindow?.destroy();
        workspaceManagerWindow = null;
        createWorkspaceManagerWindow();
      }
    }).catch(() => {
      // Error checking health, recreate window
      console.warn('[WorkspaceManager] Error checking window health, recreating window');
      workspaceManagerWindow?.destroy();
      workspaceManagerWindow = null;
      createWorkspaceManagerWindow();
    });
    return workspaceManagerWindow;
  }

  // Create the window
  workspaceManagerWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    title: 'Project Manager - Nimbalyst',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: getPreloadPath(),
      webviewTag: false
    },
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 10, y: 10 },
    vibrancy: 'sidebar',
    backgroundColor: getBackgroundColor()
  });

  // Load the main app with a query parameter to indicate Workspace Manager mode
  const loadContent = () => {
    const currentTheme = getTheme();
    if (process.env.NODE_ENV === 'development') {
      // Use VITE_PORT if set (for isolated dev mode), otherwise default to 5273
      const devPort = process.env.VITE_PORT || '5273';
      return workspaceManagerWindow!.loadURL(`http://localhost:${devPort}/?mode=workspace-manager&theme=${currentTheme}`);
    } else {
      // Note: Due to code splitting, __dirname is out/main/chunks/, not out/main/
      // Use app.getAppPath() to reliably find the renderer
      const appPath = app.getAppPath();
      let htmlPath: string;
      if (app.isPackaged) {
        htmlPath = join(appPath, 'out/renderer/index.html');
      } else if (appPath.includes('/out/main') || appPath.includes('\\out\\main')) {
        htmlPath = join(appPath, '../renderer/index.html');
      } else {
        htmlPath = join(appPath, 'out/renderer/index.html');
      }
      return workspaceManagerWindow!.loadFile(htmlPath, {
        query: { mode: 'workspace-manager', theme: currentTheme }
      });
    }
  };

  loadContent().catch(err => {
    console.error('[WorkspaceManager] Failed to load window content:', err);
    // Try to reload once
    setTimeout(() => {
      if (workspaceManagerWindow && !workspaceManagerWindow.isDestroyed()) {
        loadContent().catch(err2 => {
          console.error('[WorkspaceManager] Failed to reload window content:', err2);
        });
      }
    }, 1000);
  });

  // Show window when ready
  workspaceManagerWindow.once('ready-to-show', () => {
    workspaceManagerWindow?.show();
  });

  // Handle renderer process crashes
  workspaceManagerWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[WorkspaceManager] Renderer process gone:', details);
    if (workspaceManagerWindow && !workspaceManagerWindow.isDestroyed()) {
      // Reload the window
      workspaceManagerWindow.reload();
    }
  });

  // Handle unresponsive renderer
  workspaceManagerWindow.webContents.on('unresponsive', () => {
    console.warn('[WorkspaceManager] Window became unresponsive');
    const choice = dialog.showMessageBoxSync(workspaceManagerWindow!, {
      type: 'warning',
      buttons: ['Reload', 'Keep Waiting'],
      defaultId: 0,
      message: 'Project Manager is not responding',
      detail: 'Would you like to reload the window?'
    });

    if (choice === 0 && workspaceManagerWindow && !workspaceManagerWindow.isDestroyed()) {
      workspaceManagerWindow.reload();
    }
  });

  // Handle responsive again
  workspaceManagerWindow.webContents.on('responsive', () => {
    console.log('[WorkspaceManager] Window became responsive again');
  });

  // Clean up when closed
  workspaceManagerWindow.on('closed', () => {
    // If not closing for project selection, mark as manually closed by user
    if (!workspaceManagerClosingForProject) {
      workspaceManagerManuallyClosed = true;
    }
    // Reset the project selection flag now that the window is closed
    workspaceManagerClosingForProject = false;
    workspaceManagerWindow = null;
  });

  return workspaceManagerWindow;
}

// Setup handlers once when module loads
let handlersRegistered = false;

export function setupWorkspaceManagerHandlers() {
  // Only register handlers once
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;
  // Get recent workspaces with additional info
  safeHandle('workspace-manager:get-recent-workspaces', async () => {
    const recentWorkspaces = await getRecentItems('workspaces');

    // Process workspaces in parallel with Promise.all for faster loading
    const workspacesWithInfo = await Promise.all(
      recentWorkspaces.map(async workspace => {
        try {
          if (existsSync(workspace.path)) {
            const stats = statSync(workspace.path);
            const { files, limited } = await getWorkspaceFiles(workspace.path, '', 1000, 5);

            return {
              ...workspace,
              lastOpened: workspace.timestamp, // Use the timestamp from the recent items
              lastModified: stats.mtime.getTime(),
              fileCount: limited ? `${files.length}+` : files.length,
              markdownCount: files.filter(f => f.endsWith('.md') || f.endsWith('.markdown')).length,
              exists: true,
              limited
            };
          }
        } catch (error) {
          console.error('Error getting workspace info:', error);
        }

        return {
          ...workspace,
          lastOpened: workspace.timestamp || Date.now(), // Fallback to now if no timestamp
          exists: false
        };
      })
    );

    return workspacesWithInfo.filter(w => w.exists);
  });

  // Get currently open workspace paths (for Project Quick Open)
  safeHandle('workspace-manager:get-open-workspaces', async () => {
    const openPaths: string[] = [];
    for (const [, state] of windowStates) {
      if (state.workspacePath && state.mode === 'workspace') {
        openPaths.push(state.workspacePath);
      }
    }
    return openPaths;
  });

  // Get workspace statistics
  safeHandle('workspace-manager:get-workspace-stats', async (event, workspacePath: string) => {
    try {
      // Use higher limits for stats (when user clicks on a workspace)
      const { files, limited } = await getWorkspaceFiles(workspacePath, '', 10000, 10);
      let totalSize = 0;
      const markdownFiles = [];

      for (const file of files) {
        try {
          const filePath = join(workspacePath, file);
          const stats = statSync(filePath);
          totalSize += stats.size;

          if (file.endsWith('.md') || file.endsWith('.markdown')) {
            markdownFiles.push(file);
          }
        } catch (error) {
          // Ignore files we can't stat
        }
      }

      // Get recent files for this workspace
      const recentFiles = store.get(`workspaceRecentFiles.${workspacePath}`, []) as string[];

      return {
        fileCount: limited ? `${files.length}+` : files.length,
        markdownCount: markdownFiles.length,
        totalSize,
        recentFiles: recentFiles.slice(0, 5),
        limited
      };
    } catch (error) {
      console.error('Failed to get workspace stats:', error);
      return {
        fileCount: 0,
        markdownCount: 0,
        totalSize: 0,
        recentFiles: [],
        limited: false
      };
    }
  });

  // Open folder dialog
  safeHandle('workspace-manager:open-folder-dialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, path: result.filePaths[0] };
    }

    return { success: false };
  });

  // Create workspace dialog
  safeHandle('workspace-manager:create-workspace-dialog', async () => {
    const result = await dialog.showSaveDialog({
      title: 'Create New Workspace',
      buttonLabel: 'Create',
      properties: ['createDirectory', 'showOverwriteConfirmation']
    });

    if (!result.canceled && result.filePath) {
      try {
        // Create the directory if it doesn't exist
        if (!existsSync(result.filePath)) {
          mkdirSync(result.filePath, { recursive: true });
        }

        // Create a README.md file
        const fs = require('fs');
        const readmePath = join(result.filePath, 'README.md');
        if (!existsSync(readmePath)) {
          fs.writeFileSync(readmePath, `# ${basename(result.filePath)}\n\nWelcome to your new workspace!\n`);
        }

        return { success: true, path: result.filePath };
      } catch (error) {
        console.error('Failed to create workspace:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    return { success: false };
  });

  // Open workspace (reuse existing window if already open)
  safeHandle('workspace-manager:open-workspace', async (event, workspacePath: string) => {
    // Add to recent workspaces
    addToRecentItems('workspaces', workspacePath, basename(workspacePath));

    // Check if this workspace is already open in an existing window
    const existingWindow = findWindowByWorkspace(workspacePath);
    if (existingWindow && !existingWindow.isDestroyed()) {
      // Focus the existing window instead of creating a new one
      existingWindow.focus();

      // Close workspace manager after focusing existing workspace
      if (workspaceManagerWindow && !workspaceManagerWindow.isDestroyed()) {
        workspaceManagerClosingForProject = true;
        workspaceManagerWindow.close();
      }

      return { success: true };
    }

    // Check for saved workspace window state
    const savedState = getWorkspaceWindowState(workspacePath);

    // Create window with saved bounds if available
    const window = createWindow(false, true, workspacePath, savedState?.bounds);

    (async () => {
      try {
        const { files } = await getWorkspaceFiles(workspacePath, '', 1000, 8);

        let isGitRepository = false;
        let isGitHub = false;

        try {
          const gitStatusService = new GitStatusService();
          isGitRepository = await gitStatusService.isGitRepo(workspacePath);
          if (isGitRepository) {
            isGitHub = await gitStatusService.hasGitHubRemote(workspacePath);
          }
        } catch (gitError) {
          console.error('Error checking git status:', gitError);
        }

        const analytics = AnalyticsService.getInstance();
        analytics.sendEvent('workspace_opened', {
          fileCount: bucketFileCount(files.length),
          hasSubfolders: await hasSubfolders(workspacePath),
          source: 'dialog',
          isGitRepository,
          isGitHub,
        });
      } catch (error) {
        console.error('Error tracking workspace_opened event:', error);
      }
    })();

    setTimeout(() => {
      // Start watching workspace MCP config for changes after the open handler returns.
      try {
        const mcpService = getMcpConfigService();
        if (mcpService) {
          mcpService.startWatchingWorkspaceConfig(workspacePath);
        }
      } catch (error) {
        // Log error but don't throw - workspace opening must continue
        console.error('[MCP] Failed to start watching workspace config:', error);
      }

      // Auto-match workspace to a team and initialize tracker sync only after
      // we've yielded the main thread; both paths may probe git remotes.
      void autoMatchTeamForWorkspace(workspacePath).catch(() => {});
      void initializeTrackerSync(workspacePath).catch(() => {});
      updateTrackerSchemaWorkspace(workspacePath);
    }, 0);

    // Restore dev tools if they were open
    if (savedState?.devToolsOpen) {
      window.webContents.once('did-finish-load', () => {
        window.webContents.openDevTools();
      });
    }

    // Disable single file restoration - we now use tab restoration instead
    // if (savedState?.filePath && existsSync(savedState.filePath)) {
    //   window.webContents.once('did-finish-load', () => {
    //     // Give the renderer time to initialize
    //     setTimeout(() => {
    //       window.webContents.send('open-workspace-file', savedState.filePath);
    //     }, 500);
    //   });
    // }

    // Close workspace manager after opening workspace
    if (workspaceManagerWindow && !workspaceManagerWindow.isDestroyed()) {
      // Mark that we're closing because a project was selected (not user manually closing)
      workspaceManagerClosingForProject = true;
      workspaceManagerWindow.close();
    }

    return { success: true };
  });

  // Remove from recent.workspaces
  safeHandle('workspace-manager:remove-recent', async (event, workspacePath: string) => {
    const items = (await getRecentItems('workspaces')).filter(item => item.path !== workspacePath);
    store.set('recent.workspaces', items);
    return { success: true };
  });
}

// Helper function to get all files in a workspace with limits
// Returns { files: string[], limited: boolean } where limited=true if we hit a limit
async function getWorkspaceFiles(
  workspacePath: string,
  relativePath: string = '',
  maxFiles: number = 10000,
  maxDepth: number = 10,
  currentDepth: number = 0
): Promise<{ files: string[], limited: boolean }> {
  const files: string[] = [];
  let limited = false;

  // Stop if we've gone too deep
  if (currentDepth >= maxDepth) {
    console.warn(`[WorkspaceManager] Max depth ${maxDepth} reached for ${workspacePath}`);
    return { files, limited: true };
  }

  const fullPath = join(workspacePath, relativePath);

  try {
    const items = await readdir(fullPath, { withFileTypes: true });

    for (const item of items) {
      // Stop if we've found enough files
      if (files.length >= maxFiles) {
        console.warn(`[WorkspaceManager] Max files ${maxFiles} reached for ${workspacePath}`);
        limited = true;
        break;
      }

      // Skip .DS_Store
      if (item.name === '.DS_Store') continue;

      const itemPath = join(relativePath, item.name);

      const resolved = await resolveEntryType(item, join(workspacePath, itemPath));
      if (!resolved) continue; // Broken symlink
      const { isDir, isFile } = resolved;

      if (isDir) {
        if (shouldExcludeDir(item.name)) continue;
        const result = await getWorkspaceFiles(workspacePath, itemPath, maxFiles - files.length, maxDepth, currentDepth + 1);
        files.push(...result.files);
        if (result.limited) {
          limited = true;
          break;
        }
      } else if (isFile) {
        files.push(itemPath);
      }
    }
  } catch (error) {
    console.error('[WorkspaceManager] Error reading directory:', fullPath, error);
  }

  return { files, limited };
}

export function closeWorkspaceManagerWindow() {
  if (workspaceManagerWindow && !workspaceManagerWindow.isDestroyed()) {
    workspaceManagerWindow.close();
  }
}

export function isWorkspaceManagerOpen(): boolean {
  return workspaceManagerWindow !== null && !workspaceManagerWindow.isDestroyed();
}
