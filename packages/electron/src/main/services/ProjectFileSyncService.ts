/**
 * ProjectFileSyncService
 *
 * Background service that keeps .md files synced to ProjectSyncRoom.
 * Runs continuously in the main process, not tied to open tabs.
 *
 * Responsibilities:
 *   - Startup sync sweep: scan .md files, diff against server, push/pull changes
 *   - Ongoing sync: hook into file watcher for .md file events, push on save
 *   - Remote changes: write files received from mobile to disk
 *   - File watcher echo suppression: don't re-sync files we just wrote
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { logger } from '../utils/logger';
import { ProjectSyncProvider, type ProjectSyncManifestFile, type ProjectSyncResponse, type ProjectSyncFileUpdate } from '@nimbalyst/runtime/sync';
import { getPersonalDocSyncConfig } from './SyncManager';
import { timeStartupPhase } from '../utils/startupTiming';
import { database } from '../database/PGLiteDatabaseWorker';
import { dirtyEditorRegistry } from './DirtyEditorRegistry';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

interface SyncedFileState {
  syncId: string;
  contentHash: string;
  lastSyncedMtime: number;
}

export class ProjectFileSyncService {
  private provider: ProjectSyncProvider | null = null;
  private projectStates = new Map<string, Map<string, SyncedFileState>>(); // projectId -> (syncId -> state)
  private recentlyWrittenFiles = new Set<string>(); // absolute paths of files we just wrote from remote
  private writeSuppressionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Remote writes held back because the target is open in a dirty editor; keyed
  // by absolute path, latest update wins. Flushed when the editor becomes clean.
  private deferredRemoteWrites = new Map<string, { projectId: string; workspacePath: string; file: ProjectSyncFileUpdate }>();
  // Remote deletes held back because the target is open in a dirty editor; keyed
  // by absolute path. Resolved when the editor becomes clean.
  private deferredRemoteDeletes = new Map<string, { projectId: string; workspacePath: string; syncId: string; filePath: string }>();
  private cleanUnsubscribe: (() => void) | null = null;

  constructor() {
    // When an editor saves or closes, retry any remote write/delete we deferred
    // for it. A path has at most one pending op (they supersede each other).
    this.cleanUnsubscribe = dirtyEditorRegistry.onBecameClean((filePath) => {
      void this.flushDeferredWrite(filePath);
      void this.flushDeferredDelete(filePath);
    });
  }

  /**
   * Initialize the service. Creates the ProjectSyncProvider and sets up event handlers.
   */
  async initialize(): Promise<void> {
    const config = getPersonalDocSyncConfig();
    if (!config) {
      logger.main.info('[ProjectFileSync] Sync not configured, skipping initialization');
      return;
    }

    // A prior shutdown() (sync reinitialize) removed the dirty-editor clean
    // listener; without it, deferred remote writes/deletes would never flush.
    if (!this.cleanUnsubscribe) {
      this.cleanUnsubscribe = dirtyEditorRegistry.onBecameClean((filePath) => {
        void this.flushDeferredWrite(filePath);
        void this.flushDeferredDelete(filePath);
      });
    }

    this.provider = new ProjectSyncProvider({
      serverUrl: config.serverUrl,
      orgId: config.orgId,
      userId: config.userId,
      encryptionKey: config.encryptionKeyRaw,
      getJwt: async () => {
        // Re-fetch config each time to get fresh JWT
        const fresh = getPersonalDocSyncConfig();
        if (!fresh) throw new Error('Sync config unavailable');
        // The config doesn't directly expose a JWT getter, so we need
        // to get it from the SyncManager's auth flow
        const { getPersonalSessionJwt } = await import('./StytchAuthService');
        return getPersonalSessionJwt() ?? '';
      },
    });

    // Handle sync response (initial diff)
    this.provider.onSyncResponse((projectId, response) => {
      this.handleSyncResponse(projectId, response);
    });

    // Handle realtime file updates from mobile
    this.provider.onFileUpdate((projectId, file) => {
      this.handleRemoteFileUpdate(projectId, file);
    });

    // Handle realtime file deletions from mobile
    this.provider.onFileDelete((projectId, syncId) => {
      this.handleRemoteFileDelete(projectId, syncId);
    });

    logger.main.info('[ProjectFileSync] Initialized');
  }

  /**
   * Start syncing a project. Scans .md files, builds manifest, connects to ProjectSyncRoom.
   *
   * @param workspacePath - Absolute path to the project directory
   * @param encryptedProjectId - The encrypted project ID for room routing
   */
  async syncProject(workspacePath: string, encryptedProjectId: string): Promise<void> {
    if (!this.provider) return;

    const projectName = path.basename(workspacePath);
    logger.main.info(`[ProjectFileSync] Starting sync for ${projectName}`);

    try {
      // Restore the durable last-synced baseline so the conflict guard can tell
      // which files diverged locally before this restart (NIM-853, Layer 3).
      await this.loadBaseline(encryptedProjectId);

      // Initial sweep: scan + hash current disk, refresh the file-map, and seed a
      // baseline only for files with no persisted one. Timed separately because
      // buildManifest (read + sha256 every .md) dominates startup on large projects.
      const manifest = await timeStartupPhase(
        `ProjectFileSync.buildManifest(${projectName})`,
        () => this.buildManifest(workspacePath, encryptedProjectId, { seedBaseline: true }),
      );
      logger.main.info(`[ProjectFileSync] Found ${manifest.length} .md files`);

      // Connect with a manifest *builder* (not a static array): every reconnect
      // re-announces current disk state so the server never compares against a
      // stale startup snapshot (NIM-853, Layer 1). seedBaseline:false on
      // reconnect preserves an existing baseline that may reflect local edits.
      await timeStartupPhase(
        `ProjectFileSync.connect(${projectName})`,
        () => this.provider!.connect(
          encryptedProjectId,
          () => this.buildManifest(workspacePath, encryptedProjectId, { seedBaseline: false }),
        ),
      );
    } catch (err) {
      logger.main.error(`[ProjectFileSync] Failed to sync project:`, err);
    }
  }

  /**
   * Build the wire manifest (current on-disk content hash + mtime per .md file)
   * for a project, refreshing the file-map cache. Called on every (re)connect so
   * the server always diffs against current disk, never a stale snapshot.
   *
   * @param opts.seedBaseline when true (startup only), also seed the in-memory
   *   last-synced baseline from current disk. Reconnects pass false so an
   *   existing baseline (which may reflect locally-diverged content) is kept.
   */
  private async buildManifest(
    workspacePath: string,
    encryptedProjectId: string,
    opts: { seedBaseline: boolean },
  ): Promise<ProjectSyncManifestFile[]> {
    const mdFiles = await this.scanMarkdownFiles(workspacePath);
    const manifest: ProjectSyncManifestFile[] = [];

    // Ensure the file-map cache exists for this project (syncId -> absolutePath).
    const fileMapCache = ((this as any)._fileMapCache ||= new Map<string, { fileMap: Map<string, string>; workspacePath: string }>());
    let cache = fileMapCache.get(encryptedProjectId) as { fileMap: Map<string, string>; workspacePath: string } | undefined;
    if (!cache) {
      cache = { fileMap: new Map<string, string>(), workspacePath };
      fileMapCache.set(encryptedProjectId, cache);
    }

    let baseline = this.projectStates.get(encryptedProjectId);
    if (opts.seedBaseline && !baseline) {
      baseline = new Map();
      this.projectStates.set(encryptedProjectId, baseline);
    }

    for (const filePath of mdFiles) {
      try {
        const relativePath = path.relative(workspacePath, filePath);
        const syncId = this.syncIdFromPath(relativePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const stat = await fs.stat(filePath);
        const contentHash = this.sha256(content);
        const lastModifiedAt = Math.floor(stat.mtimeMs);

        manifest.push({ syncId, contentHash, lastModifiedAt, hasYjs: false, yjsSeq: 0 });
        cache.fileMap.set(syncId, filePath);

        // First sweep only: seed a baseline for files that have no persisted one
        // (brand-new / never synced). Files with a loaded baseline keep it, so a
        // pre-restart divergence remains detectable.
        if (opts.seedBaseline && baseline && !baseline.has(syncId)) {
          await this.setBaseline(encryptedProjectId, syncId, contentHash, lastModifiedAt);
        }
      } catch (err) {
        logger.main.error(`[ProjectFileSync] Failed to process ${filePath}:`, err);
      }
    }

    return manifest;
  }

  /**
   * Handle a local file save event (from file watcher). Pushes the file to the server.
   */
  async handleFileSaved(filePath: string, workspacePath: string, encryptedProjectId: string): Promise<void> {
    if (!this.provider) return;

    // Suppress echoes from files we just wrote from remote
    if (this.recentlyWrittenFiles.has(filePath)) return;

    // Only sync .md files
    if (!filePath.endsWith('.md')) return;

    try {
      const relativePath = path.relative(workspacePath, filePath);
      const syncId = this.syncIdFromPath(relativePath);
      const content = await fs.readFile(filePath, 'utf-8');
      const stat = await fs.stat(filePath);
      const title = path.basename(filePath, '.md');

      await this.provider.pushFileContent(
        encryptedProjectId,
        syncId,
        content,
        relativePath,
        title,
        Math.floor(stat.mtimeMs)
      );

      // The pushed content is now the agreed baseline (durable so the conflict
      // guard survives a restart).
      await this.setBaseline(encryptedProjectId, syncId, this.sha256(content), Math.floor(stat.mtimeMs));

      // Register newly-created files in the file map so remote deletes/updates
      // from mobile can be applied to the right local path. The map is only
      // seeded at startup (buildManifest), so files created after the sweep
      // would otherwise be invisible to round-trip handling.
      const cache = (this as any)._fileMapCache?.get(encryptedProjectId) as
        | { fileMap: Map<string, string>; workspacePath: string }
        | undefined;
      cache?.fileMap.set(syncId, filePath);
    } catch (err) {
      logger.main.error(`[ProjectFileSync] Failed to push file save:`, err);
    }
  }

  /**
   * Push a locally created/saved file to the server immediately, without
   * waiting for the OS file watcher. Used when the app itself creates a
   * document (e.g. the createDocument AI tool) so a newly created doc syncs
   * to mobile right away instead of depending on a best-effort watcher event.
   *
   * Suppresses the subsequent watcher echo so the file is not pushed twice.
   */
  async pushLocalFileNow(filePath: string, workspacePath: string, encryptedProjectId: string): Promise<void> {
    await this.handleFileSaved(filePath, workspacePath, encryptedProjectId);
    // handleFileSaved already ran the push; suppress the watcher's later
    // add/change echo for this path so we don't re-send identical content.
    this.suppressFileWatcherEcho(filePath);
  }

  /**
   * Handle a local file deletion event. Pushes the deletion to the server.
   */
  handleFileDeleted(syncId: string, encryptedProjectId: string): void {
    if (!this.provider) return;
    this.provider.deleteFile(encryptedProjectId, syncId);
    void this.deleteBaseline(encryptedProjectId, syncId);
    const cache = (this as any)._fileMapCache?.get(encryptedProjectId) as { fileMap: Map<string, string> } | undefined;
    cache?.fileMap.delete(syncId);
  }

  /**
   * Handle a local file deletion by absolute path (from the file watcher).
   * The syncId is derived deterministically from the relative path, so no
   * disk access is needed even though the file is already gone.
   */
  handleFileDeletedByPath(filePath: string, workspacePath: string, encryptedProjectId: string): void {
    const relativePath = path.relative(workspacePath, filePath);
    const syncId = this.syncIdFromPath(relativePath);
    logger.main.info(`[ProjectFileSync] Local delete: ${relativePath}`);
    this.handleFileDeleted(syncId, encryptedProjectId);
  }

  /**
   * Disconnect from a project.
   */
  disconnectProject(encryptedProjectId: string): void {
    this.provider?.disconnect(encryptedProjectId);
    this.projectStates.delete(encryptedProjectId);
  }

  /**
   * Shutdown: disconnect all projects.
   */
  shutdown(): void {
    this.provider?.disconnectAll();
    this.projectStates.clear();
    for (const timer of this.writeSuppressionTimers.values()) {
      clearTimeout(timer);
    }
    this.writeSuppressionTimers.clear();
    this.recentlyWrittenFiles.clear();
    this.deferredRemoteWrites.clear();
    this.deferredRemoteDeletes.clear();
    this.cleanUnsubscribe?.();
    this.cleanUnsubscribe = null;
  }

  // MARK: - Sync Response Handling

  private async handleSyncResponse(projectId: string, response: ProjectSyncResponse): Promise<void> {
    const cache = (this as any)._fileMapCache?.get(projectId) as { fileMap: Map<string, string>; workspacePath: string } | undefined;
    if (!cache) return;

    const startedAt = Date.now();
    const updatedCount = response.updatedFiles.length;
    const newCount = response.newFiles.length;
    const deleteCount = response.deletedSyncIds.length;
    const needFromClientCount = response.needFromClient.length;
    // logger.main.info(`[ProjectFileSync] handleSyncResponse start: updated=${updatedCount} new=${newCount} deleted=${deleteCount} needFromClient=${needFromClientCount}`);

    // Write updated/new files from server to disk
    const writePhaseStart = Date.now();
    const filesToWrite = [...response.updatedFiles, ...response.newFiles];
    for (const file of filesToWrite) {
      await this.writeRemoteFileToDisk(projectId, cache.workspacePath, file);
    }
    if (filesToWrite.length > 0) {
      logger.main.info(`[ProjectFileSync] handleSyncResponse wrote ${filesToWrite.length} remote files in ${Date.now() - writePhaseStart}ms`);
    }

    // Delete files that were deleted on server
    for (const syncId of response.deletedSyncIds) {
      const filePath = cache.fileMap.get(syncId);
      if (filePath) {
        // Don't delete a file open with unsaved edits; defer until the editor is
        // clean, then resolve (NIM-853, Layer 4 — applies to deletes too).
        if (dirtyEditorRegistry.isDirty(filePath)) {
          this.deferRemoteDelete(projectId, cache.workspacePath, syncId, filePath);
          continue;
        }
        await this.applyRemoteDelete(projectId, syncId, filePath);
      }
    }

    // Push files the server needs from us
    if (response.needFromClient.length > 0) {
      const pushPhaseStart = Date.now();
      const filesToPush: Array<{
        syncId: string;
        content: string;
        relativePath: string;
        title: string;
        lastModifiedAt: number;
      }> = [];

      for (const syncId of response.needFromClient) {
        const filePath = cache.fileMap.get(syncId);
        if (!filePath) continue;

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const stat = await fs.stat(filePath);
          const relativePath = path.relative(cache.workspacePath, filePath);
          const title = path.basename(filePath, '.md');

          filesToPush.push({
            syncId,
            content,
            relativePath,
            title,
            lastModifiedAt: Math.floor(stat.mtimeMs),
          });
        } catch (err) {
          logger.main.error(`[ProjectFileSync] Failed to read file for push: ${filePath}`, err);
        }
      }

      const readPhaseMs = Date.now() - pushPhaseStart;
      logger.main.info(`[ProjectFileSync] handleSyncResponse read ${filesToPush.length}/${response.needFromClient.length} needFromClient files in ${readPhaseMs}ms`);

      if (filesToPush.length > 0) {
        const networkStart = Date.now();
        await this.provider!.pushFileBatch(projectId, filesToPush);
        // The server requested these because the client's copy was newer; after
        // pushing, both sides agree on the local content. Advance the baseline so
        // a later legitimate remote edit isn't wrongly rejected as locally-diverged.
        for (const f of filesToPush) {
          await this.setBaseline(projectId, f.syncId, this.sha256(f.content), f.lastModifiedAt);
        }
        logger.main.info(`[ProjectFileSync] Pushed ${filesToPush.length} files to server in ${Date.now() - networkStart}ms`);
      }
    }

    // logger.main.info(`[ProjectFileSync] Sync complete for project ${projectId} (total ${Date.now() - startedAt}ms)`);
  }

  // MARK: - Remote Updates

  private async handleRemoteFileUpdate(_projectId: string, file: ProjectSyncFileUpdate): Promise<void> {
    // Find the workspace path for this project
    const cache = (this as any)._fileMapCache?.get(_projectId) as { fileMap: Map<string, string>; workspacePath: string } | undefined;
    if (!cache) return;

    await this.writeRemoteFileToDisk(_projectId, cache.workspacePath, file);
  }

  private async handleRemoteFileDelete(_projectId: string, syncId: string): Promise<void> {
    const cache = (this as any)._fileMapCache?.get(_projectId) as { fileMap: Map<string, string>; workspacePath: string } | undefined;
    if (!cache) return;

    const filePath = cache.fileMap.get(syncId);
    if (filePath) {
      // Don't delete a file open with unsaved edits; defer until the editor is
      // clean, then resolve (NIM-853, Layer 4 — applies to deletes too).
      if (dirtyEditorRegistry.isDirty(filePath)) {
        this.deferRemoteDelete(_projectId, cache.workspacePath, syncId, filePath);
        return;
      }
      await this.applyRemoteDelete(_projectId, syncId, filePath);
    }
  }

  /**
   * Record a remote delete that can't be applied yet because the target is open
   * in a dirty editor. A delete supersedes any pending write for the same path.
   */
  private deferRemoteDelete(projectId: string, workspacePath: string, syncId: string, filePath: string): void {
    this.deferredRemoteWrites.delete(filePath);
    this.deferredRemoteDeletes.set(filePath, { projectId, workspacePath, syncId, filePath });
    logger.main.info(`[ProjectFileSync] Deferring remote delete of dirty file: ${path.basename(filePath)}`);
  }

  /** Unlink a file for a remote delete and clear its baseline + file-map entry. */
  private async applyRemoteDelete(projectId: string, syncId: string, filePath: string): Promise<void> {
    try {
      this.suppressFileWatcherEcho(filePath);
      await fs.unlink(filePath);
      logger.main.info(`[ProjectFileSync] Remote delete: ${path.basename(filePath)}`);
    } catch {
      // File might already be gone.
    }
    await this.deleteBaseline(projectId, syncId);
    const cache = (this as any)._fileMapCache?.get(projectId) as { fileMap: Map<string, string> } | undefined;
    cache?.fileMap.delete(syncId);
  }

  /**
   * Apply a remote file to disk, guarding against regressing newer/diverged
   * local content (NIM-853). Resolution is mtime last-writer-wins, made safe by
   * re-reading the *current* local file and consulting the last-synced baseline
   * so a stale `updatedFiles` (e.g. from a reconnect) can never silently clobber
   * a newer local copy.
   */
  private async writeRemoteFileToDisk(projectId: string, workspacePath: string, file: ProjectSyncFileUpdate): Promise<void> {
    const filePath = path.join(workspacePath, file.relativePath);

    // Never overwrite an editor's unsaved buffer. Hold the remote write until the
    // editor saves or closes, then retry it through the normal guard below. A
    // newer write supersedes any pending delete for the same path.
    if (dirtyEditorRegistry.isDirty(filePath)) {
      this.deferredRemoteDeletes.delete(filePath);
      this.deferredRemoteWrites.set(filePath, { projectId, workspacePath, file });
      logger.main.info(`[ProjectFileSync] Deferring remote write to dirty editor: ${file.relativePath}`);
      return;
    }

    try {
      let localExists = false;
      let localContent = '';
      let localMtimeMs = 0;
      try {
        localContent = await fs.readFile(filePath, 'utf-8');
        const stat = await fs.stat(filePath);
        localMtimeMs = Math.floor(stat.mtimeMs);
        localExists = true;
      } catch {
        // File doesn't exist locally -- genuinely new from remote.
      }

      if (localExists) {
        const localHash = this.sha256(localContent);

        // Already in sync: nothing to write (avoids disk IO + watcher noise).
        if (localHash === file.contentHash) {
          return;
        }

        const baseline = this.projectStates.get(projectId)?.get(file.syncId);

        // Guard 1 (mtime LWW): the local copy is at-least-as-fresh as the
        // incoming remote copy but the content differs. This is a stale/racing
        // `updatedFiles` (the NIM-853 clobber). Keep local and re-push it so the
        // server converges upward instead of dragging local backward.
        if (localMtimeMs >= file.lastModifiedAt) {
          logger.main.warn(
            `[ProjectFileSync] Refusing stale remote overwrite (local mtime ${localMtimeMs} >= remote ${file.lastModifiedAt}): ${file.relativePath}; re-pushing local`,
          );
          await this.repushLocalFile(projectId, workspacePath, file.syncId, filePath);
          return;
        }

        // Guard 2 (baseline): the local copy diverged from the last point both
        // sides agreed on, so it has unpushed edits. Prefer local even if mtime
        // ordering is unreliable (clock skew / git touching mtime).
        if (baseline && localHash !== baseline.contentHash) {
          logger.main.warn(
            `[ProjectFileSync] Refusing remote overwrite of locally-diverged file: ${file.relativePath}; re-pushing local`,
          );
          await this.repushLocalFile(projectId, workspacePath, file.syncId, filePath);
          return;
        }
      }

      // Fast-forward: remote is strictly newer and local is unchanged since the
      // baseline (or the file is new locally). Apply the remote copy.
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      // Suppress file watcher echo for this write
      this.suppressFileWatcherEcho(filePath);

      await fs.writeFile(filePath, file.content, 'utf-8');

      // Preserve the original filesystem mtime from the source device
      if (file.lastModifiedAt) {
        const mtime = new Date(file.lastModifiedAt);
        await fs.utimes(filePath, mtime, mtime);
      }

      // The two sides now agree on this content -- record it as the baseline.
      await this.setBaseline(projectId, file.syncId, file.contentHash, file.lastModifiedAt);

      // Register the path so a later remote delete/update for a file created on
      // another device can resolve it before the next full manifest rebuild.
      const cache = (this as any)._fileMapCache?.get(projectId) as { fileMap: Map<string, string> } | undefined;
      cache?.fileMap.set(file.syncId, filePath);

      logger.main.info(`[ProjectFileSync] Wrote remote file: ${file.relativePath}`);
    } catch (err) {
      logger.main.error(`[ProjectFileSync] Failed to write remote file: ${file.relativePath}`, err);
    }
  }

  /**
   * Record the last-synced baseline (content hash + mtime) for a file, both
   * in the in-memory cache and the durable `project_file_sync_baseline` table so
   * it survives a restart.
   */
  private async setBaseline(projectId: string, syncId: string, contentHash: string, mtime: number): Promise<void> {
    let state = this.projectStates.get(projectId);
    if (!state) {
      state = new Map();
      this.projectStates.set(projectId, state);
    }
    state.set(syncId, { syncId, contentHash, lastSyncedMtime: mtime });

    try {
      await database.query(
        `INSERT INTO project_file_sync_baseline (project_id, sync_id, content_hash, last_synced_mtime, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, sync_id) DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           last_synced_mtime = EXCLUDED.last_synced_mtime,
           updated_at = EXCLUDED.updated_at`,
        [projectId, syncId, contentHash, mtime, new Date()],
      );
    } catch (err) {
      logger.main.error(`[ProjectFileSync] Failed to persist baseline for ${syncId}:`, err);
    }
  }

  /** Load the durable baseline for a project into the in-memory cache. */
  private async loadBaseline(projectId: string): Promise<void> {
    try {
      const result = await database.query<{ sync_id: string; content_hash: string; last_synced_mtime: number | string }>(
        `SELECT sync_id, content_hash, last_synced_mtime FROM project_file_sync_baseline WHERE project_id = $1`,
        [projectId],
      );
      let state = this.projectStates.get(projectId);
      if (!state) {
        state = new Map();
        this.projectStates.set(projectId, state);
      }
      for (const row of result.rows) {
        // BIGINT can come back as a string on PGLite; normalize to number.
        const mtime = typeof row.last_synced_mtime === 'string'
          ? parseInt(row.last_synced_mtime, 10)
          : row.last_synced_mtime;
        state.set(row.sync_id, { syncId: row.sync_id, contentHash: row.content_hash, lastSyncedMtime: mtime });
      }
    } catch (err) {
      logger.main.error(`[ProjectFileSync] Failed to load baseline for ${projectId}:`, err);
    }
  }

  /** Remove a file's baseline from the in-memory cache and the durable table. */
  private async deleteBaseline(projectId: string, syncId: string): Promise<void> {
    this.projectStates.get(projectId)?.delete(syncId);
    try {
      await database.query(
        `DELETE FROM project_file_sync_baseline WHERE project_id = $1 AND sync_id = $2`,
        [projectId, syncId],
      );
    } catch (err) {
      logger.main.error(`[ProjectFileSync] Failed to delete baseline for ${syncId}:`, err);
    }
  }

  /**
   * Re-push the current local copy of a file to the server. Used when a remote
   * update is refused because local is newer/diverged, so the server converges
   * to the local content rather than the client dragging local backward.
   */
  private async repushLocalFile(projectId: string, workspacePath: string, syncId: string, filePath: string): Promise<void> {
    if (!this.provider) return;
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const stat = await fs.stat(filePath);
      const relativePath = path.relative(workspacePath, filePath);
      const title = path.basename(filePath, '.md');
      await this.provider.pushFileContent(
        projectId,
        syncId,
        content,
        relativePath,
        title,
        Math.floor(stat.mtimeMs),
      );
      await this.setBaseline(projectId, syncId, this.sha256(content), Math.floor(stat.mtimeMs));
    } catch (err) {
      logger.main.error(`[ProjectFileSync] Failed to re-push local file: ${filePath}`, err);
    }
  }

  /**
   * Re-attempt a remote write that was deferred because its target was open in a
   * dirty editor. Runs the full conflict guard again, so a just-saved buffer is
   * still protected.
   */
  private async flushDeferredWrite(filePath: string): Promise<void> {
    const deferred = this.deferredRemoteWrites.get(filePath);
    if (!deferred) return;
    this.deferredRemoteWrites.delete(filePath);
    await this.writeRemoteFileToDisk(deferred.projectId, deferred.workspacePath, deferred.file);
  }

  /**
   * Resolve a remote delete that was deferred because its target was open in a
   * dirty editor. On clean: if the on-disk file still matches the last-synced
   * baseline (no persisted local edit -- the user discarded or never saved),
   * honor the delete; if a saved local edit diverged it, local wins and we
   * re-push to resurrect the file on the server.
   */
  private async flushDeferredDelete(filePath: string): Promise<void> {
    const deferred = this.deferredRemoteDeletes.get(filePath);
    if (!deferred) return;
    this.deferredRemoteDeletes.delete(filePath);
    const { projectId, workspacePath, syncId } = deferred;

    let diskHash: string | null = null;
    try {
      diskHash = this.sha256(await fs.readFile(filePath, 'utf-8'));
    } catch {
      // File already gone locally -- nothing to delete; just clear our state.
      await this.deleteBaseline(projectId, syncId);
      const cache = (this as any)._fileMapCache?.get(projectId) as { fileMap: Map<string, string> } | undefined;
      cache?.fileMap.delete(syncId);
      return;
    }

    const baseline = this.projectStates.get(projectId)?.get(syncId);
    if (baseline && diskHash !== baseline.contentHash) {
      // A saved local edit diverged from the last sync -> local wins over the
      // remote delete; re-push to resurrect it on the server.
      logger.main.info(`[ProjectFileSync] Local edit overrides remote delete; re-pushing: ${path.basename(filePath)}`);
      await this.repushLocalFile(projectId, workspacePath, syncId, filePath);
    } else {
      // No persisted divergence -> honor the remote delete.
      await this.applyRemoteDelete(projectId, syncId, filePath);
    }
  }

  // MARK: - File Watcher Echo Suppression

  private suppressFileWatcherEcho(filePath: string): void {
    this.recentlyWrittenFiles.add(filePath);

    // Clear existing timer if any
    const existing = this.writeSuppressionTimers.get(filePath);
    if (existing) clearTimeout(existing);

    // Remove from suppression set after 5s
    const timer = setTimeout(() => {
      this.recentlyWrittenFiles.delete(filePath);
      this.writeSuppressionTimers.delete(filePath);
    }, 5000);
    this.writeSuppressionTimers.set(filePath, timer);
  }

  /**
   * Check if a file path is in the suppression set (recently written from remote).
   * Exported for the file watcher integration to check.
   */
  isRecentlyWrittenFromRemote(filePath: string): boolean {
    return this.recentlyWrittenFiles.has(filePath);
  }

  // MARK: - File Scanning

  private async scanMarkdownFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    await this.walkDir(dir, results);
    return results;
  }

  private async walkDir(dir: string, results: string[]): Promise<void> {
    const basename = path.basename(dir);

    // Skip common non-content directories
    const skipDirs = new Set([
      'node_modules', '.git', '.nimbalyst', 'dist', 'build', '.build',
      'out', '.next', '.nuxt', '.svelte-kit', 'coverage', '.cache',
      '.turbo', '.vercel', '.output', '__pycache__', '.venv', 'venv',
      'target', 'Pods', '.gradle', 'DerivedData',
    ]);
    if (skipDirs.has(basename) || basename.startsWith('.build')) {
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or other error
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDir(fullPath, results);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size <= MAX_FILE_SIZE) {
            results.push(fullPath);
          } else {
            logger.main.warn(`[ProjectFileSync] Skipping large file: ${entry.name} (${Math.round(stat.size / 1024 / 1024)}MB)`);
          }
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }

  // MARK: - Stats

  /**
   * Get stats about document sync for the sync status menu.
   */
  getStats(): { projectCount: number; fileCount: number; connected: boolean } {
    let fileCount = 0;
    for (const state of this.projectStates.values()) {
      fileCount += state.size;
    }
    const connected = this.provider
      ? [...this.projectStates.keys()].some(pid => this.provider!.isConnected(pid))
      : false;

    return {
      projectCount: this.projectStates.size,
      fileCount,
      connected,
    };
  }

  /**
   * Per-project sync status for the settings UI (Docs toggle feedback).
   */
  getProjectStats(encryptedProjectId: string): { connected: boolean; fileCount: number } {
    return {
      connected: this.provider?.isConnected(encryptedProjectId) ?? false,
      fileCount: this.projectStates.get(encryptedProjectId)?.size ?? 0,
    };
  }

  // MARK: - Utilities

  /** Deterministic sync ID from relative path -- no file modification needed. */
  private syncIdFromPath(relativePath: string): string {
    return createHash('sha256').update(relativePath).digest('hex');
  }

  private sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}

// Singleton instance
let _instance: ProjectFileSyncService | null = null;

export function getProjectFileSyncService(): ProjectFileSyncService {
  if (!_instance) {
    _instance = new ProjectFileSyncService();
  }
  return _instance;
}
