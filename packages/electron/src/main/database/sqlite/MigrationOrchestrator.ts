/**
 * MigrationOrchestrator
 *
 * Drives the full PGLite → SQLite migration end-to-end:
 *
 *   1. Pre-flight (disk space + last-backup freshness)
 *   2. Snapshot the PGLite store (current backup ring)
 *   3. Open a fresh SQLite under sqlite-db/
 *   4. Run PGLiteToSQLiteMigrator against the live worker for the bulk copy
 *   5. Hand the last five steps to `cutoverMachine.runCutover`, which is the
 *      single journaled cutover shared with `MigrationAdopter`: verify the
 *      target, quiesce PGLite, catch up and close, rename pglite-db/ →
 *      pglite-db.migrated-{ts}/, commit the backend flag. The PGLite directory
 *      is never deleted.
 *
 * Failure rules:
 *   - Any error before the source is preserved -> delete the partial sqlite-db/
 *     directory and leave PGLite untouched. The flag file is not written. The
 *     app reopens on PGLite next launch.
 *   - Once the source has been preserved the partial target is NOT removed --
 *     it is the store the journal points at, and startup reconciliation
 *     finishes or rolls the cutover back from there.
 *   - Nothing is suppressed. This file used to log a warning and commit the
 *     backend flag anyway when the pglite-db rename failed, which is how a live
 *     PGLite store could end up orphaned behind a flag naming SQLite.
 *
 * This module owns FILESYSTEM and SETTINGS side effects. The data-plane copy
 * lives in `PGLiteToSQLiteMigrator`; the IPC channel lives in
 * `MigrationProgressReporter`; this orchestrates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SQLiteDatabase } from './SQLiteDatabase';
import {
  PGLiteToSQLiteMigrator,
  type MigrationProgress,
  type MigrationSummary,
  type PGLiteHandle,
} from './PGLiteToSQLiteMigrator';
import { MigrationProgressReporter } from './MigrationProgressReporter';
import { asCutoverAbort, runCutover } from './cutoverMachine';
import type { CutoverFs } from './cutoverJournal';
import { classifyDatabaseError } from '../DatabaseErrorTelemetry';
import { dirSizeBytes } from './dirSize';
import { findRestorableBackups } from './recoveryArtifacts';
import {
  assessMigrationSource,
  buildMigrationRefusal,
  gatherMigrationSourceFacts,
  humanBytes,
  type MigrationSourceFacts,
} from './migrationSourcePlausibility';
import {
  buildMigrationOutcome,
  countBucket,
  sizeBucket,
  MigrationRefusedError,
  type MigrationOperationContext,
  type MigrationOutcome,
  type MigrationOutcomeBody,
  type MigrationRefusal,
} from './migrationOutcome';

/**
 * Read surface satisfied by the live PGLiteDatabaseWorker. Mirrors the adapter
 * used by MigrationDryRunner and MigrationAdopter: the orchestrator reads
 * from the live worker rather than closing it and opening an in-process
 * PGLite handle, because `new PGlite()` in-process triggers PGlite's WASM
 * env to re-`require()` the main bundle, which re-evaluates the bundled
 * `electron-log` module and crashes with "Attempted to register a second
 * handler for '__ELECTRON_LOG__'".
 */
export interface LivePgliteReader {
  queryReadOnly<T = unknown>(
    sql: string,
    params?: unknown[],
    timeoutMs?: number,
  ): Promise<{ rows: T[] }>;
}

