import { app, BrowserWindow } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { database } from './database/PGLiteDatabaseWorker';
import { logger } from './utils/logger';
import { parseJsonObjectColumn } from './utils/jsonColumn';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export type SnapshotType = 'auto-save' | 'manual' | 'ai-diff' | 'pre-apply' | 'external-change' | 'ai-edit' | 'incremental-approval';

export interface Snapshot {
  timestamp: string;
  type: SnapshotType;
  size: number;
  baseMarkdownHash: string;
  metadata?: any;
}

export type TagStatus = 'pending-review' | 'reviewed' | 'archived';

export interface HistoryTag {
  id: string;                    // "pre-ai-edit-${sessionId}-${toolUseId}"
  filePath: string;
  content: string;               // The tagged content
  type: 'pre-edit' | 'incremental-approval';  // Tag type
  status: TagStatus;
  sessionId: string;
  toolUseId: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Manages document history snapshots and tags for version control and AI diff tracking.
 *
 * Features:
 * - Snapshot creation with compression and deduplication
 * - Tag-based tracking for AI editing sessions (pre-edit and incremental-approval tags)
 * - Automatic cleanup of old snapshots based on age and count limits
 * - Baseline content retrieval for diff comparison during AI sessions
 *
 * Storage: All data is stored in the PGLite database (document_history table) with
 * compressed content to minimize disk usage.
 */
export class HistoryManager {
  private maxSnapshots = 250;
  private maxAgeDays = 30;
  private pendingSnapshots = new Map<string, { promise: Promise<void>; timestamp: number }>(); // Track in-flight snapshot creations
  private readonly DEDUP_WINDOW_MS = 1500; // Only deduplicate within 1500ms window

  // Short-TTL cache + in-flight dedup for getPendingFilesForSession.
  // The underlying query (LIKE workspacePath% + two metadata->>? JSON extracts)
  // is 50-127ms on SQLite, and was being fanned out hundreds of times per
  // second from the renderer. Cache invalidates on createTag/markTagReviewed.
  private pendingFilesCache = new Map<string, { value: string[]; expiresAt: number }>();
  private pendingFilesInFlight = new Map<string, Promise<string[]>>();
  private readonly PENDING_FILES_TTL_MS = 2000;

  private invalidatePendingFilesForWorkspace(workspacePath: string): void {
    const prefix = `${workspacePath}|`;
    for (const key of this.pendingFilesCache.keys()) {
      if (key.startsWith(prefix)) this.pendingFilesCache.delete(key);
    }
  }

  // Trailing-debounce for the pending-count broadcast. getPendingCount is a
  // 100ms-ish full scan (no index serves file_path LIKE + status without a
  // sessionId), and a single git commit auto-approves N tags back-to-back --
  // each tag update used to fire its own count query, producing an N+1 burst
  // of identical scans. Coalesce them: invalidate the files cache immediately
  // (correctness), but run the count+emit once after the burst settles.
  private pendingCountEmitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly PENDING_COUNT_EMIT_DEBOUNCE_MS = 50;

  constructor() {}

  /**
   * Configure the history retention limits.
   * Called during initialization with values from app settings.
   */
  configure(options: { maxAgeDays?: number; maxSnapshots?: number }): void {
    if (options.maxAgeDays !== undefined && options.maxAgeDays > 0) {
      this.maxAgeDays = options.maxAgeDays;
    }
    if (options.maxSnapshots !== undefined && options.maxSnapshots > 0) {
      this.maxSnapshots = options.maxSnapshots;
    }
    logger.main.info('[HistoryManager] Configured:', { maxAgeDays: this.maxAgeDays, maxSnapshots: this.maxSnapshots });
  }

  /**
   * Schedule a pending-count-changed broadcast for a workspace.
   *
   * Cache invalidation is immediate (so getPendingFilesForSession never serves
   * stale data), but the expensive count query + IPC emit are trailing-debounced
   * so a burst of tag mutations (e.g. commit auto-approval over N files)
   * collapses into a single count query instead of N.
   */
  private emitPendingCountChanged(workspacePath: string): void {
    // Any code path that mutates pending state ends up here, so this is the
    // single invalidation point for the getPendingFilesForSession cache.
    this.invalidatePendingFilesForWorkspace(workspacePath);

    const existing = this.pendingCountEmitTimers.get(workspacePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingCountEmitTimers.delete(workspacePath);
      void this.flushPendingCountChanged(workspacePath);
    }, this.PENDING_COUNT_EMIT_DEBOUNCE_MS);
    // Don't keep the process alive just for a pending count broadcast.
    timer.unref?.();
    this.pendingCountEmitTimers.set(workspacePath, timer);
  }

  /** Run the actual count query and broadcast it to all windows. */
  private async flushPendingCountChanged(workspacePath: string): Promise<void> {
    try {
      const count = await this.getPendingCount(workspacePath);
      const windows = BrowserWindow.getAllWindows();
      for (const window of windows) {
        if (!window.isDestroyed()) {
          window.webContents.send('history:pending-count-changed', {
            workspacePath,
            count
          });
        }
      }
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to emit pending count changed:', error);
    }
  }

