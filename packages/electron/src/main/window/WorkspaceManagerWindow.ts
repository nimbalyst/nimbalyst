import { BrowserWindow, dialog, app } from 'electron';
import { join, basename } from 'path';
import { getPreloadPath } from '../utils/appPaths';
import { existsSync, mkdirSync, statSync } from 'fs';
import { readdir } from 'fs/promises';
import { resolveEntryType } from '../utils/FileTree';
import { shouldExcludeDir, shouldExcludePath } from '../utils/fileFilters';
import { getRecentItems, addToRecentItems, store, getWorkspaceWindowState, getTheme, getMultiProjectMode } from '../utils/store';
import { createWindow, findWindowByWorkspace, getMostRecentlyFocusedWorkspaceWindow, windowStates, type CreateWindowOptions } from './WindowManager';
import { safeHandle } from '../utils/ipcRegistry';
import { resolveProjectOpenTarget } from './resolveProjectOpenTarget';
import { seedProjectIntoWindow, type RailSeedOutcome } from './railSeeding';
import { logger } from '../utils/logger';
import { getBackgroundColor } from '../theme/ThemeManager';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { GitStatusService } from '../services/GitStatusService';
import { getMcpConfigService } from '../index';
import {
  autoMatchTeamForWorkspace,
  bindWorkspaceToSharedProject,
  broadcastWorkspaceOrgChanged,
} from '../services/TeamService';
import { initializeTrackerSync } from '../services/TrackerSyncManager';
import { updateTrackerSchemaWorkspace } from '../services/TrackerSchemaService';
import { getDialogDefaultPath, rememberDialogSelection } from '../utils/dialogPaths';
import { TutorialProjectService } from '../services/tutorial/TutorialProjectService';
import {
  normalizeTutorialEntryPoint,
  type TutorialEntryPoint,
} from '../services/tutorial/tutorialAnalytics';
import type { TutorialStartResult } from '../../shared/tutorial';
import { windowControlsOverlayOptions } from './windowChrome';
import {
  createWorkspaceManagerDevUrl,
  createWorkspaceManagerRendererQuery,
  type WorkspaceManagerWindowOptions,
} from './workspaceManagerRendererQuery';
import {
  isStartupCohortWindow,
  notifyStartupWindowRevealed,
  registerStartupWindow,
} from './StartupActivation';

let workspaceManagerWindow: BrowserWindow | null = null;

const tutorialProjectService = new TutorialProjectService({
  closeWorkspaceManagerWindow: () => {
    if (workspaceManagerWindow && !workspaceManagerWindow.isDestroyed()) {
      workspaceManagerClosingForProject = true;
      workspaceManagerWindow.close();
    }
  },
});

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

export type ProjectOpenOutcome =
  | { kind: 'focus-existing'; window: BrowserWindow }
  | { kind: 'add-to-rail'; window: BrowserWindow }
  | { kind: 'new-window'; window: BrowserWindow };

/** Async-sibling outcome for callers that must sequence a payload after the
 *  rail registration actually lands (see `openOrFocusWorkspaceWindowAwaitingRailSeed`
 *  below). `'blocked'` replaces `add-to-rail` when the seed did not land --
 *  there is no window it is safe to deliver a payload into. */
export type ProjectOpenOutcomeAsync =
  | { kind: 'focus-existing'; window: BrowserWindow }
  | { kind: 'add-to-rail'; window: BrowserWindow }
  | { kind: 'new-window'; window: BrowserWindow }
  | { kind: 'blocked'; reason: Extract<RailSeedOutcome, 'at-cap' | 'timeout'>; window: BrowserWindow };

/**
 * Shared routing decision: focus an existing window, add to the focused
 * window's rail (Multi-Project Mode), or spawn a new window. Pulled out so
 * the sync and async entry points below cannot drift on recents tracking or
 * the existing-window/focused-window lookups.
 */
function routeWorkspaceWindow(workspacePath: string) {
  addToRecentItems('workspaces', workspacePath, basename(workspacePath));

  // findWindowByWorkspace (not a local exact-match helper) so worktree paths
  // resolve to the parent project's window the same way MCP routing and the
  // notification click path already do -- funneling call sites through this
  // chokepoint must not narrow their existing-window matching.
  const existingWindow = findWindowByWorkspace(workspacePath);
  return resolveProjectOpenTarget({
    workspacePath,
    multiProjectModeEnabled: getMultiProjectMode(),
    existingWindowForPath: existingWindow,
    focusedWorkspaceWindow: existingWindow ? null : getMostRecentlyFocusedWorkspaceWindow(),
  });
}

function createNewWorkspaceWindow(workspacePath: string, options?: CreateWindowOptions): BrowserWindow {
  const savedState = getWorkspaceWindowState(workspacePath);
  return createWindow(false, true, workspacePath, savedState?.bounds, options);
}

