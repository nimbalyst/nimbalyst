import type { Database } from "better-sqlite3";
import { serialize } from "node:v8";

export const HISTORY_QUARANTINE_TABLE = "migration_history_quarantine";
const MAX_ROWS = 100;
const MAX_FRACTION = 0.01;

class HistoryRowError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function historyQuarantineCount(db: Database): number {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(HISTORY_QUARANTINE_TABLE)
  )
    return 0;
  return (
    db
      .prepare(`SELECT count(*) AS n FROM ${HISTORY_QUARANTINE_TABLE}`)
      .get() as { n: number }
  ).n;
}

/** Validate only known row defects. Engine, source-read and unexpected errors stay fatal. */
function validateHistoryRow(row: Record<string, unknown>): void {
  // Without a trustworthy source key we cannot produce a recoverable omission.
  if (!Number.isSafeInteger(row.id) || Number(row.id) < 1)
    throw new Error("Invalid document history source ID");
  for (const key of [
    "workspace_id",
    "file_path",
    "content",
    "timestamp",
    "metadata",
  ]) {
    // A missing source column can indicate schema incompatibility, not a bad row.
    if (!(key in row))
      throw new Error(`Missing document history source column: ${key}`);
    if (row[key] === null)
      throw new HistoryRowError("history_null_required_value");
  }
  if (!(row.content instanceof Uint8Array))
    throw new HistoryRowError("history_invalid_content");
  if (
    typeof row.workspace_id !== "string" ||
    typeof row.file_path !== "string" ||
    !Number.isSafeInteger(row.timestamp)
  ) {
    throw new HistoryRowError("history_invalid_value");
  }
}

function normalizeHistoryRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...row };
  // Preserve missing columns as schema errors and original rows for quarantine.
  if ("metadata" in normalized && normalized.metadata == null) {
    normalized.metadata = "{}";
  } else if (typeof normalized.metadata === "string") {
    try {
      JSON.parse(normalized.metadata);
    } catch {
      // PGLite returns JSONB string scalars as unquoted JavaScript strings.
      normalized.metadata = JSON.stringify(normalized.metadata);
    }
  }
  return normalized;
}

/**
 * Fast batch first, then isolate only explicitly validated row defects. Caller
 * owns the write transaction; the accepted rows and serialized source records
 * commit together. SQLite failures (including constraints) are never swallowed.
 */
export function historyBatchWriter(
  db: Database,
  sourceRows: number,
  insert: (row: Record<string, unknown>) => void
): (rows: Record<string, unknown>[]) => Record<string, unknown>[] {
  if (!Number.isSafeInteger(sourceRows) || sourceRows < 0) {
    throw new Error("Invalid source history row count; cannot bound omissions");
  }
  const limit = Math.min(MAX_ROWS, Math.floor(sourceRows * MAX_FRACTION));
  if (historyQuarantineCount(db) > limit) {
    throw new Error("Document history omission limit exceeded after source history changed");
  }
  const insertOne = (row: Record<string, unknown>) => {
    const normalized = normalizeHistoryRow(row);
    validateHistoryRow(normalized);
    insert(normalized);
    return normalized;
  };
  const fastBatch = db.transaction((rows: Record<string, unknown>[]) => {
    return rows.map(insertOne);
  });
  return db.transaction((rows: Record<string, unknown>[]) => {
    try {
      return fastBatch(rows);
    } catch (error) {
      if (!(error instanceof HistoryRowError)) throw error;
    }
    db.exec(`CREATE TABLE IF NOT EXISTS ${HISTORY_QUARANTINE_TABLE} (
      source_id INTEGER PRIMARY KEY, reason_code TEXT NOT NULL,
      source_row BLOB NOT NULL, encoding TEXT NOT NULL DEFAULT 'node-v8-v1',
      quarantined_at TEXT NOT NULL
    )`);
    const save = db.prepare(`INSERT INTO ${HISTORY_QUARANTINE_TABLE}
      (source_id, reason_code, source_row, quarantined_at) VALUES (?, ?, ?, ?)`);
    const accepted: Record<string, unknown>[] = [];
    let quarantined = historyQuarantineCount(db);
    for (const row of rows) {
      const normalized = normalizeHistoryRow(row);
      try {
        validateHistoryRow(normalized);
      } catch (error) {
        if (!(error instanceof HistoryRowError)) throw error;
        if (++quarantined > limit)
          throw Object.assign(
            new Error(
              `Document history omission limit exceeded (maximum ${limit} rows; at most 100 rows and 1% of history).`
            ),
            { code: "migration_history_limit" }
          );
        // No row contents, identifiers or exception messages go to telemetry.
        // Serialization/storage failures abort the entire batch, including good rows.
        save.run(row.id, error.code, serialize(row), new Date().toISOString());
        continue;
      }
      insert(normalized);
      accepted.push(normalized);
    }
    return accepted;
  });
}