  async initialize(): Promise<void> {
    // Ensure database is initialized
    if (!database.isInitialized()) {
      await database.initialize();
    }

    await this.cleanup();
  }


  async createSnapshot(
    filePath: string,
    state: string,
    type: SnapshotType,
    description?: string,
    extraMetadata?: Record<string, unknown>
  ): Promise<void> {
    // Calculate markdown hash first
    const baseMarkdownHash = crypto
      .createHash('sha256')
      .update(state)
      .digest('hex');

    // Create a unique key for this snapshot (file + hash)
    const snapshotKey = `${filePath}:${baseMarkdownHash}`;
    const now = Date.now();

    // If there's already a pending snapshot with the same content within dedup window, wait for it and skip
    const existing = this.pendingSnapshots.get(snapshotKey);
    if (existing) {
      const timeSinceStart = now - existing.timestamp;
      if (timeSinceStart < this.DEDUP_WINDOW_MS) {
        logger.main.debug('[HistoryManager] Skipping duplicate snapshot (already in progress, within dedup window):', snapshotKey);
        await existing.promise; // Wait for the existing one to complete
        return;
      } else {
        // Outside dedup window - this is a legitimate re-save of same content
        logger.main.debug('[HistoryManager] Allowing snapshot (outside dedup window):', snapshotKey);
      }
    }

    // Create a promise for this snapshot operation
    const snapshotPromise = this._createSnapshotImpl(filePath, state, type, description, baseMarkdownHash, extraMetadata);
    this.pendingSnapshots.set(snapshotKey, { promise: snapshotPromise, timestamp: now });

    try {
      await snapshotPromise;
    } finally {
      // Clean up the pending snapshot entry
      this.pendingSnapshots.delete(snapshotKey);
    }
  }