export interface OrchestratorOptions {
  /** User data path (`app.getPath('userData')` in production). */
  userDataPath: string;
  /** Absolute path to the SQLite schema directory. */
  schemaDir: string;
  /**
   * Live PGLite worker. We read the migration source via its `queryReadOnly`
   * surface (single-statement, bounded timeout) rather than opening a second
   * in-process PGLite handle — see `LivePgliteReader` above for the
   * `__ELECTRON_LOG__` re-registration trap that motivates this.
   */
  pglite: LivePgliteReader;
  /**
   * Close the live PGLite worker. Called only after the migrator has finished
   * reading and the SQLite copy is verified; the rename can't happen while
   * the worker holds the directory.
   */
  closeRunningPglite: () => Promise<void>;
  /**
   * Report the terminal domain result for this operation. The orchestrator
   * runs inside the SQLite worker, which has no business naming analytics
   * events — it returns a typed result and `migrationEventMapper.ts` on main
   * decides what, if anything, is emitted. See `migrationOutcome.ts`.
   */
  onOutcome?: (outcome: MigrationOutcome) => void;
  /**
   * Identity and provenance of this run, echoed into the domain result so the
   * mapper can dedupe and attribute it. Defaults to a one-off manual run.
   */
  operation?: MigrationOperationContext;
  /**
   * Called after a successful cutover. Production wiring opens the new
   * SQLiteDatabase under the repository manager. Tests can supply a no-op.
   * The instance passed in is already closed by the time we call this.
   */
  onCutoverSuccess?: (info: {
    sqliteDir: string;
    pgliteMigratedDir: string;
    summary: MigrationSummary;
  }) => Promise<void> | void;
  /** Hook for the renderer-bound progress emitter. */
  reporter?: MigrationProgressReporter;
  /** Override for tests; defaults to PGLiteToSQLiteMigrator. */
  migrator?: PGLiteToSQLiteMigrator;
  /**
   * After the live PGLite worker is quiesced, reopen the on-disk database so
   * we can do one final catch-up pass and make the cutover snapshot exact.
   */
  reopenPgliteAfterClose?: (dataDir: string) => Promise<PGLiteHandle>;
  /** Logger. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
  /** For tests: skip the safety check that requires `pglite-db/` to exist. */
  allowEmptyPglite?: boolean;
  /**
   * Projects configured in app settings. Used as evidence from outside the
   * source database that this install has actually been used, so a store with
   * no sessions in it can be recognised as the wrong store (NIM-3632).
   * Defaults to 0, which is the permissive value.
   */
  configuredProjectCount?: number;
  /**
   * Fault-injection seam for the cutover's filesystem operations. Production
   * leaves it unset. Tests use it to make one specific rename fail with the
   * `EPERM`/`EBUSY` Windows produces when a directory handle is still open --
   * the case we cannot reproduce on the machines we develop on, and the one
   * the old suppressed-rename branch was written for.
   */
  cutoverFs?: CutoverFs;
  /** Identifies the cutover in the journal. Defaults to the operation id. */
  operationId?: string;
}

export interface PreflightResult {
  ok: boolean;
  /** Reason text for the UI when ok=false. */
  reason?: string;
  /**
   * Present whenever the failure is a *verdict about the install* rather than
   * a transient environment hiccup. Carries the reason code, the bucketed
   * facts, and the fingerprint that decides whether an existing durable block
   * still stands.
   */
  refusal?: MigrationRefusal;
  pgliteDirBytes: number;
  freeBytes: number;
  requiredBytes: number;
}

const SAFETY_MULTIPLIER = 2;

export class MigrationOrchestrator {
  constructor(private opts: OrchestratorOptions) {}

