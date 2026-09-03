/**
 * MigrationAdopter
 *
 * Promotes a successful dry-run SQLite into the active backend, instead of
 * making the user re-run the full migration. The dry-run SQLite is a snapshot
 * — PGLite has continued accepting writes since it ran — so before flipping
 * the flag we catch the SQLite up to PGLite's current state.
 *
 *   1. Find the latest sqlite-db.dry-run-{stamp}/ directory + its manifest.
 *   2. Open the dry-run SQLite.
 *   3. Run PGLiteToSQLiteMigrator.catchUp() against the live worker.
 *   4. Hand the rest to `cutoverMachine.runCutover` — the same journaled
 *      cutover `MigrationOrchestrator` uses. It quiesces PGLite, runs the final
 *      catch-up, renames pglite-db/ → pglite-db.migrated-{ts}/, promotes
 *      sqlite-db.dry-run-{stamp}/ → sqlite-db/, and commits the backend flag.
 *
 * Failure rules mirror MigrationOrchestrator because they are now literally the
 * same code: any error before the source is preserved leaves PGLite untouched
 * and the dry-run dir in place, and nothing is suppressed. This file used to
 * log a warning when the pglite-db rename failed and then promote the dry run
 * and commit the flag regardless, which is the worse half of the same defect.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SQLiteDatabase } from './SQLiteDatabase';
import {
  PGLiteToSQLiteMigrator,
  type DryRunManifest,
  type MigrationProgress,
  type MigrationSummary,
  type PGLiteHandle,
} from './PGLiteToSQLiteMigrator';
import { MigrationProgressReporter } from './MigrationProgressReporter';
import { asCutoverAbort, runCutover } from './cutoverMachine';
import type { CutoverFs } from './cutoverJournal';
import { DRY_RUN_MANIFEST_FILENAME } from './MigrationDryRunner';
import { classifyDatabaseError } from '../DatabaseErrorTelemetry';
import { dirSizeBytes } from './dirSize';
import { findRestorableBackups } from './recoveryArtifacts';
import { assessMigrationSource, gatherMigrationSourceFacts } from './migrationSourcePlausibility';
import {
  buildMigrationOutcome,
  MigrationRefusedError,
  type MigrationOperationContext,
  type MigrationOutcome,
  type MigrationOutcomeBody,
} from './migrationOutcome';

/**
 * Same single-statement read surface MigrationDryRunner uses — lets us pull
 * catch-up reads from the live PGLite worker without opening a second handle
 * to the same data dir (which deadlocks on the PID lock) and without close-
 * then-in-process-reopen (which dynamically requires the main bundle a
 * second time, double-registering `__ELECTRON_LOG__`).
 */
export interface LivePgliteReader {
  queryReadOnly<T = unknown>(
    sql: string,
    params?: unknown[],
    timeoutMs?: number,
  ): Promise<{ rows: T[] }>;
}

export interface AdopterOptions {
  userDataPath: string;
  schemaDir: string;
  /**
   * Live PGLite worker. We read catch-up rows through its `queryReadOnly`
   * surface, then call `closeRunningPglite()` to release it before the
   * directory rename.
   */
  pglite: LivePgliteReader;
  closeRunningPglite: () => Promise<void>;
  /**
   * After the live PGLite worker is quiesced, reopen the on-disk database so
   * we can run one final exact catch-up pass before the directory rename.
   */
  reopenPgliteAfterClose?: (dataDir: string) => Promise<PGLiteHandle>;
  onCutoverSuccess?: (info: {
    sqliteDir: string;
    pgliteMigratedDir: string;
  }) => Promise<void> | void;
  reporter?: MigrationProgressReporter;
  migrator?: PGLiteToSQLiteMigrator;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
  /**
   * Report the terminal domain result. Same contract as the orchestrator's:
   * the worker returns a typed result and `migrationEventMapper.ts` on main is
   * the only thing that names an analytics event.
   */
  onOutcome?: (outcome: MigrationOutcome) => void;
  operation?: MigrationOperationContext;
  /**
   * Projects configured in app settings — evidence from outside the database
   * that this install has been used. See `migrationSourcePlausibility.ts`.
   *
   * Not optional in spirit: the worker case that adopts in production omitted
   * it for a while, so every real adoption assessed itself as having zero
   * projects — the permissive value — and the plausibility check could not
   * fire on the one path that commits a cutover.
   */
  configuredProjectCount?: number;
  /** Fault-injection seam for the cutover's renames. See `OrchestratorOptions`. */
  cutoverFs?: CutoverFs;
  /** Identifies the cutover in the journal. Defaults to the operation id. */
  operationId?: string;
}

export interface AdoptResult {
  rowsAdded: number;
  perTable: Array<{ name: string; added: number }>;
  pgliteMigratedDir: string;
  sqliteDir: string;
  durationMs: number;
}

/**
 * Floor for "the dry run actually wrote a store". A schema-only Nimbalyst
 * SQLite carries dozens of tables, so this only rejects an empty or
 * half-created file -- it is a sanity check, not a judgement about how much
 * data the install has.
 */
