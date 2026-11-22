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
import { ProjectSyncProvider, type ProjectSyncManifestFile, type ProjectSyncResponse, type ProjectSyncFileUpdate, type ProjectFilePushOutcome } from '@nimbalyst/runtime/sync';
import { getPersonalDocSyncConfig } from './SyncManager';
import { timeStartupPhase } from '../utils/startupTiming';
import { database } from '../database/PGLiteDatabaseWorker';
import { dirtyEditorRegistry } from './DirtyEditorRegistry';
import { getPersonalSessionJwt } from './StytchAuthService';
import { hashProjectFiles, scanProjectSyncCandidates } from './ProjectManifestHasher';
import { exceedsProjectSyncLimit, OversizedFileWarnings, projectSyncTitle, storedSyncIds } from './projectFileSyncLimits';
import { keepDivergedRemoteCopy } from './projectFileSyncConflicts';
import { isInWiki, isProjectSyncPath, isWikiMarkerPath, PROJECT_SYNC_CANDIDATES, ProjectSyncWikiRules, wikiMarkerFirst } from './sync/projectSyncWikiRules';
import { parseDiskStamp, persistDiskStamps, stampMatches, type DiskStamp, type ScannedFile } from './projectFileSyncDiskCache';

interface SyncedFileState {
  syncId: string;
  contentHash: string;
  lastSyncedMtime: number;
}

/** What writeRemoteFileToDisk did with one offered file; logged per sync response. */
type RemoteWriteOutcome =
  | 'written' | 'in-sync' | 'not-sync-path' | 'deferred-dirty'
  | 'kept-local-newer' | 'kept-local-diverged' | 'moved-away' | 'deleted-locally' | 'failed';

