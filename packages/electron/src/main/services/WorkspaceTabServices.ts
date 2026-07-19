import { BrowserWindow } from 'electron';
import { existsSync } from 'fs';
import {
  documentServices,
  getWindowId,
  windowStates,
} from '../window/WindowManager';
import { resolveDocumentServicePath } from '../window/windowState';
import { fileSystemServices } from '../window/serviceRegistry';
import {
  ElectronDocumentService,
  setupDocumentServiceHandlers,
} from './ElectronDocumentService';
import { ElectronFileSystemService } from './ElectronFileSystemService';
import { addNimAssetRoot } from '../protocols/nimAssetProtocol';
import { addNimPreviewWorkspaceRoot } from '../protocols/nimPreviewProtocol';
import { getWorkspaceNavigationHistory } from '../utils/store';
import { navigationHistoryService } from './NavigationHistoryService';
import { setFileSystemServiceFor, clearFileSystemServiceFor } from '@nimbalyst/runtime';
import { logger } from '../utils/logger';

export interface EnsureWorkspaceTabServicesResult {
  success: boolean;
  error?: string;
}

function resolveDocumentServiceForEvent(
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
): ElectronDocumentService | null {
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  if (!browserWindow) return null;
  const windowId = getWindowId(browserWindow);
  if (windowId === null) return null;
  const workspacePath = resolveDocumentServicePath(windowStates.get(windowId));
  return workspacePath ? documentServices.get(workspacePath) ?? null : null;
}

/**
 * Create the path-scoped services needed by a warm project tab.
 *
 * Service construction is transactional: the window state is updated by the
 * caller only after this function succeeds, and any newly-created partial
 * services are removed if construction or registration throws.
 */
export function ensureWorkspaceTabServices(
  window: BrowserWindow,
  workspacePath: string,
): EnsureWorkspaceTabServicesResult {
  if (!workspacePath || !existsSync(workspacePath)) {
    return { success: false, error: 'Workspace path does not exist' };
  }

  let createdDocumentService: ElectronDocumentService | null = null;
  let createdFileSystemService: ElectronFileSystemService | null = null;
  let documentInserted = false;
  let fileSystemInserted = false;

  try {
    if (!documentServices.has(workspacePath)) {
      createdDocumentService = new ElectronDocumentService(workspacePath);
    }
    if (!fileSystemServices.has(workspacePath)) {
      createdFileSystemService = new ElectronFileSystemService(workspacePath);
    }

    addNimAssetRoot(workspacePath);
    addNimPreviewWorkspaceRoot(workspacePath);

    if (createdDocumentService) {
      documentServices.set(workspacePath, createdDocumentService);
      documentInserted = true;
      setupDocumentServiceHandlers(resolveDocumentServiceForEvent);
    }

    if (createdFileSystemService) {
      fileSystemServices.set(workspacePath, createdFileSystemService);
      fileSystemInserted = true;
      setFileSystemServiceFor(workspacePath, createdFileSystemService);
    }
  } catch (error) {
    if (documentInserted) documentServices.delete(workspacePath);
    if (fileSystemInserted) {
      fileSystemServices.delete(workspacePath);
      clearFileSystemServiceFor(workspacePath);
    }
    try {
      createdDocumentService?.destroy();
    } catch {
      // Preserve the original construction error.
    }
    try {
      createdFileSystemService?.destroy();
    } catch {
      // Preserve the original construction error.
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.main.error('[ProjectTabs] Failed to initialize workspace services:', workspacePath, error);
    return { success: false, error: message };
  }

  // Navigation history is useful but non-critical; a malformed persisted
  // history must not turn a successfully-created service set into a ghost
  // registration.
  try {
    const windowId = getWindowId(window);
    const navigationHistory = getWorkspaceNavigationHistory(workspacePath);
    if (windowId !== null && navigationHistory) {
      navigationHistoryService.restoreNavigationState(windowId, navigationHistory);
    }
  } catch (error) {
    logger.main.warn('[ProjectTabs] Failed to restore navigation history:', workspacePath, error);
  }

  return { success: true };
}
