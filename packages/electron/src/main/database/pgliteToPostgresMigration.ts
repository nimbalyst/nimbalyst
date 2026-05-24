import { app } from 'electron';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { POSTGRES_SCHEMA_STATEMENTS } from './postgresSchema';

const TABLES = [
  'workspaces',
  'documents',
  'document_history',
  'worktrees',
  'ai_sessions',
  'session_files',
  'ai_agent_messages',
  'ai_tool_call_file_edits',
  'tracker_items',
  'tracker_body_cache',
  'tracker_transactions',
  'queued_prompts',
  'ai_session_wakeups',
  'super_loops',
  'super_iterations',
  'ai_transcript_events',
  'collab_local_origins',
];

const GENERATED_COLUMNS = new Set([
  'tracker_items.title',
  'tracker_items.status',
  'tracker_items.kanban_sort_order',
]);

const JSON_COLUMNS = new Set([
  'document_history.metadata',
  'ai_sessions.document_context',
  'ai_sessions.provider_config',
  'ai_sessions.metadata',
  'ai_sessions.last_document_state',
  'session_files.metadata',
  'ai_agent_messages.metadata',
  'tracker_items.data',
  'tracker_items.content',
  'tracker_transactions.payload',
  'tracker_transactions.last_rejection',
  'queued_prompts.attachments',
  'queued_prompts.document_context',
  'ai_transcript_events.payload',
]);

const DEFERRED_REFERENCE_COLUMNS = new Map([
  ['ai_sessions', { key: 'id', columns: ['parent_session_id', 'created_by_session_id', 'branched_from_session_id'] }],
  ['ai_transcript_events', { key: 'id', columns: ['parent_event_id'] }],
]);

export interface PgliteToPostgresMigrationOptions {
  postgresUrl: string;
  pgliteDir?: string;
  batchSize?: number;
  truncate?: boolean;
  snapshot?: boolean;
}

export interface PgliteToPostgresMigrationResult {
  rowsCopied: number;
  sourceDir: string;
  migratedDir: string;
  snapshotDir?: string;
  tableCounts: Record<string, number>;
  messages: string[];
}

export function getDefaultPgliteDir(): string {
  return path.join(app.getPath('userData'), 'pglite-db');
}

function quoteIdent(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function tableExists(db: { query: PGlite['query'] }, tableName: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean | 't' }>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName],
  );
  return rows[0]?.exists === true || rows[0]?.exists === 't';
}

async function getTargetColumns(pool: Pool, tableName: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT column_name, is_generated
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName],
  );
  return rows
    .filter((row) => row.is_generated !== 'ALWAYS')
    .map((row) => row.column_name)
    .filter((column) => !GENERATED_COLUMNS.has(`${tableName}.${column}`));
}

async function getSourceColumns(db: PGlite, tableName: string): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName],
  );
  return rows.map((row) => row.column_name);
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  return value;
}

function normalizeColumnValue(tableName: string, columnName: string, value: unknown): unknown {
  const normalized = normalizeValue(value);
  if (normalized == null || !JSON_COLUMNS.has(`${tableName}.${columnName}`)) {
    return normalized;
  }
  return JSON.stringify(normalized);
}