  /**
   * Run pre-flight checks without doing anything destructive.
   * The migration UI calls this before showing the "Start migration" button.
   */
  async preflight(): Promise<PreflightResult> {
    const pgliteDir = path.join(this.opts.userDataPath, 'pglite-db');
    if (!fs.existsSync(pgliteDir) && !this.opts.allowEmptyPglite) {
      const reason = 'No PGLite directory found — nothing to migrate.';
      return {
        ok: false,
        reason,
        refusal: buildMigrationRefusal(
          'source_missing',
          {
            liveBytes: 'none',
            largestBackupBytes: 'none',
            configuredProjects: countBucket(this.opts.configuredProjectCount ?? 0),
            sourceSessions: 'unknown',
          },
          reason,
        ),
        pgliteDirBytes: 0,
        freeBytes: 0,
        requiredBytes: 0,
      };
    }
    const pgliteDirBytes = fs.existsSync(pgliteDir) ? dirSizeBytes(pgliteDir) : 0;
    const requiredBytes = pgliteDirBytes * SAFETY_MULTIPLIER;
    const freeBytes = await freeBytesOnPath(this.opts.userDataPath);
    if (freeBytes < requiredBytes) {
      const reason =
        `Not enough free disk space. Need ~${humanBytes(requiredBytes)}; have ${humanBytes(freeBytes)}.`;
      return {
        ok: false,
        reason,
        // Bucketed, so freeing a few bytes does not churn the fingerprint and
        // re-ask on every launch; crossing a bucket does.
        refusal: buildMigrationRefusal(
          'insufficient_disk',
          {
            liveBytes: sizeBucket(pgliteDirBytes),
            largestBackupBytes: 'none',
            configuredProjects: countBucket(this.opts.configuredProjectCount ?? 0),
            sourceSessions: 'unknown',
            freeDiskBytes: sizeBucket(freeBytes),
          },
          reason,
        ),
        pgliteDirBytes,
        freeBytes,
        requiredBytes,
      };
    }
    const plausibility = assessMigrationSource(await this.gatherSourceFacts(pgliteDirBytes));
    if (!plausibility.ok) {
      const { ok: _ok, ...refusal } = plausibility;
      return { ok: false, reason: refusal.reason, refusal, pgliteDirBytes, freeBytes, requiredBytes };
    }
    return { ok: true, pgliteDirBytes, freeBytes, requiredBytes };
  }

  /**
   * Stamp the operation identity onto a domain result and hand it up. Every
   * terminal outcome from this class goes through here, so there is exactly
   * one place that decides what a result looks like.
   */
  private report(body: MigrationOutcomeBody): void {
    this.opts.onOutcome?.(buildMigrationOutcome('migrate', this.opts.operation, body));
  }

  /**
   * Facts about the migration source drawn from outside the source itself.
   * See `migrationSourcePlausibility.ts` for why that distinction is the whole
   * point of this check.
   */
  private gatherSourceFacts(liveDirBytes: number): Promise<MigrationSourceFacts> {
    return gatherMigrationSourceFacts({
      userDataPath: this.opts.userDataPath,
      liveDirBytes,
      pglite: this.opts.pglite,
      configuredProjectCount: this.opts.configuredProjectCount,
      findBackups: findRestorableBackups,
    });
  }

