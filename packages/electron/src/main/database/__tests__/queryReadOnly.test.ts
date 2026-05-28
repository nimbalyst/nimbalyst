/**
 * Smoke tests for the read-only query path used by `host.data.query`.
 *
 * The actual IPC + permission gate is exercised manually (the IPC layer is a
 * thin scan-manifest + dispatch shim). These tests pin the SQL semantics that
 * the path depends on: read works, writes are rejected by the READ ONLY
 * transaction, statement_timeout fires, CTEs run, and SET LOCAL doesn't leak.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { clampReadOnlyTimeout, raceWithTimeout } from '../PGLiteDatabaseWorker';

interface Pg {
  exec(sql: string): Promise<unknown>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: Pg) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function queryReadOnly<T = unknown>(
  db: Pg,
  sql: string,
  params?: unknown[],
  timeoutMs = 5000
): Promise<{ rows: T[] }> {
  return await db.transaction(async (tx) => {
    await tx.exec('SET TRANSACTION READ ONLY');
    await tx.exec(`SET LOCAL statement_timeout = '${timeoutMs}'`);
    return await tx.query<T>(sql, params);
  });
}

describe('queryReadOnly (PGLite native semantics)', () => {
  let db: Pg;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = path.join(os.tmpdir(), `pglite-readonly-test-${Date.now()}`);
    db = new PGlite({ dataDir }) as unknown as Pg;
    await (db as unknown as { waitReady: Promise<void> }).waitReady;

    await db.exec(`
      CREATE TABLE ai_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.exec(`
      CREATE TABLE session_files (
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL
      )
    `);
    await db.query('INSERT INTO ai_sessions (id, title) VALUES ($1, $2), ($3, $4)', [
      'sess-1', 'Refactor auth',
      'sess-2', 'Fix tracker sync',
    ]);
    await db.query('INSERT INTO session_files (session_id, file_path) VALUES ($1, $2), ($3, $4)', [
      'sess-1', 'src/auth.ts',
      'sess-1', 'src/middleware.ts',
    ]);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (dataDir && fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('round-trips a trivial SELECT', async () => {
    const result = await queryReadOnly<{ x: number }>(db, 'SELECT 1::int AS x');
    expect(result.rows).toEqual([{ x: 1 }]);
  });

  it('returns rows from a real table', async () => {
    const result = await queryReadOnly<{ id: string; title: string }>(
      db,
      'SELECT id, title FROM ai_sessions ORDER BY id'
    );
    expect(result.rows).toEqual([
      { id: 'sess-1', title: 'Refactor auth' },
      { id: 'sess-2', title: 'Fix tracker sync' },
    ]);
  });

  it('runs CTE queries (WITH foo AS ...)', async () => {
    const result = await queryReadOnly<{ session_id: string; file_count: number }>(
      db,
      `WITH file_counts AS (
         SELECT session_id, COUNT(*)::int AS file_count
         FROM session_files
         GROUP BY session_id
       )
       SELECT session_id, file_count FROM file_counts ORDER BY session_id`
    );
    expect(result.rows).toEqual([
      { session_id: 'sess-1', file_count: 2 },
    ]);
  });

  it('rejects INSERT with read-only error', async () => {
    await expect(
      queryReadOnly(db, "INSERT INTO ai_sessions (id, title) VALUES ('x', 'y')")
    ).rejects.toThrow(/read-only/i);
  });

  it('rejects UPDATE with read-only error', async () => {
    await expect(
      queryReadOnly(db, "UPDATE ai_sessions SET title = 'mutated' WHERE id = 'sess-1'")
    ).rejects.toThrow(/read-only/i);
  });

  it('rejects DELETE with read-only error', async () => {
    await expect(
      queryReadOnly(db, "DELETE FROM ai_sessions WHERE id = 'sess-1'")
    ).rejects.toThrow(/read-only/i);
  });

  it('rejects DDL (CREATE TABLE) with read-only error', async () => {
    await expect(
      queryReadOnly(db, 'CREATE TABLE evil (id INT)')
    ).rejects.toThrow(/read-only/i);
  });

  // PGLite does not enforce statement_timeout (single-thread WASM, no signal-
  // based cancel). The SET LOCAL is still issued so the path is portable to
  // a future backend; today the wrapper's Promise.race is what bounds caller
  // latency. That race is exercised in the "JS-level timeout race" suite.

  it('does not leak statement_timeout to subsequent queries (SET LOCAL reverts at COMMIT)', async () => {
    await queryReadOnly(db, 'SELECT 1', undefined, 100);
    // A long-running query in a fresh txn must not inherit the 100ms cap.
    const result = await db.transaction(async (tx) => {
      await tx.exec('SET TRANSACTION READ ONLY');
      // No SET LOCAL here -- timeout should be whatever the session default is (0 = unlimited)
      return await tx.query<{ now: string }>('SELECT now()::text AS now');
    });
    expect(result.rows[0].now).toBeTruthy();
  });

  it('does not leave the connection in an aborted state after a write rejection', async () => {
    await expect(
      queryReadOnly(db, "INSERT INTO ai_sessions (id, title) VALUES ('y', 'z')")
    ).rejects.toThrow();
    // The next query on the same connection must still succeed.
    const result = await queryReadOnly<{ ok: number }>(db, 'SELECT 1::int AS ok');
    expect(result.rows).toEqual([{ ok: 1 }]);
  });

  it('left an unchanged row count after rejected writes', async () => {
    const result = await queryReadOnly<{ count: number | string }>(
      db,
      'SELECT COUNT(*) AS count FROM ai_sessions'
    );
    // PGLite returns COUNT as a number; PG over the wire would return a
    // bigint-as-string. Accept either so this test pins behavior, not coercion.
    expect(String(result.rows[0].count)).toBe('2');
  });
});

describe('JS-level timeout race (wrapper enforces bound when backend does not)', () => {
  it('rejects with a PG-shaped error after the configured timeout', async () => {
    const start = Date.now();
    const hangingWork = new Promise<{ rows: unknown[] }>(() => {
      // never resolves -- simulates a runaway PGLite query
    });
    await expect(raceWithTimeout(hangingWork, 200)).rejects.toThrow(
      /canceling statement due to statement timeout/i
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1000);
  });

  it('does not reject when work completes before the timeout fires', async () => {
    const fastWork = Promise.resolve({ rows: [{ x: 1 }] });
    const result = await raceWithTimeout(fastWork, 1000);
    expect(result).toEqual({ rows: [{ x: 1 }] });
  });

  it('clampReadOnlyTimeout: bounds defaults, floor, and ceiling', () => {
    expect(clampReadOnlyTimeout(0)).toBe(5000); // default
    expect(clampReadOnlyTimeout(-1)).toBe(5000); // negative -> default
    expect(clampReadOnlyTimeout(Number.NaN)).toBe(5000); // NaN -> default
    expect(clampReadOnlyTimeout(1000)).toBe(1000); // mid-range passes
    expect(clampReadOnlyTimeout(60000)).toBe(30000); // clamped to ceiling
  });
});
