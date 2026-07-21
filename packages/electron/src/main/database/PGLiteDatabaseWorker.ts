/**
 * PGLite Database Service using Worker Thread
 * Main thread wrapper that communicates with PGLite running in a worker
 */

import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { app, dialog } from 'electron';
import path from 'path';
import { getPackageRoot } from '../utils/appPaths';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import type { SQLiteDatabase } from './sqlite/SQLiteDatabase';
import { DatabaseBackupService } from '../services/database/DatabaseBackupService';
import { deserializeWorkerError } from './workerErrorSerialization';

/**
 * Error that has already been shown to the user via a dialog.
 * Callers should skip redundant error UI when catching this.
 */
export class HandledError extends Error {}

/**
 * Normalize a caller-supplied timeout to a sane bound for queryReadOnly.
 * Floors at 1ms; defaults to 5000; ceiling is 30000 to prevent runaway
 * extension queries from holding the worker indefinitely.
 */
export function clampReadOnlyTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 5000;
  return Math.min(Math.floor(timeoutMs), 30000);
}

/**
 * Wrap a promise with a JS-level timeout. On timeout, rejects with a PG-shaped
 * "canceling statement due to statement timeout" message so the error surface
 * matches what callers will eventually see when this targets a backend that
 * actually enforces statement_timeout. The wrapped promise is not cancellable;
 * it continues running and its result is dropped.
 */
export function raceWithTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`canceling statement due to statement timeout (${timeoutMs}ms)`));
    }, timeoutMs);
  });
  return Promise.race([work, timeoutPromise]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }) as Promise<T>;
}

/**
 * Extended timeout for the worker `init` message. The init path runs
 * PGLite WAL recovery after an unclean shutdown plus schema migration
 * and, if corruption is detected, the auto-recovery flow. The default
 * 30s sendMessage timeout was tripping on the first relaunch after a
 * force-close on slower machines (see #238) even though the second
 * relaunch consistently succeeded - the recovery had simply not
 * finished within 30s. 120s covers the observed recovery window
 * while still surfacing a genuinely-deadlocked init within 2 minutes
 * rather than waiting forever.
 *
 * Exported so unit tests can pin the value if reasoning ever shifts.
 */
export const INIT_TIMEOUT_MS = 120_000;

export function resolveCheckedInPGLiteWorkerPath(): string {
  return path.join(getPackageRoot(), 'src', 'main', 'database', 'worker.js');
}

export interface PGLiteDatabaseWorkerOptions {
  /** Explicit source-byte seam for isolated schema regressions; production omits it. */
  workerPathOverride?: string;
  /** Owned, absolute test root; production must omit this. */
  userDataPathOverride?: string;
}

// Helper to categorize database errors
function categorizeDBError(error: any): string {
  const message = error?.message?.toLowerCase() || String(error).toLowerCase();
  if (message.includes('permission') || message.includes('eacces')) return 'permission';
  if (message.includes('disk') || message.includes('enospc')) return 'disk_full';
  if (message.includes('lock') || message.includes('busy')) return 'lock';
  if (message.includes('corrupt')) return 'corruption';
  if (message.includes('syntax')) return 'syntax';
  return 'unknown';
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

// ============================================================================
// Database Performance Stats
// ============================================================================

interface QuerySample {
  duration: number;
  execMs: number;    // actual PGLite execution time in worker
  blockedMs: number; // time waiting in queue (duration - execMs)
  timestamp: number;
}

interface TableStats {
  reads: QuerySample[];
  writes: QuerySample[];
}

interface SampleSummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  totalMs: number;
  blockedP50: number;
  blockedP95: number;
  blockedMax: number;
  blockedTotalMs: number;
}

/**
 * Collects per-table read/write timing samples in a rolling window.
 * Computes count, p50, p95, p99, and max on demand.
 */
class DatabaseStats {
  private tables = new Map<string, TableStats>();
  private windowMs: number;

  constructor(windowMs: number = 5 * 60 * 1000) { // default 5 min window
    this.windowMs = windowMs;
  }

  record(table: string, operation: 'read' | 'write', durationMs: number, execMs?: number): void {
    let stats = this.tables.get(table);
    if (!stats) {
      stats = { reads: [], writes: [] };
      this.tables.set(table, stats);
    }
    const actualExecMs = execMs ?? durationMs;
    const blockedMs = Math.max(0, durationMs - actualExecMs);
    const samples = operation === 'read' ? stats.reads : stats.writes;
    samples.push({ duration: durationMs, execMs: actualExecMs, blockedMs, timestamp: performance.now() });
  }

