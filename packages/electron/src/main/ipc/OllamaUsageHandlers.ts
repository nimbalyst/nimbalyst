/**
 * IPC Handlers for Ollama Usage tracking
 */

import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';
import { ollamaUsageService, OllamaUsageData } from '../services/OllamaUsageService';

export function registerOllamaUsageHandlers(): void {
  safeHandle('ollama-usage:get', async (): Promise<OllamaUsageData | null> => {
    try {
      const cached = ollamaUsageService.getCachedUsage();
      if (cached) {
        return cached;
      }
      return await ollamaUsageService.refresh();
    } catch (error) {
      logger.main.error('[OllamaUsageHandlers] Error getting usage:', error);
      return null;
    }
  });

  safeHandle('ollama-usage:refresh', async (): Promise<OllamaUsageData> => {
    try {
      return await ollamaUsageService.refresh();
    } catch (error) {
      logger.main.error('[OllamaUsageHandlers] Error refreshing usage:', error);
      throw error;
    }
  });

  safeHandle('ollama-usage:activity', async (): Promise<void> => {
    try {
      await ollamaUsageService.recordActivity();
    } catch (error) {
      logger.main.error('[OllamaUsageHandlers] Error recording activity:', error);
    }
  });

  logger.main.info('[OllamaUsageHandlers] Ollama usage IPC handlers registered');
}