  /**
   * Run the migration end-to-end. Throws on any failure path before cutover;
   * the partial sqlite-db/ is cleaned up before the throw.
   */
  async run(): Promise<MigrationSummary> {
    const log = this.opts.log ?? (() => {});
    const reporter = this.opts.reporter;
    const userData = this.opts.userDataPath;
    const pgliteDir = path.join(userData, 'pglite-db');
    const sqliteDir = path.join(userData, 'sqlite-db');
    const migratedSuffix = new Date().toISOString().replace(/[:.]/g, '-');
    const pgliteMigratedDir = path.join(userData, `pglite-db.migrated-${migratedSuffix}`);

    log('info', '[orchestrator] starting migration', {
      pgliteDir,
      sqliteDir,
      pgliteMigratedDir,
    });

    // Refuse an implausible source before touching anything. preflight() runs
    // this too, but the UI is not the only caller and this is the last moment
    // the PGLite store is still authoritative (NIM-3632). The event goes out
    // before we act, so a refusal is visible even if this process dies next.
    const liveDirBytes = fs.existsSync(pgliteDir) ? dirSizeBytes(pgliteDir) : 0;
    const plausibility = assessMigrationSource(await this.gatherSourceFacts(liveDirBytes));
    if (!plausibility.ok) {
      const { ok: _ok, ...refusal } = plausibility;
      this.report({ kind: 'refused', refusal });
      log('error', '[orchestrator] refusing to migrate an implausible source', {
        reasonCode: refusal.reasonCode,
        reason: refusal.reason,
      });
      throw new MigrationRefusedError(refusal);
    }

    // Sanity: don't overwrite an existing sqlite-db. If one exists from a
    // previous aborted attempt, move it aside first.
    if (fs.existsSync(sqliteDir)) {
      const aside = path.join(userData, `sqlite-db.aborted-${migratedSuffix}`);
      fs.renameSync(sqliteDir, aside);
      log('warn', '[orchestrator] existing sqlite-db moved aside', { aside });
    }
    fs.mkdirSync(sqliteDir, { recursive: true });

    let sqlite: SQLiteDatabase | null = null;
    let summary: MigrationSummary | null = null;
    let phase = 'opening-sqlite';
    // Set once the source has been renamed aside. From that moment the SQLite
    // target is the store the journal points at, so the failure path must not
    // remove it -- that would leave the install with neither.
    let targetCleanupSafe = true;
    try {
      // 1. Open fresh SQLite (initialize runs the schema bootstrap).
      sqlite = new SQLiteDatabase({
        dbDir: sqliteDir,
        schemaDir: this.opts.schemaDir,
        slowQueryThresholdMs: 100,
        log,
      });
      await sqlite.initialize();

      // 2. Bulk-copy against the LIVE PGLite worker. This gives us the
      // initial manifest/high-water marks, but it is not yet the final
      // cutover snapshot because the app can still write to PGLite while
      // the copy is running. We close that race below by quiescing PGLite
      // and running one last catch-up pass against a freshly reopened
      // on-disk handle.
      phase = 'migrating';
      const migrator = this.opts.migrator ?? new PGLiteToSQLiteMigrator();
      const onProgress: ((p: MigrationProgress) => void) | undefined = reporter
        ? reporter.onProgress
        : undefined;
      const adapter = buildReadOnlyAdapter(this.opts.pglite);
      summary = await migrator.migrate({
        pglite: adapter,
        sqlite,
        onProgress,
        log,
      });

      // 3. Everything from here is the shared journaled cutover. Validate the
      // inputs it needs before it opens a journal, so a missing dependency
      // fails while PGLite is still live and authoritative.
      const reopen = this.opts.reopenPgliteAfterClose;
      if (!reopen) {
        throw new Error('MigrationOrchestrator requires reopenPgliteAfterClose() for final catch-up.');
      }
      const manifest = summary.manifest;
      if (!manifest) {
        throw new Error('MigrationOrchestrator missing migration manifest for final catch-up.');
      }

      const copied = summary;
      const sqliteHandle = sqlite;
      phase = 'cutover';
      await runCutover({
        userDataPath: userData,
        operationId: this.opts.operationId ?? this.opts.operation?.operationId ?? `migrate-${Date.now()}`,
        operation: 'migrate',
        sourceLiveDir: pgliteDir,
        sourcePreservedDir: pgliteMigratedDir,
        targetLiveDir: sqliteDir,
        cutoverFs: this.opts.cutoverFs,
        log,
        // The target is a complete store at this point; the catch-up below only
        // applies a delta. Checking it here means the source is never touched
        // for a copy that already failed its own integrity check.
        verifyTarget: async () => {
          if (copied.integrityCheck !== 'ok') {
            throw new Error(`SQLite integrity check failed: ${copied.integrityCheck}`);
          }
          if (copied.foreignKeyViolations > 0) {
            throw new Error(`SQLite copy has ${copied.foreignKeyViolations} foreign key violation(s)`);
          }
        },
        quiesceSource: () => this.opts.closeRunningPglite(),
        // Runs with the source frozen and before the rename: re-open the now
        // quiesced PGLite dir, apply the exact final delta, close both.
        finalizeTarget: async () => {
          phase = 'catching-up-after-close';
          const closedSource = await reopen(pgliteDir);
          const finalCatchUp = await (async () => {
            try {
              return await migrator.catchUp({
                pglite: closedSource,
                sqlite: sqliteHandle,
                manifest,
                onProgress,
                log,
              });
            } finally {
              await closedSource.close();
            }
          })();
          copied.totalRowsCopied += finalCatchUp.rowsAdded;
          copied.tablesCopied = mergeCopiedTables(copied.tablesCopied, finalCatchUp.perTable);
          phase = 'closing-sqlite';
          await sqliteHandle.close();
          sqlite = null;
        },
      }).catch((err) => {
        const abort = asCutoverAbort(err);
        if (abort) {
          phase = `cutover:${abort.phase}`;
          targetCleanupSafe = abort.targetCleanupSafe;
        }
        throw err;
      });

      // 4. Done. Hand control back to the caller, which re-opens SQLite under
      // the production code path.
      if (this.opts.onCutoverSuccess) {
        await this.opts.onCutoverSuccess({ sqliteDir, pgliteMigratedDir, summary });
      }
      reporter?.emitComplete(summary);
      log('info', '[orchestrator] migration succeeded', summary);

      this.report({
        kind: 'completed',
        // pglite-db/ has just been renamed; measure from the new location.
        sourceBytes: fs.existsSync(pgliteMigratedDir) ? dirSizeBytes(pgliteMigratedDir) : liveDirBytes,
        rowCount: summary.totalRowsCopied,
        durationMs: summary.durationMs,
        tableCount: summary.tablesCopied.length,
        spotCheckCount: summary.spotCheckCount,
        foreignKeyViolations: summary.foreignKeyViolations,
        integrityCheck: summary.integrityCheck,
      });

      return summary;
    } catch (err) {
      const message = (err as Error).message;
      const stack = (err as Error).stack;
      log('error', `[orchestrator] migration failed in ${phase}`, { message, stack });
      reporter?.emitFailed({ phase, message, stack });
      // A refusal already reported itself above; re-reporting it here would
      // relabel a verdict as a failure.
      if (!(err instanceof MigrationRefusedError)) {
        this.report({ kind: 'failed', phase, ...classifyDatabaseError(err) });
      }

      // Best-effort cleanup. We're conservative about not touching pglite-db;
      // the live worker is still serving the app, don't take it down on
      // failure. Just clean up the partial sqlite-db dir — and only while it is
      // still a partial copy. Once the cutover has preserved the source, this
      // directory is the store the journal points at and removing it would
      // leave the install with no database at all.
      try {
        if (sqlite) await sqlite.close();
      } catch { /* ignore */ }
      if (!targetCleanupSafe) {
        log('warn', '[orchestrator] leaving sqlite-db in place; the cutover journal points at it', {
          sqliteDir,
        });
        throw err;
      }
      try {
        if (fs.existsSync(sqliteDir)) {
          fs.rmSync(sqliteDir, { recursive: true, force: true });
        }
      } catch (rmErr) {
        log('warn', '[orchestrator] failed to remove partial sqlite-db', {
          err: (rmErr as Error).message,
        });
      }

      throw err;
    }
  }
}