  private prune(samples: QuerySample[]): QuerySample[] {
    const cutoff = performance.now() - this.windowMs;
    // Remove old samples in-place
    let writeIdx = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].timestamp >= cutoff) {
        samples[writeIdx++] = samples[i];
      }
    }
    samples.length = writeIdx;
    return samples;
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  private summarizeSamples(samples: QuerySample[]): SampleSummary {
    this.prune(samples);
    if (samples.length === 0) {
      return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, totalMs: 0, blockedP50: 0, blockedP95: 0, blockedMax: 0, blockedTotalMs: 0 };
    }
    const durations = samples.map(s => s.duration).sort((a, b) => a - b);
    const blocked = samples.map(s => s.blockedMs).sort((a, b) => a - b);
    const totalMs = durations.reduce((sum, d) => sum + d, 0);
    const blockedTotalMs = blocked.reduce((sum, d) => sum + d, 0);
    return {
      count: durations.length,
      p50: Math.round(this.percentile(durations, 50)),
      p95: Math.round(this.percentile(durations, 95)),
      p99: Math.round(this.percentile(durations, 99)),
      max: Math.round(durations[durations.length - 1]),
      totalMs: Math.round(totalMs),
      blockedP50: Math.round(this.percentile(blocked, 50)),
      blockedP95: Math.round(this.percentile(blocked, 95)),
      blockedMax: Math.round(blocked[blocked.length - 1]),
      blockedTotalMs: Math.round(blockedTotalMs),
    };
  }

  getSnapshot(): Record<string, { reads: SampleSummary; writes: SampleSummary }> {
    const result: Record<string, any> = {};
    for (const [table, stats] of this.tables) {
      const reads = this.summarizeSamples(stats.reads);
      const writes = this.summarizeSamples(stats.writes);
      // Skip tables with no activity in the window
      if (reads.count === 0 && writes.count === 0) continue;
      result[table] = { reads, writes };
    }
    return result;
  }

  getSummaryLog(): string {
    const snapshot = this.getSnapshot();
    const tables = Object.keys(snapshot).sort();
    if (tables.length === 0) return '[PGLite Stats] No queries in window';

    let totalReads = 0;
    let totalWrites = 0;
    const lines = ['[PGLite Stats] Rolling 5min window:'];
    for (const table of tables) {
      const { reads, writes } = snapshot[table];
      totalReads += reads.count;
      totalWrites += writes.count;
      if (reads.count > 0) {
        let line = `  ${table} R: ${reads.count} queries, p50=${reads.p50}ms p95=${reads.p95}ms p99=${reads.p99}ms max=${reads.max}ms total=${reads.totalMs}ms`;
        if (reads.blockedTotalMs > 0) {
          line += ` | blocked: p50=${reads.blockedP50}ms p95=${reads.blockedP95}ms max=${reads.blockedMax}ms total=${reads.blockedTotalMs}ms`;
        }
        lines.push(line);
      }
      if (writes.count > 0) {
        let line = `  ${table} W: ${writes.count} queries, p50=${writes.p50}ms p95=${writes.p95}ms p99=${writes.p99}ms max=${writes.max}ms total=${writes.totalMs}ms`;
        if (writes.blockedTotalMs > 0) {
          line += ` | blocked: p50=${writes.blockedP50}ms p95=${writes.blockedP95}ms max=${writes.blockedMax}ms total=${writes.blockedTotalMs}ms`;
        }
        lines.push(line);
      }
    }
    lines.splice(1, 0, `  Total: ${totalReads} reads, ${totalWrites} writes`);
    return lines.join('\n');
  }
}

export class PGLiteDatabaseWorker {
  private worker: Worker | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private analytics = AnalyticsService.getInstance();
  private backupService: DatabaseBackupService | null = null;
  private stats = new DatabaseStats();
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private lastExecMs: number | undefined;

  constructor(private readonly options: PGLiteDatabaseWorkerOptions = {}) {}

  private resolveUserDataPath(): string {
    const liveRoot = path.resolve(app.getPath('userData'));
    const override = this.options.userDataPathOverride;
    if (override === undefined) {
      return process.env.NIMBALYST_USER_DATA_PATH
        || (process.env.PLAYWRIGHT === '1' ? path.join(app.getPath('temp'), 'nimbalyst-test-db') : null)
        || app.getPath('userData');
    }
    if (!override || !path.isAbsolute(override)) {
      throw new Error('pglite_worker_user_data_override_invalid');
    }
    const normalized = path.resolve(override);
    const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (comparable(normalized) === comparable(liveRoot)) {
      throw new Error('pglite_worker_user_data_override_live_root');
    }
    return normalized;
  }

  // ============================================================================
  // Helper methods for dialogs and common operations
  // ============================================================================

  /**
   * Show an error dialog and quit the application
   */
  private showErrorAndQuit(title: string, message: string, detail?: string): void {
    dialog.showMessageBox({
      type: 'error',
      title: `Nimbalyst - ${title}`,
      message,
      detail,
      buttons: ['Quit']
    }).then(() => app.quit()).catch((err) => {
      logger.main.error('[PGLite Worker] Dialog error:', err);
      app.quit();
    });
  }

  /**
   * Show an info dialog (non-blocking)
   */
  private showInfoDialog(title: string, message: string, detail?: string): void {
    dialog.showMessageBox({
      type: 'info',
      title: `Nimbalyst - ${title}`,
      message,
      detail,
      buttons: ['OK']
    }).catch(() => {});
  }

  /**
   * Show the "Start Fresh?" confirmation dialog
   * @returns true if user confirmed, false if cancelled
   */
  private async showStartFreshConfirmation(): Promise<boolean> {
    const response = await dialog.showMessageBox({
      type: 'warning',
      title: 'Nimbalyst - Start Fresh?',
      message: 'This will clear your AI chat sessions.',
      detail: 'Your files will not be affected, but all AI chat history will be permanently deleted.\n\nAre you sure you want to continue?',
      buttons: ['Cancel', 'Yes, Start Fresh'],
      defaultId: 0,
      cancelId: 0
    });
    return response.response === 1;
  }

  /**
   * Recreate the worker and re-initialize the database
   * @throws Error if re-initialization fails
   */
  private async recreateWorkerAndReinit(): Promise<void> {
    this.createWorker();
    // Use the same extended timeout as the cold-start path - recreate
    // is invoked from the backup-restore recovery flow, where the just-
    // restored DB also needs to replay WAL on first open. See #238.
    await this.sendMessage('init', undefined, INIT_TIMEOUT_MS);
  }

