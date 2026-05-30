/**
 * Orchestrator end-to-end test: drives the full migration against a real
 * PGLite store + real SQLite, verifies the filesystem layout post-cutover,
 * and confirms the backend flag is written.
 *
 * We don't stub the migrator itself — this exercises the production code path
 * the cutover release will use.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { MigrationOrchestrator, type LivePgliteReader } from '../MigrationOrchestrator';
import type { PGLiteHandle } from '../PGLiteToSQLiteMigrator';

async function openPgliteReader(dataDir: string): Promise<{
  db: PGlite;
  reader: LivePgliteReader;
  close: () => Promise<void>;
}> {
  const db = new PGlite({ dataDir });
  await (db as unknown as { waitReady: Promise<void> }).waitReady;
  const reader: LivePgliteReader = {
    queryReadOnly: async <T,>(sql: string, params?: unknown[]) =>
      db.query<T>(sql, params) as Promise<{ rows: T[] }>,
  };
  return { db, reader, close: () => db.close() };
}

async function reopenPgliteHandle(dataDir: string): Promise<PGLiteHandle> {
  const db = new PGlite({ dataDir });
  await (db as unknown as { waitReady: Promise<void> }).waitReady;
  return {
    async query<T>(sql: string, params?: unknown[]) {
      return db.query<T>(sql, params as unknown[]) as Promise<{ rows: T[] }>;
    },
    async exec(sql: string) {
      return db.exec(sql);
    },
    async close() {
      await db.close();
    },
  };
}
import { readBackendState } from '../BackendSelector';
import { MigrationProgressReporter } from '../MigrationProgressReporter';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

describe('MigrationOrchestrator', () => {
  let tmp: string;
  let userDataPath: string;
  let pgliteDir: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-orch-'));
    userDataPath = tmp;
    pgliteDir = path.join(userDataPath, 'pglite-db');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function buildFixturePglite(): Promise<void> {
    fs.mkdirSync(pgliteDir, { recursive: true });
    const db = new PGlite({ dataDir: pgliteDir });
    await (db as unknown as { waitReady: Promise<void> }).waitReady;
    await db.exec(`
      CREATE TABLE worktrees (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_branch TEXT DEFAULT 'main',
        display_name TEXT,
        is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
        is_archived BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE ai_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        provider TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await db.query(
      `INSERT INTO ai_sessions(id, provider, title, metadata) VALUES ($1, $2, $3, $4::jsonb)`,
      ['s1', 'claude', 'one', JSON.stringify({ pinned: false })],
    );
    await db.close();
  }

  it('runs the full migration, renames pglite-db, writes the backend flag', async () => {
    await buildFixturePglite();

    const { reader, close } = await openPgliteReader(pgliteDir);
    const closeRunningPglite = vi.fn(async () => { await close(); });
    const cutoverSpy = vi.fn(async () => undefined);

    const orch = new MigrationOrchestrator({
      userDataPath,
      schemaDir: SCHEMA_DIR,
      pglite: reader,
      closeRunningPglite,
      reopenPgliteAfterClose: reopenPgliteHandle,
      onCutoverSuccess: cutoverSpy,
      log: () => {},
    });

    const pre = await orch.preflight();
    expect(pre.ok).toBe(true);
    expect(pre.pgliteDirBytes).toBeGreaterThan(0);

    const summary = await orch.run();
    expect(summary.foreignKeyViolations).toBe(0);
    expect(summary.integrityCheck).toBe('ok');

    // pglite-db/ has been renamed aside.
    expect(fs.existsSync(pgliteDir)).toBe(false);
    const migrated = fs.readdirSync(userDataPath).find((d) => d.startsWith('pglite-db.migrated-'));
    expect(migrated).toBeTruthy();

    // sqlite-db/ exists with the database file.
    expect(fs.existsSync(path.join(userDataPath, 'sqlite-db', 'nimbalyst.sqlite'))).toBe(true);

    // Backend flag written.
    const state = readBackendState(userDataPath);
    expect(state?.backend).toBe('sqlite');
    expect(state?.setBy).toBe('user-migration');
    expect(state?.pgliteMigratedDir).toContain('pglite-db.migrated-');

    expect(closeRunningPglite).toHaveBeenCalledTimes(1);
    expect(cutoverSpy).toHaveBeenCalledTimes(1);
  });

  it('on migration failure: removes partial sqlite-db, leaves pglite-db untouched, no flag written, broadcasts failed', async () => {
    await buildFixturePglite();

    // Trigger a failure by passing a schemaDir that doesn't exist; SQLiteDatabase
    // initialize will throw with no schema file present.
    const broadcast = vi.fn();
    const reporter = new MigrationProgressReporter({ throttleMs: 10, broadcast });
    const { reader, close } = await openPgliteReader(pgliteDir);

    const orch = new MigrationOrchestrator({
      userDataPath,
      schemaDir: path.join(tmp, 'no-such-schemas'),
      pglite: reader,
      closeRunningPglite: async () => { await close(); },
      reopenPgliteAfterClose: reopenPgliteHandle,
      reporter,
      log: () => {},
    });

    await expect(orch.run()).rejects.toThrow();

    // pglite-db/ still there.
    expect(fs.existsSync(pgliteDir)).toBe(true);
    // sqlite-db/ cleaned up.
    expect(fs.existsSync(path.join(userDataPath, 'sqlite-db'))).toBe(false);
    // No backend flag written.
    expect(readBackendState(userDataPath)).toBeNull();
    // Failed channel fired.
    const failedCall = broadcast.mock.calls.find((c) => c[0] === 'db:migration:failed');
    expect(failedCall).toBeTruthy();
  });

  it('preflight returns ok=false when no pglite-db directory exists', async () => {
    const stubReader: LivePgliteReader = {
      queryReadOnly: async () => ({ rows: [] }),
    };
    const orch = new MigrationOrchestrator({
      userDataPath,
      schemaDir: SCHEMA_DIR,
      pglite: stubReader,
      closeRunningPglite: async () => undefined,
      reopenPgliteAfterClose: reopenPgliteHandle,
    });
    const pre = await orch.preflight();
    expect(pre.ok).toBe(false);
    expect(pre.reason).toMatch(/No PGLite directory/i);
  });

  it('moves a leftover sqlite-db from a previous aborted run aside before starting', async () => {
    await buildFixturePglite();
    // Plant a sqlite-db with a marker file to verify it gets preserved aside.
    const stale = path.join(userDataPath, 'sqlite-db');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'stale-marker.txt'), 'I was here');

    const { reader, close } = await openPgliteReader(pgliteDir);
    const orch = new MigrationOrchestrator({
      userDataPath,
      schemaDir: SCHEMA_DIR,
      pglite: reader,
      closeRunningPglite: async () => { await close(); },
      reopenPgliteAfterClose: reopenPgliteHandle,
    });
    await orch.run();

    const aside = fs.readdirSync(userDataPath).find((d) => d.startsWith('sqlite-db.aborted-'));
    expect(aside).toBeTruthy();
    expect(fs.existsSync(path.join(userDataPath, aside!, 'stale-marker.txt'))).toBe(true);
  });

  it('captures writes that land after the bulk copy but before cutover', async () => {
    await buildFixturePglite();

    const { db, reader, close } = await openPgliteReader(pgliteDir);
    const closeRunningPglite = vi.fn(async () => {
      await db.query(
        `INSERT INTO ai_sessions(id, provider, title, metadata)
         VALUES ($1, $2, $3, $4::jsonb)`,
        ['late-write', 'claude', 'arrived during cutover', JSON.stringify({ pinned: true })],
      );
      await close();
    });

    const orch = new MigrationOrchestrator({
      userDataPath,
      schemaDir: SCHEMA_DIR,
      pglite: reader,
      closeRunningPglite,
      reopenPgliteAfterClose: reopenPgliteHandle,
    });

    await orch.run();

    const sqliteDir = path.join(userDataPath, 'sqlite-db');
    const sqlitePath = path.join(sqliteDir, 'nimbalyst.sqlite');
    expect(fs.existsSync(sqlitePath)).toBe(true);

    const sqliteDb = new (await import('../SQLiteDatabase')).SQLiteDatabase({
      dbDir: sqliteDir,
      schemaDir: SCHEMA_DIR,
    });
    await sqliteDb.initialize();
    const result = await sqliteDb.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ai_sessions WHERE id = $1`,
      ['late-write'],
    );
    expect(Number(result.rows[0]?.c ?? 0)).toBe(1);
    await sqliteDb.close();
  });
});
