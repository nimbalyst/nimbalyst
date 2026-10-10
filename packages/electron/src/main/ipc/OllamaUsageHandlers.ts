/**
 * IPC Handlers for Ollama Usage tracking
 */

import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';
import { ollamaUsageService, type OllamaUsageData } from '../services/OllamaUsageService';
import { getWindowIdForWindow, windowReferencesWorkspace, windowStates } from '../window/windowState';

function assertMeterWorkspace(event: IpcMainInvokeEvent, workspacePath: string): string {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
    throw new Error('Ollama usage requires an active workspace');
  }
  const window = BrowserWindow.fromWebContents(event.sender);
  const windowId = getWindowIdForWindow(window);
  if (windowId === null || !windowReferencesWorkspace(windowStates.get(windowId), workspacePath)) {
    throw new Error('Ollama usage workspace is not open in this window');
  }
  return workspacePath;
}

export function registerOllamaUsageHandlers(): void {
  safeHandle('ollama-usage:get', async (event, requestedPath: string): Promise<OllamaUsageData | null> => {
    try {
      const workspacePath = assertMeterWorkspace(event, requestedPath);
      return await ollamaUsageService.getUsage(workspacePath);
    } catch (error) {
      logger.main.error('[OllamaUsageHandlers] Error getting usage');
      return null;
    }
  });

  safeHandle('ollama-usage:refresh', async (event, requestedPath: string): Promise<OllamaUsageData> => {
    try {
      return await ollamaUsageService.getUsage(assertMeterWorkspace(event, requestedPath), true);
    } catch (error) {
      logger.main.error('[OllamaUsageHandlers] Error refreshing usage');
      throw new Error('Ollama usage could not be refreshed.');
    }
  });

  safeHandle('ollama-usage:reset-times', async (event, requestedPath: string) => {
    const workspacePath = assertMeterWorkspace(event, requestedPath);
    try { return await ollamaUsageService.getResetUsage(workspacePath); }
    catch { throw new Error('Ollama usage could not be read.'); }
  });
  safeHandle('ollama-usage:connect', async (event, requestedPath: string) => {
    const workspacePath = assertMeterWorkspace(event, requestedPath);
    try { return await ollamaUsageService.connect(workspacePath, BrowserWindow.fromWebContents(event.sender) ?? undefined); }
    catch { throw new Error('Ollama usage sign-in could not be completed.'); }
  });
  safeHandle('ollama-usage:disconnect', async (event, requestedPath: string) => {
    const workspacePath = assertMeterWorkspace(event, requestedPath);
    try { return await ollamaUsageService.disconnect(workspacePath); }
    catch { throw new Error('Ollama usage sign-in could not be cleared.'); }
  });

  safeHandle('ollama-usage:activity', async (event, requestedPath: string): Promise<void> => {
    try {
      await ollamaUsageService.recordActivity(assertMeterWorkspace(event, requestedPath));
    } catch (error) {
      logger.main.error('[OllamaUsageHandlers] Error recording activity');
    }
  });

  logger.main.info('[OllamaUsageHandlers] Ollama usage IPC handlers registered');
}
