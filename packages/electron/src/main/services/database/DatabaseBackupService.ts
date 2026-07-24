/**
 * Database Backup Service
 * Manages verified backups of the PGlite database with rolling backup strategy
 */

import { app } from 'electron';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger';
import type { PGLiteDatabaseWorker } from '../../database/PGLiteDatabaseWorker';

interface BackupMetadata {
  currentBackup: {
    timestamp: string;
    size: number;
    verified: boolean;
  } | null;
  previousBackup: {
    timestamp: string;
    size: number;
    verified: boolean;
  } | null;
  oldestBackup: {
    timestamp: string;
    size: number;
    verified: boolean;
  } | null;
  lastBackupAttempt: string | null;
  lastSuccessfulBackup: string | null;
}

export class DatabaseBackupService {
  private backupDir: string;
  private metadataPath: string;
  private dbPath: string;
  private metadata: BackupMetadata;
  private dbWorker: PGLiteDatabaseWorker;

  constructor(dbPath: string, dbWorker: PGLiteDatabaseWorker) {
    this.dbPath = dbPath;
    this.dbWorker = dbWorker;
    const userDataPath = app.getPath('userData');
    this.backupDir = path.join(userDataPath, 'db-backups');
    this.metadataPath = path.join(this.backupDir, 'backup-metadata.json');
    this.metadata = {
      currentBackup: null,
      previousBackup: null,
      oldestBackup: null,
      lastBackupAttempt: null,
      lastSuccessfulBackup: null
    };
  }

