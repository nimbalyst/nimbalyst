import { historyBatchWriter } from "./historyMigrationRecovery";
import type { Database as BetterSqliteDb } from "better-sqlite3";
import type { SQLiteDatabase } from "./SQLiteDatabase";
import type {
  PGLiteHandle,
  MigrateOptions,
  TargetColumn,
} from "./PGLiteToSQLiteMigrator";
import {
  MigrationBatchPolicy,
  estimatePayloadBytes,
  MIGRATION_RECOVERY_BUDGET_MS,
} from "./migrationBatchPolicy";
import { isSettledMigrationTimeout } from "./migrationSourceRead";

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export async function copyMigrationTable(opts: {
  targetColumns: TargetColumn[];
  sourceColumns: Set<string>;
  translateRow: (
    row: Record<string, unknown>,
    cols: TargetColumn[]
  ) => unknown[];
  filterSql: string;
  conflictKeys?: readonly string[];
  sourceTable: string;
  expectedRows: number;
  historySourceRows?: number;
  pglite: PGLiteHandle;
  sqlite: SQLiteDatabase;
  sqliteHandle: BetterSqliteDb;
  batchSize: number;
  /**
   * Single-column PK to drive cursor pagination (WHERE col > $cursor ORDER
   * BY col). Tables without an eligible key retain LIMIT/OFFSET paging.
   */
  cursorColumn?: string;
  /**
   * Start cursor for catch-up: skip rows with pk <= initialCursor. When
   * omitted, copy from the beginning of the table.
   */
  initialCursor?: string | number;
  /** Max rows to reservoir-sample for later spot-check. */
  sampleSize: number;
  onBatchProgress: (rowsCopiedInTable: number) => void;
  log: NonNullable<MigrateOptions["log"]>;
}): Promise<{
  copied: number;
  samples: Record<string, unknown>[];
  cursorMax?: string | number;
}> {
  if (opts.expectedRows === 0 && opts.initialCursor === undefined) {
    opts.onBatchProgress(0);
    return { copied: 0, samples: [] };
  }

  const target = opts.targetColumns;
  // Intersect with the source's columns so we don't try to INSERT a target
  // column the source never had (the SQLite schema may legitimately add
  // columns that the PGLite end-state didn't carry). SQLite fills in the
  // DEFAULT for any column we omit.
  const sourceCols = opts.sourceColumns;
  const insertableCols = target.filter(
    (c) => !c.generated && sourceCols.has(c.name)
  );
  if (insertableCols.length === 0) {
    throw new Error(`No insertable columns for ${opts.sourceTable}`);
  }
  const conflictKeys = opts.conflictKeys;
  const conflictClause = conflictKeys
    ? (() => {
        const keySet = new Set(conflictKeys);
        const updateCols = insertableCols.filter(
          (column) => !keySet.has(column.name)
        );
        const action =
          updateCols.length > 0
            ? `DO UPDATE SET ${updateCols
                .map(
                  (column) =>
                    `${quoteIdent(column.name)} = excluded.${quoteIdent(
                      column.name
                    )}`
                )
                .join(",")}`
            : "DO NOTHING";
        return ` ON CONFLICT (${conflictKeys
          .map(quoteIdent)
          .join(",")}) ${action}`;
      })()
    : "";
  const insertSql = `INSERT INTO ${quoteIdent(
    opts.sourceTable
  )}(${insertableCols
    .map((c) => quoteIdent(c.name))
    .join(",")}) VALUES (${insertableCols
    .map(() => "?")
    .join(",")})${conflictClause}`;

  const stmt = opts.sqliteHandle.prepare(insertSql);
  const insertMany = opts.sqliteHandle.transaction((rows: unknown[][]) => {
    for (const r of rows) stmt.run(...r);
  });

  const writeHistory =
    opts.sourceTable === "document_history"
      ? historyBatchWriter(
          opts.sqliteHandle,
          opts.historySourceRows ?? opts.expectedRows,
          (row) => stmt.run(...opts.translateRow(row, insertableCols))
        )
      : undefined;

  // Cursor-paginated path: WHERE pk > $cursor ORDER BY pk LIMIT N. This is
  // O(n) total work across the whole table because each batch starts from
  // an indexed position, not from row 0. For ai_agent_messages this is the
  // difference between minutes and hours.
  const useCursor =
    opts.cursorColumn !== undefined && sourceCols.has(opts.cursorColumn);
  if (opts.cursorColumn && !useCursor) {
    opts.log(
      "warn",
      `[migrator] ${opts.sourceTable}: cursor column "${opts.cursorColumn}" not in source; falling back to OFFSET`
    );
  }
  const pkCol = useCursor ? quoteIdent(opts.cursorColumn!) : null;
  const filterSql = opts.filterSql;

  let copied = 0;
  let quarantined = 0;
  let offset = 0;
  let cursor: unknown =
    opts.initialCursor !== undefined ? opts.initialCursor : null;
  // Reservoir sample (Algorithm R): unbiased k-of-n sample with one pass.
  const samples: Record<string, unknown>[] = [];
  let seen = 0;
  // Loop until PGLite returns 0 rows. We can't trust expectedRows as a hard
  // stop because catch-up's expectedRows is "new rows since dry-run" which
  // is just an estimate — actual new rows can be a few more (race with live
  // writes between measure and copy).
  const policy = new MigrationBatchPolicy(opts.batchSize);
  let recoveryStarted: number | undefined;
  let retries = 0;
  while (true) {
    const attemptedLimit = policy.limit;
    const readStarted = performance.now();
    let result: { rows: Record<string, unknown>[] };
    try {
      result = useCursor
        ? cursor === null
          ? await opts.pglite.query<Record<string, unknown>>(
              `SELECT * FROM ${quoteIdent(
                opts.sourceTable
              )}${filterSql} ORDER BY ${pkCol} LIMIT $1`,
              [attemptedLimit]
            )
          : await opts.pglite.query<Record<string, unknown>>(
              `SELECT * FROM ${quoteIdent(opts.sourceTable)}${filterSql}${
                filterSql ? " AND" : " WHERE"
              } ${pkCol} > $1 ORDER BY ${pkCol} LIMIT $2`,
              [cursor, attemptedLimit]
            )
        : await opts.pglite.query<Record<string, unknown>>(
            `SELECT * FROM ${quoteIdent(
              opts.sourceTable
            )}${filterSql} ORDER BY 1 LIMIT $1 OFFSET $2`,
            [attemptedLimit, offset]
          );
    } catch (error) {
      if (!isSettledMigrationTimeout(error)) throw error;
      recoveryStarted ??=
        readStarted -
        Math.max(0, error.data.elapsedMs - (performance.now() - readStarted));
      const recoveryMs = performance.now() - recoveryStarted;
      if (attemptedLimit === 1 || recoveryMs >= MIGRATION_RECOVERY_BUDGET_MS) {
        throw Object.assign(
          new Error(
            `Migration read failed for ${
              opts.sourceTable
            } at committed position ${String(
              cursor ?? offset
            )} (batch ${attemptedLimit}, timeout recovery exhausted)`
          ),
          {
            cause: error,
            code: "migration_batch_timeout",
          }
        );
      }
      policy.timedOut();
      retries++;
      opts.log("warn", "[migrator] retrying settled source timeout", {
        table: opts.sourceTable,
        attemptedLimit,
        nextLimit: policy.limit,
        retries,
        recoveryMs,
      });
      continue;
    }
    const readMs = performance.now() - readStarted;
    if (result.rows.length === 0) break;

    const translatedBatch = writeHistory
      ? undefined
      : result.rows.map((row) => opts.translateRow(row, insertableCols));
    let accepted = result.rows;

    // Run the insert through the hot write lane. Each batch is a single
    // BEGIN IMMEDIATE / COMMIT so we pay one fsync per batch instead of one
    // per row. The await yields the event loop after the batch commits,
    // and the next iteration awaits pglite.query() which yields again.
    const writeStarted = performance.now();
    const coordinator = opts.sqlite.getCoordinator();
    if (!coordinator)
      throw new Error("SQLiteDatabase coordinator not available");
    await coordinator.write((db: BetterSqliteDb) => {
      if (db === opts.sqliteHandle) {
        if (writeHistory) accepted = writeHistory(result.rows);
        else insertMany(translatedBatch!);
      } else {
        // Defensive: coordinator should always pass the same handle we
        // prepared the statement against.
        throw new Error("WriteCoordinator handed a different db handle");
      }
    });

    const writeMs = performance.now() - writeStarted;
    for (const row of accepted) {
      if (samples.length < opts.sampleSize) {
        samples.push(row);
      } else {
        const j = Math.floor(Math.random() * (seen + 1));
        if (j < opts.sampleSize) samples[j] = row;
      }
      seen++;
    }

    const bytes = estimatePayloadBytes(result.rows);
    policy.succeeded(readMs, bytes);
    opts.log("info", "[migrator] copied batch", {
      table: opts.sourceTable,
      attemptedLimit,
      rows: accepted.length,
      rowsQuarantined: result.rows.length - accepted.length,
      bytes,
      readMs,
      writeMs,
      retries,
    });
    recoveryStarted = undefined;
    retries = 0;
    copied += accepted.length;
    quarantined += result.rows.length - accepted.length;
    if (useCursor) {
      // Advance cursor to the last PK we just read. PGLite returns the rows
      // already ordered by pkCol, so the last row's PK is the new high-water.
      cursor = result.rows[result.rows.length - 1][opts.cursorColumn!];
    } else {
      offset += result.rows.length;
    }
    opts.onBatchProgress(copied);

    // Safety: if PGLite returned fewer rows than batchSize, we're done.
    if (result.rows.length < attemptedLimit) break;
  }

  if (copied + quarantined !== opts.expectedRows) {
    opts.log(
      "warn",
      `[migrator] ${opts.sourceTable}: copied ${copied} and quarantined ${quarantined} but expected ${opts.expectedRows}`
    );
  }
  const cursorMax =
    useCursor && cursor !== null ? (cursor as string | number) : undefined;
  return { copied, samples, cursorMax };
}
