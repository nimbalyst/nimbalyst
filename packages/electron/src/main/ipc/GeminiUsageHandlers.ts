/**
 * IPC Handlers for Gemini Usage tracking
 */

import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';
import { geminiUsageService, GeminiUsageData } from '../services/GeminiUsageService';

export function registerGeminiUsageHandlers(): void {
  safeHandle('gemini-usage:get', async (): Promise<GeminiUsageData | null> => {
    try {
      const cached = geminiUsageService.getCachedUsage();
      if (cached) {
        return cached;
      }
      return await geminiUsageService.refresh();
    } catch (error) {
      logger.main.error('[GeminiUsageHandlers] Error getting usage:', error);
      return null;
    }
  });

  safeHandle('gemini-usage:refresh', async (): Promise<GeminiUsageData> => {
    try {
      return await geminiUsageService.refresh();
    } catch (error) {
      logger.main.error('[GeminiUsageHandlers] Error refreshing usage:', error);
      throw error;
    }
  });

  safeHandle('gemini-usage:activity', async (): Promise<void> => {
    try {
      await geminiUsageService.recordActivity();
    } catch (error) {
      logger.main.error('[GeminiUsageHandlers] Error recording activity:', error);
    }
  });

  logger.main.info('[GeminiUsageHandlers] Gemini usage IPC handlers registered');
}