export class ProjectFileSyncService {
  private provider: ProjectSyncProvider | null = null;
  private projectStates = new Map<string, Map<string, SyncedFileState>>(); // projectId -> (syncId -> state)
  // projectId -> (syncId -> hash of the bytes on disk at a size + mtime). Lets a
  // manifest build skip files that have not moved; see projectFileSyncDiskCache.
  private diskStamps = new Map<string, Map<string, DiskStamp>>();
  private recentlyWrittenFiles = new Set<string>(); // absolute paths of files we just wrote from remote
  private writeSuppressionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Remote writes held back because the target is open in a dirty editor; keyed
  // by absolute path, latest update wins. Flushed when the editor becomes clean.
  private deferredRemoteWrites = new Map<string, { projectId: string; workspacePath: string; file: ProjectSyncFileUpdate }>();
  private sweepListeners = new Set<(projectId: string, filePaths: string[]) => void>();
  // Remote deletes held back because the target is open in a dirty editor; keyed
  // by absolute path. Resolved when the editor becomes clean.
  private deferredRemoteDeletes = new Map<string, { projectId: string; workspacePath: string; syncId: string; filePath: string }>();
  private cleanUnsubscribe: (() => void) | null = null;
  private oversizedWarnings = new OversizedFileWarnings();
  private wikiRules = new ProjectSyncWikiRules({
    baselineHash: (projectId, syncId) => this.projectStates.get(projectId)?.get(syncId)?.contentHash,
    forget: async (projectId, syncId, filePath) => {
      this.suppressFileWatcherEcho(filePath);
      this.fileMapFor(projectId)?.fileMap.delete(syncId);
      await this.deleteBaseline(projectId, syncId);
    },
  });

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
      personalMemberId: config.personalMemberId,
      encryptionKey: config.encryptionKeyRaw,
      getJwt: async () => {
        // Re-fetch config each time to get fresh JWT
        const fresh = getPersonalDocSyncConfig();
        if (!fresh) throw new Error('Sync config unavailable');
        // The config doesn't directly expose a JWT getter, so we need
        // to get it from the SyncManager's auth flow
        const jwt = getPersonalSessionJwt();
        if (!jwt) throw new Error('Personal sync JWT unavailable');
        return jwt;
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

      // Initial sweep: scan current disk (hashing only files whose size or mtime
      // moved), refresh the file-map, and seed a baseline only for files with no
      // persisted one. buildManifest logs its rehashed/cached counts.
      await timeStartupPhase(
        `ProjectFileSync.buildManifest(${projectName})`,
        () => this.buildManifest(workspacePath, encryptedProjectId, { seedBaseline: true }),
      );

      // Connect with a manifest *builder* (not a static array): every reconnect
      // re-announces current disk state so the server never compares against a
      // stale startup snapshot (NIM-853, Layer 1). seedBaseline:false on
      // reconnect preserves an existing baseline that may reflect local edits.
      await timeStartupPhase(
        `ProjectFileSync.connect(${projectName})`,
        () => this.provider!.connect(
          encryptedProjectId,
          ({ fullRehash }) => this.buildManifest(workspacePath, encryptedProjectId, { seedBaseline: false, fullRehash }),
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
   * @param opts.fullRehash re-read every file instead of reusing the hash of a
   *   file whose size and mtime have not moved. Only an explicit resync asks.
   */
  private async buildManifest(
    workspacePath: string,
    encryptedProjectId: string,
    opts: { seedBaseline: boolean; fullRehash?: boolean },
  ): Promise<ProjectSyncManifestFile[]> {
    const startedAt = Date.now();
    const scanned = await this.scanSyncFiles(workspacePath);
    const mdFiles = scanned.map((f) => f.filePath);
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

    // A file whose size and mtime match its stamp reuses the stamped hash; only
    // the rest are read and hashed.
    const stamps = this.diskStampsFor(encryptedProjectId);
    const entries = scanned.map((file) => {
      const syncId = this.syncIdFromPath(path.relative(workspacePath, file.filePath));
      const stamp = stamps.get(syncId);
      return { file, syncId, cachedHash: !opts.fullRehash && stampMatches(stamp, file) ? stamp.hash : undefined };
    });
    const toHash = entries.filter((e) => e.cachedHash === undefined).map((e) => e.file.filePath);

    // Read + sha256 on a worker thread. Only digests come back, so file
    // contents never cross the thread boundary.
    const hashedByPath = new Map((await hashProjectFiles(toHash)).map((h) => [h.filePath, h]));
    const freshStamps: Array<{ syncId: string; stamp: DiskStamp }> = [];

    for (const { file, syncId, cachedHash } of entries) {
      const filePath = file.filePath;
      try {
        let contentHash: string;
        let lastModifiedAt: number;
        if (cachedHash !== undefined) {
          contentHash = cachedHash;
          lastModifiedAt = file.mtime;
        } else {
          const entry = hashedByPath.get(filePath);
          if (!entry || entry.error || !entry.contentHash || entry.lastModifiedAt == null) {
            // Log and skip, so a single unreadable file never truncates the manifest.
            logger.main.error(`[ProjectFileSync] Failed to process ${filePath}: ${entry?.error ?? 'no hash'}`);
            continue;
          }
          contentHash = entry.contentHash;
          lastModifiedAt = entry.lastModifiedAt;
          // The worker stats after reading. Only stamp when that mtime equals the
          // scan's, so the hash belongs to the size + mtime it is stored under.
          if (lastModifiedAt === file.mtime) {
            freshStamps.push({ syncId, stamp: { hash: contentHash, size: file.size, mtime: file.mtime } });
          }
        }

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

    await this.recordDiskStamps(encryptedProjectId, freshStamps);
    logger.main.info(
      `[ProjectFileSync] buildManifest(${path.basename(workspacePath)}): ${manifest.length} files, ${toHash.length} rehashed, ${entries.length - toHash.length} cached${opts.fullRehash ? ' (full rehash)' : ''} in ${Date.now() - startedAt}ms`,
    );

    for (const listener of this.sweepListeners) listener(encryptedProjectId, mdFiles);
    return manifest;
  }

  /** Called with the files every sweep (startup and each reconnect) found. Returns the unsubscribe. */
  onSwept(listener: (encryptedProjectId: string, filePaths: string[]) => void): () => void {
    this.sweepListeners.add(listener);
    return () => this.sweepListeners.delete(listener);
  }

  /**
   * The wiki's marker just appeared here, so tables the server offered while it
   * was missing were refused. Ask again; they return through the normal path.
   */
  resync(encryptedProjectId: string, opts: { fullRehash?: boolean } = {}): void {
    void (opts.fullRehash
      ? this.provider?.resync(encryptedProjectId, { fullRehash: true })
      : this.provider?.resync(encryptedProjectId));
  }

  /**
   * Handle a local file save event (from file watcher). Pushes the file to the server.
   */
  async handleFileSaved(filePath: string, workspacePath: string, encryptedProjectId: string): Promise<void> {
    if (!this.provider) return;

    // Suppress echoes from files we just wrote from remote
    if (this.recentlyWrittenFiles.has(filePath)) return;

    if (!isProjectSyncPath(filePath, workspacePath)) return;

    try {
      const relativePath = path.relative(workspacePath, filePath);
      const syncId = this.syncIdFromPath(relativePath);
      const stat = await fs.stat(filePath);
      if (exceedsProjectSyncLimit(stat.size, relativePath)) {
        this.oversizedWarnings.warn(filePath, stat.size);
        return;
      }
      // Stat came before the read, so if the file changes in between, the stamp
      // carries the older mtime and the next manifest build rehashes it.
      const content = await fs.readFile(filePath, 'utf-8');
      const title = projectSyncTitle(filePath);
      const stamp: DiskStamp = { hash: this.sha256(content), size: stat.size, mtime: Math.floor(stat.mtimeMs) };

      // Register newly-created files in the file map so remote deletes/updates
      // from mobile can be applied to the right local path. The map is only
      // seeded at startup (buildManifest), so files created after the sweep
      // would otherwise be invisible to round-trip handling.
      this.fileMapFor(encryptedProjectId)?.fileMap.set(syncId, filePath);

      // A save that left the content at the agreed baseline (touch, format-on-
      // save with no change, a re-save) has nothing for the server.
      if (this.projectStates.get(encryptedProjectId)?.get(syncId)?.contentHash === stamp.hash) {
        await this.recordDiskStamps(encryptedProjectId, [{ syncId, stamp }]);
        return;
      }

      const outcome = await this.provider.pushFileContent(
        encryptedProjectId,
        syncId,
        content,
        relativePath,
        title,
        Math.floor(stat.mtimeMs)
      );

      // Content the server stored is the agreed baseline (durable so the
      // conflict guard survives a restart).
      await this.setBaselinesForStored(encryptedProjectId, outcome, [{ syncId, content, lastModifiedAt: Math.floor(stat.mtimeMs) }]);
      await this.recordDiskStamps(encryptedProjectId, [{ syncId, stamp }]);
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
    this.fileMapFor(encryptedProjectId)?.fileMap.delete(syncId);
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
    this.diskStamps.delete(encryptedProjectId);
  }

  /**
   * Shutdown: disconnect all projects.
   */
  shutdown(): void {
    this.provider?.disconnectAll();
    this.projectStates.clear();
    this.diskStamps.clear();
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
    // Pushes whose ack was lost and which the server says it holds are agreed
    // content; settle them before the diff below consults the baseline.
    for (const p of response.confirmedPushes ?? []) await this.setBaseline(projectId, p.syncId, p.contentHash, p.lastModifiedAt);
    const cache = this.fileMapFor(projectId);
    if (!cache) return;

    const startedAt = Date.now();
    const updatedCount = response.updatedFiles.length;
    const newCount = response.newFiles.length;
    const deleteCount = response.deletedSyncIds.length;
    const needFromClientCount = response.needFromClient.length;
    // logger.main.info(`[ProjectFileSync] handleSyncResponse start: updated=${updatedCount} new=${newCount} deleted=${deleteCount} needFromClient=${needFromClientCount}`);

    // Write updated/new files from server to disk
    const writePhaseStart = Date.now();
    const filesToWrite = wikiMarkerFirst([...response.updatedFiles, ...response.newFiles], cache.workspacePath);
    const outcomes = new Map<RemoteWriteOutcome, string[]>();
    for (const file of filesToWrite) {
      const outcome = await this.writeRemoteFileToDisk(projectId, cache.workspacePath, file);
      outcomes.set(outcome, [...(outcomes.get(outcome) ?? []), file.syncId]);
    }
    if (filesToWrite.length > 0) {
      // Per outcome, with the syncIds of everything not written. A set of files
      // the server re-offers on every reconnect shows up here as the same ids.
      const summary = [...outcomes].map(([outcome, ids]) =>
        outcome === 'written' ? `written=${ids.length}` : `${outcome}=${ids.length} [${ids.slice(0, 50).join(',')}${ids.length > 50 ? ',...' : ''}]`,
      ).join(' ');
      logger.main.info(`[ProjectFileSync] handleSyncResponse offered ${filesToWrite.length} remote files in ${Date.now() - writePhaseStart}ms: ${summary}`);
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
          const title = projectSyncTitle(filePath);

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
        const outcome = await this.provider!.pushFileBatch(projectId, filesToPush);
        // The server requested these because the client's copy was newer; once
        // it stores them, both sides agree on the local content. Advance the
        // baseline so a later legitimate remote edit isn't wrongly rejected as
        // locally-diverged.
        await this.setBaselinesForStored(projectId, outcome, filesToPush);
        logger.main.info(`[ProjectFileSync] Pushed ${filesToPush.length} files to server (${outcome.stored.length} stored, ${outcome.rejected.length} rejected, ${outcome.unconfirmed.length} unconfirmed) in ${Date.now() - networkStart}ms`);
      }
    }

    // logger.main.info(`[ProjectFileSync] Sync complete for project ${projectId} (total ${Date.now() - startedAt}ms)`);
  }

  // MARK: - Remote Updates

  private async handleRemoteFileUpdate(_projectId: string, file: ProjectSyncFileUpdate): Promise<void> {
    // Find the workspace path for this project
    const cache = this.fileMapFor(_projectId);
    if (!cache) return;

    await this.writeRemoteFileToDisk(_projectId, cache.workspacePath, file);
  }

  private async handleRemoteFileDelete(_projectId: string, syncId: string): Promise<void> {
    const cache = this.fileMapFor(_projectId);
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

  /**
   * Handle a remote delete. Project sync does NOT remove local files.
   *
   * This used to `fs.unlink(filePath)`. A workspace is a real directory on a
   * real disk -- frequently a git working tree -- and a tombstone in the room's
   * state is not consent to destroy the user's copy of a file. The only guard
   * was `dirtyEditorRegistry.isDirty()`, which protects an unsaved editor
   * buffer and nothing else: no git check, no confirmation, no backup, and
   * `unlink` does not go to the trash. A single stale tombstone therefore
   * deleted the same path on every client, on every sync, indefinitely --
   * observed as 91 extension `.md` files (including a command file added the
   * day before) being removed four times in two days, each time restored from
   * git and each time deleted again on the next sync burst.
   *
   * See `.claude/rules/destructive-data-paths.md`: a destructive path must
   * verify the damage is real, ask, and leave a recoverable artifact. None of
   * that was true here, so the delete does not happen at all.
   *
   * Consequence, deliberately chosen: a file genuinely deleted on another
   * device stays on disk here and is re-offered to the server on the next
   * manifest sweep. Resurrecting a file is recoverable; deleting one is not.
   */
  private async applyRemoteDelete(_projectId: string, _syncId: string, filePath: string): Promise<void> {
    // Inside the Local wiki, a delete whose page id now lives elsewhere was a move: the stale copy goes to the wiki trash.
    const workspacePath = this.workspacePathFor(_projectId);
    if (workspacePath && await this.wikiRules.applyRemoteDelete(_projectId, workspacePath, _syncId, filePath)) return;
    // Keep the baseline and file-map entry: the file is still on disk, so the
    // conflict guard must keep working and the next sweep must still see it.
    logger.main.debug(
      `[ProjectFileSync] Ignoring remote delete for ${path.relative(this.workspacePathFor(_projectId) ?? '', filePath) || path.basename(filePath)} -- project sync does not remove local files`,
    );
  }

  /** Workspace root for a project, if the file-map cache knows it. */
  private workspacePathFor(projectId: string): string | undefined {
    return this.fileMapFor(projectId)?.workspacePath;
  }

  /** syncId -> absolute path for a project, seeded by its first manifest build. */
  private fileMapFor(projectId: string): { fileMap: Map<string, string>; workspacePath: string } | undefined {
    return (this as any)._fileMapCache?.get(projectId);
  }

  /**
   * Apply a remote file to disk, guarding against regressing newer/diverged
   * local content (NIM-853). Resolution is mtime last-writer-wins, made safe by
   * re-reading the *current* local file and consulting the last-synced baseline
   * so a stale `updatedFiles` (e.g. from a reconnect) can never silently clobber
   * a newer local copy.
   */
  private async writeRemoteFileToDisk(projectId: string, workspacePath: string, file: ProjectSyncFileUpdate): Promise<RemoteWriteOutcome> {
    const filePath = path.join(workspacePath, file.relativePath);
    // An older client may have pushed wiki trash; it is not restored into the
    // trash here. Wiki tables are only written inside this desktop's wiki folder.
    if (!isProjectSyncPath(filePath, workspacePath)) return 'not-sync-path';

    // Never overwrite an editor's unsaved buffer. Hold the remote write until the
    // editor saves or closes, then retry it through the normal guard below. A
    // newer write supersedes any pending delete for the same path.
    if (dirtyEditorRegistry.isDirty(filePath)) {
      this.deferredRemoteDeletes.delete(filePath);
      this.deferredRemoteWrites.set(filePath, { projectId, workspacePath, file });
      logger.main.info(`[ProjectFileSync] Deferring remote write to dirty editor: ${file.relativePath}`);
      return 'deferred-dirty';
    }

    try {
      let localExists = false;
      let localContent = '';
      let localMtimeMs = 0;
      let localSize = 0;
      try {
        // Stat before reading, so a change in between leaves an older mtime on
        // the in-sync stamp below and the next manifest build rehashes.
        const stat = await fs.stat(filePath);
        localContent = await fs.readFile(filePath, 'utf-8');
        localMtimeMs = Math.floor(stat.mtimeMs);
        localSize = stat.size;
        localExists = true;
      } catch {
        // File doesn't exist locally -- genuinely new from remote.
      }

      if (localExists) {
        const localHash = this.sha256(localContent);

        // Already in sync: nothing to write (avoids disk IO + watcher noise).
        if (localHash === file.contentHash) {
          this.diskStampsFor(projectId).set(file.syncId, { hash: localHash, size: localSize, mtime: localMtimeMs });
          return 'in-sync';
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
          await keepDivergedRemoteCopy(filePath, file, localHash, baseline?.contentHash);
          await this.repushLocalFile(projectId, workspacePath, file.syncId, filePath);
          return 'kept-local-newer';
        }

        // Guard 2 (baseline): the local copy diverged from the last point both
        // sides agreed on, so it has unpushed edits. Prefer local even if mtime
        // ordering is unreliable (clock skew / git touching mtime).
        if (baseline && localHash !== baseline.contentHash) {
          logger.main.warn(
            `[ProjectFileSync] Refusing remote overwrite of locally-diverged file: ${file.relativePath}; re-pushing local`,
          );
          await keepDivergedRemoteCopy(filePath, file, localHash, baseline.contentHash);
          await this.repushLocalFile(projectId, workspacePath, file.syncId, filePath);
          return 'kept-local-diverged';
        }
      } else if (await this.wikiRules.isMovedAwayLocally(projectId, workspacePath, file)) {
        this.handleFileDeleted(file.syncId, projectId);
        return 'moved-away';
      } else if (
        !isInWiki(filePath, workspacePath)
        && this.projectStates.get(projectId)?.get(file.syncId)?.contentHash === file.contentHash
      ) {
        // This desktop synced exactly this version and the file is gone, so it
        // was deleted here without a per-file unlink reaching sync: a folder
        // removal, or a delete while the app was closed. Restoring it made
        // deleted folders come back (NIM-7587). Send the delete instead; a
        // version edited elsewhere since has another hash and is still written.
        // Inside the wiki the move rules above decide, and restore unless the
        // moved copy provably holds the content.
        logger.main.info(`[ProjectFileSync] Deleted locally since last sync: ${file.relativePath}`);
        this.handleFileDeleted(file.syncId, projectId);
        return 'deleted-locally';
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
      // Stamp what was written so the next manifest build does not read it back.
      const written = await fs.stat(filePath);
      await this.recordDiskStamps(projectId, [{
        syncId: file.syncId,
        stamp: { hash: this.sha256(file.content), size: written.size, mtime: Math.floor(written.mtimeMs) },
      }]);

      // Register the path so a later remote delete/update for a file created on
      // another device can resolve it before the next full manifest rebuild.
      this.fileMapFor(projectId)?.fileMap.set(file.syncId, filePath);

      logger.main.info(`[ProjectFileSync] Wrote remote file: ${file.relativePath}`);
      await this.wikiRules.afterRemoteWrite(projectId, workspacePath, filePath, file.content);
      if (!localExists && isWikiMarkerPath(filePath, workspacePath)) this.resync(projectId);
      return 'written';
    } catch (err) {
      logger.main.error(`[ProjectFileSync] Failed to write remote file: ${file.relativePath}`, err);
      return 'failed';
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

  /** A push only moves the baseline for files the server confirmed it stored (NIM-7337). */
  private async setBaselinesForStored(
    projectId: string,
    outcome: ProjectFilePushOutcome,
    files: Array<{ syncId: string; content: string; lastModifiedAt: number }>,
  ): Promise<void> {
    const stored = storedSyncIds(outcome);
    for (const f of files) {
      if (stored.has(f.syncId)) await this.setBaseline(projectId, f.syncId, this.sha256(f.content), f.lastModifiedAt);
    }
  }

  /** Load the durable baseline for a project into the in-memory cache. */
  private async loadBaseline(projectId: string): Promise<void> {
    try {
      const result = await database.query<{
        sync_id: string; content_hash: string; last_synced_mtime: number | string;
        disk_hash?: string | null; disk_size?: number | string | null; disk_mtime?: number | string | null;
      }>(
        `SELECT sync_id, content_hash, last_synced_mtime, disk_hash, disk_size, disk_mtime
         FROM project_file_sync_baseline WHERE project_id = $1`,
        [projectId],
      );
      const stamps = this.diskStampsFor(projectId);
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
        const stamp = parseDiskStamp(row);
        if (stamp) stamps.set(row.sync_id, stamp);
      }
    } catch (err) {
      logger.main.error(`[ProjectFileSync] Failed to load baseline for ${projectId}:`, err);
    }
  }

  private diskStampsFor(projectId: string): Map<string, DiskStamp> {
    let stamps = this.diskStamps.get(projectId);
    if (!stamps) {
      stamps = new Map();
      this.diskStamps.set(projectId, stamps);
    }
    return stamps;
  }

  /**
   * Remember disk stamps in memory, and persist those whose file has a baseline
   * row (the stamp columns live on that row). One batched write per call.
   */
  private async recordDiskStamps(projectId: string, entries: Array<{ syncId: string; stamp: DiskStamp }>): Promise<void> {
    if (entries.length === 0) return;
    const stamps = this.diskStampsFor(projectId);
    const baseline = this.projectStates.get(projectId);
    const rows = [];
    for (const { syncId, stamp } of entries) {
      stamps.set(syncId, stamp);
      const b = baseline?.get(syncId);
      if (b) rows.push({ syncId, baselineHash: b.contentHash, baselineMtime: b.lastSyncedMtime, stamp });
    }
    await persistDiskStamps(projectId, rows);
  }

  /** Remove a file's baseline from the in-memory cache and the durable table. */
  private async deleteBaseline(projectId: string, syncId: string): Promise<void> {
    this.projectStates.get(projectId)?.delete(syncId);
    this.diskStamps.get(projectId)?.delete(syncId);
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
      const title = projectSyncTitle(filePath);
      const outcome = await this.provider.pushFileContent(
        projectId,
        syncId,
        content,
        relativePath,
        title,
        Math.floor(stat.mtimeMs),
      );
      await this.setBaselinesForStored(projectId, outcome, [{ syncId, content, lastModifiedAt: Math.floor(stat.mtimeMs) }]);
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
      this.fileMapFor(projectId)?.fileMap.delete(syncId);
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

  /** The walk and its stats run on the manifest worker; the sync rules apply here. */
  private async scanSyncFiles(root: string): Promise<ScannedFile[]> {
    const candidates = await scanProjectSyncCandidates({ root, ...PROJECT_SYNC_CANDIDATES });
    const results: ScannedFile[] = [];
    for (const file of candidates) {
      if (!isProjectSyncPath(file.filePath, root)) continue;
      if (exceedsProjectSyncLimit(file.size, path.relative(root, file.filePath))) {
        this.oversizedWarnings.warn(file.filePath, file.size);
        continue;
      }
      results.push(file);
    }
    return results;
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