/**
 * Focus the window already showing a workspace, add it to the focused
 * window's project rail (Multi-Project Mode), or open a new window for it.
 * This is THE chokepoint for "open this project" -- every call site that
 * opens a workspace (as opposed to a bare document) must funnel through
 * here so they cannot drift apart on recents, saved bounds, or whether the
 * rail is respected.
 *
 * In the `focus-existing` and `new-window` cases the returned window's
 * *content* is already loaded or is a genuinely fresh window callers wait on
 * `ready-to-show` / `did-finish-load` for, same as before. In the
 * `add-to-rail` case, though, the window's content is loaded but the
 * *project* is not yet registered in it -- `workspace:register-additional`
 * and the rail activation happen asynchronously in the renderer (see
 * `store/listeners/railProjectListeners.ts`) and are still in flight when
 * this function returns. Callers that only need to know where a project
 * landed (menus, discarded outcomes) can use the returned window as-is; any
 * caller that needs to deliver a payload targeted at that project (a deep
 * link, `open-document`, ...) MUST NOT send it synchronously against this
 * return value -- use `openOrFocusWorkspaceWindowAwaitingRailSeed` instead
 * and sequence the send after it resolves.
 */
function openOrFocusWorkspaceWindow(
  workspacePath: string,
  options?: CreateWindowOptions,
): ProjectOpenOutcome {
  const target = routeWorkspaceWindow(workspacePath);

  if (target.kind === 'focus-existing') {
    target.window.focus();
    return { kind: 'focus-existing', window: target.window };
  }

  if (target.kind === 'add-to-rail') {
    target.window.focus();
    // Fire-and-forget: this caller doesn't need to know the outcome, but
    // route it through the same acked channel `seedProjectIntoWindow` uses
    // (rather than a bare `webContents.send`) so there is exactly one way
    // `rail:add-project` ever gets sent, and callers that DO need to wait
    // (`openOrFocusWorkspaceWindowAwaitingRailSeed`) aren't racing a second,
    // unacked send of the same message.
    void seedProjectIntoWindow(target.window, workspacePath);
    return { kind: 'add-to-rail', window: target.window };
  }

  return { kind: 'new-window', window: createNewWorkspaceWindow(workspacePath, options) };
}

export { openOrFocusWorkspaceWindow };

/**
 * Async sibling of `openOrFocusWorkspaceWindow` for callers that need to
 * deliver a payload targeted at `workspacePath` once it is actually open in
 * the returned window. Resolves only after the `add-to-rail` case's seed is
 * confirmed (registered, and appended to the rail) or definitively failed:
 *
 * - `focus-existing` / `new-window` resolve immediately, same as the sync
 *   chokepoint -- there is no seed to wait on.
 * - `add-to-rail` resolves once `seedProjectIntoWindow` gets an `'added'` or
 *   `'already-open'` ack.
 * - `'at-cap'` or `'timeout'` resolve to `{ kind: 'blocked' }` instead of
 *   `add-to-rail` -- the project never landed anywhere, so there is no
 *   window it is safe to deliver a payload into. Callers must not send
 *   anything in this case; surface the failure instead (log, notify, or
 *   leave a queued/pending entry for a later attempt to drain).
 */
export async function openOrFocusWorkspaceWindowAwaitingRailSeed(
  workspacePath: string,
  options?: CreateWindowOptions & { seedTimeoutMs?: number },
): Promise<ProjectOpenOutcomeAsync> {
  const target = routeWorkspaceWindow(workspacePath);

  if (target.kind === 'focus-existing') {
    target.window.focus();
    return { kind: 'focus-existing', window: target.window };
  }

  if (target.kind === 'add-to-rail') {
    target.window.focus();
    const seedOutcome = await seedProjectIntoWindow(target.window, workspacePath, {
      timeoutMs: options?.seedTimeoutMs,
    });
    if (seedOutcome === 'at-cap' || seedOutcome === 'timeout') {
      return { kind: 'blocked', reason: seedOutcome, window: target.window };
    }
    return { kind: 'add-to-rail', window: target.window };
  }

  return { kind: 'new-window', window: createNewWorkspaceWindow(workspacePath, options) };
}

/**
 * Materializes (or reopens) the tutorial project and opens it in a window.
 * Shared by the `tutorial:start` IPC channel and the Help menu entry.
 */
export function startTutorialProject(
  entryPoint: TutorialEntryPoint = 'unknown'
): Promise<TutorialStartResult> {
  return tutorialProjectService.startTutorial(entryPoint);
}

