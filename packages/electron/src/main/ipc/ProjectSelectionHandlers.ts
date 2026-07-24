import { dialog, BrowserWindow } from 'electron';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { getRecentItems, addToRecentItems } from '../utils/store';
import { getWindowId, windowStates } from '../window/WindowManager';
import { loadFileIntoWindow } from '../file/FileOperations';
import { logger } from '../utils/logger';
import { basename } from 'path';
import { getDialogDefaultPath, rememberDialogSelection } from '../utils/dialogPaths';

export function registerProjectSelectionHandlers() {
  // Get recent workspaces for project selection dialog
  safeHandle('get-recent-workspaces', async () => {
    return getRecentItems('workspaces');
  });

  // Show native folder selection dialog
  safeHandle('dialog-show-open-dialog', async (event, options) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
      ...(options ?? {}),
      defaultPath: getDialogDefaultPath({ window, explicitPath: options?.defaultPath }),
    };
    const result = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (!result.canceled) {
      const isDirectory = dialogOptions.properties?.includes('openDirectory') === true;
      rememberDialogSelection(result.filePaths[0], isDirectory ? 'directory' : 'file');
    }
    return result;
  });

  // Handle project selection - user chose a project for the file
  safeHandle('project-selected', async (event, data: { filePath: string; workspacePath: string }) => {
    const { filePath, workspacePath } = data;
    logger.main.info(`[ProjectSelection] User selected workspace: ${workspacePath} for file: ${filePath}`);

    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        logger.main.error('[ProjectSelection] No window found for event sender');
        return { success: false, error: 'No window found' };
      }

      // Update window state to use the selected workspace
      const windowId = getWindowId(window);
      if (windowId !== null) {
        const state = windowStates.get(windowId);
        if (state) {
          state.workspacePath = workspacePath;
          state.mode = 'workspace';
        }
      }

      // Add to recent workspaces
      addToRecentItems('workspaces', workspacePath, basename(workspacePath));

      // Tell renderer to switch to workspace mode and initialize workspace UI
      window.webContents.send('open-workspace-from-cli', workspacePath);

      // Give the renderer time to initialize workspace mode, then load the file
      setTimeout(async () => {
        await loadFileIntoWindow(window, filePath);
      }, 200);

      return { success: true };
    } catch (error: any) {
      logger.main.error('[ProjectSelection] Error opening file in workspace:', error);
      return { success: false, error: error.message };
    }
  });

  // Handle project selection cancelled - close window since document mode isn't supported
  safeHandle('project-selection-cancelled', async (event, data: { filePath: string }) => {
    const { filePath } = data;
    logger.main.info(`[ProjectSelection] User cancelled project selection for file: ${filePath}`);

    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        logger.main.error('[ProjectSelection] No window found for event sender');
        return { success: false, error: 'No window found' };
      }

      // Close the temp window since document mode is no longer supported
      window.close();

      return { success: true };
    } catch (error: any) {
      logger.main.error('[ProjectSelection] Error closing window:', error);
      return { success: false, error: error.message };
    }
  });
}
