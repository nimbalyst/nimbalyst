import { createHash } from "crypto";
import type { SQLiteDatabase } from "./SQLiteDatabase";

const TABLES = [
  "ai_sessions",
  "ai_agent_messages",
  "document_history",
] as const;
// Bound bytes as well as row counts. These are content spot checks, not a
// second full scan; skip mutable startup housekeeping fields.
const COLUMNS = {
  ai_sessions:
    "id, length(title) AS title_length, substr(title, 1, 4096) AS title_start, provider",
  ai_agent_messages:
    "id, session_id, length(content) AS content_length, substr(content, 1, 4096) AS content_start, substr(content, -4096) AS content_end",
  document_history:
    "id, file_path, length(content) AS content_length, substr(content, 1, 4096) AS content_start, substr(content, -4096) AS content_end",
} as const;

type ReceiptTable = (typeof TABLES)[number];
export interface CutoverVerification {
  version: 1;
  tables: Array<{
    table: ReceiptTable;
    samples: Array<{ id: string | number; digest: string }>;
  }>;
}

function handleFor(db: SQLiteDatabase) {
  const handle = db.getRawHandle();
  if (!handle)
    throw new Error("Cutover verification requires an open SQLite database");
  return handle;
}

function digest(row: unknown): string {
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

/** Runs in the owning SQLite worker; user content never crosses to main. */
export function captureCutoverVerification(
  db: SQLiteDatabase
): CutoverVerification {
  const handle = handleFor(db);
  const integrity = handle.pragma("integrity_check") as Array<{
    integrity_check: string;
  }>;
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new Error("Final migration integrity check failed");
  }
  if ((handle.pragma("foreign_key_check") as unknown[]).length > 0) {
    throw new Error("Final migration foreign key check failed");
  }
  return {
    version: 1,
    tables: TABLES.map((table) => {
      const first = handle
        .prepare(`SELECT ${COLUMNS[table]} FROM "${table}" ORDER BY id LIMIT 1`)
        .get() as Record<string, unknown> | undefined;
      const last = handle
        .prepare(
          `SELECT ${COLUMNS[table]} FROM "${table}" ORDER BY id DESC LIMIT 1`
        )
        .get() as Record<string, unknown> | undefined;
      const rows = first
        ? last && last.id !== first.id
          ? [first, last]
          : [first]
        : [];
      return {
        table,
        samples: rows.map((row) => ({
          id: row.id as string | number,
          digest: digest(row),
        })),
      };
    }),
  };
}

/** Bounded reads on startup, before repositories can mutate the sampled rows. */
export function verifyCutoverContent(
  db: SQLiteDatabase,
  receipt?: CutoverVerification
): void {
  const handle = handleFor(db);
  if (!receipt) {
    // Legacy journals have no content receipt. Require readable core tables,
    // but do not claim their historic row contents were compared.
    for (const table of TABLES)
      handle.prepare(`SELECT id FROM "${table}" LIMIT 1`).get();
    return;
  }
  if (
    receipt.version !== 1 ||
    !Array.isArray(receipt.tables) ||
    receipt.tables.length !== TABLES.length
  ) {
    throw new Error("Unsupported cutover verification receipt");
  }
  for (const table of TABLES) {
    const entry = receipt.tables.find((item) => item.table === table);
    if (!entry || !Array.isArray(entry.samples) || entry.samples.length > 2) {
      throw new Error("Invalid cutover verification receipt");
    }
    if (entry.samples.length === 0) {
      if (handle.prepare(`SELECT id FROM "${table}" LIMIT 1`).get()) {
        throw new Error(
          `Cutover verification failed for ${table}: expected an empty table`
        );
      }
      continue;
    }
    for (const sample of entry.samples) {
      if (
        (typeof sample.id !== "string" && typeof sample.id !== "number") ||
        typeof sample.digest !== "string"
      ) {
        throw new Error("Invalid cutover verification sample");
      }
      const row = handle
        .prepare(`SELECT ${COLUMNS[table]} FROM "${table}" WHERE id = ?`)
        .get(sample.id);
      if (!row || digest(row) !== sample.digest)
        throw new Error(`Cutover verification failed for ${table}`);
    }
  }
}