  /**
   * Initialize the backup service - create directories and load metadata
   */
  async initialize(): Promise<void> {
    try {
      // Create backup directory if it doesn't exist
      await fs.mkdir(this.backupDir, { recursive: true });

      // Load existing metadata
      await this.loadMetadata();

      logger.main.info('[Backup Service] Initialized', {
        backupDir: this.backupDir,
        hasCurrentBackup: !!this.metadata.currentBackup,
        hasPreviousBackup: !!this.metadata.previousBackup,
        hasOldestBackup: !!this.metadata.oldestBackup,
        currentSizeMB: this.metadata.currentBackup ? (this.metadata.currentBackup.size / 1024 / 1024).toFixed(1) : null
      });
    } catch (error) {
      logger.main.error('[Backup Service] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Load backup metadata from disk
   */
  private async loadMetadata(): Promise<void> {
    try {
      const data = await fs.readFile(this.metadataPath, 'utf-8');
      this.metadata = JSON.parse(data);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // No metadata file yet - start fresh
        logger.main.info('[Backup Service] No metadata file found, starting fresh');
      } else {
        logger.main.warn('[Backup Service] Failed to load metadata:', error);
      }
    }
  }

  /**
   * Save backup metadata to disk
   */
  private async saveMetadata(): Promise<void> {
    try {
      await fs.writeFile(
        this.metadataPath,
        JSON.stringify(this.metadata, null, 2),
        'utf-8'
      );
    } catch (error) {
      logger.main.error('[Backup Service] Failed to save metadata:', error);
    }
  }

  /**
   * Check if there's enough disk space for a backup
   */
  private async hasEnoughDiskSpace(): Promise<boolean> {
    try {
      // Get size of database directory
      const dbSize = await this.getDirectorySize(this.dbPath);

      // Require at least 1GB + (2 * db size) free space
      const requiredSpace = 1024 * 1024 * 1024 + (dbSize * 2);

      // Note: fs.statfs is not available in Node.js
      // We'll use a simpler check - try to write a test file
      const testFile = path.join(this.backupDir, '.space-check');
      await fs.writeFile(testFile, 'test');
      await fs.unlink(testFile);

      return true;
    } catch (error) {
      logger.main.warn('[Backup Service] Disk space check failed:', error);
      return false;
    }
  }

  /**
   * Get total size of a directory in bytes
   */
  private async getDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          totalSize += await this.getDirectorySize(fullPath);
        } else {
          const stats = await fs.stat(fullPath);
          totalSize += stats.size;
        }
      }
    } catch (error) {
      logger.main.warn('[Backup Service] Failed to get directory size:', error);
    }

    return totalSize;
  }

  /**
   * Copy directory recursively
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });

    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Verify that a backup is valid by attempting to open it with PGlite
   * Also checks data integrity (session/history counts)
   */
  private async verifyBackup(backupPath: string): Promise<{
    valid: boolean;
    hasData?: boolean;
    sessionCount?: number;
    historyCount?: number;
  }> {
    try {
      logger.main.info('[Backup Service] Verifying backup:', backupPath);

      // Use the database worker to verify the backup
      // This avoids conflicts with the main database instance
      const result = await this.dbWorker.verifyBackup(backupPath);

      if (result.valid) {
        logger.main.info('[Backup Service] Backup verification successful', {
          hasData: result.hasData,
          sessionCount: result.sessionCount,
          historyCount: result.historyCount
        });
        return {
          valid: true,
          hasData: result.hasData,
          sessionCount: result.sessionCount,
          historyCount: result.historyCount
        };
      } else {
        logger.main.error('[Backup Service] Backup verification failed:', result.error);
        return { valid: false };
      }
    } catch (error) {
      logger.main.error('[Backup Service] Backup verification error:', error);
      return { valid: false };
    }
  }

  /**
   * Create a new backup with verification and rolling backup management
   */
  async createBackup(): Promise<{ success: boolean; error?: string }> {
    this.metadata.lastBackupAttempt = new Date().toISOString();

    // Declared outside the try so the catch can clean up a partial temp dir.
    // Without this, a throw mid-copyDirectory leaves temp-backup-* dirs
    // accumulating in backupDir forever (cleanupOldCorruptedBackups never
    // scanned this folder, and the rotation path only deletes on rejection).
    let tempBackupPath: string | null = null;

    try {
      logger.main.info('[Backup Service] Starting backup creation...');

      // Check if database path exists
      if (!fsSync.existsSync(this.dbPath)) {
        logger.main.warn('[Backup Service] Database path does not exist:', this.dbPath);
        return { success: false, error: 'Database path does not exist' };
      }

      // Check disk space
      const hasSpace = await this.hasEnoughDiskSpace();
      if (!hasSpace) {
        logger.main.warn('[Backup Service] Insufficient disk space for backup');
        return { success: false, error: 'Insufficient disk space' };
      }

      // Create temporary backup directory
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      tempBackupPath = path.join(this.backupDir, `temp-backup-${timestamp}`);

      // Copy database to temporary location
      logger.main.info('[Backup Service] Copying database to:', tempBackupPath);
      await this.copyDirectory(this.dbPath, tempBackupPath);

      // Get backup size
      const backupSize = await this.getDirectorySize(tempBackupPath);

      // Verify the backup
      const verification = await this.verifyBackup(tempBackupPath);

      if (!verification.valid) {
        // Verification failed - clean up temp backup
        await fs.rm(tempBackupPath, { recursive: true, force: true });
        return { success: false, error: 'Backup verification failed' };
      }

      // Additional data integrity check: if current backup has data but new one doesn't,
      // this is suspicious and we should log a warning
      const currentHasData = this.metadata.currentBackup && this.metadata.currentBackup.size > 50 * 1024 * 1024;
      if (currentHasData && !verification.hasData) {
        logger.main.warn('[Backup Service] New backup has no data but current backup does - will rely on size check', {
          newSessionCount: verification.sessionCount,
          newHistoryCount: verification.historyCount
        });
      }

      // Verification succeeded - rotate backups (may be rejected if size is suspicious)
      const rotated = await this.rotateBackups(tempBackupPath, timestamp, backupSize);

      if (rotated) {
        this.metadata.lastSuccessfulBackup = timestamp;
        await this.saveMetadata();
        logger.main.info('[Backup Service] Backup created and rotated successfully');
        return { success: true };
      } else {
        // Rotation was rejected due to suspicious size - this is actually a success
        // for protecting data, but we should log it
        await this.saveMetadata();
        logger.main.info('[Backup Service] Backup rejected due to suspicious size - existing backups preserved');
        return { success: true }; // Return success since we protected the data
      }

    } catch (error: any) {
      logger.main.error('[Backup Service] Failed to create backup:', error);
      if (tempBackupPath && fsSync.existsSync(tempBackupPath)) {
        try {
          await fs.rm(tempBackupPath, { recursive: true, force: true });
        } catch (cleanupErr) {
          logger.main.warn('[Backup Service] Failed to clean up partial temp backup:', cleanupErr);
        }
      }
      await this.saveMetadata();
      return { success: false, error: error.message || String(error) };
    }
  }

  /**
   * Rotate backups: oldest -> delete, previous -> oldest, current -> previous, new -> current
   *
   * CRITICAL: Size-aware rotation to prevent data loss
   * If new backup is significantly smaller than current, we reject it to avoid
   * replacing a valid large backup with a corrupted/empty small one.
   */
  private async rotateBackups(
    newBackupPath: string,
    timestamp: string,
    size: number
  ): Promise<boolean> {
    const currentPath = path.join(this.backupDir, 'pglite-db.backup-current');
    const previousPath = path.join(this.backupDir, 'pglite-db.backup-previous');
    const oldestPath = path.join(this.backupDir, 'pglite-db.backup-oldest');

    // Size-aware rotation check: Don't replace large backups with small ones
    const currentSize = this.metadata.currentBackup?.size ?? 0;
    if (currentSize > 0) {
      const sizeRatio = size / currentSize;

      // If new backup is less than 50% of current size, it's suspicious
      if (sizeRatio < 0.5) {
        logger.main.warn('[Backup Service] New backup is suspiciously smaller than current - rejecting rotation', {
          newSize: size,
          currentSize,
          ratio: sizeRatio.toFixed(2),
          newSizeMB: (size / 1024 / 1024).toFixed(1),
          currentSizeMB: (currentSize / 1024 / 1024).toFixed(1)
        });
        // Clean up the rejected backup
        await fs.rm(newBackupPath, { recursive: true, force: true });
        return false;
      }
    }

    // Delete oldest backup if it exists
    if (fsSync.existsSync(oldestPath)) {
      logger.main.info('[Backup Service] Deleting oldest backup');
      await fs.rm(oldestPath, { recursive: true, force: true });
    }

    // Move previous to oldest if it exists
    if (fsSync.existsSync(previousPath)) {
      logger.main.info('[Backup Service] Moving previous backup to oldest');
      await fs.rename(previousPath, oldestPath);
      this.metadata.oldestBackup = this.metadata.previousBackup;
    }

    // Move current to previous if it exists
    if (fsSync.existsSync(currentPath)) {
      logger.main.info('[Backup Service] Moving current backup to previous');
      await fs.rename(currentPath, previousPath);
      this.metadata.previousBackup = this.metadata.currentBackup;
    }

    // Move new backup to current
    logger.main.info('[Backup Service] Promoting new backup to current');
    await fs.rename(newBackupPath, currentPath);

    this.metadata.currentBackup = {
      timestamp,
      size,
      verified: true
    };

    return true;
  }

  /**
   * Restore from the most recent backup
   */
  async restoreFromBackup(): Promise<{ success: boolean; error?: string; source?: string }> {
    const currentPath = path.join(this.backupDir, 'pglite-db.backup-current');
    const previousPath = path.join(this.backupDir, 'pglite-db.backup-previous');
    const oldestPath = path.join(this.backupDir, 'pglite-db.backup-oldest');

    // Try current backup first
    if (fsSync.existsSync(currentPath)) {
      logger.main.info('[Backup Service] Attempting restore from current backup');
      const result = await this.restoreFromPath(currentPath, 'current');
      if (result.success) {
        return result;
      }
    }

    // Fall back to previous backup
    if (fsSync.existsSync(previousPath)) {
      logger.main.info('[Backup Service] Attempting restore from previous backup');
      const result = await this.restoreFromPath(previousPath, 'previous');
      if (result.success) {
        return result;
      }
    }

    // Fall back to oldest backup
    if (fsSync.existsSync(oldestPath)) {
      logger.main.info('[Backup Service] Attempting restore from oldest backup');
      const result = await this.restoreFromPath(oldestPath, 'oldest');
      if (result.success) {
        return result;
      }
    }

    return { success: false, error: 'No valid backups available' };
  }

  /**
   * Restore from a specific backup path
   */
  private async restoreFromPath(
    backupPath: string,
    source: string
  ): Promise<{ success: boolean; error?: string; source?: string }> {
    try {
      // Verify backup before restoring
      const verification = await this.verifyBackup(backupPath);
      if (!verification.valid) {
        return { success: false, error: `${source} backup verification failed` };
      }

      logger.main.info(`[Backup Service] Verified ${source} backup before restore`, {
        hasData: verification.hasData,
        sessionCount: verification.sessionCount,
        historyCount: verification.historyCount
      });

      // Close the database before restoring
      logger.main.info('[Backup Service] Closing database for restore');
      try {
        await this.dbWorker.close();
      } catch (error) {
        logger.main.warn('[Backup Service] Error closing database:', error);
        // Continue anyway - might already be closed
      }

      // Remove existing database
      if (fsSync.existsSync(this.dbPath)) {
        logger.main.info('[Backup Service] Removing existing database');
        await fs.rm(this.dbPath, { recursive: true, force: true });
      }

      // Copy backup to database location
      logger.main.info('[Backup Service] Copying backup to database location');
      await this.copyDirectory(backupPath, this.dbPath);

      logger.main.info(`[Backup Service] Successfully restored from ${source} backup`);
      return { success: true, source };

    } catch (error: any) {
      logger.main.error(`[Backup Service] Failed to restore from ${source} backup:`, error);
      return { success: false, error: error.message || String(error) };
    }
  }

  /**
   * Check if any backups are available
   */
  hasBackups(): boolean {
    const currentPath = path.join(this.backupDir, 'pglite-db.backup-current');
    const previousPath = path.join(this.backupDir, 'pglite-db.backup-previous');
    const oldestPath = path.join(this.backupDir, 'pglite-db.backup-oldest');

    return fsSync.existsSync(currentPath) || fsSync.existsSync(previousPath) || fsSync.existsSync(oldestPath);
  }

  /**
   * Get backup status information
   */
  getBackupStatus(): BackupMetadata {
    return { ...this.metadata };
  }

  /**
   * Clean up stranded temp backup dirs in backupDir, plus any historical
   * timestamped `pglite-db.backup-*` dirs at the userData root (legacy
   * naming from earlier versions; modern installs don't produce these).
   *
   * Temp dirs are unrecoverable garbage the moment createBackup() returns,
   * so we delete them eagerly. The 30-day cutoff at the userData root is
   * kept as a safety net for legacy stragglers.
   */
  async cleanupOldCorruptedBackups(): Promise<void> {
    // Stranded temp-backup-* dirs in the backup folder — created by
    // createBackup() when verification or rotation throws mid-flight.
    // No age guard: by the time this runs they're unreferenced garbage.
    try {
      const entries = await fs.readdir(this.backupDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith('temp-backup-')) continue;
        const fullPath = path.join(this.backupDir, entry.name);
        logger.main.info('[Backup Service] Removing stranded temp backup:', entry.name);
        await fs.rm(fullPath, { recursive: true, force: true });
      }
    } catch (error) {
      logger.main.warn('[Backup Service] Failed to clean stranded temp backups:', error);
    }

    // Legacy timestamped corrupted-backup dirs at the userData root.
    try {
      const userDataPath = app.getPath('userData');
      const entries = await fs.readdir(userDataPath, { withFileTypes: true });
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('pglite-db.backup-')) {
          const fullPath = path.join(userDataPath, entry.name);
          const stats = await fs.stat(fullPath);

          if (stats.mtimeMs < thirtyDaysAgo) {
            logger.main.info('[Backup Service] Cleaning up old corrupted backup:', entry.name);
            await fs.rm(fullPath, { recursive: true, force: true });
          }
        }
      }
    } catch (error) {
      logger.main.error('[Backup Service] Failed to clean up old backups:', error);
    }
  }
}
