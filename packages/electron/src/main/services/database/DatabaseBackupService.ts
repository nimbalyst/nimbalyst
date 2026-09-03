/**
 * Database Backup Service
 * Manages verified backups of the PGlite database with rolling backup strategy
 */

import { app } from 'electron';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger';
import { getPackageRoot } from '../../utils/appPaths';
import type { PGLiteDatabaseWorker } from '../../database/PGLiteDatabaseWorker';
import {
  classifyBackupEntry,
  ROLLING_BACKUP_DIRNAMES,
  TEMP_BACKUP_DIR_PREFIX,
} from '../../database/sqlite/recoveryArtifacts';
import { createPgliteRecoveryAdapter } from '../../database/recovery/backendAdapters';
import { createPgliteRecoveryVerifier } from '../../database/recovery/pgliteVerification';
import { createRecoveryJournalPort } from '../../database/recovery/recoveryJournal';
import {
  mayTryAnotherCandidate,
  runRecoveryTransaction,
} from '../../database/recovery/recoveryTransaction';
import { pathSizeBytes } from '../../database/recovery/recoveryFs';
import { directorySizeBytes } from '../../database/sqlite/dirSize';
import { resolveDatabaseUserDataPath } from '../../database/userDataPath';
import {
  sizeBucketFor,
  type RecoveryStep,
  type RecoveryVerification,
} from '../../database/recovery/types';
import {
  describeOperationConflict,
  withDatabaseOperationLock,
} from '../../database/databaseOperationLock';

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

const BACKUP_DIRNAMES = ROLLING_BACKUP_DIRNAMES;

/** Newest to oldest. `rotateBackups` truncates this to the retention setting. */
const BACKUP_SLOT_ORDER = ['current', 'previous', 'oldest'] as const;

type BackupSlot = (typeof BACKUP_SLOT_ORDER)[number];

const SLOT_METADATA_KEYS = {
  current: 'currentBackup',
  previous: 'previousBackup',
  oldest: 'oldestBackup',
} as const satisfies Record<BackupSlot, keyof BackupMetadata>;

/** Same default and ceiling as the SQLite service; each copy is a full store. */
export const DEFAULT_BACKUP_COPIES_KEPT = 2;
export const MAX_BACKUP_COPIES_KEPT = BACKUP_SLOT_ORDER.length;

/** A bad setting must never mean "keep zero backups". */
function clampCopiesKept(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BACKUP_COPIES_KEPT;
  return Math.max(1, Math.min(MAX_BACKUP_COPIES_KEPT, Math.floor(value)));
}

export interface DatabaseBackupServiceOptions {
  /**
   * Resolves the backupCopiesKept setting at rotation time, so a change in
   * settings takes hold on the next backup without a restart. The SQLite
   * service gets the same value pushed through its worker proxy; this
   * service runs on main and can just read the store.
   */
  getCopiesKept?: () => number;
  /**
   * Verifies a PGLite store at an arbitrary path, off this thread and without
   * the live worker.
   *
   * Restore closes the live database before it touches anything, so
   * `dbWorker.verifyBackup()` — which routes through that worker — cannot be
   * used past that point. Production passes `createPgliteRecoveryVerifier`,
   * which spawns a throwaway worker from the same bundle. Injected rather
   * than constructed here so the destructive path is exercisable in a test
   * without a real PGLite behind it, per
   * `.claude/rules/destructive-data-paths.md`.
   *
   * Defaults to a verifier over the packaged PGLite worker bundle, so the
   * production construction site does not have to know this exists. It used to
   * be required-by-omission: the only production caller never passed it, so
   * every `restoreFromBackup()` returned "No database verifier configured" and
   * the entire rolling-backup restore path was dead in shipped builds.
   */
  verifyDatabaseAt?: (dbPath: string) => Promise<RecoveryVerification>;
  /**
   * Fault-injection seam, forwarded to `runRecoveryTransaction.beforeStep`.
   *
   * The transaction exposes one for the same reason: the failure that matters
   * here is a swap that dies between its two renames, and that is not a state
   * a test can reach by feeding the service different files. It exists so the
   * *sweep* -- which copy is tried next, and whether one is tried at all -- can
   * be driven over real directories rather than asserted against a mock.
   */
  beforeRecoveryStep?: (step: RecoveryStep) => void | Promise<void>;
}