  private async _createSnapshotImpl(
    filePath: string,
    state: string,
    type: SnapshotType,
    description: string | undefined,
    baseMarkdownHash: string,
    extraMetadata?: Record<string, unknown>
  ): Promise<void> {
    // Check for duplicate: if the most recent snapshot has the same content hash, skip
    try {
      // Ensure database is initialized
      if (!database.isInitialized()) {
        await database.initialize();
      }

      // Get the most recent snapshot for this file
      const recentResult = await database.query<{ metadata: any }>(`
        SELECT metadata
        FROM document_history
        WHERE file_path = $1
        ORDER BY timestamp DESC
        LIMIT 1
      `, [filePath]);

      if (recentResult.rows.length > 0) {
        const recentMetadata = recentResult.rows[0].metadata;
        if (recentMetadata?.baseMarkdownHash === baseMarkdownHash) {
          logger.main.debug('[HistoryManager] Skipping duplicate snapshot (same content hash in DB):', filePath);
          return; // Skip creating duplicate
        }
      }
    } catch (error) {
      // If deduplication check fails, continue with snapshot creation
      logger.main.warn('[HistoryManager] Deduplication check failed, creating snapshot anyway:', error);
    }

    // Compress the state
    const compressed = await gzip(Buffer.from(state, 'utf-8'));

    // Save to database
    try {
      // Ensure database is initialized
      if (!database.isInitialized()) {
        await database.initialize();
      }

      // Determine workspace ID
      let workspaceId: string | null = null;
      const dirPath = path.dirname(filePath);
      if (dirPath !== '/' && dirPath !== path.parse(dirPath).root) {
        workspaceId = dirPath;
      }

      await database.query(`
        INSERT INTO document_history (
          workspace_id,
          file_path,
          content,
          size_bytes,
          timestamp,
          version,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        workspaceId,
        filePath,
        compressed, // Store compressed content directly in database
        compressed.length,
        Date.now(),
        1,
        { type, description, baseMarkdownHash, ...extraMetadata }
      ]);

      logger.main.debug('[HistoryManager] Saved history to database for:', filePath);
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to save history to database:', error);
      throw error; // Actually fail if we can't save
    }
  }


  async listSnapshots(filePath: string): Promise<Snapshot[]> {
    try {
      // Ensure database is initialized
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const result = await database.query<{
        timestamp: number;
        size_bytes: number;
        metadata: any;
      }>(`
        SELECT timestamp, size_bytes, metadata
        FROM document_history
        WHERE file_path = $1
        ORDER BY timestamp DESC
      `, [filePath]);

      return result.rows.map(row => {
        const metadata = parseJsonObjectColumn(row.metadata);
        return {
          timestamp: new Date(row.timestamp).toISOString(),
          type: metadata.type || 'manual',
          size: row.size_bytes,
          baseMarkdownHash: metadata.baseMarkdownHash || '',
          metadata,
        };
      });
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to list snapshots:', error);
      return [];
    }
  }

  async loadSnapshot(filePath: string, timestamp: string): Promise<string> {
    try {
      // Ensure database is initialized
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const result = await database.query<{ content: Buffer }>(`
        SELECT content
        FROM document_history
        WHERE file_path = $1 AND timestamp = $2
        LIMIT 1
      `, [filePath, Date.parse(timestamp)]);

      if (result.rows.length === 0) {
        throw new Error('Snapshot not found');
      }

      const compressed = result.rows[0].content;
      const decompressed = await gunzip(compressed);
      return decompressed.toString('utf-8');
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to load snapshot from database:', error);
      throw error;
    }
  }

  async deleteSnapshot(filePath: string, timestamp: string): Promise<void> {
    try {
      await database.query(`
        DELETE FROM document_history
        WHERE file_path = $1 AND timestamp = $2
      `, [filePath, Date.parse(timestamp)]);
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to delete snapshot:', error);
      throw error;
    }
  }


  async cleanup(): Promise<void> {
    try {
      const now = Date.now();
      const maxAge = this.maxAgeDays * 24 * 60 * 60 * 1000;

      // Delete old snapshots
      await database.query(`
        DELETE FROM document_history
        WHERE timestamp < $1
      `, [now - maxAge]);

      // Keep only maxSnapshots per file
      // Use CTE to avoid race conditions with corrupted data
      await database.query(`
        WITH ids_to_keep AS (
          SELECT id
          FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY timestamp DESC) as rn
            FROM document_history
          ) t
          WHERE rn <= $1
        ),
        ids_to_delete AS (
          SELECT id FROM document_history WHERE id NOT IN (SELECT id FROM ids_to_keep)
        )
        DELETE FROM document_history
        WHERE id IN (SELECT id FROM ids_to_delete)
        AND EXISTS (SELECT 1 FROM document_history dh WHERE dh.id = document_history.id)
      `, [this.maxSnapshots]);
    } catch (error: any) {
      logger.main.error('[HistoryManager] Cleanup failed:', error);
    }
  }

  /**
   * List all files with history in a workspace
   * Returns file paths with their latest snapshot timestamp and count
   */
  async listWorkspaceFiles(workspacePath: string): Promise<{
    path: string;
    latestTimestamp: number;
    snapshotCount: number;
  }[]> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      // Query files that are in this workspace or in subdirectories of it
      const result = await database.query<{
        file_path: string;
        latest: number;
        count: string;
      }>(`
        SELECT file_path, MAX(timestamp) as latest, COUNT(*) as count
        FROM document_history
        WHERE file_path LIKE $1
        GROUP BY file_path
        ORDER BY latest DESC
      `, [workspacePath + '/%']);

      return result.rows.map(row => ({
        path: row.file_path,
        latestTimestamp: Number(row.latest),
        snapshotCount: Number(row.count)
      }));
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to list workspace files:', error);
      return [];
    }
  }

  /**
   * Delete all history for a workspace
   */
  async deleteWorkspaceHistory(workspacePath: string): Promise<void> {
    try {
      logger.main.info('[HistoryManager] Deleting history for workspace:', workspacePath);

      await database.query(`
        DELETE FROM document_history
        WHERE workspace_id = $1
      `, [workspacePath]);

      logger.main.info('[HistoryManager] Deleted history for workspace:', workspacePath);
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to delete workspace history:', error);
    }
  }

  /**
   * Create a tag for a document version (Phase 1 of file-watcher diff approval)
   * Tags are permanent records that mark specific document states
   */
  async createTag(
    workspacePath: string,
    filePath: string,
    tagId: string,
    content: string,
    sessionId: string,
    toolUseId: string,
    options?: { replaceSpeculative?: boolean }
  ): Promise<void> {
    try {
      // Ensure database is initialized
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const now = Date.now();
      const compressed = await gzip(Buffer.from(content, 'utf-8'));

      const workspaceId = workspacePath;

      // If the SAME session already has a pending tag for this file, keep it.
      // The original pre-edit baseline is the correct one for cumulative diffs.
      //
      // EXCEPTION: If the existing tag has empty content but the new content is
      // non-empty, update the existing tag. This fixes a race condition where
      // the watcher-based WorkspaceFileEditAttributionService creates a tag with
      // empty beforeContent (cache miss / null fallback) before the proactive
      // file_change handler can supply the correct baseline from the snapshot cache.
      const existing = await database.query<{ session_id: string; content: Buffer; tag_id: string }>(`
        SELECT metadata->>'sessionId' as session_id, content, metadata->>'tagId' as tag_id
        FROM document_history
        WHERE file_path = $1
          AND metadata->>'status' = 'pending-review'
        LIMIT 1
      `, [filePath]);

      if (existing.rows.length > 0 && existing.rows[0].session_id === sessionId) {
        // Check if the existing tag has empty content and we have better content
        const existingContent = existing.rows[0].content;
        let existingIsEmpty = !existingContent || existingContent.length === 0;
        if (!existingIsEmpty) {
          try {
            existingIsEmpty = (await gunzip(existingContent)).toString('utf-8').length === 0;
          } catch {
            // Decompression failed — treat as non-empty to avoid overwriting
            existingIsEmpty = false;
          }
        }

        const existingTagId = existing.rows[0].tag_id;
        const replaceSpeculative = options?.replaceSpeculative === true;

        // Authoritative attribution override: when an explicitly
        // authoritative caller (file_change `pre_edit_snapshot`, OpenCode
        // / Codex-ACP edit tool handlers) calls with a different tagId
        // than the existing tag, replace tagId, toolUseId, AND content in
        // place. The flag is required -- a heuristic on the toolUseId
        // string is not sufficient, because watcher-attribution callers
        // (HooklessAgentFileWatcher's trackBashEditsFromCommand, the
        // workspace-edit watcher) ALSO mint `nimtc|`-prefixed IDs by
        // attributing to a recent Bash tool call's editGroupId, and a
        // stale `sed` command can outscore a still-being-stored file_change
        // in the same chokidar tick. Without an explicit caller signal we
        // can't tell speculative `nimtc|` IDs from authoritative ones.
        // Run BEFORE the upgrade-empty branch so an authoritative caller
        // always wins -- otherwise an existing-empty + authoritative-new
        // combo would only update content (not toolUseId) and the diff
        // would still mis-attribute via ToolCallMatcher.computeHistoryDiff.
        if (replaceSpeculative && existingTagId !== tagId) {
          logger.main.info('[HistoryManager] Replacing speculative pre-edit tag with authoritative attribution:', {
            filePath,
            sessionId,
            previousTagId: existingTagId,
            newTagId: tagId,
            newToolUseId: toolUseId,
            existingWasEmpty: existingIsEmpty,
            replaceSpeculative,
          });
          await database.query(`
            UPDATE document_history
            SET content = $1,
                size_bytes = $2,
                timestamp = $3,
                metadata = jsonb_set(
                  jsonb_set(
                    jsonb_set(metadata, '{tagId}', to_jsonb($4::text)),
                    '{toolUseId}', to_jsonb($5::text)
                  ),
                  '{updatedAt}', to_jsonb($6::bigint)
                )
            WHERE file_path = $7
              AND metadata->>'tagId' = $8
          `, [compressed, compressed.length, now, tagId, toolUseId, now, filePath, existingTagId]);

          const windows = BrowserWindow.getAllWindows();
          for (const window of windows) {
            if (!window.isDestroyed()) {
              window.webContents.send('history:pending-tag-created', { path: filePath });
              window.webContents.send('file-changed-on-disk', { path: filePath });
            }
          }
          return;
        }

        if (existingIsEmpty && content.length > 0) {
          // Upgrade the empty tag with real baseline content
          logger.main.info('[HistoryManager] Upgrading empty pre-edit tag with real baseline:', {
            filePath,
            sessionId,
            existingTagId,
            newContentLength: content.length,
          });
          await this.updateTagContent(filePath, existingTagId, content);

          // Re-notify renderer so it re-reads the now-correct baseline
          const windows = BrowserWindow.getAllWindows();
          for (const window of windows) {
            if (!window.isDestroyed()) {
              window.webContents.send('file-changed-on-disk', { path: filePath });
            }
          }
          return;
        }

        // logger.main.debug('[HistoryManager] Keeping existing pre-edit tag for same session:', { filePath, sessionId });
        return;
      }

      // Clear pending tags from OTHER sessions (different session taking over this file)
      if (existing.rows.length > 0) {
        await database.query(`
          UPDATE document_history
          SET metadata = jsonb_set(metadata, '{status}', to_jsonb('reviewed'::text))
          WHERE file_path = $1
            AND metadata->>'status' = 'pending-review'
        `, [filePath]);
      }

      // Store tag as a special history entry with tag metadata
      await database.query(`
        INSERT INTO document_history (
          workspace_id,
          file_path,
          content,
          size_bytes,
          timestamp,
          version,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        workspaceId,
        filePath,
        compressed,
        compressed.length,
        now,
        1,
        {
          type: 'pre-edit',
          tagId,
          status: 'pending-review' as TagStatus,
          sessionId,
          toolUseId,
          createdAt: now,
          updatedAt: now
        }
      ]);