function buildReadOnlyAdapter(reader: LivePgliteReader): PGLiteHandle {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      return reader.queryReadOnly<T>(sql, params, 30_000);
    },
    async exec(_sql: string): Promise<unknown> {
      throw new Error('MigrationOrchestrator adapter is read-only; exec() is not supported');
    },
    async close(): Promise<void> {
      // No-op: the live worker keeps running until we explicitly close it.
    },
  };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function freeBytesOnPath(p: string): Promise<number> {
  // `fs.statfs` is Node 18.15+ / 20+. We're on Node 22 in Electron 33+.
  // Fall back to Number.MAX_SAFE_INTEGER if it throws so preflight doesn't
  // false-positive on platforms that don't support statfs (extremely rare).
  type Statfs = (p: string) => Promise<{ bsize: number; bavail: number }>;
  const statfs = (fs.promises as unknown as { statfs?: Statfs }).statfs;
  if (!statfs) return Number.MAX_SAFE_INTEGER;
  try {
    const s = await statfs(p);
    return s.bsize * s.bavail;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function mergeCopiedTables(
  base: Array<{ name: string; rows: number }>,
  delta: Array<{ name: string; added: number }>,
): Array<{ name: string; rows: number }> {
  const merged = new Map(base.map((entry) => [entry.name, entry.rows]));
  for (const entry of delta) {
    merged.set(entry.name, (merged.get(entry.name) ?? 0) + entry.added);
  }
  return Array.from(merged.entries()).map(([name, rows]) => ({ name, rows }));
}
