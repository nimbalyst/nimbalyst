import { getShellTrackingCoverage } from '../services/ai/codexShellTrackingHost';
/** IPC handlers for session-file link operations. */

import { AISessionsRepository, SessionFilesRepository, type FileLinkType, type FileLink } from '@nimbalyst/runtime';
import { promises as fs } from 'fs';
import path from 'node:path';
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

export function isSessionWorkspaceAllowed(
  session: { workspacePath?: string; worktreePath?: string; worktreeProjectPath?: string } | null | undefined,
  workspacePath: string,
): boolean {
  if (!session || !workspacePath) return false;
  const requestedWorkspace = path.resolve(workspacePath);
  return [session.workspacePath, session.worktreePath, session.worktreeProjectPath]
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
    .some((candidate) => path.resolve(candidate) === requestedWorkspace);
}

/**
 * Normalize a `session:file-diff` request path to the absolute form
 * `document_history.file_path` is keyed by.
 *
 * The sidebars send absolute paths, but the commit proposal widget sends the
 * workspace-relative paths `git:get-commit-context` produced. Matching a
 * relative path against the absolute key found nothing, so every proposal fell
 * back to "no session baseline" and lost its hunk pre-selection.
 *
 * Absolute paths pass through untouched -- a session may legitimately have
 * edited a file outside the workspace, and that has always been diffable here.
 * Returns null when a relative path cannot be safely rooted.
 */
export function resolveSessionDiffPath(
  workspacePath: string | undefined,
  filePath: string,
): string | null {
  if (!filePath) return null;
  if (path.isAbsolute(filePath)) return filePath;
  if (!workspacePath) return null;

  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, filePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function invalidateSessionCache(sessionId: string): void {
  sessionFilesCache.invalidate(sessionId);
}

export function setupSessionFileHandlers(): void {
  safeHandle('session-files:coverage', (_event, ids: string[]) => getShellTrackingCoverage(ids));
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
      const unique = Array.from(new Set(sessionIds ?? [])).filter(Boolean);
      if (unique.length === 0) return { success: true, files: [] };

      // Go through the per-session cache so batching keeps NIM-816's
      // epoch-based invalidation semantics, but let every cache MISS share a
      // single `getFilesBySessionMany` round trip. The shared query is created
      // lazily, so an all-hit batch issues no query at all. It fetches the
      // whole requested set (a superset of the misses) — one query either way.
      let shared: Promise<FileLink[]> | null = null;
      const runShared = () => (shared ??= SessionFilesRepository.getFilesBySessionMany(unique, linkType as any));

      const perSession = await Promise.all(
        unique.map((sessionId) =>
          sessionFilesCache.get(sessionId, linkType, async () => {
            const all = await runShared();
            return all.filter((file) => file.sessionId === sessionId);
          })
        )
      );

      return { success: true, files: perSession.flat() };
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
      // One round trip, counted in JS, sharing the linkType-less cache entry
      // with `session-files:get-by-session`. This used to fire three queries
      // over the same index for three subsets of the same rows — on a FIFO
      // single-lane DB worker each one is an independent chance to queue
      // behind an unrelated multi-second query.
      const files = await sessionFilesCache.get(sessionId, undefined, () =>
        SessionFilesRepository.getFilesBySession(sessionId)
      );

      const counts = { edited: 0, referenced: 0, read: 0 };
      for (const file of files) {
        if (file.linkType in counts) counts[file.linkType as keyof typeof counts] += 1;
      }

      return {
        success: true,
        stats: { ...counts, total: counts.edited + counts.referenced + counts.read }
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
      _event,
      workspacePath: string,
      sessionId: string,
      toolCallItemId: string,
      toolCallTimestamp?: number
    ) => {
      if (!workspacePath || !sessionId || !toolCallItemId) {
        return { state: 'failed', diffs: [], omissions: [], errorCode: 'snapshot-read-failed' };
      }
      try {
        const session = await AISessionsRepository.get(sessionId);
        if (!isSessionWorkspaceAllowed(session, workspacePath)) {
          logger.main.warn('[SessionFileHandlers] Rejected cross-workspace tool diff request', {
            sessionId,
          });
          return { state: 'failed', diffs: [], omissions: [], errorCode: 'snapshot-read-failed' };
        }

        return await toolCallMatcher.getDiffsForToolCallResult(
          sessionId,
          toolCallItemId,
          toolCallTimestamp
        );
      } catch (error) {
        logger.main.error('[SessionFileHandlers] Failed to get tool call diffs:', error);
        return { state: 'failed', diffs: [], omissions: [], errorCode: 'worker-failed' };
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
      workspacePath: string,
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
      // Snapshots are keyed by absolute path; the commit widget asks with
      // workspace-relative ones.
      const absoluteFilePath = resolveSessionDiffPath(workspacePath, filePath);
      if (!absoluteFilePath) {
        return { unifiedDiff: '', isBinary: false, source: 'none' };
      }
      try {
        const beforeContent = await historyManager.getLatestSnapshotContent(
          absoluteFilePath,
          sessionId,
          'pre-edit',
        );
        if (beforeContent === null) {
          // No pre-edit baseline for this session — caller falls back to git.
          return { unifiedDiff: '', isBinary: false, source: 'none' };
        }
        let afterContent = await historyManager.getLatestSnapshotContent(
          absoluteFilePath,
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
            afterContent = await fs.readFile(absoluteFilePath, 'utf-8');
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