async function hasSubfolders(workspacePath: string): Promise<boolean> {
  try {
    const entries = await readdir(workspacePath, { withFileTypes: true });
    return entries.some(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  } catch (error) {
    return false;
  }
}

export function createWorkspaceManagerWindow(options: WorkspaceManagerWindowOptions = {}) {
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
        createWorkspaceManagerWindow(options);
      }
    }).catch(() => {
      // Error checking health, recreate window
      console.warn('[WorkspaceManager] Error checking window health, recreating window');
      workspaceManagerWindow?.destroy();
      workspaceManagerWindow = null;
      createWorkspaceManagerWindow(options);
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
    ...windowControlsOverlayOptions(),
    vibrancy: 'sidebar',
    backgroundColor: getBackgroundColor()
  });

  // Load the main app with a query parameter to indicate Workspace Manager mode
  const loadContent = () => {
    const currentTheme = getTheme();
    const query = createWorkspaceManagerRendererQuery(currentTheme, options);
    if (process.env.NODE_ENV === 'development') {
      // Use VITE_PORT if set (for isolated dev mode), otherwise default to 5273
      const devPort = process.env.VITE_PORT || '5273';
      return workspaceManagerWindow!.loadURL(createWorkspaceManagerDevUrl(devPort, query));
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
        query
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

  if (options.startupReveal) {
    registerStartupWindow(workspaceManagerWindow, { frontmost: true });
  }

  // Show window when ready
  workspaceManagerWindow.once('ready-to-show', () => {
    const window = workspaceManagerWindow;
    if (!window || window.isDestroyed()) return;
    if (isStartupCohortWindow(window)) {
      // Launch reveals without activating; the app is foregrounded once, at
      // the end of startup.
      window.showInactive();
      notifyStartupWindowRevealed(window);
    } else {
      window.show();
    }
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

  safeHandle('tutorial:get-status', async () => {
    return tutorialProjectService.getStatus();
  });

  safeHandle('tutorial:start', async (_event, entryPoint?: unknown) => {
    return startTutorialProject(normalizeTutorialEntryPoint(entryPoint));
  });

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
      properties: ['openDirectory'],
      defaultPath: getDialogDefaultPath(),
    });

    if (!result.canceled && result.filePaths.length > 0) {
      rememberDialogSelection(result.filePaths[0], 'directory');
      return { success: true, path: result.filePaths[0] };
    }

    return { success: false };
  });

  // Create workspace dialog
  safeHandle('workspace-manager:create-workspace-dialog', async () => {
    const defaultPath = getDialogDefaultPath({ suggestedName: 'Untitled Workspace' });
    const result = await dialog.showSaveDialog({
      title: 'Create New Workspace',
      defaultPath,
      buttonLabel: 'Create',
      properties: ['createDirectory', 'showOverwriteConfirmation']
    });

    if (!result.canceled && result.filePath) {
      rememberDialogSelection(result.filePath, 'file');
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

  // Open workspace: focus an existing window, add to the focused window's
  // rail (Multi-Project Mode), or create a new window -- via the shared
  // chokepoint so this, the most common "open a project" entry point,
  // cannot drift from the others.
  safeHandle('workspace-manager:open-workspace', async (event, workspacePath: string) => {
    // Awaits the rail seed (if any) before touching the Workspace Manager
    // window: closing it is an irreversible UI action for the user, and
    // doing that before the seed is confirmed would strand them with no
    // surface to retry from if the seed comes back 'at-cap' or 'timeout'.
    const outcome = await openOrFocusWorkspaceWindowAwaitingRailSeed(workspacePath);

    if (outcome.kind === 'blocked') {
      logger.main.warn(
        '[WorkspaceManager] Rail seed did not land, leaving Workspace Manager open:',
        { workspacePath, reason: outcome.reason },
      );
      return { success: false, error: `Could not open project (${outcome.reason})` };
    }

    if (outcome.kind !== 'new-window') {
      // Existing/rail window is already loaded -- no analytics/MCP-watch/
      // team-match/tracker-sync/devtools bootstrapping to do, that already
      // happened when the window (or the rail registration) was created.
      if (workspaceManagerWindow && !workspaceManagerWindow.isDestroyed()) {
        workspaceManagerClosingForProject = true;
        workspaceManagerWindow.close();
      }
      return { success: true };
    }

    const window = outcome.window;
    const savedState = getWorkspaceWindowState(workspacePath);

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

  safeHandle('team:open-project-workspace', async (_event, workspacePath: string) => {
    try {
      if (!workspacePath || typeof workspacePath !== 'string') {
        throw new Error('team:open-project-workspace requires workspacePath');
      }
      if (!existsSync(workspacePath)) {
        throw new Error(`Workspace does not exist: ${workspacePath}`);
      }

      openOrFocusWorkspaceWindow(workspacePath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Open a shared project that has no git remote by attaching a directory to
   * it. TeamService owns the validation and the binding; this handler owns the
   * window, the same way `team:open-project-workspace` does.
   */
  safeHandle('team:open-shared-project', async (_event, payload: {
    orgId: string;
    teamProjectId: string;
    directoryPath: string;
  }) => {
    try {
      if (!payload?.directoryPath) {
        throw new Error('team:open-shared-project requires a directory');
      }
      await bindWorkspaceToSharedProject(payload);
      openOrFocusWorkspaceWindow(payload.directoryPath);
      broadcastWorkspaceOrgChanged({
        orgId: payload.orgId,
        workspacePath: payload.directoryPath,
      });
      return { success: true, workspacePath: payload.directoryPath };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
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
        if (shouldExcludeDir(item.name) || shouldExcludePath(join(workspacePath, itemPath))) continue;
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
