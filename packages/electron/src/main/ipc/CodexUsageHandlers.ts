/**
 * IPC Handlers for Codex Usage tracking
 */

import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';
import { codexUsageService, CodexUsageData } from '../services/CodexUsageService';

export function registerCodexUsageHandlers(): void {
  safeHandle('codex-usage:get', async (): Promise<CodexUsageData | null> => {
    try {
      const cached = codexUsageService.getCachedUsage();
      if (cached) {
        return cached;
      }
      return await codexUsageService.refresh();
    } catch (error) {
      logger.main.error('[CodexUsageHandlers] Error getting usage:', error);
      return null;
    }
  });

  safeHandle('codex-usage:refresh', async (): Promise<CodexUsageData> => {
    try {
      return await codexUsageService.refresh();
    } catch (error) {
      logger.main.error('[CodexUsageHandlers] Error refreshing usage:', error);
      throw error;
    }
  });

  safeHandle('codex-usage:activity', async (): Promise<void> => {
    try {
      await codexUsageService.recordActivity();
    } catch (error) {
      logger.main.error('[CodexUsageHandlers] Error recording activity:', error);
    }
  });

  logger.main.info('[CodexUsageHandlers] Codex usage IPC handlers registered');
}
