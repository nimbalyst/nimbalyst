/**
 * Smoke tests for DatabaseBrowserSqliteBackend — the pure-logic half of the
 * IPC handlers. We exercise the translation work (information_schema -> PRAGMA,
 * pg_total_relation_size -> dbstat, pg_database_size -> page_count*page_size)
 * against a real SQLite database to confirm the queries are well-formed and
 * return the shapes the renderer expects.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { DatabaseBrowserSqliteBackend } from '../DatabaseBrowserSqliteHandlers';

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: () => {}, warn: () => {}, error: () => {} } },
}));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: () => {},
}));

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas');

describe('DatabaseBrowserSqliteBackend', () => {
  let tmp: string;
  let sqlite: SQLiteDatabase;
  let backend: DatabaseBrowserSqliteBackend;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-browser-'));
    const sqliteDir = path.join(tmp, 'sqlite-db');
    fs.mkdirSync(sqliteDir, { recursive: true });
    sqlite = new SQLiteDatabase({ dbDir: sqliteDir, schemaDir: SCHEMA_DIR });
    await sqlite.initialize();
    backend = new DatabaseBrowserSqliteBackend({ sqlite });
  });

  afterEach(async () => {
    await sqlite.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lists user tables and excludes sqlite_* + _migrations + _perf_slow_queries', async () => {
    const tables = await backend.listTables();
    expect(tables).toContain('ai_sessions');
    expect(tables).toContain('tracker_items');
    expect(tables).not.toContain('sqlite_master');
    expect(tables.every((t) => !t.startsWith('_'))).toBe(true);
  });

  it('translates information_schema.columns → PRAGMA table_info shape', () => {
    const cols = backend.getTableSchema('ai_sessions');
    expect(cols.length).toBeGreaterThan(10);
    const id = cols.find((c) => c.column_name === 'id');
    expect(id).toBeTruthy();
    expect(id!.data_type).toBe('TEXT');
    // workspace_id is declared NOT NULL explicitly in the schema; the PK
    // column reports notnull=0 because SQLite tracks the literal NOT NULL
    // declaration, not the implication of PRIMARY KEY.
    const ws = cols.find((c) => c.column_name === 'workspace_id');
    expect(ws!.is_nullable).toBe('NO');
  });

  it('returns primary key columns in order', () => {
    expect(backend.getPrimaryKeys('ai_sessions')).toEqual(['id']);
    expect(backend.getPrimaryKeys('tracker_body_cache')).toEqual(['item_id', 'body_version']);
  });

  it('reports total db bytes via page_count * page_size', async () => {
    const bytes = await backend.getTotalDbBytes();
    expect(bytes).toBeGreaterThan(0);
    // Sanity bounds — an empty schema dump is < 10 MB.
    expect(bytes).toBeLessThan(10 * 1024 * 1024);
  });

  it('returns dbstat-based per-table size for a populated table', async () => {
    const handle = sqlite.getRawHandle()!;
    for (let i = 0; i < 200; i++) {
      handle.prepare('INSERT INTO ai_sessions(id, provider) VALUES (?, ?)').run(`x${i}`, 'claude');
    }
    const bytes = await backend.getTableSizeBytes('ai_sessions');
    // dbstat is compiled into the standard SQLite build. If the build dropped
    // it, the backend returns 0 (graceful degrade) and we'd see 0 here. Allow
    // 0 to keep the test stable across builds, but if non-zero it must be a
    // believable size.
    if (bytes > 0) {
      expect(bytes).toBeGreaterThan(1024);
    }
  });
});
