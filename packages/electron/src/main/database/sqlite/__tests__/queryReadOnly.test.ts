/**
 * Verifies the SELECT-only contract of `SQLiteDatabase.queryReadOnly`.
 *
 * The MCP `database_query` tool and the `extension:database:query` IPC both
 * route through this method, so the engine-level rejection of writes is the
 * security boundary — the prefix check in those handlers is defense in depth.
 *
 * Pairs with the existing PGLite-side test in
 * `packages/electron/src/main/database/__tests__/queryReadOnly.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../SQLiteDatabase';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

describe('SQLiteDatabase.queryReadOnly', () => {
  let tmp: string;
  let sqlite: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-readonly-'));
    const dbDir = path.join(tmp, 'sqlite-db');
    fs.mkdirSync(dbDir, { recursive: true });
    sqlite = new SQLiteDatabase({ dbDir, schemaDir: SCHEMA_DIR });
    await sqlite.initialize();
    const handle = sqlite.getRawHandle()!;
    handle.prepare('INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)').run('s1', 'claude', 'Auth refactor');
    handle.prepare('INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)').run('s2', 'openai', 'Tracker fix');
  });

  afterEach(async () => {
    try { await sqlite.close(); } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips a trivial SELECT', async () => {
    const result = await sqlite.queryReadOnly<{ x: number }>('SELECT 1 AS x');
    expect(result.rows).toEqual([{ x: 1 }]);
  });

  it('returns rows for SELECT against a real table', async () => {
    const result = await sqlite.queryReadOnly<{ id: string; title: string }>(
      'SELECT id, title FROM ai_sessions ORDER BY id',
    );
    expect(result.rows).toEqual([
      { id: 's1', title: 'Auth refactor' },
      { id: 's2', title: 'Tracker fix' },
    ]);
  });

  it('rejects INSERT under query_only=ON', async () => {
    await expect(
      sqlite.queryReadOnly(`INSERT INTO ai_sessions(id, provider) VALUES ('x', 'y')`),
    ).rejects.toThrow(/non-SELECT|readonly|attempt to write/i);
  });

  it('rejects UPDATE under query_only=ON', async () => {
    await expect(
      sqlite.queryReadOnly(`UPDATE ai_sessions SET title = 'mutated' WHERE id = 's1'`),
    ).rejects.toThrow(/non-SELECT|readonly|attempt to write/i);
    // And the data wasn't actually mutated.
    const row = sqlite
      .getRawHandle()!
      .prepare('SELECT title FROM ai_sessions WHERE id = ?')
      .get('s1') as { title: string };
    expect(row.title).toBe('Auth refactor');
  });

  it('rejects DELETE under query_only=ON', async () => {
    await expect(
      sqlite.queryReadOnly(`DELETE FROM ai_sessions WHERE id = 's1'`),
    ).rejects.toThrow(/non-SELECT|readonly|attempt to write/i);
  });

  it('rejects DROP TABLE under query_only=ON', async () => {
    await expect(
      sqlite.queryReadOnly(`DROP TABLE ai_sessions`),
    ).rejects.toThrow(/non-SELECT|readonly|attempt to write/i);
  });

  it('clears query_only=ON after a successful read so subsequent writes succeed', async () => {
    await sqlite.queryReadOnly('SELECT COUNT(*) FROM ai_sessions');
    // A regular write through .query should work now.
    await sqlite.query(
      `INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)`,
      ['after-read', 'claude', 'After'],
    );
    const row = sqlite
      .getRawHandle()!
      .prepare('SELECT id FROM ai_sessions WHERE id = ?')
      .get('after-read') as { id: string } | undefined;
    expect(row?.id).toBe('after-read');
  });

  it('clears query_only=ON after a failed read so subsequent writes succeed', async () => {
    await expect(
      sqlite.queryReadOnly(`UPDATE ai_sessions SET title = 'no'`),
    ).rejects.toThrow();
    // PRAGMA query_only must be reset in `finally` -- subsequent writes work.
    await sqlite.query(
      `INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)`,
      ['recovered', 'claude', 'OK'],
    );
    const row = sqlite
      .getRawHandle()!
      .prepare('SELECT id FROM ai_sessions WHERE id = ?')
      .get('recovered') as { id: string } | undefined;
    expect(row?.id).toBe('recovered');
  });
});
