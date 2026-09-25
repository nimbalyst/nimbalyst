import { BrowserWindow } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { getProjectAppearance, updateProjectAppearance } from '../services/projectAppearance';

export function registerProjectAppearanceHandlers(): void {
  safeHandle('project-appearance:get', (_event, workspacePath: string) => getProjectAppearance(workspacePath));
  safeHandle('project-appearance:update', (_event, workspacePath: string, patch: unknown) => {
    const snapshot = updateProjectAppearance(workspacePath, patch);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('project-appearance:changed', { workspacePath, ...snapshot });
    }
    return snapshot;
  });
}