/**
 * The PGLite worker bundle, resolved the same way `PGLiteDatabaseWorker` does.
 * Duplicated rather than imported from `recovery/productionRecovery.ts`
 * because `PGLiteDatabaseWorker` imports this module, and that import would
 * close the cycle.
 */
function defaultPgliteWorkerPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'worker.bundle.js')
    : path.join(getPackageRoot(), 'out', 'worker.bundle.js');
}

export class DatabaseBackupService {
  private backupDir: string;
  private metadataPath: string;
  private dbPath: string;
  private metadata: BackupMetadata;
  private dbWorker: PGLiteDatabaseWorker;
  private getCopiesKept: () => number;
  private verifyDatabaseAt: (dbPath: string) => Promise<RecoveryVerification>;
  private userDataPath: string;
  private beforeRecoveryStep?: (step: RecoveryStep) => void | Promise<void>;
  /**
   * #1369: five call sites can start a backup (periodic timer, startup and
   * resume staleness checks, before-quit, project migration). On wake from
   * sleep the periodic copy that slept mid-flight and the resume copy ran at
   * once on the same multi-GB store and both failed verification. A second
   * caller now awaits the in-flight backup instead of starting another.
   */
  private inFlight: Promise<{ success: boolean; error?: string }> | null = null;

  constructor(dbPath: string, dbWorker: PGLiteDatabaseWorker, options: DatabaseBackupServiceOptions = {}) {
    this.dbPath = dbPath;
    this.dbWorker = dbWorker;
    this.getCopiesKept = options.getCopiesKept ?? (() => DEFAULT_BACKUP_COPIES_KEPT);
    this.beforeRecoveryStep = options.beforeRecoveryStep;
    // Built lazily: constructing the verifier resolves the packaged worker
    // path, and a restore is rare enough that paying for it per call costs
    // nothing while keeping construction free of `app.isPackaged`.
    const userDataPath = resolveDatabaseUserDataPath();
    this.verifyDatabaseAt = options.verifyDatabaseAt
      ?? ((dbPath) =>
        createPgliteRecoveryVerifier({
          workerPath: defaultPgliteWorkerPath(),
          userDataPath,
          log: (level, msg, meta) => logger.main[level](msg, meta),
        })(dbPath));
    this.userDataPath = userDataPath;
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
      const dbSize = await directorySizeBytes(this.dbPath);

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
   * Create a new backup with verification and rolling backup management.
   * While one is running, further calls share its result rather than
   * starting a second copy of the store.
   */
  createBackup(): Promise<{ success: boolean; error?: string }> {
    if (this.inFlight) {
      logger.main.info('[Backup Service] Backup already in flight; joining it instead of starting another');
      return this.inFlight;
    }
    // doCreateBackup catches everything it can, but the guard must clear on
    // any exit, so the finally is here rather than trusting that.
    this.inFlight = this.doCreateBackup().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doCreateBackup(): Promise<{ success: boolean; error?: string }> {
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
      tempBackupPath = path.join(this.backupDir, `${TEMP_BACKUP_DIR_PREFIX}${timestamp}`);

      // Copy database to temporary location
      logger.main.info('[Backup Service] Copying database to:', tempBackupPath);
      await this.copyDirectory(this.dbPath, tempBackupPath);

      // Get backup size
      const backupSize = await directorySizeBytes(tempBackupPath);

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
   * Roll the backup chain, keeping `backupCopiesKept` generations (1-3).
   * At the default of 2: previous is deleted, current -> previous, new -> current.
   * Every kept copy is a FULL copy of the store, so the setting is a direct
   * multiplier on disk. Mirrors SQLiteBackupService.rotateBackups.
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

    const copiesKept = clampCopiesKept(this.getCopiesKept());

    // Slots from newest to oldest, truncated to the retention setting. Slots
    // past the limit are removed so lowering the setting actually reclaims
    // the space rather than orphaning directories in the backup folder.
    const slots = BACKUP_SLOT_ORDER.slice(0, copiesKept);
    const dropped = BACKUP_SLOT_ORDER.slice(copiesKept);
    for (const slot of dropped) {
      const p = path.join(this.backupDir, BACKUP_DIRNAMES[slot]);
      if (fsSync.existsSync(p)) {
        logger.main.info(`[Backup Service] Removing ${slot} backup (retention set to ${copiesKept})`);
        await fs.rm(p, { recursive: true, force: true });
      }
      this.metadata[SLOT_METADATA_KEYS[slot]] = null;
    }

    // Shift each kept slot down one, oldest first so nothing is overwritten.
    for (let i = slots.length - 1; i > 0; i--) {
      const target = slots[i];
      const sourceSlot = slots[i - 1];
      const targetPath = path.join(this.backupDir, BACKUP_DIRNAMES[target]);
      const sourcePath = path.join(this.backupDir, BACKUP_DIRNAMES[sourceSlot]);
      if (fsSync.existsSync(targetPath)) {
        logger.main.info(`[Backup Service] Deleting ${target} backup`);
        await fs.rm(targetPath, { recursive: true, force: true });
      }
      if (fsSync.existsSync(sourcePath)) {
        logger.main.info(`[Backup Service] Moving ${sourceSlot} backup to ${target}`);
        await fs.rename(sourcePath, targetPath);
        this.metadata[SLOT_METADATA_KEYS[target]] = this.metadata[SLOT_METADATA_KEYS[sourceSlot]];
      }
    }

    // At copiesKept === 1 there is no older generation to fall back on, so
    // the new backup is still copied to a temp dir and promoted by rename,
    // never written over the live slot.
    const currentPath = path.join(this.backupDir, BACKUP_DIRNAMES.current);
    if (copiesKept === 1 && fsSync.existsSync(currentPath)) {
      await fs.rm(currentPath, { recursive: true, force: true });
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
   * Restore from the backup with the most in it.
   *
   * Not "the newest". Slot order is recency, and recency is exactly the wrong
   * tiebreaker for the failure this path exists to undo: the shape of #1347 is
   * a database that lost its contents and then got backed up, so `current` is
   * a small, structurally-valid, recent copy of nothing sitting in front of a
   * `previous` holding months of history. The old code took the first
   * non-empty slot, so that small `current` restored successfully and the
   * richer copy was never considered.
   *
   * Size is the evidence available here without opening three multi-gigabyte
   * stores — the same signal `findRestorableBackups` and the migration
   * plausibility gate use. It is a proxy, and it does not have to be a perfect
   * one: the recovery transaction fully verifies whichever copy is chosen and
   * refuses an empty or damaged one, so a wrong first guess falls through to
   * the next candidate rather than replacing anything.
   */
  async restoreFromBackup(): Promise<{ success: boolean; error?: string; source?: string }> {
    const present = BACKUP_SLOT_ORDER
      .map((slot, index) => ({
        slot,
        index,
        path: path.join(this.backupDir, BACKUP_DIRNAMES[slot]),
      }))
      .filter((entry) => fsSync.existsSync(entry.path));

    const ranked = (
      await Promise.all(
        present.map(async (entry) => ({ ...entry, bytes: await directorySizeBytes(entry.path) })),
      )
    )
      // Largest first; slot order breaks ties, so equal-sized copies still
      // prefer the newest.
      .sort((a, b) => (b.bytes - a.bytes) || (a.index - b.index));

    if (ranked.length === 0) {
      return { success: false, error: 'No valid backups available' };
    }

    logger.main.info('[Backup Service] Restore candidates, richest first', {
      candidates: ranked.map((e) => ({ slot: e.slot, bytes: e.bytes })),
    });

    // One lease for the whole sweep, not one per attempt: a migration starting
    // between two attempts would close and rename the engine the next attempt
    // is about to restore into.
    const run = await withDatabaseOperationLock('backup-restore', async () => {
      const failures: string[] = [];
      for (const entry of ranked) {
        logger.main.info(`[Backup Service] Attempting restore from ${entry.slot} backup`, {
          bytes: entry.bytes,
        });
        const result = await this.restoreFromPath(entry.path, entry.slot);
        if (result.success) return result;
        if (result.error) failures.push(result.error);
        // Falling through to the next copy is only safe while nothing has
        // moved. Past the swap the install may be carrying an unresolved
        // journal and a displaced database, and the next attempt's `begin()`
        // would overwrite the only record of where that database went.
        if (!result.canTryAnother) {
          logger.main.error(
            '[Backup Service] Stopping the restore sweep: this attempt left recovery state that '
            + 'startup has to resolve first. Every copy is still on disk.',
            { slot: entry.slot },
          );
          break;
        }
      }
      return {
        success: false,
        error: failures.length > 0 ? failures.join('; ') : 'No valid backups available',
      };
    });
    if (!run.acquired) {
      return { success: false, error: describeOperationConflict(run.heldBy, run.heldSince) };
    }
    return run.value;
  }

  /**
   * Restore from a specific backup path.
   *
   * This used to close the database, `fs.rm` the live store, and only then
   * copy the backup over the hole — so a crash mid-copy left nothing, and a
   * structurally-valid but empty backup silently replaced a populated
   * database (#1347). It now runs the shared recovery transaction, which
   * stages and verifies the replacement before the live store moves anywhere,
   * swaps by rename, and keeps the displaced database.
   */
  private async restoreFromPath(
    backupPath: string,
    source: string
  ): Promise<{ success: boolean; error?: string; source?: string; canTryAnother: boolean }> {
    const adapter = createPgliteRecoveryAdapter({
      livePath: this.dbPath,
      engine: this.dbWorker,
      verify: this.verifyDatabaseAt,
    });

    // The lock is held by `restoreFromBackup` for the whole sweep; this method
    // is private and has no other caller, so it must not take it again.
    const outcome = await runRecoveryTransaction({
      candidateId: `rolling:${source}`,
      candidatePath: backupPath,
      adapter,
      // No eligibility gate: the user named this backup, and there is no
      // artifact assessment for a rolling backup. Every other guarantee --
      // verified staging, the empty-candidate refusal, the atomic swap, the
      // preserved displaced database, the journal -- still applies.
      context: {
        candidateSizeBucket: sizeBucketFor(await pathSizeBytes(backupPath)),
        liveSizeBucket: sizeBucketFor(await pathSizeBytes(this.dbPath)),
        reasonCode: null,
      },
      journal: createRecoveryJournalPort(this.userDataPath),
      operationId: `backup-restore-${source}-${Date.now()}`,
      log: (level, msg, meta) => logger.main[level](msg, meta),
      beforeStep: this.beforeRecoveryStep,
    });

    if (outcome.ok) {
      logger.main.info(`[Backup Service] Restored from ${source} backup`, {
        displacedLivePath: outcome.artifacts.displacedLivePath,
        preRestoreSnapshotPath: outcome.artifacts.preRestoreSnapshotPath,
      });
      return { success: true, source, canTryAnother: false };
    }
    return {
      success: false,
      error: `${source}: ${outcome.message}`,
      canTryAnother: mayTryAnotherCandidate(outcome),
    };
  }

  /**
   * Check if any backups are available
   */
  hasBackups(): boolean {
    const currentPath = path.join(this.backupDir, BACKUP_DIRNAMES.current);
    const previousPath = path.join(this.backupDir, BACKUP_DIRNAMES.previous);
    const oldestPath = path.join(this.backupDir, BACKUP_DIRNAMES.oldest);

    return fsSync.existsSync(currentPath) || fsSync.existsSync(previousPath) || fsSync.existsSync(oldestPath);
  }

  /**
   * Get backup status information
   */
  getBackupStatus(): BackupMetadata {
    return { ...this.metadata };
  }

  /**
   * Clean up stranded temp backup dirs in backupDir. The legacy method name
   * remains for startup and quit callers, but root-level corruption artifacts
   * are held indefinitely for explicit recovery assessment and resolution.
   */
  async cleanupOldCorruptedBackups(): Promise<void> {
    // Stranded temp-backup-* dirs in the backup folder — created by
    // createBackup() when verification or rotation throws mid-flight.
    // No age guard: by the time this runs they're unreferenced garbage.
    try {
      const entries = await fs.readdir(this.backupDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (classifyBackupEntry(this.backupDir, entry.name) !== 'temp-backup') continue;
        const fullPath = path.join(this.backupDir, entry.name);
        logger.main.info('[Backup Service] Removing stranded temp backup:', entry.name);
        await fs.rm(fullPath, { recursive: true, force: true });
      }
    } catch (error) {
      logger.main.warn('[Backup Service] Failed to clean stranded temp backups:', error);
    }
  }
}
