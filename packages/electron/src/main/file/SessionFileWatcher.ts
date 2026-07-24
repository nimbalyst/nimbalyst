import * as fs from 'fs/promises';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import type { FileSnapshotCache } from './FileSnapshotCache';
import * as workspaceEventBus from './WorkspaceEventBus';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.flac',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.sqlite', '.db', '.lock',
  '.wasm', '.node',
  '.pak', '.pdb', '.dat', '.bin', '.blockmap', '.asar', '.icns', '.appimage',
  '.dmg', '.deb', '.rpm', '.snap', '.msi', '.nupkg',
]);

/** TTL for editor save markers (ms). Must exceed chokidar's awaitWriteFinish delay. */
const EDITOR_SAVE_TTL_MS = 2000;
const FILE_CHANGED_NOTIFY_DEDUPE_MS = 250;

// ---------------------------------------------------------------------------
// Re-exports from WorkspaceEventBus for backward compatibility
// ---------------------------------------------------------------------------

/** Active session IDs currently attached to the shared watcher for a workspace. */
export function getSharedWatcherSessionIds(workspacePath: string): string[] {
  return workspaceEventBus.getSubscriberIds(workspacePath);
}

/** Visible for testing / diagnostics. */
export function getSharedWatcherCount(): number {
  return workspaceEventBus.getBusEntryCount();
}

/** Visible for testing. */
export function getSharedWatcherRefCount(workspacePath: string): number {
  return workspaceEventBus.getRefCount(workspacePath);
}

/** Reset shared watcher state. Only for tests. */
export function resetSharedWatchers(): void {
  workspaceEventBus.resetBus();
}

// ---------------------------------------------------------------------------
// SessionFileWatcher -- per-session wrapper that subscribes to WorkspaceEventBus
// ---------------------------------------------------------------------------

export interface SessionFileWatcherEditEvent {
  workspacePath: string;
  filePath: string;
  timestamp: number;
  beforeContent?: string | null;
}

export class SessionFileWatcher {
  private cache: FileSnapshotCache | null = null;
  private sessionId: string | null = null;
  private workspacePath: string | null = null;
  private active = false;
  private onFileChanged: ((event: SessionFileWatcherEditEvent) => Promise<void> | void) | null = null;

  /**
   * File paths recently saved by the Nimbalyst editor (user saves).
   * These are excluded from AI tool call matching so human edits
   * don't get attributed to AI tool calls.
   */
  private static recentEditorSaves = new Map<string, number>();
  private static recentDiskNotifications = new Map<string, number>();

  /**
   * Mark a file as recently saved by the editor.
   * Called from FileHandlers when the user saves a file (Cmd+S / autosave).
   */
  static markEditorSave(filePath: string): void {
    SessionFileWatcher.recentEditorSaves.set(path.normalize(filePath), Date.now());
  }

  private isRecentEditorSave(filePath: string): boolean {
    const normalized = path.normalize(filePath);
    const savedAt = SessionFileWatcher.recentEditorSaves.get(normalized);
    if (savedAt === undefined) return false;
    if (Date.now() - savedAt > EDITOR_SAVE_TTL_MS) {
      SessionFileWatcher.recentEditorSaves.delete(normalized);
      return false;
    }
    return true;
  }

  async start(
    workspacePath: string,
    sessionId: string,
    cache: FileSnapshotCache,
    onFileChanged?: (event: SessionFileWatcherEditEvent) => Promise<void> | void
  ): Promise<void> {
    await this.stop();

    this.cache = cache;
    this.sessionId = sessionId;
    this.workspacePath = workspacePath;
    this.active = true;
    this.onFileChanged = onFileChanged ?? null;

    await workspaceEventBus.subscribe(workspacePath, sessionId, {
      onChange: (filePath: string) => this.handleChange(filePath),
      onAdd: (filePath: string) => this.handleAdd(filePath),
      onUnlink: (filePath: string) => this.handleUnlink(filePath),
    });

    // logger.main.info('[SessionFileWatcher] Started watching:', { workspacePath, sessionId });
  }

  async stop(): Promise<void> {
    if (this.workspacePath && this.sessionId) {
      workspaceEventBus.unsubscribe(this.workspacePath, this.sessionId);
    }
    this.cache = null;
    this.sessionId = null;
    this.workspacePath = null;
    this.active = false;
    this.onFileChanged = null;
  }

  isActive(): boolean {
    return this.active;
  }

