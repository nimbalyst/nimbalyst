/**
 * MigrationDryRunner — confirms a dry run produces real stats without
 * touching pglite-db/ or the backend flag, and that the temp SQLite dir is
 * cleaned up on both success and failure.
 *
 * The "live worker" stand-in is a PGLite instance held open across the test;
 * the adapter routes the migrator's reads through its `queryReadOnly`
 * surface (same shape PGLiteDatabaseWorker exposes in production).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MigrationDryRunner, type LivePgliteReader } from '../MigrationDryRunner';
import { MigrationProgressReporter } from '../MigrationProgressReporter';
import { readBackendState } from '../BackendSelector';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

/** Adapter around a PGlite instance that mimics PGLiteDatabaseWorker.queryReadOnly. */
function liveWorker(pglite: PGlite): LivePgliteReader {
  return {
    async queryReadOnly<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      const res = await pglite.query<T>(sql, params as unknown[]);
      return { rows: res.rows };
    },
  };
}

describe('MigrationDryRunner', () => {
  let tmp: string;
  let userDataPath: string;
  let pgliteDir: string;
  let pglite: PGlite;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-dryrun-'));
    userDataPath = tmp;
    pgliteDir = path.join(userDataPath, 'pglite-db');
    fs.mkdirSync(pgliteDir, { recursive: true });

    pglite = new PGlite({ dataDir: pgliteDir });
    await (pglite as unknown as { waitReady: Promise<void> }).waitReady;

    // Seed a minimal but realistic shape.
    await pglite.exec(`
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
    for (let i = 0; i < 25; i++) {
      await pglite.query(
        `INSERT INTO ai_sessions(id, provider, title) VALUES ($1, $2, $3)`,
        [`s${i}`, 'claude', `Title ${i}`],
      );
    }
  });

  afterEach(async () => {
    await pglite.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('waits for an in-flight source read before cancelling and preserves the previous successful artifact', async () => {
    const previous = path.join(tmp, 'sqlite-db.dry-run-previous');
    fs.mkdirSync(previous);
    fs.writeFileSync(path.join(previous, '.dry-run-manifest.json'), 'previous successful result');
    const cancellation = new Int32Array(new SharedArrayBuffer(4));
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const reader: LivePgliteReader = { queryReadOnly: async <T,>(sql: string, params?: unknown[]) => {
      entered(); await blocked;
      return liveWorker(pglite).queryReadOnly<T>(sql, params);
    } };
    const run = new MigrationDryRunner({ userDataPath, schemaDir: SCHEMA_DIR, pglite: reader, cancellation: cancellation.buffer as SharedArrayBuffer }).run();
    const rejection = expect(run).rejects.toThrow(/cancelled/);
    await started;
    Atomics.store(cancellation, 0, 1);
    await Promise.resolve();
    expect(fs.readdirSync(tmp).filter(name => name.startsWith('sqlite-db.dry-run-'))).toHaveLength(2);
    release();
    await rejection;
    expect(fs.readdirSync(tmp).filter(name => name.startsWith('sqlite-db.dry-run-'))).toEqual(['sqlite-db.dry-run-previous']);
    expect((await pglite.query('SELECT COUNT(*)::int AS n FROM ai_sessions')).rows).toEqual([{ n: 25 }]);
    expect(readBackendState(tmp)).toBeNull();
  });

  it('runs end-to-end and returns stats without touching pglite-db or writing the flag', async () => {
    const runner = new MigrationDryRunner({
      userDataPath,
      schemaDir: SCHEMA_DIR,
      pglite: liveWorker(pglite),
      // Force cleanup; the default is now to retain artifacts for adoption.
      keepArtifacts: false,
    });

    const result = await runner.run();

    expect(result.summary.totalRowsCopied).toBe(25);
    expect(result.summary.foreignKeyViolations).toBe(0);
    expect(result.summary.integrityCheck).toBe('ok');
    expect(result.sqliteFileBytes).toBeGreaterThan(0);
    expect(result.pgliteDirBytes).toBeGreaterThan(0);

    // pglite-db/ still there, untouched.
    expect(fs.existsSync(pgliteDir)).toBe(true);
    // dry-run dir cleaned up.
    expect(fs.existsSync(result.dryRunDir)).toBe(false);
    // No `pglite-db.migrated-*` aside.
    expect(
      fs.readdirSync(userDataPath).some((d) => d.startsWith('pglite-db.migrated-')),
    ).toBe(false);
    // No backend flag.
    expect(readBackendState(userDataPath)).toBeNull();
  });

  it('keepArtifacts=true leaves the dry-run dir for inspection', async () => {
    const runner = new MigrationDryRunner({
      userDataPath,
      schemaDir: SCHEMA_DIR,
      pglite: liveWorker(pglite),
      keepArtifacts: true,
    });
    const result = await runner.run();
    expect(fs.existsSync(result.dryRunDir)).toBe(true);
    expect(
      fs.existsSync(path.join(result.dryRunDir, 'nimbalyst.sqlite')),
    ).toBe(true);
    fs.rmSync(result.dryRunDir, { recursive: true, force: true });
  });

  it('streams progress events through the reporter and emits complete (not failed)', async () => {
    const broadcast = vi.fn();
    const reporter = new MigrationProgressReporter({ throttleMs: 10, broadcast });
    const runner = new MigrationDryRunner({
      userDataPath,
      schemaDir: SCHEMA_DIR,
      pglite: liveWorker(pglite),
      reporter,
    });
    await runner.run();

    const channels = broadcast.mock.calls.map((c) => c[0]);
    expect(channels).toContain('db:migration:progress');
    expect(channels).toContain('db:migration:complete');
    expect(channels).not.toContain('db:migration:failed');
  });

  it('cleans up the dry-run dir on failure (schemaDir missing)', async () => {
    const runner = new MigrationDryRunner({
      userDataPath,
      schemaDir: path.join(tmp, 'no-such-schemas'),
      pglite: liveWorker(pglite),
    });
    await expect(runner.run()).rejects.toThrow();

    // pglite still untouched.
    expect(fs.existsSync(pgliteDir)).toBe(true);
    // No leftover dry-run dirs.
    const leftover = fs.readdirSync(userDataPath).filter((d) => d.startsWith('sqlite-db.dry-run-'));
    expect(leftover).toEqual([]);
    // No flag.
    expect(readBackendState(userDataPath)).toBeNull();
  });

  it('routes ALL migrator queries through queryReadOnly (live worker stays write-safe)', async () => {
    const readOnlyCalls: string[] = [];
    const writeBlocker: LivePgliteReader = {
      async queryReadOnly<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        readOnlyCalls.push(sql.replace(/\s+/g, ' ').slice(0, 80));
        const res = await pglite.query<T>(sql, params as unknown[]);
        return { rows: res.rows };
      },
    };
    const runner = new MigrationDryRunner({
      userDataPath,
      schemaDir: SCHEMA_DIR,
      pglite: writeBlocker,
    });
    await runner.run();

    expect(readOnlyCalls.length).toBeGreaterThan(0);
    expect(readOnlyCalls.every((s) => !/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)/i.test(s))).toBe(true);
  });
});
