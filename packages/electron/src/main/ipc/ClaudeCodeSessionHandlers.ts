/**
 * IPC handlers for Claude Code session discovery and sync
 */

import { logger } from '../utils/logger';
import { safeHandle, removeHandler } from '../utils/ipcRegistry';
import { AISessionsRepository, AgentMessagesRepository } from '@nimbalyst/runtime';
import {
  scanAllSessions,
  type SessionMetadata,
} from '../services/ClaudeCodeSessionScanner';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import {
  checkSyncStatus,
  syncSession,
  syncSessions,
  type SyncStatus,
} from '../services/ClaudeCodeSessionSync';

const log = logger.ipc;

/**
 * Build a map of providerSessionId -> session for a workspace
 * This batches the lookups to avoid N+1 queries
 */
async function buildProviderSessionIdMap(workspacePath: string): Promise<Map<string, any>> {
  try {
    const sessionStore = AISessionsRepository.getStore();
    const allSessions = await sessionStore.list(workspacePath);
    const map = new Map();

    // Batch load all sessions for this workspace
    await Promise.all(
      allSessions.map(async (sessionItem) => {
        const fullSession = await sessionStore.get(sessionItem.id);
        if (fullSession?.providerSessionId) {
          map.set(fullSession.providerSessionId, fullSession);
        }
      })
    );

    return map;
  } catch (error) {
    log.error(`Error building providerSessionId map for ${workspacePath}:`, error);
    return new Map();
  }
}

/**
 * Initialize the IPC handlers
 */
export function initializeClaudeCodeSessionHandlers() {

  // Scan for Claude Code sessions
  safeHandle('claude-code:scan-sessions', async (event, { workspacePath }: { workspacePath?: string }) => {
    try {
      // Scan filesystem for sessions (optionally filtered by workspace)
      const sessionMetadata = await scanAllSessions(workspacePath);

      log.info(`Found ${sessionMetadata.length} sessions`);

      // Get store references from repositories
      const sessionStore = AISessionsRepository.getStore();

      // Build maps of providerSessionId -> session for each workspace (batch query optimization)
      const workspaceSessionMaps = new Map<string, Map<string, any>>();
      const uniqueWorkspaces = [...new Set(sessionMetadata.map(s => s.workspacePath))];

      await Promise.all(
        uniqueWorkspaces.map(async (workspace) => {
          const map = await buildProviderSessionIdMap(workspace);
          workspaceSessionMaps.set(workspace, map);
        })
      );

      // Deduplicate sessions by sessionId (in case scanner returns duplicates)
      const uniqueMetadata = Array.from(
        new Map(sessionMetadata.map(m => [m.sessionId, m])).values()
      );

      log.info(`After deduplication: ${uniqueMetadata.length} unique sessions`);

      // Build map of Claude session ID -> existing DB session
      const existingSessionMap = new Map<string, any>();
      for (const metadata of uniqueMetadata) {
        // First check by direct ID (for already-imported sessions)
        let existingSession = await sessionStore.get(metadata.sessionId);

        // If not found, check the batched providerSessionId map
        if (!existingSession) {
          const workspaceMap = workspaceSessionMaps.get(metadata.workspacePath);
          existingSession = workspaceMap?.get(metadata.sessionId) || null;
        }

        if (existingSession) {
          existingSessionMap.set(metadata.sessionId, existingSession);
        }
      }

      // Build the final result using date comparison for sync status
      const sessionsWithStatus = uniqueMetadata.map((metadata) => {
        const existingSession = existingSessionMap.get(metadata.sessionId);

        let status: 'new' | 'up-to-date' | 'needs-update' = 'new';

        if (existingSession) {
          // Compare timestamps - if file is newer, needs update
          const fileUpdatedAt = metadata.updatedAt;
          const dbUpdatedAt = existingSession.updatedAt;

          // Use a small tolerance (1 second) for timestamp comparison
          if (fileUpdatedAt > dbUpdatedAt + 1000) {
            status = 'needs-update';
          } else {
            status = 'up-to-date';
          }
        }

        return {
          sessionId: metadata.sessionId,
          workspacePath: metadata.workspacePath,
          title: metadata.title || 'Untitled Session',
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
          messageCount: metadata.messageCount,
          tokenUsage: metadata.tokenUsage,
          syncStatus: status,
        };
      });

      return {
        success: true,
        sessions: sessionsWithStatus,
      };
    } catch (error) {
      log.error('Failed to scan sessions:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Sync specific sessions
  safeHandle('claude-code:sync-sessions', async (event, { sessionIds, workspacePath }: { sessionIds: string[]; workspacePath?: string }) => {
    try {
      log.info(`Syncing ${sessionIds.length} sessions...`);

      // Get store references from repositories
      const sessionStore = AISessionsRepository.getStore();
      const messagesStore = AgentMessagesRepository.getStore();

      // Scan for metadata - use workspace path if provided to avoid scanning all workspaces
      const allSessions = await scanAllSessions(workspacePath);
      const sessionsToSync = allSessions.filter(s => sessionIds.includes(s.sessionId));

      if (sessionsToSync.length === 0) {
        return {
          success: false,
          error: 'No sessions found to sync',
        };
      }

      // Sync sessions
      const results = await syncSessions(
        sessionStore,
        messagesStore,
        sessionsToSync,
        (current, total, sessionId) => {
          log.info(`Syncing session ${current}/${total}: ${sessionId}`);
          // TODO: Send progress updates to renderer
        }
      );

      const successCount = results.filter(r => r.success).length;
      const failureCount = results.length - successCount;
      const totalMessagesAdded = results.reduce((sum, r) => sum + (r.messagesAdded ?? 0), 0);

      log.info(`Sync complete: ${successCount} succeeded, ${failureCount} failed`);

      AnalyticsService.getInstance().sendEvent('claude_code_import_completed', {
        successCount,
        failureCount,
        messagesAdded: totalMessagesAdded,
        sessionsRequested: sessionIds.length,
      });

      // If every session failed, surface that as a failed call so the
      // renderer's error path renders something instead of silently closing
      // the dialog. Reuse the first sync error so the user sees the actual
      // cause (e.g. ENOENT for an encoder mismatch).
      if (successCount === 0 && failureCount > 0) {
        const firstError = results.find(r => !r.success)?.error ?? 'All sessions failed to sync';
        return {
          success: false,
          error: `Import failed: ${firstError}`,
          results,
          successCount,
          failureCount,
        };
      }

      return {
        success: true,
        results,
        successCount,
        failureCount,
      };
    } catch (error) {
      log.error('Failed to sync sessions:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  log.info('Claude Code session handlers initialized');
}

/**
 * Clean up handlers
 */
export function cleanupClaudeCodeSessionHandlers() {
  removeHandler('claude-code:scan-sessions');
  removeHandler('claude-code:sync-sessions');
}