  /**
   * Delete the database directory for a fresh start
   */
  private async deleteDatabaseDirectory(): Promise<void> {
    const dataDir = path.join(this.resolveUserDataPath(), 'pglite-db');
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      logger.main.info('[PGLite Worker] Deleted database directory');
    }
  }

  /**
   * Format an error for display in a dialog
   */
  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // ============================================================================
  // Main initialization methods
  // ============================================================================

  /**
   * Initialize the database worker
   */
  async initialize(): Promise<void> {
    // Return existing initialization if in progress
    if (this.initPromise) {
      logger.main.info('[PGLite] initialize() called but initPromise already exists - returning existing promise');
      return this.initPromise;
    }

    // Already initialized
    if (this.initialized) {
      logger.main.info('[PGLite] initialize() called but already initialized - returning immediately');
      return;
    }

    logger.main.info('[PGLite] initialize() called - starting fresh initialization');
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  /**
   * Create and set up a new worker thread
   */
  private createWorker(): void {
    // Create worker thread - use the bundled worker
    let workerPath: string;
    if (this.options.workerPathOverride) {
      workerPath = this.options.workerPathOverride;
    } else if (app.isPackaged) {
      workerPath = path.join(process.resourcesPath, 'worker.bundle.js');
    } else {
      // The worker bundle is always built to the primary out/ directory under the package root.
      workerPath = path.join(getPackageRoot(), 'out', 'worker.bundle.js');
    }

    // Use test-specific userData path to avoid touching production database
    // NIMBALYST_USER_DATA_PATH: custom path (for manual testing of packaged builds)
    // PLAYWRIGHT=1: use temp directory (for automated tests)
    const userDataPath = this.resolveUserDataPath();

    logger.main.info('[PGLite] createWorker() called', {
      existingWorker: !!this.worker,
      workerPath,
      userDataPath
    });

    this.worker = new Worker(workerPath, {
      workerData: {
        userDataPath
      }
    });

    // Set up message handler
    this.worker.on('message', (response) => {
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.success) {
          // Store worker-reported execution time for stats
          if (response.execMs !== undefined) {
            this.lastExecMs = response.execMs;
          }
          pending.resolve(response.data);
        } else {
          pending.reject(deserializeWorkerError(response.errorData, response.error));
        }
      }
    });

    // Set up error handler
    this.worker.on('error', (error) => {
      logger.main.error('[PGLite Worker] Worker error:', error);
      // Reject all pending requests with the original error
      this.pendingRequests.forEach((pending) => {
        pending.reject(error);
      });
      this.pendingRequests.clear();
    });

    // Set up exit handler
    this.worker.on('exit', (code) => {
      if (code !== 0) {
        logger.main.error(`[PGLite Worker] Worker exited with code ${code}`);
        // Reject all pending requests
        this.pendingRequests.forEach((pending) => {
          pending.reject(new Error(`Worker exited with code ${code}`));
        });
        this.pendingRequests.clear();
        this.initialized = false;
        this.worker = null;
      }
    });
  }

  private async doInitialize(): Promise<void> {
    try {
      logger.main.info('[PGLite Worker] Starting database worker thread...');

      // Create the worker
      this.createWorker();

      // Initialize database in worker.
      //
      // The init path is heavier than other ops: it may run PGLite's WAL
      // recovery after an unclean shutdown, replay the schema migration
      // path, and (if corruption is detected) run the auto-recovery flow
      // below. With the default 30s sendMessage timeout, the FIRST relaunch
      // after a force-close was hitting "Request init timed out" while the
      // worker was still mid-recovery; a SECOND relaunch then succeeded
      // because recovery had already completed in the background. See #238
      // (shayliraz reported the exact two-relaunch pattern on Windows 11).
      //
      // 120s covers the recovery window we have signal for. If init is
      // genuinely deadlocked (worker bug) we still surface the failure
      // within 2 minutes rather than waiting forever; the user-facing
      // modal copy then matches reality. The constant lives at module
      // scope so it can be referenced from `recreateWorkerAndReinit` too.
      const initResult = await this.sendMessage('init', undefined, INIT_TIMEOUT_MS);

      // Check if database was recovered from corruption
      if (initResult.recovered) {
        logger.main.warn('[PGLite Worker] Database was corrupted and has been auto-recovered');
        logger.main.warn('[PGLite Worker] Checking for backups...');

        // Track corruption detection
        this.analytics.sendEvent('database_corruption_detected', {
          hasBackups: !!(this.backupService && this.backupService.hasBackups())
        });

        // Check if we have backups available
        if (this.backupService && this.backupService.hasBackups()) {
          logger.main.info('[PGLite Worker] Backups available - offering restore option');

          // Show dialog with restore option
          const response = await dialog.showMessageBox(this.getRecoveryDialogOptions());

          if (response.response === 0) {
            // User chose to restore from backup
            logger.main.info('[PGLite Worker] User chose to restore from backup');
            this.analytics.sendEvent('database_corruption_recovery_choice', {
              choice: 'restore_from_backup'
            });

            // Don't close yet - we need the worker for backup verification!
            // The restore process will handle closing and reopening

            // Attempt restore
            const restoreResult = await this.backupService.restoreFromBackup();

            if (restoreResult.success) {
              logger.main.info(`[PGLite Worker] Successfully restored from ${restoreResult.source} backup`);
              this.analytics.sendEvent('database_corruption_restore_result', {
                success: true,
                source: restoreResult.source
              });

              // Worker was closed during restore - recreate it
              logger.main.info('[PGLite Worker] Recreating worker thread after restore...');
              await this.recreateWorkerAndReinit();

              this.showInfoDialog('Database Restored', `Your database has been successfully restored from the ${restoreResult.source} backup.`);
            } else {
              logger.main.error('[PGLite Worker] Failed to restore from backup:', restoreResult.error);
              this.analytics.sendEvent('database_corruption_restore_result', {
                success: false,
                errorType: restoreResult.error?.includes('verification') ? 'verification_failed' : 'restore_failed'
              });

              this.showInfoDialog('Restore Failed', 'Failed to restore from backup. Starting with a fresh database.', restoreResult.error);
            }
          } else {
            // User clicked "Start Fresh" - show confirmation dialog
            logger.main.info('[PGLite Worker] User clicked Start Fresh - showing confirmation');

            const confirmed = await this.showStartFreshConfirmation();

            if (confirmed) {
              // User confirmed starting fresh
              logger.main.info('[PGLite Worker] User confirmed starting fresh');
              this.analytics.sendEvent('database_corruption_recovery_choice', {
                choice: 'start_fresh',
                confirmed: true
              });
            } else {
              // User cancelled - go back to restore option
              logger.main.info('[PGLite Worker] User cancelled start fresh - attempting restore');
              this.analytics.sendEvent('database_corruption_recovery_choice', {
                choice: 'start_fresh',
                confirmed: false
              });

              // Attempt restore as fallback
              const restoreResult = await this.backupService.restoreFromBackup();

              if (restoreResult.success) {
                logger.main.info(`[PGLite Worker] Successfully restored from ${restoreResult.source} backup`);
                this.analytics.sendEvent('database_corruption_restore_result', {
                  success: true,
                  source: restoreResult.source,
                  trigger: 'cancel_start_fresh'
                });

                // Worker was closed during restore - recreate it
                logger.main.info('[PGLite Worker] Recreating worker thread after restore...');
                await this.recreateWorkerAndReinit();

                this.showInfoDialog('Database Restored', `Your database has been successfully restored from the ${restoreResult.source} backup.`);
              } else {
                logger.main.error('[PGLite Worker] Failed to restore from backup:', restoreResult.error);
                this.analytics.sendEvent('database_corruption_restore_result', {
                  success: false,
                  errorType: restoreResult.error?.includes('verification') ? 'verification_failed' : 'restore_failed',
                  trigger: 'cancel_start_fresh'
                });

                this.showInfoDialog('Restore Failed', 'Failed to restore from backup. Starting with a fresh database.', restoreResult.error);
              }
            }
          }
        } else {
          // No backups available - just show the auto-recovery notification
          logger.main.warn('[PGLite Worker] No backups available - fresh database created');
          this.analytics.sendEvent('database_corruption_recovery_choice', {
            choice: 'auto_fresh',
            reason: 'no_backups_available'
          });

          dialog.showMessageBox({
            type: 'warning',
            title: 'Nimbalyst - Database Recovered',
            message: 'The application database was corrupted and has been automatically repaired.',
            detail: `A fresh database has been created. Your old data has been backed up to:\n\n${initResult.dataDir}.backup-[timestamp]\n\nYour document files have not been lost - they are still on disk. Only the internal application database (AI chat sessions and document history) needs to be rebuilt.`,
            buttons: ['OK']
          }).catch(() => {});
        }
      }

      if (initResult.initTimeMs) {
        logger.main.info(`[PGLite Worker] Database initialized in worker thread (${initResult.initTimeMs}ms)`);
      } else {
        logger.main.info('[PGLite Worker] Database initialized in worker thread');
      }

      // Create schemas
      logger.main.info('[PGLite Worker] Database schemas created');

      // Start periodic stats logging (every 60s, dev mode only)
      if (!app.isPackaged) {
        this.statsInterval = setInterval(() => {
          const summary = this.stats.getSummaryLog();
          if (!summary.includes('No queries in window')) {
            logger.main.info(summary);
          }
        }, 60_000);
      }

      this.initialized = true;
    } catch (error: any) {
      logger.main.error('[PGLite Worker] Failed to initialize:', error);
      this.initPromise = null;

      // Check for the AMBIGUOUS branch FIRST (its error message also contains
      // the string "DATABASE_LOCKED" so the simpler check below would match
      // it otherwise). The ambiguous branch fires when worker.js could not
      // signal the lock holder via `kill(0)` (EPERM) AND the lock timestamp
      // is fresh enough that we cannot rule out a real sibling instance.
      // Per @ghinkle's review on the closed PR #316: ask the user instead of
      // guessing. See #272 for the original Windows-pid-reuse hazard.
      if (error?.code === 'DATABASE_LOCKED_AMBIGUOUS') {
        if (process.env.PLAYWRIGHT === '1') {
          // Tests should never hit this; if they do, surface the ambiguity
          // rather than silently force-unlocking which could mask a real
          // dual-instance race in test setup.
          console.error('FATAL: Ambiguous database-lock state in Playwright. Refusing to force-unlock.');
          process.exit(1);
        }
        const lockPid = (error as any).lockPid;
        const lockTimestamp = (error as any).lockTimestamp;
        const lockHostname = (error as any).lockHostname;
        const lockFilePath = (error as any).lockFilePath as string | undefined;
        const response = await dialog.showMessageBox({
          type: 'question',
          title: 'Nimbalyst - Database Locked (Ambiguous)',
          message: 'Cannot tell whether another Nimbalyst is already running.',
          detail:
            `Nimbalyst found a database lock from a few seconds ago and cannot confirm whether ` +
            `the process holding it (PID ${lockPid}, host ${lockHostname}, acquired ${lockTimestamp}) ` +
            `is still alive. Two scenarios are equally likely:\n\n` +
            `  1. Another Nimbalyst window is open under a different user account or privilege level. ` +
            `Opening anyway will run two instances against the same database and may corrupt data.\n\n` +
            `  2. A previous Nimbalyst crashed less than a minute ago and the OS has already reused ` +
            `the original PID for a system process. In this case the lock is safe to clear.\n\n` +
            `If unsure, choose Cancel and look for another Nimbalyst window before retrying.`,
          buttons: ['Cancel', 'Open Anyway (clear lock)'],
          defaultId: 0,
          cancelId: 0,
        }).catch(() => ({ response: 0 } as Electron.MessageBoxReturnValue));

        if (response.response === 1 && lockFilePath) {
          this.analytics.sendEvent('database_lock_ambiguous_force_unlock', { lockPid });
          try {
            fs.unlinkSync(lockFilePath);
            logger.main.info(`[PGLite Worker] User chose to force-unlock; removed ${lockFilePath}. Retrying init.`);
            // Recreate worker + retry init. INIT_TIMEOUT_MS covers the
            // post-force-unlock recovery path (#238 lesson).
            await this.recreateWorkerAndReinit();
            this.initialized = true;
            return;
          } catch (unlockErr) {
            logger.main.error('[PGLite Worker] Force-unlock failed:', unlockErr);
            this.showErrorAndQuit(
              'Database Locked',
              'Could not clear the database lock.',
              `Removing the lock file failed: ${this.formatError(unlockErr)}\n\n` +
              `If another Nimbalyst window is open, close it manually before retrying.`
            );
            throw new HandledError('DATABASE_LOCKED_AMBIGUOUS_UNLOCK_FAILED');
          }
        }

        // User cancelled - quit cleanly without removing the lock.
        this.analytics.sendEvent('database_lock_ambiguous_cancel', { lockPid });
        this.showErrorAndQuit(
          'Database Locked',
          'Nimbalyst cannot start while the database lock state is uncertain.',
          'Close any other Nimbalyst windows you have open and try again. If you are sure no other Nimbalyst is running, restart this machine to clear any stale system locks.'
        );
        throw new HandledError('DATABASE_LOCKED_AMBIGUOUS');
      }

      // Check for database locked error (another instance running)
      if (error?.message?.includes('DATABASE_LOCKED') || error?.message?.includes('locked by another process')) {
        if (process.env.PLAYWRIGHT === '1') {
          // In Playwright tests, skip the dialog and exit immediately with a clear error
          // so the test runner knows it can't run multiple instances in parallel
          console.error('FATAL: Another instance of Nimbalyst is already running. Cannot run multiple instances in parallel.');
          process.exit(1);
        }
        this.showErrorAndQuit(
          'Database Locked',
          'Another instance of Nimbalyst is already running.',
          'The database is locked by another process. Please close the other instance before starting a new one.\n\nRunning multiple instances simultaneously can cause data corruption.'
        );
        // Throw to prevent downstream code from continuing while quit dialog is pending.
        // HandledError signals to index.ts that a user-facing dialog was already shown.
        throw new HandledError('DATABASE_LOCKED');
      }

      // Check for DATABASE_INIT_FAILED - offer restore if backups exist
      if (error?.message?.includes('DATABASE_INIT_FAILED') || error?.message?.includes('Aborted')) {
        const hasBackups = this.backupService && this.backupService.hasBackups();

        if (hasBackups) {
          logger.main.info('[PGLite Worker] Init failed but backups available - offering restore');
          this.analytics.sendEvent('database_init_failed_with_backups', {
            hasBackups: true
          });

          // Use shared recovery dialog with Quit option (since app can't continue without recovery)
          const response = await dialog.showMessageBox(this.getRecoveryDialogOptions(true));

          if (response.response === 0) {
            // Restore from backup
            logger.main.info('[PGLite Worker] User chose to restore from backup after init failure');
            this.analytics.sendEvent('database_init_failed_recovery_choice', {
              choice: 'restore_from_backup'
            });

            // backupService is guaranteed non-null here (checked via hasBackups above)
            const restoreResult = await this.backupService!.restoreFromBackup();

            if (restoreResult.success) {
              logger.main.info(`[PGLite Worker] Successfully restored from ${restoreResult.source} backup`);

              // Recreate worker and try again
              try {
                await this.recreateWorkerAndReinit();
              } catch (reinitError) {
                logger.main.error('[PGLite Worker] Re-initialization after restore failed:', reinitError);
                this.showErrorAndQuit('Initialization Failed', 'Database was restored but failed to initialize.', this.formatError(reinitError));
                return;
              }

              this.showInfoDialog('Database Restored', `Your database has been restored from the ${restoreResult.source} backup.`);
              this.initialized = true;
              return;
            } else {
              logger.main.error('[PGLite Worker] Restore failed:', restoreResult.error);
              this.showErrorAndQuit('Restore Failed', 'Failed to restore from backup.', restoreResult.error || 'Unknown error');
              return;
            }
          } else if (response.response === 1) {
            // Start fresh - show confirmation dialog first
            logger.main.info('[PGLite Worker] User clicked Start Fresh - showing confirmation');

            const confirmed = await this.showStartFreshConfirmation();

            if (!confirmed) {
              // User cancelled - quit since we can't continue without recovery
              logger.main.info('[PGLite Worker] User cancelled start fresh');
              this.analytics.sendEvent('database_init_failed_recovery_choice', {
                choice: 'start_fresh',
                confirmed: false
              });
              app.quit();
              return;
            }

            logger.main.info('[PGLite Worker] User confirmed start fresh after init failure');
            this.analytics.sendEvent('database_init_failed_recovery_choice', {
              choice: 'start_fresh',
              confirmed: true
            });

            try {
              await this.deleteDatabaseDirectory();

              // Recreate worker and try again
              try {
                await this.recreateWorkerAndReinit();
              } catch (reinitError) {
                logger.main.error('[PGLite Worker] Re-initialization after delete failed:', reinitError);
                this.showErrorAndQuit('Initialization Failed', 'Failed to initialize fresh database.', this.formatError(reinitError));
                return;
              }

              this.showInfoDialog('Database Reset', 'A fresh database has been created.', 'Your previous AI chat sessions could not be recovered, but your document files are safe.');

              this.initialized = true;
              return;
            } catch (deleteError) {
              logger.main.error('[PGLite Worker] Failed to delete database directory:', deleteError);
              this.showErrorAndQuit('Delete Failed', 'Failed to delete corrupted database.', this.formatError(deleteError));
              return;
            }
          } else {
            // User chose Quit
            app.quit();
            return;
          }
        }
      }

      // The worker should have already provided a detailed error message
      // Just re-throw it
      throw error;
    }
  }

  /**
   * Send a message to the worker and wait for response
   * @param timeoutMs - Timeout in milliseconds (default: 30000)
   */
  private sendMessage(type: string, payload?: any, timeoutMs: number = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const id = uuidv4();
      this.pendingRequests.set(id, { resolve, reject });

      this.worker.postMessage({
        id,
        type,
        payload
      });

      // Timeout (default 30 seconds, can be extended for long operations)
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${type} timed out`));
        }
      }, timeoutMs);
    });
  }

  // Threshold for logging slow queries (milliseconds)
  private static SLOW_QUERY_THRESHOLD_MS = 2000;

  /**
   * Execute a query
   */
  async query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
    if (!this.initialized) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    const startTime = performance.now();
    const tableName = this.extractTableName(sql);
    const operation = this.classifySqlOperation(sql);
    try {
      const result = await this.sendMessage('query', { sql, params });
      const duration = performance.now() - startTime;
      const execMs = this.lastExecMs;
      this.lastExecMs = undefined;

      // Record stats with worker execution time for blocked calculation
      this.stats.record(tableName, operation, duration, execMs);

      // Log slow queries
      if (duration >= PGLiteDatabaseWorker.SLOW_QUERY_THRESHOLD_MS) {
        const rowCount = result?.rows?.length ?? 0;
        const blockedMs = execMs !== undefined ? Math.round(duration - execMs) : undefined;
        // Truncate SQL for logging (first 200 chars)
        const truncatedSql = sql.length > 200 ? sql.substring(0, 400) + '...' : sql;
        logger.main.warn(`[PGLite] Slow query (${duration.toFixed(0)}ms, exec=${execMs?.toFixed(0) ?? '?'}ms, blocked=${blockedMs ?? '?'}ms): table=${tableName}, rows=${rowCount}, sql="${truncatedSql}"`);
      }

      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      const execMs = this.lastExecMs;
      this.lastExecMs = undefined;
      // Record stats even for failures
      this.stats.record(tableName, operation, duration, execMs);
      // Track database error
      this.analytics.sendEvent('database_error', {
        operation,
        errorType: categorizeDBError(error),
        tableName
      });
      // Also log slow failed queries
      if (duration >= PGLiteDatabaseWorker.SLOW_QUERY_THRESHOLD_MS) {
        logger.main.warn(`[PGLite] Slow query failed (${duration.toFixed(0)}ms): table=${tableName}`);
      }
      throw error;
    }
  }

  /**
   * Run a read-only query inside a `READ ONLY` transaction with a bounded
   * statement_timeout. PG planner rejects DML/DDL inside a read-only txn;
   * `statement_timeout` is applied via `SET LOCAL` so it reverts at COMMIT
   * and never pollutes subsequent queries on the same PGLite session.
   *
   * Note on timeouts: `statement_timeout` is a no-op in PGLite today (single-
   * thread WASM, no signal-based cancel) -- the SET is still issued so that
   * when this code path eventually targets native SQLite/Postgres the limit
   * works, but for now the caller-visible bound is enforced by a JS-level
   * Promise.race in this wrapper. The actual query keeps running on the
   * worker until PGLite finishes it; the worker is briefly hogged but other
   * callers' messages queue normally.
   *
   * Used by the extension `host.data.query` IPC to expose raw SELECT access
   * to built-in extensions without giving them write capability.
   *
   * @param sql - User-supplied SQL (single statement or CTE)
   * @param params - Parameterized values
   * @param timeoutMs - Per-query timeout in ms (default 5000, capped at 30000 in worker)
   */
  async queryReadOnly<T = any>(
    sql: string,
    params?: any[],
    timeoutMs: number = 5000
  ): Promise<{ rows: T[] }> {
    if (!this.initialized) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    const startTime = performance.now();
    const tableName = this.extractTableName(sql);
    const effectiveTimeout = clampReadOnlyTimeout(timeoutMs);

    try {
      const result = await raceWithTimeout(
        this.sendMessage('queryReadOnly', { sql, params, timeoutMs: effectiveTimeout }),
        effectiveTimeout
      ) as { rows: T[] };
      const duration = performance.now() - startTime;
      const execMs = this.lastExecMs;
      this.lastExecMs = undefined;
      this.stats.record(tableName, 'read', duration, execMs);
      if (duration >= PGLiteDatabaseWorker.SLOW_QUERY_THRESHOLD_MS) {
        const truncatedSql = sql.length > 200 ? sql.substring(0, 400) + '...' : sql;
        logger.main.warn(`[PGLite] Slow extension queryReadOnly (${duration.toFixed(0)}ms): table=${tableName}, sql="${truncatedSql}"`);
      }
      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      const execMs = this.lastExecMs;
      this.lastExecMs = undefined;
      this.stats.record(tableName, 'read', duration, execMs);
      throw error;
    }
  }

  /**
   * Execute a statement (no return value)
   * @param timeoutMs - Timeout in milliseconds (default: 30000, use longer for index creation)
   */
  async exec(sql: string, timeoutMs: number = 30000): Promise<void> {
    if (!this.initialized) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    const startTime = performance.now();
    const tableName = this.extractTableName(sql);
    try {
      await this.sendMessage('exec', { sql }, timeoutMs);
      const duration = performance.now() - startTime;
      const execMs = this.lastExecMs;
      this.lastExecMs = undefined;

      // Record stats with worker execution time for blocked calculation
      this.stats.record(tableName, 'write', duration, execMs);

      // Log slow exec operations
      if (duration >= PGLiteDatabaseWorker.SLOW_QUERY_THRESHOLD_MS) {
        const blockedMs = execMs !== undefined ? Math.round(duration - execMs) : undefined;
        const truncatedSql = sql.length > 200 ? sql.substring(0, 200) + '...' : sql;
        logger.main.warn(`[PGLite] Slow exec (${duration.toFixed(0)}ms, exec=${execMs?.toFixed(0) ?? '?'}ms, blocked=${blockedMs ?? '?'}ms): table=${tableName}, sql="${truncatedSql}"`);
      }
    } catch (error) {
      const duration = performance.now() - startTime;
      const execMs = this.lastExecMs;
      this.lastExecMs = undefined;
      // Record stats even for failures
      this.stats.record(tableName, 'write', duration, execMs);
      // Track database error
      this.analytics.sendEvent('database_error', {
        operation: 'write',
        errorType: categorizeDBError(error),
        tableName
      });
      // Also log slow failed exec operations
      if (duration >= PGLiteDatabaseWorker.SLOW_QUERY_THRESHOLD_MS) {
        logger.main.warn(`[PGLite] Slow exec failed (${duration.toFixed(0)}ms): table=${tableName}`);
      }
      throw error;
    }
  }

  runTransaction<T = any>(
    statements: Array<{ sql: string; params?: any[]; expectedRowCount?: 1 }>,
  ): Promise<Array<{ rows: T[] }>>;
  runTransaction(
    statements: Array<{ sql: string; params?: any[] }>,
  ): Promise<void>;
  async runTransaction<T = any>(
    statements: Array<{ sql: string; params?: any[]; expectedRowCount?: 1 }>,
  ): Promise<Array<{ rows: T[] }> | void> {
    if (!this.initialized) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return await this.sendMessage('transaction', { statements });
  }

  /**
   * Extract table name from SQL query (simple heuristic)
   */
  private extractTableName(sql: string): string {
    // Normalize whitespace for easier matching
    const normalized = sql.replace(/\s+/g, ' ').trim();
    // Try specific DML patterns in priority order
    const patterns = [
      /^SELECT\b.+?\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i,    // SELECT ... FROM table
      /^INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/i,          // INSERT INTO table
      /^UPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*)/i,                  // UPDATE table
      /^DELETE\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i,           // DELETE FROM table
      /^CREATE\s+(?:TABLE|INDEX)\b.*?\bON\s+([a-zA-Z_][a-zA-Z0-9_]*)/i, // CREATE INDEX ... ON table
      /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/i, // CREATE TABLE table
      /^ALTER\s+TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)/i,           // ALTER TABLE table
      /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/i, // DROP TABLE table
    ];
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) return match[1];
    }
    return 'unknown';
  }

  /**
   * Classify SQL as a read or write for stats reporting.
   * Parameterized DML goes through query(), so infer from the leading verb.
   */
  private classifySqlOperation(sql: string): 'read' | 'write' {
    const normalized = sql.replace(/^\s+/, '');
    if (/^(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|BEGIN|COMMIT|ROLLBACK)\b/i.test(normalized)) {
      return 'write';
    }
    return 'read';
  }

  /**
   * Begin a transaction
   * Note: Transactions in worker threads are more complex - simplified for now
   */
  /**
   * Statement-array transaction parity with StoreDbAdapter. Keep the legacy
   * callback overload below unchanged; it is not the atomic worker batch.
   */
  async transaction<T = any>(
    statements: Array<{ sql: string; params?: any[]; expectedRowCount?: 1 }>,
  ): Promise<Array<{ rows: T[] }>>;
  async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
  async transaction<T>(
    arg: Array<{ sql: string; params?: any[]; expectedRowCount?: 1 }> | ((tx: any) => Promise<T>),
  ): Promise<T | Array<{ rows: T[] }>> {
    if (Array.isArray(arg)) return this.runTransaction<T>(arg);
    // For now, just execute the function
    // Real transaction support would need message batching
    return await arg({
      query: (sql: string, params?: any[]) => this.query(sql, params),
      exec: (sql: string) => this.exec(sql)
    });
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    // Log final stats on shutdown (dev mode only)
    if (!app.isPackaged) {
      const summary = this.stats.getSummaryLog();
      if (!summary.includes('No queries in window')) {
        logger.main.info(`[PGLite] Final stats before shutdown:\n${summary}`);
      }
    }
    if (this.worker) {
      await this.sendMessage('close');
      await this.worker.terminate();
      this.worker = null;
      this.initialized = false;
      this.initPromise = null;
      logger.main.info('[PGLite Worker] Database worker terminated');
    }
  }

  /**
   * Check if database is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get database stats
   */
  async getStats(): Promise<any> {
    if (!this.initialized) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    const dbStats = await this.sendMessage('getStats');
    return {
      ...dbStats,
      queryStats: this.stats.getSnapshot(),
    };
  }

  /**
   * Get the database instance (compatibility method)
   * Note: With worker threads, we can't return the actual DB instance
   */
  getDB(): any {
    if (!this.initialized) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    // Return a proxy object that forwards calls
    return {
      query: (sql: string, params?: any[]) => this.query(sql, params),
      exec: (sql: string) => this.exec(sql)
    };
  }

  /**
   * Verify a backup database
   * Returns validity status plus data integrity info (session/history counts)
   */
  async verifyBackup(backupPath: string): Promise<{
    valid: boolean;
    error?: string;
    hasData?: boolean;
    sessionCount?: number;
    historyCount?: number;
  }> {
    return await this.sendMessage('verifyBackup', { backupPath });
  }

  /**
   * Set the backup service instance
   */
  setBackupService(backupService: DatabaseBackupService): void {
    this.backupService = backupService;
  }

  /**
   * Create a database backup
   */
  async createBackup(): Promise<{ success: boolean; error?: string }> {
    if (!this.backupService) {
      return { success: false, error: 'Backup service not initialized' };
    }
    return await this.backupService.createBackup();
  }

  /**
   * Get the backup service instance
   */
  getBackupService(): DatabaseBackupService | null {
    return this.backupService;
  }

  /**
   * Get the recovery dialog options (shared between corruption recovery, init failure, and dev menu preview)
   * @param includeQuit - If true, adds a "Quit" button for cases where the app cannot continue without recovery
   */
  private getRecoveryDialogOptions(includeQuit: boolean = false): Electron.MessageBoxOptions {
    const backupStatus = this.backupService?.getBackupStatus();
    const backupTimestamp = backupStatus?.currentBackup?.timestamp
      || backupStatus?.previousBackup?.timestamp
      || backupStatus?.oldestBackup?.timestamp;

    let backupDateStr = '';
    if (backupTimestamp) {
      // Convert timestamp format from "2026-01-12T19-10-17-765Z" to valid ISO
      const isoTimestamp = backupTimestamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
      const backupDate = new Date(isoTimestamp);
      backupDateStr = backupDate.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    }

    const buttons = includeQuit
      ? ['Restore (Recommended)', 'Start Fresh', 'Quit']
      : ['Restore (Recommended)', 'Start Fresh'];

    return {
      type: 'info',
      title: 'Nimbalyst - Restore Your Data',
      message: 'No file data has been lost.',
      detail: backupDateStr
        ? `Your files are safe, but your chat history will need to be restored from a backup dated ${backupDateStr}.`
        : `Your files are safe and your AI chat sessions can be restored from a recent backup.`,
      buttons,
      defaultId: 0,
      cancelId: includeQuit ? 2 : 1
    };
  }

  /**
   * Show the database recovery dialog (for testing via developer menu)
   * This shows the exact same dialog that would appear during actual recovery
   */
  async showRecoveryDialog(): Promise<void> {
    if (!this.backupService || !this.backupService.hasBackups()) {
      this.showInfoDialog('No Backups Available', 'No backups are available to test the recovery dialog.');
      return;
    }

    dialog.showMessageBox(this.getRecoveryDialogOptions());
  }
}

export type DatabaseEngine = 'pglite' | 'sqlite';

export interface AppDatabaseBackupService {
  createBackup(): Promise<{ success: boolean; error?: string }>;
  getBackupStatus?(): unknown;
  cleanupOldCorruptedBackups?(): Promise<void>;
}

export interface AppDatabase {
  initialize(): Promise<void>;
  isInitialized(): boolean;
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  queryReadOnly<T = any>(sql: string, params?: any[], timeoutMs?: number): Promise<{ rows: T[] }>;
  exec(sql: string, timeoutMs?: number): Promise<void>;
  runTransaction<T = any>(statements: Array<{ sql: string; params?: any[]; expectedRowCount?: 1 }>): Promise<Array<{ rows: T[] }>>;
  runTransaction(statements: Array<{ sql: string; params?: any[] }>): Promise<void>;
  close(): Promise<void>;
  getStats(): Promise<any>;
  getDB(): any;
  verifyBackup(backupPath: string): Promise<{
    valid: boolean;
    error?: string;
    hasData?: boolean;
    sessionCount?: number;
    historyCount?: number;
  }>;
  setBackupService(backupService: AppDatabaseBackupService): void;
  createBackup(): Promise<{ success: boolean; error?: string }>;
  getBackupService(): AppDatabaseBackupService | null;
  showRecoveryDialog?(): Promise<void>;
}

class ActiveDatabaseFacade implements AppDatabase {
  private active: AppDatabase;
  private engine: DatabaseEngine;

  constructor(initial: AppDatabase, engine: DatabaseEngine) {
    this.active = initial;
    this.engine = engine;
  }

  useDatabase(databaseImpl: AppDatabase, engine: DatabaseEngine): void {
    this.active = databaseImpl;
    this.engine = engine;
  }

  getEngine(): DatabaseEngine {
    return this.engine;
  }

  getActiveDatabase(): AppDatabase {
    return this.active;
  }

  /**
   * Returns the active SQLite backend when SQLite is the live engine.
   *
   * In production this is now a `SQLiteDatabaseProxy` (worker-hosted) rather
   * than an in-process `SQLiteDatabase`. The two share the same public shape
   * for `query/exec/queryReadOnly/getStats/...`, but proxy-only methods
   * (`pragmaRead`, `dashboardTableStats`, `getSlowQueries`, `getPerformance`,
   * `walCheckpoint`) only exist on the proxy. Callers that need those should
   * accept the proxy type directly. The return type is loosely typed as the
   * SQLiteDatabase interface so existing call sites keep compiling; the
   * dashboard / performance handlers cast to the proxy.
   */
  getActiveSQLiteDatabase(): SQLiteDatabase | null {
    return this.engine === 'sqlite' ? (this.active as unknown as SQLiteDatabase) : null;
  }

  initialize(): Promise<void> {
    return this.active.initialize();
  }

  isInitialized(): boolean {
    return this.active.isInitialized();
  }

  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
    return this.active.query<T>(sql, params);
  }

  queryReadOnly<T = any>(sql: string, params?: any[], timeoutMs?: number): Promise<{ rows: T[] }> {
    return this.active.queryReadOnly<T>(sql, params, timeoutMs);
  }

  exec(sql: string, timeoutMs?: number): Promise<void> {
    return this.active.exec(sql, timeoutMs);
  }

  runTransaction<T = any>(
    statements: Array<{ sql: string; params?: any[]; expectedRowCount?: 1 }>,
  ): Promise<Array<{ rows: T[] }>>;
  runTransaction(
    statements: Array<{ sql: string; params?: any[] }>,
  ): Promise<void>;
  runTransaction<T = any>(
    statements: Array<{ sql: string; params?: any[]; expectedRowCount?: 1 }>,
  ): Promise<Array<{ rows: T[] }> | void> {
    return this.active.runTransaction(statements);
  }

  close(): Promise<void> {
    return this.active.close();
  }

  getStats(): Promise<any> {
    return this.active.getStats();
  }

  getDB(): any {
    return this.active.getDB();
  }

  verifyBackup(backupPath: string): Promise<{
    valid: boolean;
    error?: string;
    hasData?: boolean;
    sessionCount?: number;
    historyCount?: number;
  }> {
    return this.active.verifyBackup(backupPath);
  }

  setBackupService(backupService: AppDatabaseBackupService): void {
    this.active.setBackupService(backupService);
  }

  createBackup(): Promise<{ success: boolean; error?: string }> {
    return this.active.createBackup();
  }

  getBackupService(): AppDatabaseBackupService | null {
    return this.active.getBackupService();
  }

  async showRecoveryDialog(): Promise<void> {
    if (typeof this.active.showRecoveryDialog === 'function') {
      await this.active.showRecoveryDialog();
    }
  }
}

// Legacy worker remains available for migration / rollback flows even when the
// active app backend has been switched to SQLite.
export const legacyPgliteDatabase = new PGLiteDatabaseWorker();

// Export singleton facade instance under the historical import path so the
// rest of the main process can route through the selected backend without a
// large import rewrite.
export const database = new ActiveDatabaseFacade(legacyPgliteDatabase, 'pglite');