async function createPostgresSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of POSTGRES_SCHEMA_STATEMENTS) {
      await client.query(statement);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function truncateTarget(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE TABLE ${TABLES.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`);
}

async function copyTable(
  sourceDb: PGlite,
  targetPool: Pool,
  tableName: string,
  batchSize: number,
  messages: string[],
): Promise<number> {
  if (!(await tableExists(sourceDb, tableName))) {
    messages.push(`${tableName}: source table missing, skipped`);
    return 0;
  }

  const sourceColumns = new Set(await getSourceColumns(sourceDb, tableName));
  const targetColumns = await getTargetColumns(targetPool, tableName);
  const deferredColumns = new Set(DEFERRED_REFERENCE_COLUMNS.get(tableName)?.columns ?? []);
  const columns = targetColumns.filter((column) => sourceColumns.has(column) && !deferredColumns.has(column));
  if (columns.length === 0) {
    messages.push(`${tableName}: no shared columns, skipped`);
    return 0;
  }

  const countResult = await sourceDb.query<{ count: number | string }>(`SELECT COUNT(*) AS count FROM ${quoteIdent(tableName)}`);
  const total = Number(countResult.rows[0]?.count ?? 0);
  if (total === 0) {
    messages.push(`${tableName}: 0 rows`);
    return 0;
  }

  let copied = 0;
  const columnList = columns.map(quoteIdent).join(', ');
  const orderColumn = quoteIdent(columns[0]);

  for (let offset = 0; offset < total; offset += batchSize) {
    const rows = await sourceDb.query<Record<string, any>>(
      `SELECT ${columnList} FROM ${quoteIdent(tableName)} ORDER BY ${orderColumn} LIMIT $1 OFFSET $2`,
      [batchSize, offset],
    );
    if (rows.rows.length === 0) break;

    const values: unknown[] = [];
    let paramIndex = 1;
    const tuples = rows.rows.map((row) => {
      const placeholders = columns.map((column) => {
        values.push(normalizeColumnValue(tableName, column, row[column]));
        return `$${paramIndex++}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    await targetPool.query(
      `INSERT INTO ${quoteIdent(tableName)} (${columnList}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
      values,
    );
    copied += rows.rows.length;
  }

  messages.push(`${tableName}: copied ${copied}/${total} rows`);
  return copied;
}

async function restoreDeferredReferences(
  sourceDb: PGlite,
  targetPool: Pool,
  tableName: string,
  config: { key: string; columns: string[] },
  batchSize: number,
  messages: string[],
): Promise<void> {
  if (!(await tableExists(sourceDb, tableName))) return;

  const sourceColumns = new Set(await getSourceColumns(sourceDb, tableName));
  const targetColumns = new Set(await getTargetColumns(targetPool, tableName));
  const columns = config.columns.filter((column) => sourceColumns.has(column) && targetColumns.has(column));
  if (!sourceColumns.has(config.key) || !targetColumns.has(config.key) || columns.length === 0) return;

  const key = quoteIdent(config.key);
  const table = quoteIdent(tableName);
  const whereClause = columns.map((column) => `${quoteIdent(column)} IS NOT NULL`).join(' OR ');
  const countResult = await sourceDb.query<{ count: number | string }>(`SELECT COUNT(*) AS count FROM ${table} WHERE ${whereClause}`);
  const total = Number(countResult.rows[0]?.count ?? 0);
  if (total === 0) return;

  const selectList = [config.key, ...columns].map(quoteIdent).join(', ');
  const setClause = columns.map((column, index) => `${quoteIdent(column)} = $${index + 2}`).join(', ');
  let restored = 0;

  for (let offset = 0; offset < total; offset += batchSize) {
    const rows = await sourceDb.query<Record<string, any>>(
      `SELECT ${selectList} FROM ${table} WHERE ${whereClause} ORDER BY ${key} LIMIT $1 OFFSET $2`,
      [batchSize, offset],
    );
    if (rows.rows.length === 0) break;

    for (const row of rows.rows) {
      await targetPool.query(
        `UPDATE ${table} SET ${setClause} WHERE ${key} = $1`,
        [normalizeValue(row[config.key]), ...columns.map((column) => normalizeValue(row[column]))],
      );
      restored += 1;
    }
  }

  messages.push(`${tableName}: restored deferred references for ${restored}/${total} rows`);
}

async function resetSequences(pool: Pool): Promise<void> {
  for (const [tableName, columnName] of [
    ['document_history', 'id'],
    ['ai_agent_messages', 'id'],
    ['ai_tool_call_file_edits', 'id'],
    ['ai_transcript_events', 'id'],
  ]) {
    await pool.query(
      `SELECT setval(
        pg_get_serial_sequence($1, $2),
        COALESCE((SELECT MAX(${quoteIdent(columnName)}) FROM ${quoteIdent(tableName)}), 1),
        (SELECT COUNT(*) FROM ${quoteIdent(tableName)}) > 0
      )`,
      [tableName, columnName],
    );
  }
}

async function snapshotPgliteDir(sourceDir: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const snapshotRoot = path.join(app.getPath('userData'), 'migration-snapshots');
  const snapshotDir = path.join(snapshotRoot, `pglite-db-${stamp}`);
  await fs.mkdir(snapshotRoot, { recursive: true });
  await fs.cp(sourceDir, snapshotDir, { recursive: true });
  return snapshotDir;
}

export async function migratePgliteToPostgres(
  options: PgliteToPostgresMigrationOptions,
): Promise<PgliteToPostgresMigrationResult> {
  const postgresUrl = options.postgresUrl?.trim();
  if (!postgresUrl) {
    throw new Error('Postgres connection string is required');
  }

  const sourceDir = options.pgliteDir?.trim() || getDefaultPgliteDir();
  if (!fsSync.existsSync(sourceDir)) {
    throw new Error(`PGLite directory does not exist: ${sourceDir}`);
  }

  const batchSize = Number.isFinite(options.batchSize) && options.batchSize! > 0
    ? Math.floor(options.batchSize!)
    : 200;
  const messages: string[] = [];
  const migratedDir = options.snapshot === false ? sourceDir : await snapshotPgliteDir(sourceDir);
  const sourceDb = new PGlite(migratedDir, { readonly: true } as any);
  const targetPool = new Pool({
    connectionString: postgresUrl,
    application_name: 'nimbalyst-pglite-migration',
  });

  try {
    await sourceDb.waitReady;
    await targetPool.query('SELECT 1');
    await createPostgresSchema(targetPool);
    if (options.truncate) {
      await truncateTarget(targetPool);
      messages.push('Target tables truncated');
    }

    let rowsCopied = 0;
    const tableCounts: Record<string, number> = {};
    for (const tableName of TABLES) {
      const copied = await copyTable(sourceDb, targetPool, tableName, batchSize, messages);
      tableCounts[tableName] = copied;
      rowsCopied += copied;
    }
    for (const [tableName, config] of DEFERRED_REFERENCE_COLUMNS) {
      await restoreDeferredReferences(sourceDb, targetPool, tableName, config, batchSize, messages);
    }
    await resetSequences(targetPool);
    messages.push(`Migration complete. Rows copied: ${rowsCopied}`);

    return {
      rowsCopied,
      sourceDir,
      migratedDir,
      snapshotDir: migratedDir === sourceDir ? undefined : migratedDir,
      tableCounts,
      messages,
    };
  } finally {
    await targetPool.end().catch(() => {});
    await sourceDb.close().catch(() => {});
  }
}
