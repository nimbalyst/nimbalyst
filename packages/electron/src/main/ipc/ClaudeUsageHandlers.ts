/**
 * IPC Handlers for Claude Usage tracking
 */

import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';
import { claudeUsageService, ClaudeUsageData } from '../services/ClaudeUsageService';

export function registerClaudeUsageHandlers(): void {
  // Get current cached usage data (fetches if no cached data exists)
  safeHandle('claude-usage:get', async (): Promise<ClaudeUsageData | null> => {
    try {
      const cached = claudeUsageService.getCachedUsage();
      if (cached) {
        return cached;
      }
      // No cached data - do an initial fetch so indicator can show
      return await claudeUsageService.refresh();
    } catch (error) {
      logger.main.error('[ClaudeUsageHandlers] Error getting usage:', error);
      return null;
    }
  });

  // Force refresh usage data from API
  safeHandle('claude-usage:refresh', async (): Promise<ClaudeUsageData> => {
    try {
      return await claudeUsageService.refresh();
    } catch (error) {
      logger.main.error('[ClaudeUsageHandlers] Error refreshing usage:', error);
      throw error;
    }
  });

  // Record activity (wakes up service if sleeping)
  safeHandle('claude-usage:activity', async (): Promise<void> => {
    try {
      await claudeUsageService.recordActivity();
    } catch (error) {
      logger.main.error('[ClaudeUsageHandlers] Error recording activity:', error);
    }
  });

  logger.main.info('[ClaudeUsageHandlers] Claude usage IPC handlers registered');
}