  private isBinaryPath(filePath: string): boolean {
    return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  private async handleChange(filePath: string): Promise<void> {
    if (!this.active || !this.cache || !this.sessionId || !this.workspacePath) return;
    if (this.isBinaryPath(filePath)) return;
    if (this.isRecentEditorSave(filePath)) return;
    if (!this.isPathInWorkspace(filePath, this.workspacePath)) return;

    try {
      logger.main.debug('[SessionFileWatcher] Change event received:', {
        sessionId: this.sessionId,
        filePath,
      });

      const beforeContent = await this.cache.getBeforeState(filePath);

      let currentContent: string;
      try {
        currentContent = await fs.readFile(filePath, 'utf-8');
      } catch {
        return; // File may have been deleted between event and read
      }

      if (beforeContent !== null && beforeContent === currentContent) {
        logger.main.debug('[SessionFileWatcher] No-op skip (content unchanged):', {
          workspacePath: this.workspacePath,
          filePath,
          sessionId: this.sessionId,
          reason: 'no_content_change',
        });
        this.cache.updateSnapshot(filePath, currentContent);
        return;
      }

      const timestamp = Date.now();
      if (this.onFileChanged) {
        await this.onFileChanged({
          workspacePath: this.workspacePath,
          filePath,
          timestamp,
          beforeContent,
        });
      }

      this.notifyFileChanged(filePath);
      logger.main.debug('[SessionFileWatcher] Emitted change event:', {
        sessionId: this.sessionId,
        filePath,
        timestamp,
        hasBeforeContent: beforeContent !== null,
      });

      // Update cache with current content for subsequent edits
      this.cache.updateSnapshot(filePath, currentContent);
    } catch (error) {
      logger.main.error('[SessionFileWatcher] Error handling file change:', error);
    }
  }

  private async handleAdd(filePath: string): Promise<void> {
    if (!this.active || !this.cache || !this.sessionId || !this.workspacePath) return;
    if (this.isBinaryPath(filePath)) return;
    if (this.isRecentEditorSave(filePath)) return;
    if (!this.isPathInWorkspace(filePath, this.workspacePath)) return;

    try {
      // Check if we already have a cached state for this file BEFORE reading the new content.
      // Atomic writes (write-to-temp then rename) trigger 'rename' events on macOS,
      // which get classified as 'add'. If the cache already has content for this path,
      // this is an overwrite of an existing file, not a truly new file creation.
      const beforeContent = await this.cache.getBeforeState(filePath);

      logger.main.debug('[SessionFileWatcher] Add event received:', {
        sessionId: this.sessionId,
        filePath,
        hasExistingCache: beforeContent !== null,
      });

      let currentContent: string;
      try {
        currentContent = await fs.readFile(filePath, 'utf-8');
      } catch {
        // File may have been deleted already
        return;
      }

      // If we had cached content and it matches the new content, skip (no real change)
      if (beforeContent !== null && beforeContent === currentContent) {
        logger.main.debug('[SessionFileWatcher] No-op skip (add event, content unchanged):', {
          filePath,
          sessionId: this.sessionId,
        });
        this.cache.updateSnapshot(filePath, currentContent);
        return;
      }

      const timestamp = Date.now();
      if (this.onFileChanged) {
        await this.onFileChanged({
          workspacePath: this.workspacePath,
          filePath,
          timestamp,
          beforeContent: beforeContent ?? '',
        });
      }

      this.notifyFileChanged(filePath);
      logger.main.debug('[SessionFileWatcher] Emitted add event:', {
        sessionId: this.sessionId,
        filePath,
        timestamp,
      });

      // Update cache with current content AFTER firing the event
      this.cache.updateSnapshot(filePath, currentContent);
    } catch (error) {
      logger.main.error('[SessionFileWatcher] Error handling file add:', error);
    }
  }

  private handleUnlink(_filePath: string): void {
    // Intentionally do NOT remove from cache on unlink.
    // Atomic writes (write-to-temp, rename) trigger unlink+add in quick succession.
    // Removing the cache entry here would lose the "before" state needed by handleAdd
    // to produce a correct diff. The cache has a bounded memory cap and is cleaned up
    // when the session stops, so stale entries are not a concern.
  }

  private isPathInWorkspace(filePath: string, workspacePath: string): boolean {
    const resolvedFile = path.resolve(filePath);
    const resolvedWorkspace = path.resolve(workspacePath);
    return resolvedFile === resolvedWorkspace || resolvedFile.startsWith(resolvedWorkspace + path.sep);
  }

  private notifyFileChanged(filePath: string): void {
    const normalized = path.normalize(filePath);
    const now = Date.now();

    for (const [trackedPath, notifiedAt] of SessionFileWatcher.recentDiskNotifications.entries()) {
      if ((now - notifiedAt) > FILE_CHANGED_NOTIFY_DEDUPE_MS) {
        SessionFileWatcher.recentDiskNotifications.delete(trackedPath);
      }
    }

    const lastNotifiedAt = SessionFileWatcher.recentDiskNotifications.get(normalized);
    if (lastNotifiedAt != null && (now - lastNotifiedAt) < FILE_CHANGED_NOTIFY_DEDUPE_MS) {
      return;
    }
    SessionFileWatcher.recentDiskNotifications.set(normalized, now);

    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('file-changed-on-disk', { path: filePath });
      }
    }
  }
}
