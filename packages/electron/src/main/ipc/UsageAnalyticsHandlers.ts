import { safeHandle } from '../utils/ipcRegistry';
import { UsageAnalyticsService } from '../services/UsageAnalyticsService';
import { ToolUsageService } from '../services/ToolUsageService';
import { database } from '../database/PGLiteDatabaseWorker';

let analyticsService: UsageAnalyticsService | null = null;

export async function registerUsageAnalyticsHandlers() {
  // Initialize analytics service
  analyticsService = new UsageAnalyticsService(database);

  // Rolled-up tool usage for tip targeting (mcp:<server> + built-in names)
  safeHandle('tool-usage:get-rollup', async () => {
    try {
      return await ToolUsageService.getInstance().getRollup();
    } catch (error) {
      console.error('[UsageAnalyticsHandlers] Failed to get tool usage rollup:', error);
      throw error;
    }
  });

  // Tool usage aggregates for the AI Usage Report Tools tab
  safeHandle('tool-usage:get-report', async (event, workspaceId?: string) => {
    try {
      return await ToolUsageService.getInstance().getReport(workspaceId);
    } catch (error) {
      console.error('[UsageAnalyticsHandlers] Failed to get tool usage report:', error);
      throw error;
    }
  });

  // Retry-safe historical backfill from raw codex + claude-code messages
  safeHandle('tool-usage:backfill', async () => {
    try {
      return await ToolUsageService.getInstance().backfillFromRawMessages();
    } catch (error) {
      console.error('[UsageAnalyticsHandlers] Failed to backfill tool usage:', error);
      throw error;
    }
  });

  // Get total session count (all sessions, not just those with token data)
  safeHandle('usage-analytics:get-all-session-count', async (event, workspaceId?: string) => {
    try {
      return await analyticsService!.getAllSessionCount(workspaceId);
    } catch (error) {
      console.error('[UsageAnalyticsHandlers] Failed to get all session count:', error);
      throw error;
    }
  });

  // Get overall token usage statistics
  safeHandle('usage-analytics:get-overall-stats', async (event, workspaceId?: string) => {
    try {
      return await analyticsService!.getOverallTokenUsage(workspaceId);
    } catch (error) {
      console.error('[UsageAnalyticsHandlers] Failed to get overall stats:', error);
      throw error;
    }
  });

  // Get usage broken down by provider/model
  safeHandle('usage-analytics:get-usage-by-provider', async (event, workspaceId?: string) => {
    try {
      return await analyticsService!.getUsageByProvider(workspaceId);
    } catch (error) {
      console.error('[UsageAnalyticsHandlers] Failed to get usage by provider:', error);
      throw error;
    }
  });

  // Get usage broken down by project
  safeHandle('usage-analytics:get-usage-by-project', async () => {
    try {
      return await analyticsService!.getUsageByProject();
    } catch (error) {
      console.error('[UsageAnalyticsHandlers] Failed to get usage by project:', error);
      throw error;
    }
  });

  // Get time-series data for token usage
  safeHandle('usage-analytics:get-time-series', async (
    event,
    startDate: number,
    endDate: number,
    granularity: 'hour' | 'day' | 'week' | 'month',
    workspaceId?: string
  ) => {
    try {
      return await analyticsService!.getTimeSeriesData(startDate, endDate, granularity, workspaceId);
    } catch (error) {
      console.error('[UsageAnalyticsHandlers] Failed to get time series data:', error);
      throw error;
    }
  });

  // Get activity heatmap (hour x day of week)
  safeHandle('usage-analytics:get-activity-heatmap', async (
    event,
    workspaceId?: string,
    metric?: 'sessions' | 'messages' | 'edits',
    timezoneOffsetMinutes?: number
  ) => {
    try {
      return await analyticsService!.getActivityHeatmap(
        workspaceId,
        metric || 'messages',
        timezoneOffsetMinutes || 0
      );
    } catch (error) {
      console.error('[UsageAnalyticsHandlers] Failed to get activity heatmap:', error);
      throw error;
    }
  });

  // Get document edit statistics
  safeHandle('usage-analytics:get-document-stats', async (event, workspaceId?: string) => {
    try {
      return await analyticsService!.getDocumentEditStats(workspaceId);
    } catch (error) {
      console.error('[UsageAnalyticsHandlers] Failed to get document stats:', error);
      throw error;
    }
  });

  // Get document edit time series
  safeHandle('usage-analytics:get-document-time-series', async (
    event,
    startDate: number,
    endDate: number,
    granularity: 'hour' | 'day' | 'week' | 'month',
    workspaceId?: string
  ) => {
    try {
      return await analyticsService!.getDocumentEditTimeSeries(startDate, endDate, granularity, workspaceId);
    } catch (error) {
      console.error('[UsageAnalyticsHandlers] Failed to get document time series:', error);
      throw error;
    }
  });
}
