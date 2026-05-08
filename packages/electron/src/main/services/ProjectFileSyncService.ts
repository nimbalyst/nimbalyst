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

  /**
   * Initialize the service. Creates the ProjectSyncProvider and sets up event handlers.
   */
  async initialize(): Promise<void> {
    const config = getPersonalDocSyncConfig();
    if (!config) {
      logger.main.info('[ProjectFileSync] Sync not configured, skipping initialization');
      return;
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
      // Scan all .md files
      const mdFiles = await timeStartupPhase(
        `ProjectFileSync.scan(${projectName})`,
        () => this.scanMarkdownFiles(workspacePath),
      );
      logger.main.info(`[ProjectFileSync] Found ${mdFiles.length} .md files`);

      // Build manifest from local files. Reads + hashes every file sequentially,
      // which dominates startup time on large projects -- timed separately so the
      // user log shows whether the freeze is in scan, hash, or the network connect.
      const manifest: ProjectSyncManifestFile[] = [];
      const fileMap = new Map<string, string>(); // syncId -> absolutePath

      await timeStartupPhase(
        `ProjectFileSync.buildManifest(${projectName}, ${mdFiles.length} files)`,
        async () => {
          for (const filePath of mdFiles) {
            try {
              const relativePath = path.relative(workspacePath, filePath);
              const syncId = this.syncIdFromPath(relativePath);
              const content = await fs.readFile(filePath, 'utf-8');
              const stat = await fs.stat(filePath);
              const contentHash = this.sha256(content);

              manifest.push({
                syncId,
                contentHash,
                lastModifiedAt: Math.floor(stat.mtimeMs),
                hasYjs: false,
                yjsSeq: 0,
              });

              fileMap.set(syncId, filePath);

              // Track local state
              let projectState = this.projectStates.get(encryptedProjectId);
              if (!projectState) {
                projectState = new Map();
                this.projectStates.set(encryptedProjectId, projectState);
              }
              projectState.set(syncId, {
                syncId,
                contentHash,
                lastSyncedMtime: Math.floor(stat.mtimeMs),
              });
            } catch (err) {
              logger.main.error(`[ProjectFileSync] Failed to process ${filePath}:`, err);
            }
          }
        },
      );

      // Store the file map for handling sync response
      (this as any)._fileMapCache = (this as any)._fileMapCache || new Map();
      (this as any)._fileMapCache.set(encryptedProjectId, { fileMap, workspacePath });

      // Connect and send manifest
      await timeStartupPhase(
        `ProjectFileSync.connect(${projectName})`,
        () => this.provider!.connect(encryptedProjectId, manifest),
      );
    } catch (err) {
      logger.main.error(`[ProjectFileSync] Failed to sync project:`, err);
    }
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

      // Update local state
      const projectState = this.projectStates.get(encryptedProjectId);
      if (projectState) {
        projectState.set(syncId, {
          syncId,
          contentHash: this.sha256(content),
          lastSyncedMtime: Math.floor(stat.mtimeMs),
        });
      }
    } catch (err) {
      logger.main.error(`[ProjectFileSync] Failed to push file save:`, err);
    }
  }

  /**
   * Handle a local file deletion event. Pushes the deletion to the server.
   */
  handleFileDeleted(syncId: string, encryptedProjectId: string): void {
    if (!this.provider) return;
    this.provider.deleteFile(encryptedProjectId, syncId);

    const projectState = this.projectStates.get(encryptedProjectId);
    if (projectState) {
      projectState.delete(syncId);
    }
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
  }

  // MARK: - Sync Response Handling

  private async handleSyncResponse(projectId: string, response: ProjectSyncResponse): Promise<void> {
    const cache = (this as any)._fileMapCache?.get(projectId) as { fileMap: Map<string, string>; workspacePath: string } | undefined;
    if (!cache) return;

    // Write updated/new files from server to disk
    for (const file of [...response.updatedFiles, ...response.newFiles]) {
      await this.writeRemoteFileToDisk(cache.workspacePath, file);
    }

    // Delete files that were deleted on server
    for (const syncId of response.deletedSyncIds) {
      const filePath = cache.fileMap.get(syncId);
      if (filePath) {
        try {
          await fs.unlink(filePath);
          logger.main.info(`[ProjectFileSync] Deleted local file: ${path.basename(filePath)}`);
        } catch {
          // File might already be gone
        }
      }
    }

    // Push files the server needs from us
    if (response.needFromClient.length > 0) {
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

      if (filesToPush.length > 0) {
        await this.provider!.pushFileBatch(projectId, filesToPush);
        logger.main.info(`[ProjectFileSync] Pushed ${filesToPush.length} files to server`);
      }
    }

    logger.main.info(`[ProjectFileSync] Sync complete for project ${projectId}`);
  }

  // MARK: - Remote Updates

  private async handleRemoteFileUpdate(_projectId: string, file: ProjectSyncFileUpdate): Promise<void> {
    // Find the workspace path for this project
    const cache = (this as any)._fileMapCache?.get(_projectId) as { fileMap: Map<string, string>; workspacePath: string } | undefined;
    if (!cache) return;

    await this.writeRemoteFileToDisk(cache.workspacePath, file);
  }

  private async handleRemoteFileDelete(_projectId: string, syncId: string): Promise<void> {
    const cache = (this as any)._fileMapCache?.get(_projectId) as { fileMap: Map<string, string>; workspacePath: string } | undefined;
    if (!cache) return;

    const filePath = cache.fileMap.get(syncId);
    if (filePath) {
      try {
        this.suppressFileWatcherEcho(filePath);
        await fs.unlink(filePath);
        cache.fileMap.delete(syncId);
        logger.main.info(`[ProjectFileSync] Remote delete: ${path.basename(filePath)}`);
      } catch {
        // File might already be gone
      }
    }
  }

  private async writeRemoteFileToDisk(workspacePath: string, file: ProjectSyncFileUpdate): Promise<void> {
    const filePath = path.join(workspacePath, file.relativePath);

    try {
      // Skip write if local content already matches (avoids unnecessary disk IO and file watcher noise)
      try {
        const localContent = await fs.readFile(filePath, 'utf-8');
        if (this.sha256(localContent) === file.contentHash) {
          return;
        }
      } catch {
        // File doesn't exist locally -- proceed with write (genuinely new from remote)
      }

      // Ensure parent directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      // Suppress file watcher echo for this write
      this.suppressFileWatcherEcho(filePath);

      await fs.writeFile(filePath, file.content, 'utf-8');

      // Preserve the original filesystem mtime from the source device
      if (file.lastModifiedAt) {
        const mtime = new Date(file.lastModifiedAt);
        await fs.utimes(filePath, mtime, mtime);
      }

      logger.main.info(`[ProjectFileSync] Wrote remote file: ${file.relativePath}`);
    } catch (err) {
      logger.main.error(`[ProjectFileSync] Failed to write remote file: ${file.relativePath}`, err);
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
