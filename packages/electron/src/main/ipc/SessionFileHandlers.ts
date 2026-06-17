/**
 * IPC handlers for session-file link operations
 */

import { SessionFilesRepository, type FileLinkType, type FileLink } from '@nimbalyst/runtime';
import { promises as fs } from 'fs';
import { createPatch } from 'diff';
import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';
import { BrowserWindow } from 'electron';
import { toolCallMatcher } from '../services/ToolCallMatcher';
import { historyManager } from '../HistoryManager';
import { createSessionFilesQueryCache } from '../services/sessionFilesQueryCache';
import { registerSessionFilesCacheInvalidator } from '../services/sessionFilesNotify';

// ============================================================
// Session Files Cache (NIM-816: extracted to sessionFilesQueryCache)
// Short-lived cache to prevent duplicate queries when multiple components
// mount simultaneously. Invalidated on EVERY session_files write via
// notifySessionFilesUpdated (registered below) — not just the add-link IPC —
// with epoch-based protection against caching results from queries that were
// in flight when a write landed.
// ============================================================
const SESSION_FILES_CACHE_TTL_MS = 2000; // 2 second cache

const sessionFilesCache = createSessionFilesQueryCache<FileLink[]>(SESSION_FILES_CACHE_TTL_MS);

function invalidateSessionCache(sessionId: string): void {
  sessionFilesCache.invalidate(sessionId);
}