const ADOPT_MIN_TABLES = 5;

export class MigrationAdopter {
  constructor(private opts: AdopterOptions) {}

  private report(body: MigrationOutcomeBody): void {
    this.opts.onOutcome?.(buildMigrationOutcome('adopt', this.opts.operation, body));
  }

  /**
   * Find the most recent dry-run dir + its manifest. Returns null if no
   * dry-run is available to adopt.
   */
  findDryRunDir(): { dir: string; manifest: DryRunManifest } | null {
    const userData = this.opts.userDataPath;
    if (!fs.existsSync(userData)) return null;
    const candidates = fs
      .readdirSync(userData)
      .filter((d) => d.startsWith('sqlite-db.dry-run-'))
      .map((d) => path.join(userData, d))
      .filter((d) => {
        try { return fs.statSync(d).isDirectory(); } catch { return false; }
      });
    if (candidates.length === 0) return null;
    // Newest first by mtime so we pick up the most recent dry-run.
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const dir of candidates) {
      const manifestPath = path.join(dir, DRY_RUN_MANIFEST_FILENAME);
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as DryRunManifest;
        return { dir, manifest };
      } catch {
        // Corrupt manifest; skip this dir and try the next one.
      }
    }
    return null;
  }

  async run(): Promise<AdoptResult> {
    const log = this.opts.log ?? (() => {});
    const reporter = this.opts.reporter;
    const t0 = performance.now();

    const found = this.findDryRunDir();
    if (!found) {
      throw new Error('No dry-run found to adopt. Run a dry-run first.');
    }
    const dryRunDir = found.dir;
    const manifest = found.manifest;

    const userData = this.opts.userDataPath;
    const pgliteDir = path.join(userData, 'pglite-db');
    const sqliteDir = path.join(userData, 'sqlite-db');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const pgliteMigratedDir = path.join(userData, `pglite-db.migrated-${stamp}`);

    log('info', '[adopter] starting', {
      dryRunDir,
      pgliteDir,
      pgliteMigratedDir,
      manifestAge: Date.now() - new Date(manifest.completedAt).getTime(),
    });

    // Adopting is a cutover, so it needs the same source check the orchestrator
    // does: a dry-run taken against an emptied PGLite store is exactly as
    // permanent once it becomes the active backend (NIM-3632). Event first, so
    // a refusal is recorded even if this process dies immediately after.
    const liveDirBytes = fs.existsSync(pgliteDir) ? dirSizeBytes(pgliteDir) : 0;
    const plausibility = assessMigrationSource(
      await gatherMigrationSourceFacts({
        userDataPath: userData,
        liveDirBytes,
        pglite: this.opts.pglite,
        configuredProjectCount: this.opts.configuredProjectCount,
        findBackups: findRestorableBackups,
      }),
    );
    if (!plausibility.ok) {
      const { ok: _ok, ...refusal } = plausibility;
      this.report({ kind: 'refused', refusal });
      log('error', '[adopter] refusing to adopt an implausible source', {
        reasonCode: refusal.reasonCode,
        reason: refusal.reason,
      });
      throw new MigrationRefusedError(refusal);
    }

    // Refuse to clobber an existing sqlite-db/. If a prior adopt failed mid-way
    // we want a human to look at it.
    if (fs.existsSync(sqliteDir)) {
      throw new Error(
        `Refusing to adopt: ${sqliteDir} already exists. Delete or move it first.`,
      );
    }

    let sqlite: SQLiteDatabase | null = null;
    let phase = 'opening-sqlite';
    try {
      // 1. Open the existing dry-run SQLite. initialize() is idempotent: the
      // migration runner skips already-applied versions via _migrations.
      sqlite = new SQLiteDatabase({
        dbDir: dryRunDir,
        schemaDir: this.opts.schemaDir,
        slowQueryThresholdMs: 100,
        log,
      });
      await sqlite.initialize();

      // 2. Catch-up copy. We read from the LIVE PGLite worker via the same
      // read-only adapter the dry-run uses — opening a second in-process
      // PGLite handle triggers a deadlock on the PID lock AND re-evaluates
      // the bundled `electron-log` module (double `__ELECTRON_LOG__`
      // registration crash). Writes go directly into the dry-run SQLite.
      phase = 'catching-up';
      const migrator = this.opts.migrator ?? new PGLiteToSQLiteMigrator();
      const onProgress: ((p: MigrationProgress) => void) | undefined = reporter
        ? reporter.onProgress
        : undefined;
      const adapter = buildReadOnlyAdapter(this.opts.pglite);
      const catchResult = await migrator.catchUp({
        pglite: adapter,
        sqlite,
        manifest,
        onProgress,
        log,
      });

      // 3. Everything from here is the shared journaled cutover. Validate what
      // it needs before it opens a journal, while PGLite is still authoritative.
      const reopen = this.opts.reopenPgliteAfterClose;
      if (!reopen) {
        throw new Error('MigrationAdopter requires reopenPgliteAfterClose() for final catch-up.');
      }

      const sqliteHandle = sqlite;
      let finalCatchUp = { rowsAdded: 0, perTable: [] as Array<{ name: string; added: number }> };
      phase = 'cutover';
      await runCutover({
        userDataPath: userData,
        operationId: this.opts.operationId ?? this.opts.operation?.operationId ?? `adopt-${Date.now()}`,
        operation: 'adopt',
        sourceLiveDir: pgliteDir,
        sourcePreservedDir: pgliteMigratedDir,
        targetLiveDir: sqliteDir,
        targetStagingDir: dryRunDir,
        cutoverFs: this.opts.cutoverFs,
        log,
        // The dry run was built and verified by MigrationDryRunner and has just
        // been caught up. What is worth re-checking here is that the store the
        // flag is about to name really is a schema-bearing database, because
        // the next step moves the source out from under the app.
        //
        // Asked through the open handle rather than by measuring the file: in
        // WAL mode the tables live in `nimbalyst.sqlite-wal` until close, so a
        // size check here reads 4 KB on a perfectly good store.
        verifyTarget: async () => {
          const { rows } = await sqliteHandle.queryReadOnly<{ n: number }>(
            "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'",
          );
          const tables = Number(rows[0]?.n ?? 0);
          if (tables < ADOPT_MIN_TABLES) {
            throw new Error(
              `dry-run SQLite at ${dryRunDir} has ${tables} table(s); refusing to adopt it as the active store`,
            );
          }
        },
        quiesceSource: () => this.opts.closeRunningPglite(),
        finalizeTarget: async () => {
          phase = 'catching-up-after-close';
          const closedSource = await reopen(pgliteDir);
          finalCatchUp = await (async () => {
            try {
              return await migrator.catchUp({
                pglite: closedSource,
                sqlite: sqliteHandle,
                manifest: catchResult.manifest,
                onProgress,
                log,
              });
            } finally {
              await closedSource.close();
            }
          })();
          phase = 'closing-sqlite';
          await sqliteHandle.close();
          sqlite = null;
        },
      }).catch((err) => {
        const abort = asCutoverAbort(err);
        if (abort) phase = `cutover:${abort.phase}`;
        throw err;
      });

      const durationMs = performance.now() - t0;
      const rowsAdded = catchResult.rowsAdded + finalCatchUp.rowsAdded;
      const perTable = mergeAddedTables(catchResult.perTable, finalCatchUp.perTable);
      const result: AdoptResult = {
        rowsAdded,
        perTable,
        pgliteMigratedDir,
        sqliteDir,
        durationMs,
      };

      if (this.opts.onCutoverSuccess) {
        await this.opts.onCutoverSuccess({ sqliteDir, pgliteMigratedDir });
      }

      // Fake a "complete" summary so the renderer's existing complete handler
      // works without a new channel — only the fields it actually displays
      // need to be present.
      const summary: MigrationSummary = {
        totalRowsCopied: rowsAdded,
        tablesCopied: perTable.map((t) => ({ name: t.name, rows: t.added })),
        durationMs,
        integrityCheck: 'ok',
        foreignKeyViolations: 0,
        spotCheckCount: 0,
      };
      reporter?.emitComplete(summary);

      this.report({
        kind: 'completed',
        sourceBytes: liveDirBytes,
        rowCount: rowsAdded,
        tableCount: perTable.length,
        durationMs,
        spotCheckCount: 0,
        foreignKeyViolations: 0,
        integrityCheck: 'ok',
      });

      log('info', '[adopter] adoption complete', {
        ...result,
        manifestAgeMs: Date.now() - new Date(manifest.completedAt).getTime(),
      });
      return result;
    } catch (err) {
      const message = (err as Error).message;
      const stack = (err as Error).stack;
      log('error', `[adopter] failed in ${phase}`, { message, stack });
      reporter?.emitFailed({ phase, message, stack });
      // A refusal already reported itself above.
      if (!(err instanceof MigrationRefusedError)) {
        this.report({ kind: 'failed', phase, ...classifyDatabaseError(err) });
      }

      // Best-effort cleanup. Leave the dry-run dir in place so the user can
      // try again; don't touch the running PGLite worker (it's still serving
      // app reads — closing it here would leave the app dead).
      try { if (sqlite) await sqlite.close(); } catch { /* ignore */ }

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
      throw new Error('MigrationAdopter adapter is read-only; exec() is not supported');
    },
    async close(): Promise<void> {
      // No-op: the live worker keeps running until we explicitly close it.
    },
  };
}

function mergeAddedTables(
  first: Array<{ name: string; added: number }>,
  second: Array<{ name: string; added: number }>,
): Array<{ name: string; added: number }> {
  const merged = new Map(first.map((entry) => [entry.name, entry.added]));
  for (const entry of second) {
    merged.set(entry.name, (merged.get(entry.name) ?? 0) + entry.added);
  }
  return Array.from(merged.entries()).map(([name, added]) => ({ name, added }));
}
