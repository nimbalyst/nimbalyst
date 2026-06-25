/**
 * IPC handlers for Sakana Fugu usage tracking.
 */

import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';
import { fuguUsageService, FuguUsageData } from '../services/FuguUsageService';

export function registerFuguUsageHandlers(): void {
  safeHandle('fugu-usage:get', async (): Promise<FuguUsageData | null> => {
    try {
      return await fuguUsageService.getUsage();
    } catch (error) {
      logger.main.error('[FuguUsageHandlers] Error getting usage:', error);
      return null;
    }
  });

  safeHandle('fugu-usage:refresh', async (): Promise<FuguUsageData> => {
    try {
      return await fuguUsageService.refresh();
    } catch (error) {
      logger.main.error('[FuguUsageHandlers] Error refreshing usage:', error);
      throw error;
    }
  });

  safeHandle('fugu-usage:activity', async (): Promise<void> => {
    try {
      await fuguUsageService.recordActivity();
    } catch (error) {
      logger.main.error('[FuguUsageHandlers] Error recording activity:', error);
    }
  });

  logger.main.info('[FuguUsageHandlers] Fugu usage IPC handlers registered');
}