export function setupSessionFileHandlers(): void {
  // All direct-DB session_files writers route their post-write notification
  // through sessionFilesNotify; give it the cache invalidator (NIM-816).
  registerSessionFilesCacheInvalidator(invalidateSessionCache);
  /**
   * Add a file link to a session (used by AI and tests)
   */
  safeHandle('session-files:add-link', async (event, sessionId: string, workspaceId: string, filePath: string, linkType: FileLinkType, metadata?: Record<string, any>) => {
    try {
      const link = await SessionFilesRepository.addFileLink({
        sessionId,
        workspaceId,
        filePath,
        linkType,
        timestamp: Date.now(),
        metadata,
      });

      // Invalidate cache for this session since files changed
      invalidateSessionCache(sessionId);

      // Notify renderer of the update
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window) {
        event.sender.send('session-files:updated', sessionId);
      }

      return { success: true, link };
    } catch (error) {
      logger.main.error('[SessionFileHandlers] Failed to add file link:', error);
      return { success: false, error: String(error) };
    }
  });

  /**
   * Get all file links for a session (with short-lived cache and in-flight deduplication)
   */
  safeHandle('session-files:get-by-session', async (event, sessionId: string, linkType?: string) => {
    try {
      const files = await sessionFilesCache.get(sessionId, linkType, () =>
        SessionFilesRepository.getFilesBySession(sessionId, linkType as any)
      );
      return { success: true, files };
    } catch (error) {
      logger.main.error('[SessionFileHandlers] Failed to get files by session:', error);
      return { success: false, error: String(error), files: [] };
    }
  });

  /**
   * Batch get file links for multiple sessions (more efficient than N individual calls)
   */
  safeHandle('session-files:get-by-sessions', async (event, sessionIds: string[], linkType?: string) => {
    try {
      const files = await SessionFilesRepository.getFilesBySessionMany(sessionIds, linkType as any);
      return { success: true, files };
    } catch (error) {
      logger.main.error('[SessionFileHandlers] Failed to batch get files by sessions:', error);
      return { success: false, error: String(error), files: [] };
    }
  });

  /**
   * Get all sessions that have links to a specific file
   */
  safeHandle('session-files:get-sessions-by-file', async (event, workspaceId: string, filePath: string, linkType?: string) => {
    try {
      const sessionIds = await SessionFilesRepository.getSessionsByFile(workspaceId, filePath, linkType as any);
      return { success: true, sessionIds };
    } catch (error) {
      logger.main.error('[SessionFileHandlers] Failed to get sessions by file:', error);
      return { success: false, error: String(error), sessionIds: [] };
    }
  });

  /**
   * Get aggregated file stats for a session (count by type)
   */
  safeHandle('session-files:get-stats', async (event, sessionId: string) => {
    try {
      const [edited, referenced, read] = await Promise.all([
        SessionFilesRepository.getFilesBySession(sessionId, 'edited'),
        SessionFilesRepository.getFilesBySession(sessionId, 'referenced'),
        SessionFilesRepository.getFilesBySession(sessionId, 'read')
      ]);

      return {
        success: true,
        stats: {
          edited: edited.length,
          referenced: referenced.length,
          read: read.length,
          total: edited.length + referenced.length + read.length
        }
      };
    } catch (error) {
      logger.main.error('[SessionFileHandlers] Failed to get file stats:', error);
      return {
        success: false,
        error: String(error),
        stats: { edited: 0, referenced: 0, read: 0, total: 0 }
      };
    }
  });

  /**
   * Get tool call matches for a session
   */
  safeHandle('session-files:get-tool-call-matches', async (event, sessionId: string) => {
    try {
      const matches = await toolCallMatcher.getMatchesForSession(sessionId);
      return { success: true, matches };
    } catch (error) {
      logger.main.error('[SessionFileHandlers] Failed to get tool call matches:', error);
      return { success: false, error: String(error), matches: [] };
    }
  });

  /**
   * Trigger tool call matching for a session (backfill/repair)
   */
  safeHandle('session-files:match-tool-calls', async (event, sessionId: string) => {
    try {
      const matchCount = await toolCallMatcher.matchSession(sessionId);
      return { success: true, matchCount };
    } catch (error) {
      logger.main.error('[SessionFileHandlers] Failed to match tool calls:', error);
      return { success: false, error: String(error), matchCount: 0 };
    }
  });

  /**
   * Get file diffs caused by a specific tool call
   */
  safeHandle(
    'session-files:get-tool-call-diffs',
    async (
      event,
      sessionId: string,
      toolCallItemId: string,
      toolCallTimestamp?: number
    ) => {
      try {
        const diffs = await toolCallMatcher.getDiffsForToolCall(
          sessionId,
          toolCallItemId,
          toolCallTimestamp
        );
        return { success: true, diffs };
      } catch (error) {
        logger.main.error('[SessionFileHandlers] Failed to get tool call diffs:', error);
        return { success: false, error: String(error), diffs: [] };
      }
    }
  );

  /**
   * Session-aware unified diff for a single file edited by an AI session.
   *
   * Renders pre-edit baseline (red) vs post-edit `ai-edit` snapshot (green).
   * Falls back to current disk content as the "after" side when no `ai-edit`
   * snapshot exists (e.g., the post-edit pipeline isn't wired up for the
   * provider, or the file is mid-turn). Returns null when no pre-edit
   * baseline exists so the caller can fall back to `git:file-diff`.
   *
   * Used by FilesEditedSidebar's peek popover to fix the case where git diff
   * shows the entire file as added for gitignored / untracked / brand-new
   * files the session has touched.
   */
  safeHandle(
    'session:file-diff',
    async (
      _event,
      _workspacePath: string,
      sessionId: string,
      filePath: string,
    ): Promise<{
      unifiedDiff: string;
      isBinary: boolean;
      source: 'session-history' | 'session-history-disk-fallback' | 'none';
    }> => {
      if (!sessionId || !filePath) {
        return { unifiedDiff: '', isBinary: false, source: 'none' };
      }
      try {
        const beforeContent = await historyManager.getLatestSnapshotContent(
          filePath,
          sessionId,
          'pre-edit',
        );
        if (beforeContent === null) {
          // No pre-edit baseline for this session — caller falls back to git.
          return { unifiedDiff: '', isBinary: false, source: 'none' };
        }
        let afterContent = await historyManager.getLatestSnapshotContent(
          filePath,
          sessionId,
          'ai-edit',
        );
        let source: 'session-history' | 'session-history-disk-fallback' = 'session-history';
        if (afterContent === null) {
          // Post-edit snapshot not yet written (e.g. mid-turn, or older Codex
          // session predating the post_edit_snapshot pipeline). Use disk
          // content as a best-effort "after" — this matches what the chat
          // transcript inline card has always done.
          try {
            afterContent = await fs.readFile(filePath, 'utf-8');
            source = 'session-history-disk-fallback';
          } catch {
            // File deleted post-edit — show pre-edit content removed against
            // empty after.
            afterContent = '';
            source = 'session-history-disk-fallback';
          }
        }
        if (beforeContent === afterContent) {
          return { unifiedDiff: '', isBinary: false, source };
        }
        const unifiedDiff = createPatch(filePath, beforeContent, afterContent, '', '');
        return { unifiedDiff, isBinary: false, source };
      } catch (error) {
        logger.main.error('[SessionFileHandlers] session:file-diff failed:', error);
        return { unifiedDiff: '', isBinary: false, source: 'none' };
      }
    },
  );

  /**
   * Delete all file links for a session
   */
  safeHandle('session-files:delete-session-links', async (event, sessionId: string) => {
    try {
      await SessionFilesRepository.deleteSessionLinks(sessionId);
      return { success: true };
    } catch (error) {
      logger.main.error('[SessionFileHandlers] Failed to delete session links:', error);
      return { success: false, error: String(error) };
    }
  });
}
