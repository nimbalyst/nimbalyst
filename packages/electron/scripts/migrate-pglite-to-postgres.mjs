#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

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

function usage() {
  console.log(`
Migrate Nimbalyst PGLite data into PostgreSQL.

Usage:
  npm run db:migrate:pglite-to-postgres --prefix packages/electron -- --postgres-url "postgres://user:pass@localhost:5432/nimbalyst"

Options:
  --postgres-url <url>  Target Postgres connection string. Also reads NIMBALYST_DATABASE_URL.
  --pglite-dir <path>  Source PGLite directory. Defaults to the normal Nimbalyst user data path.
  --batch-size <n>     Rows per insert batch. Default: 200.
  --truncate           Clear target tables before copying.
`);
}

function parseArgs(argv) {
  const args = {
    postgresUrl: process.env.NIMBALYST_DATABASE_URL,
    pgliteDir: process.env.NIMBALYST_PGLITE_DIR || defaultPgliteDir(),
    batchSize: 200,
    truncate: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--postgres-url') {
      args.postgresUrl = argv[++i];
    } else if (arg === '--pglite-dir') {
      args.pgliteDir = argv[++i];
    } else if (arg === '--batch-size') {
      args.batchSize = Number.parseInt(argv[++i], 10);
    } else if (arg === '--truncate') {
      args.truncate = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.postgresUrl) {
    throw new Error('Missing --postgres-url or NIMBALYST_DATABASE_URL');
  }
  if (!Number.isFinite(args.batchSize) || args.batchSize <= 0) {
    throw new Error('--batch-size must be a positive number');
  }
  return args;
}

function defaultPgliteDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '@nimbalyst', 'electron', 'pglite-db');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', '@nimbalyst', 'electron', 'pglite-db');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), '@nimbalyst', 'electron', 'pglite-db');
}

function loadSchemaStatements() {
  const schemaPath = path.join(repoRoot, 'packages', 'electron', 'src', 'main', 'database', 'postgresSchema.ts');
  const source = fs.readFileSync(schemaPath, 'utf8');
  const match = source.match(/export const POSTGRES_SCHEMA_STATEMENTS = ([\s\S]*?);\s*$/);
  if (!match) {
    throw new Error(`Could not read schema statements from ${schemaPath}`);
  }
  return vm.runInNewContext(match[1], {});
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function tableExists(db, tableName) {
  const { rows } = await db.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName],
  );
  return rows[0]?.exists === true || rows[0]?.exists === 't';
}

async function getTargetColumns(pool, tableName) {
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

async function getSourceColumns(db, tableName) {
  const { rows } = await db.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName],
  );
  return rows.map((row) => row.column_name);
}

function normalizeValue(value) {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  return value;
}

function normalizeColumnValue(tableName, columnName, value) {
  const normalized = normalizeValue(value);
  if (normalized == null || !JSON_COLUMNS.has(`${tableName}.${columnName}`)) {
    return normalized;
  }
  return JSON.stringify(normalized);
}

async function createPostgresSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of loadSchemaStatements()) {
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

async function truncateTarget(pool) {
  const tableList = TABLES.map(quoteIdent).join(', ');
  await pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

async function copyTable(sourceDb, targetPool, tableName, batchSize) {
  if (!(await tableExists(sourceDb, tableName))) {
    console.log(`- ${tableName}: source table missing, skipped`);
    return 0;
  }

  const sourceColumns = new Set(await getSourceColumns(sourceDb, tableName));
  const targetColumns = await getTargetColumns(targetPool, tableName);
  const deferredColumns = new Set(DEFERRED_REFERENCE_COLUMNS.get(tableName)?.columns ?? []);
  const columns = targetColumns.filter((column) => sourceColumns.has(column) && !deferredColumns.has(column));
  if (columns.length === 0) {
    console.log(`- ${tableName}: no shared columns, skipped`);
    return 0;
  }

  const countResult = await sourceDb.query(`SELECT COUNT(*) AS count FROM ${quoteIdent(tableName)}`);
  const total = Number(countResult.rows[0]?.count ?? 0);
  if (total === 0) {
    console.log(`- ${tableName}: 0 rows`);
    return 0;
  }

  let copied = 0;
  const columnList = columns.map(quoteIdent).join(', ');
  const orderColumn = quoteIdent(columns[0]);

  for (let offset = 0; offset < total; offset += batchSize) {
    const rows = await sourceDb.query(
      `SELECT ${columnList} FROM ${quoteIdent(tableName)} ORDER BY ${orderColumn} LIMIT $1 OFFSET $2`,
      [batchSize, offset],
    );
    if (rows.rows.length === 0) break;

    const values = [];
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

  console.log(`- ${tableName}: copied ${copied}/${total} rows`);
  return copied;
}

async function restoreDeferredReferences(sourceDb, targetPool, tableName, config, batchSize) {
  if (!(await tableExists(sourceDb, tableName))) return;

  const sourceColumns = new Set(await getSourceColumns(sourceDb, tableName));
  const targetColumns = new Set(await getTargetColumns(targetPool, tableName));
  const columns = config.columns.filter((column) => sourceColumns.has(column) && targetColumns.has(column));
  if (!sourceColumns.has(config.key) || !targetColumns.has(config.key) || columns.length === 0) return;

  const key = quoteIdent(config.key);
  const table = quoteIdent(tableName);
  const whereClause = columns.map((column) => `${quoteIdent(column)} IS NOT NULL`).join(' OR ');
  const countResult = await sourceDb.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${whereClause}`);
  const total = Number(countResult.rows[0]?.count ?? 0);
  if (total === 0) return;

  const selectList = [config.key, ...columns].map(quoteIdent).join(', ');
  const setClause = columns.map((column, index) => `${quoteIdent(column)} = $${index + 2}`).join(', ');
  let restored = 0;

  for (let offset = 0; offset < total; offset += batchSize) {
    const rows = await sourceDb.query(
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

  console.log(`- ${tableName}: restored deferred references for ${restored}/${total} rows`);
}

async function resetSequences(pool) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.pgliteDir)) {
    throw new Error(`PGLite directory does not exist: ${args.pgliteDir}`);
  }

  console.log(`Source PGLite: ${args.pgliteDir}`);
  console.log('Target Postgres: connection string provided');

  const sourceDb = new PGlite(args.pgliteDir, { readonly: true });
  const targetPool = new Pool({ connectionString: args.postgresUrl, application_name: 'nimbalyst-pglite-migration' });

  try {
    await sourceDb.waitReady;
    await targetPool.query('SELECT 1');
    await createPostgresSchema(targetPool);
    if (args.truncate) {
      await truncateTarget(targetPool);
      console.log('Target tables truncated');
    }

    let totalCopied = 0;
    for (const tableName of TABLES) {
      totalCopied += await copyTable(sourceDb, targetPool, tableName, args.batchSize);
    }
    for (const [tableName, config] of DEFERRED_REFERENCE_COLUMNS) {
      await restoreDeferredReferences(sourceDb, targetPool, tableName, config, args.batchSize);
    }
    await resetSequences(targetPool);
    console.log(`Migration complete. Rows copied: ${totalCopied}`);
  } finally {
    await targetPool.end().catch(() => {});
    await sourceDb.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