      // logger.main.info('[HistoryManager] Created tag:', { filePath, tagId, sessionId, toolUseId });

      // Notify open editors that a pending tag was created for this file.
      // This is a separate event from file-changed-on-disk so editors can
      // bypass echo suppression and check for the newly created tag.
      const windows = BrowserWindow.getAllWindows();
      for (const window of windows) {
        if (!window.isDestroyed()) {
          window.webContents.send('history:pending-tag-created', { path: filePath });
        }
      }

      // Emit pending count changed event
      this.emitPendingCountChanged(workspaceId);
    } catch (error: any) {
      logger.main.warn('[HistoryManager] createTag encountered error:', {
        filePath,
        tagId,
        sessionId,
        toolUseId,
        errorCode: error?.code,
        errorMessage: error?.message,
      });

      // Check if this is a unique constraint violation (duplicate pending pre-edit tag)
      if (
        error.code === '23505' ||
        error.message?.includes('idx_history_pending_pre_edit_per_file') ||
        error.message?.includes('idx_history_one_pending_per_file')
      ) {
        logger.main.info('[HistoryManager] Skipping tag creation - file already has pending pre-edit tag:', { filePath });
        // This is expected when AI makes multiple rapid edits - silently ignore
        return;
      }

      logger.main.error('[HistoryManager] Failed to create tag:', error);
      throw error;
    }
  }

  /**
   * Get a specific tag by ID
   */
  async getTag(filePath: string, tagId: string): Promise<HistoryTag | null> {
    try {
      // Ensure database is initialized
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const result = await database.query<{
        content: Buffer;
        metadata: any;
      }>(`
        SELECT content, metadata
        FROM document_history
        WHERE file_path = $1
          AND metadata->>'tagId' = $2
          AND metadata->>'type' = 'pre-edit'
        ORDER BY timestamp DESC
        LIMIT 1
      `, [filePath, tagId]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      const compressed = row.content;
      const decompressed = await gunzip(compressed);
      const content = decompressed.toString('utf-8');

      const metadata = parseJsonObjectColumn(row.metadata);
      return {
        id: tagId,
        filePath,
        content,
        type: metadata.type || 'pre-edit',
        status: metadata.status,
        sessionId: metadata.sessionId,
        toolUseId: metadata.toolUseId,
        createdAt: new Date(metadata.createdAt),
        updatedAt: new Date(metadata.updatedAt)
      };
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to get tag:', error);
      return null;
    }
  }

  /**
   * Update tag content (used during incremental accept/reject)
   */
  async updateTagContent(filePath: string, tagId: string, newContent: string): Promise<void> {
    try {
      // Ensure database is initialized
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const compressed = await gzip(Buffer.from(newContent, 'utf-8'));
      const now = Date.now();

      await database.query(`
        UPDATE document_history
        SET content = $1,
            size_bytes = $2,
            metadata = jsonb_set(metadata, '{updatedAt}', to_jsonb($3::bigint))
        WHERE file_path = $4
          AND metadata->>'tagId' = $5
          AND metadata->>'type' = 'pre-edit'
      `, [compressed, compressed.length, now, filePath, tagId]);

      logger.main.debug('[HistoryManager] Updated tag content:', { filePath, tagId });
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to update tag content:', error);
      throw error;
    }
  }

  /**
   * Update tag status (pending-review -> reviewed -> archived)
   * Works for both pre-edit and incremental-approval tags
   * @param filePath - Full path to the file
   * @param tagId - The tag ID to update
   * @param status - New status value
   * @param workspacePath - Optional workspace path for event emission (uses file directory if not provided)
   */
  async updateTagStatus(filePath: string, tagId: string, status: TagStatus, workspacePath?: string): Promise<void> {
    try {
      // Ensure database is initialized
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const now = Date.now();

      // logger.main.info('[HistoryManager] BEFORE updateTagStatus:', { filePath, tagId, status });

      const result = await database.query(`
        UPDATE document_history
        SET metadata = jsonb_set(
              jsonb_set(metadata, '{status}', to_jsonb($1::text)),
              '{updatedAt}', to_jsonb($2::bigint)
            )
        WHERE file_path = $3
          AND metadata->>'tagId' = $4
      `, [status, now, filePath, tagId]);

      // logger.main.info('[HistoryManager] AFTER updateTagStatus - rows affected:', (result as any).rowCount || 0);

      // Verify the update worked
      const checkResult = await database.query(`
        SELECT metadata->>'status' as status, metadata->>'tagId' as tag_id, metadata->>'type' as type
        FROM document_history
        WHERE file_path = $1
          AND (metadata->>'type' = 'pre-edit' OR metadata->>'type' = 'incremental-approval')
      `, [filePath]);

      // logger.main.info('[HistoryManager] All tags for file after update:',
      //   checkResult.rows.map((r: any) => ({ tagId: r.tag_id, type: r.type, status: r.status }))
      // );

      // Emit pending count changed event when status changes away from pending-review
      if (status === 'reviewed' || status === 'archived') {
        // Use provided workspace path, or fall back to file's directory
        const eventPath = workspacePath || path.dirname(filePath);
        if (eventPath !== '/' && eventPath !== path.parse(eventPath).root) {
          this.emitPendingCountChanged(eventPath);
        }
      }
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to update tag status:', error);
      throw error;
    }
  }

  /**
   * Get all pending tags (status='pending-review') for a file or all files
   */
  async getPendingTags(filePath?: string): Promise<HistoryTag[]> {
    try {
      // Ensure database is initialized
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const query = filePath
        ? `
          SELECT file_path, content, metadata
          FROM document_history
          WHERE file_path = $1
            AND metadata->>'status' = 'pending-review'
          ORDER BY timestamp DESC
        `
        : `
          SELECT file_path, content, metadata
          FROM document_history
          WHERE metadata->>'status' = 'pending-review'
          ORDER BY timestamp DESC
        `;

      const params = filePath ? [filePath] : [];
      const result = await database.query<{
        file_path: string;
        content: Buffer;
        metadata: any;
      }>(query, params);

      const tags: HistoryTag[] = [];
      for (const row of result.rows) {
        const compressed = row.content;
        const decompressed = await gunzip(compressed);
        const content = decompressed.toString('utf-8');

        const metadata = parseJsonObjectColumn(row.metadata);
        tags.push({
          id: metadata.tagId,
          filePath: row.file_path,
          content,
          type: metadata.type,
          status: metadata.status,
          sessionId: metadata.sessionId,
          toolUseId: metadata.toolUseId,
          createdAt: new Date(metadata.createdAt),
          updatedAt: new Date(metadata.updatedAt)
        });
      }

      // PRODUCTION LOG: Track pending tag queries to diagnose missing diff display
      if (filePath && tags.length === 0) {
        // console.log('[TAG CHECK] No pending tags found for file:', filePath);
      } else if (filePath && tags.length > 0) {
        // console.log('[TAG CHECK] Found pending tag:', JSON.stringify({
        //   file: path.basename(filePath),
        //   tagId: tags[0].id,
        //   status: tags[0].status,
        //   age: Date.now() - tags[0].createdAt.getTime() + 'ms',
        // }));
      }

      return tags;
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to get pending tags:', error);
      return [];
    }
  }

  /**
   * Check if a tag exists
   */
  async hasTag(filePath: string, tagId: string): Promise<boolean> {
    try {
      // Ensure database is initialized
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const result = await database.query<{ count: number }>(`
        SELECT COUNT(*) as count
        FROM document_history
        WHERE file_path = $1
          AND metadata->>'tagId' = $2
          AND metadata->>'type' = 'pre-edit'
      `, [filePath, tagId]);

      return result.rows[0]?.count > 0;
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to check tag existence:', error);
      return false;
    }
  }

  /**
   * Create an incremental-approval tag marking a partial accept/reject during AI session
   * These tags form a chain of user decisions, updating the baseline for remaining diffs
   */
  async createIncrementalApprovalTag(
    filePath: string,
    content: string,
    sessionId: string,
    metadata?: { acceptedGroups?: string[], rejectedGroups?: string[], remainingGroups?: string[] }
  ): Promise<string> {
    try {
      // Ensure database is initialized
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const now = Date.now();
      const compressed = await gzip(Buffer.from(content, 'utf-8'));

      // Generate unique tag ID
      const tagId = `incremental-${sessionId}-${now}`;

      // Determine workspace ID
      let workspaceId: string | null = null;
      const dirPath = path.dirname(filePath);
      if (dirPath !== '/' && dirPath !== path.parse(dirPath).root) {
        workspaceId = dirPath;
      }

      // CRITICAL: Mark any existing pending tag as reviewed
      // The unique index ensures only ONE can be pending-review at a time
      // When creating a new incremental-approval, the previous state (whether pre-edit or
      // previous incremental-approval) has been reviewed and accepted by the user
      await database.query(`
        UPDATE document_history
        SET metadata = jsonb_set(metadata, '{status}', to_jsonb('reviewed'::text))
        WHERE file_path = $1
          AND metadata->>'status' = 'pending-review'
      `, [filePath]);

      // Store as history entry with incremental-approval type and status = pending-review
      await database.query(`
        INSERT INTO document_history (
          workspace_id,
          file_path,
          content,
          size_bytes,
          timestamp,
          version,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        workspaceId,
        filePath,
        compressed,
        compressed.length,
        now,
        1,
        {
          type: 'incremental-approval',
          tagId,
          status: 'pending-review',
          sessionId,
          createdAt: now,
          updatedAt: now,
          ...metadata
        }
      ]);

      logger.main.info('[HistoryManager] Created incremental-approval tag:', { filePath, sessionId, tagId });
      return tagId;
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to create incremental-approval tag:', error);
      throw error;
    }
  }

  /**
   * Convenience method to mark a tag as reviewed
   * This is a wrapper around updateTagStatus for clarity
   */
  async markTagAsReviewed(filePath: string, tagId: string): Promise<void> {
    await this.updateTagStatus(filePath, tagId, 'reviewed');
  }

  /**
   * Get count of files with pending-review tags in a workspace
   */
  async getPendingCount(workspacePath: string): Promise<number> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      // The status predicate must textually match the partial index
      // idx_history_one_pending_per_file or the planner falls back to a full
      // table scan (~100ms). SQLite indexes the json_extract form; PGLite the
      // ->> form. A ->> query does NOT match a json_extract index on SQLite.
      const isSqlite = database.getEngine() === 'sqlite';
      const statusExpr = isSqlite
        ? `json_extract(metadata, '$.status')`
        : `metadata->>'status'`;

      // Use file_path LIKE to match all files within the workspace directory
      const result = await database.query<{ count: string }>(`
        SELECT COUNT(DISTINCT file_path) as count
        FROM document_history
        WHERE file_path LIKE $1
          AND ${statusExpr} = 'pending-review'
      `, [workspacePath + '%']);

      return parseInt(result.rows[0]?.count || '0', 10);
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to get pending count:', error);
      return 0;
    }
  }

  /**
   * Get list of files with pending-review tags for a specific session
   */
  async getPendingFilesForSession(workspacePath: string, sessionId: string): Promise<string[]> {
    const cacheKey = `${workspacePath}|${sessionId}`;
    const now = Date.now();
    const cached = this.pendingFilesCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;
    const inFlight = this.pendingFilesInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = (async () => {
      try {
        if (!database.isInitialized()) {
          await database.initialize();
        }

        // SQLite uses json_extract so the planner can match
        // idx_history_pending_session_file (migration 2). PGLite needs the
        // PostgreSQL ->> operator: its metadata column is jsonb, and
        // json_extract has no (jsonb, unknown) overload there. The dialect
        // split is required -- a single form cannot satisfy both engines.
        const isSqlite = database.getEngine() === 'sqlite';
        const sessionIdExpr = isSqlite
          ? `json_extract(metadata, '$.sessionId')`
          : `metadata->>'sessionId'`;
        const statusExpr = isSqlite
          ? `json_extract(metadata, '$.status')`
          : `metadata->>'status'`;
        const result = await database.query<{ file_path: string }>(`
          SELECT DISTINCT file_path
          FROM document_history
          WHERE ${sessionIdExpr} = $1
            AND ${statusExpr} = 'pending-review'
            AND file_path LIKE $2
        `, [sessionId, workspacePath + '%']);

        return result.rows.map((row: { file_path: string }) => row.file_path);
      } catch (error) {
        logger.main.error('[HistoryManager] Failed to get pending files for session:', error);
        return [];
      }
    })();

    this.pendingFilesInFlight.set(cacheKey, promise);
    try {
      const value = await promise;
      this.pendingFilesCache.set(cacheKey, { value, expiresAt: Date.now() + this.PENDING_FILES_TTL_MS });
      return value;
    } finally {
      this.pendingFilesInFlight.delete(cacheKey);
    }
  }

  /**
   * Get all files that have any tags (pending-review or reviewed) for a session.
   * Used to seed the FileSnapshotCache with gitignored files that have prior history.
   */
  async getTaggedFilesForSession(workspacePath: string, sessionId: string): Promise<string[]> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const result = await database.query<{ file_path: string }>(`
        SELECT DISTINCT file_path
        FROM document_history
        WHERE file_path LIKE $1
          AND metadata->>'sessionId' = $2
          AND metadata->>'type' IN ('pre-edit', 'incremental-approval')
      `, [workspacePath + '%', sessionId]);

      return result.rows.map((row: { file_path: string }) => row.file_path);
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to get tagged files for session:', error);
      return [];
    }
  }

  /**
   * Get the timestamp of the most recently reviewed tag for a file.
   * Returns null if no reviewed tags exist.
   */
  async getLastReviewedTimestamp(filePath: string): Promise<number | null> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const result = await database.query<{ last_reviewed_at: string }>(`
        SELECT MAX(CAST(metadata->>'updatedAt' AS bigint)) as last_reviewed_at
        FROM document_history
        WHERE file_path = $1
          AND metadata->>'status' = 'reviewed'
          AND metadata->>'type' = 'pre-edit'
      `, [filePath]);

      const val = result.rows[0]?.last_reviewed_at;
      return val ? parseInt(val, 10) : null;
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to get last reviewed timestamp:', error);
      return null;
    }
  }

  /**
   * Get count of files with pending-review tags for a specific session
   */
  async getPendingCountForSession(workspacePath: string, sessionId: string): Promise<number> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const result = await database.query<{ count: string }>(`
        SELECT COUNT(DISTINCT file_path) as count
        FROM document_history
        WHERE file_path LIKE $1
          AND metadata->>'status' = 'pending-review'
          AND metadata->>'sessionId' = $2
      `, [workspacePath + '%', sessionId]);

      return parseInt(result.rows[0]?.count || '0', 10);
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to get pending count for session:', error);
      return 0;
    }
  }

  /**
   * Clear all pending tags in a workspace by marking them as reviewed
   * Returns an object with the count and list of cleared file paths
   */
  async clearAllPending(workspacePath: string): Promise<{ count: number; clearedFiles: string[] }> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const now = Date.now();

      // First get the list of files we're clearing (for notifying tabs)
      // Use file_path LIKE to match all files within the workspace directory
      const filesResult = await database.query<{ file_path: string }>(`
        SELECT DISTINCT file_path
        FROM document_history
        WHERE file_path LIKE $1
          AND metadata->>'status' = 'pending-review'
      `, [workspacePath + '%']);

      const clearedFiles = filesResult.rows.map((row: { file_path: string }) => row.file_path);
      const clearedCount = clearedFiles.length;

      if (clearedCount > 0) {
        // Update all pending tags to reviewed
        await database.query(`
          UPDATE document_history
          SET metadata = jsonb_set(
                jsonb_set(metadata, '{status}', '"reviewed"'),
                '{updatedAt}', to_jsonb($1::bigint)
              )
          WHERE file_path LIKE $2
            AND metadata->>'status' = 'pending-review'
        `, [now, workspacePath + '%']);

        logger.main.info('[HistoryManager] Cleared all pending tags:', { workspacePath, clearedCount, clearedFiles });

        // Emit pending count changed event (count is now 0)
        this.emitPendingCountChanged(workspacePath);

        // Emit event to notify tabs to exit diff mode for cleared files
        const windows = BrowserWindow.getAllWindows();
        for (const window of windows) {
          if (!window.isDestroyed()) {
            window.webContents.send('history:pending-cleared', {
              workspacePath,
              clearedFiles
            });
          }
        }
      }

      return { count: clearedCount, clearedFiles };
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to clear all pending:', error);
      return { count: 0, clearedFiles: [] };
    }
  }

  /**
   * Clear pending tags for a specific session by marking them as reviewed
   * Returns an object with the count and list of cleared file paths
   */
  async clearPendingForSession(workspacePath: string, sessionId: string): Promise<{ count: number; clearedFiles: string[] }> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const now = Date.now();

      // First get the list of files we're clearing (for notifying tabs)
      const filesResult = await database.query<{ file_path: string }>(`
        SELECT DISTINCT file_path
        FROM document_history
        WHERE file_path LIKE $1
          AND metadata->>'status' = 'pending-review'
          AND metadata->>'sessionId' = $2
      `, [workspacePath + '%', sessionId]);

      const clearedFiles = filesResult.rows.map((row: { file_path: string }) => row.file_path);
      const clearedCount = clearedFiles.length;

      if (clearedCount > 0) {
        // Update pending tags for this session to reviewed
        await database.query(`
          UPDATE document_history
          SET metadata = jsonb_set(
                jsonb_set(metadata, '{status}', '"reviewed"'),
                '{updatedAt}', to_jsonb($1::bigint)
              )
          WHERE file_path LIKE $2
            AND metadata->>'status' = 'pending-review'
            AND metadata->>'sessionId' = $3
        `, [now, workspacePath + '%', sessionId]);

        logger.main.info('[HistoryManager] Cleared pending tags for session:', { workspacePath, sessionId, clearedCount, clearedFiles });

        // Emit pending count changed event
        this.emitPendingCountChanged(workspacePath);

        // Emit event to notify tabs to exit diff mode for cleared files
        const windows = BrowserWindow.getAllWindows();
        for (const window of windows) {
          if (!window.isDestroyed()) {
            window.webContents.send('history:pending-cleared', {
              workspacePath,
              sessionId,
              clearedFiles
            });
          }
        }
      }

      return { count: clearedCount, clearedFiles };
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to clear pending for session:', error);
      return { count: 0, clearedFiles: [] };
    }
  }

  /**
   * Get the baseline content for diff comparison
   * With the unique constraint, there's only ONE pending tag per file.
   * It will be either a pre-edit tag or an incremental-approval tag.
   */
  /**
   * Fetch the most recent snapshot content for (filePath, sessionId,
   * snapshotType). Used by session-aware diff IPC to retrieve the pre-edit
   * baseline (snapshotType='pre-edit') or the AI's post-edit output
   * (snapshotType='ai-edit') for the active session.
   */
  async getLatestSnapshotContent(
    filePath: string,
    sessionId: string,
    snapshotType: SnapshotType | 'pre-edit',
  ): Promise<string | null> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }
      const result = await database.query<{ content: Buffer }>(
        `
          SELECT content
          FROM document_history
          WHERE file_path = $1
            AND metadata->>'sessionId' = $2
            AND metadata->>'type' = $3
          ORDER BY timestamp DESC
          LIMIT 1
        `,
        [filePath, sessionId, snapshotType],
      );
      if (result.rows.length === 0) return null;
      const decompressed = await gunzip(result.rows[0].content);
      return decompressed.toString('utf-8');
    } catch (error) {
      logger.main.error('[HistoryManager] getLatestSnapshotContent failed:', error);
      return null;
    }
  }

  /**
   * Fetch a file's content as of a point in time within a session: the newest
   * snapshot for (filePath, sessionId) whose timestamp is <= `timestampMs`.
   * Used by the edit/rewind file-revert to restore a file to its as-of-message-N
   * state. Best-effort -- bounded by snapshot retention. Returns null when no
   * in-session snapshot at or before the cutoff exists.
   */
  async getSnapshotContentAsOf(
    filePath: string,
    sessionId: string,
    timestampMs: number,
  ): Promise<string | null> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }
      const result = await database.query<{ content: Buffer }>(
        `
          SELECT content
          FROM document_history
          WHERE file_path = $1
            AND metadata->>'sessionId' = $2
            AND timestamp <= $3
          ORDER BY timestamp DESC
          LIMIT 1
        `,
        [filePath, sessionId, timestampMs],
      );
      if (result.rows.length === 0) return null;
      const decompressed = await gunzip(result.rows[0].content);
      return decompressed.toString('utf-8');
    } catch (error) {
      logger.main.error('[HistoryManager] getSnapshotContentAsOf failed:', error);
      return null;
    }
  }

  async getDiffBaseline(filePath: string): Promise<{ content: string; tagType: 'pre-edit' | 'incremental-approval' } | null> {
    try {
      // SIMPLIFIED: With the unique constraint, there's only ONE pending tag per file
      // It will be either:
      // - A pre-edit tag (if no acceptances have happened yet)
      // - An incremental-approval tag (if user has accepted some changes)
      // Just return whichever one is pending
      const pendingTags = await this.getPendingTags(filePath);
      if (pendingTags.length === 0) {
        return null; // No AI session in progress
      }

      const pendingTag = pendingTags[0];
      const contentLength = pendingTag.content?.length ?? 0;
      if (contentLength === 0) {
        logger.main.warn('[HistoryManager] getDiffBaseline returning empty content:', {
          filePath,
          tagId: pendingTag.id,
          tagType: pendingTag.type,
          sessionId: pendingTag.sessionId,
        });
      }
      return {
        content: pendingTag.content,
        tagType: pendingTag.type as 'pre-edit' | 'incremental-approval'
      };
    } catch (error) {
      logger.main.error('[HistoryManager] Failed to get diff baseline:', error);
      return null;
    }
  }
}

// Export singleton instance
export const historyManager = new HistoryManager();
