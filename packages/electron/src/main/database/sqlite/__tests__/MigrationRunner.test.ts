// @vitest-environment node
/**
 * Tests for the SQLite migration runner using a fake database handle.
 * Doesn't require better-sqlite3 to be installed; only exercises the runner's
 * orchestration logic (ordering, idempotency, the _migrations ledger).
 *
 * The end-of-file block also runs the real bundled migrations against an
 * `:memory:` better-sqlite3 database to verify the on-disk SQL is valid and
 * produces the expected end-state schema (columns, indexes, triggers).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'node:worker_threads';
import { getMigrations, runMigrations, type Migration } from '../MigrationRunner';
import { SQLiteDatabase } from '../SQLiteDatabase';
import { diskStampUpsertSql, parseDiskStamp } from '../../../services/projectFileSyncDiskCache';

/**
 * Stage a no-op .sql for every migration the runner expects, and return their
 * versions in order. Derived from `getMigrations` so adding a migration does
 * not mean hand-editing a parallel list here -- that list went stale on every
 * new schema file.
 */
function stageMigrationFiles(dir: string, overrides: Record<string, string> = {}): number[] {
  const versions: number[] = [];
  for (const migration of getMigrations(dir)) {
    const sqlFile = (migration as { sqlFile?: string }).sqlFile;
    if (sqlFile) {
      const name = path.basename(sqlFile);
      fs.writeFileSync(sqlFile, overrides[name] ?? '-- noop\n');
    }
    versions.push(migration.version);
  }
  return versions.sort((a, b) => a - b);
}

/** Bare-minimum mock that supports the bits MigrationRunner touches. */
class FakeDb {
  // Map from version -> migration row.
  private migrations: Array<{ version: number; name: string }> = [];
  public execs: string[] = [];

  exec(sql: string) {
    this.execs.push(sql);
    if (/CREATE TABLE IF NOT EXISTS _migrations/i.test(sql)) {
      // ok
    }
  }

  prepare(sql: string) {
    if (/SELECT version FROM _migrations/i.test(sql)) {
      return {
        all: () => this.migrations.map((m) => ({ version: m.version })),
        get: (version: number) => this.migrations.find((m) => m.version === version),
      };
    }
    if (/INSERT INTO _migrations/i.test(sql)) {
      return {
        run: (version: number, name: string) => {
          this.migrations.push({ version, name });
        },
      };
    }
    throw new Error(`unexpected prepare: ${sql}`);
  }

  transaction<T extends (...args: any[]) => any>(fn: T): T & { immediate: T } {
    const wrapped = ((...args: any[]) => fn(...args)) as T & { immediate: T };
    wrapped.immediate = wrapped;
    return wrapped;
  }
}

describe('runMigrations', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-migrations-'));
  });

  it('applies migrations in version order and records them', () => {
    // Stage every migration the runner knows about; versions come back in order.
    const expectedVersions = stageMigrationFiles(tmp);

    const db = new FakeDb();
    // Hack: inject our own migration list via reflection-equivalent. Re-using
    // the real getMigrations() requires reading 0001_initial.sql; we want to
    // exercise the ordering logic with custom entries.
    const customs: Migration[] = [
      { version: 2, name: 'second', sql: 'SELECT 2' },
      { version: 1, name: 'first', sql: 'SELECT 1' },
    ];
    // The simplest way to test ordering is to call the runner directly with
    // a stand-in implementation; for now, test the file-backed path with the
    // bundled migrations.
    const result = runMigrations(db as unknown as import('better-sqlite3').Database, tmp);
    expect(result.applied).toEqual(expectedVersions);
    expect(result.skipped).toEqual([]);

    // Second invocation: nothing to apply, all skipped.
    const result2 = runMigrations(db as unknown as import('better-sqlite3').Database, tmp);
    expect(result2.applied).toEqual([]);
    expect(result2.skipped).toEqual(expectedVersions);

    // Anti-flake: unused locals lint silencer.
    void customs;
  });

  it('reads the migration SQL from disk and execs it', () => {
    // Real SQL for the two under test; no-ops for the rest.
    stageMigrationFiles(tmp, {
      '0001_initial.sql': 'CREATE TABLE foo (id INTEGER PRIMARY KEY);',
      '0002_pending_files_index.sql': 'CREATE INDEX bar ON foo(id);',
    });

    const db = new FakeDb();
    runMigrations(db as unknown as import('better-sqlite3').Database, tmp);
    expect(db.execs.some((s) => s.includes('CREATE TABLE foo'))).toBe(true);
    expect(db.execs.some((s) => s.includes('CREATE INDEX bar'))).toBe(true);
  });

  it('is idempotent when two SQLite connections initialize the same database concurrently', async () => {
    for (const migration of getMigrations(tmp)) {
      if (migration.sqlFile) {
        fs.writeFileSync(migration.sqlFile, '-- noop\n');
      }
    }

    const dbPath = path.join(tmp, 'concurrent.sqlite');
    const runnerPath = path.resolve(__dirname, '..', 'MigrationRunner.ts');
    const betterSqlitePath = require.resolve('better-sqlite3');
    const snapshotBarrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);

    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const BetterSqlite = require(workerData.betterSqlitePath);
      const { runMigrations } = require(workerData.runnerPath);
      const raw = new BetterSqlite(workerData.dbPath, { timeout: 10_000 });
      const barrier = new Int32Array(workerData.snapshotBarrier);
      const db = {
        exec: raw.exec.bind(raw),
        transaction: raw.transaction.bind(raw),
        prepare(sql) {
          const statement = raw.prepare(sql);
          if (!/SELECT version FROM _migrations ORDER BY version ASC/i.test(sql)) {
            return statement;
          }
          return {
            all() {
              const rows = statement.all();
              const arrivals = Atomics.add(barrier, 0, 1) + 1;
              if (arrivals < 2) {
                Atomics.wait(barrier, 0, arrivals, 10_000);
              } else {
                Atomics.notify(barrier, 0);
              }
              return rows;
            },
          };
        },
      };
      try {
        const result = runMigrations(db, workerData.schemaDir);
        parentPort.postMessage({ ok: true, result });
      } catch (error) {
        parentPort.postMessage({
          ok: false,
          error: {
            name: error?.name,
            message: error?.message,
            code: error?.code,
          },
        });
      } finally {
        raw.close();
      }
    `;

    const runWorker = () => new Promise<{
      ok: boolean;
      error?: { name?: string; message?: string; code?: string };
    }>((resolve, reject) => {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: {
          betterSqlitePath,
          runnerPath,
          dbPath,
          schemaDir: tmp,
          snapshotBarrier,
        },
      });
      worker.once('message', resolve);
      worker.once('error', reject);
    });

    const outcomes = await Promise.all([runWorker(), runWorker()]);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
  });
});

describe('runMigrations against the real schema dir', () => {
  it('applies 0003 and adds searchable_text + message_kind to ai_agent_messages', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-mig-real-'));
    const schemaDir = path.resolve(__dirname, '..', 'schemas');
    const sqlite = new SQLiteDatabase({
      dbDir: tmpDir,
      schemaDir,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    try {
      await sqlite.initialize();
      const handle = sqlite.getRawHandle()!;

      const versions = handle
        .prepare(`SELECT version FROM _migrations ORDER BY version ASC`)
        .all() as Array<{ version: number }>;
      expect(versions.map((v) => v.version)).toContain(3);

      const cols = handle
        .prepare(`PRAGMA table_info(ai_agent_messages)`)
        .all() as Array<{ name: string; type: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain('searchable_text');
      expect(colNames).toContain('message_kind');

      const sText = cols.find((c) => c.name === 'searchable_text');
      const mKind = cols.find((c) => c.name === 'message_kind');
      expect(sText?.type).toBe('TEXT');
      expect(mKind?.type).toBe('TEXT');

      const replicaCols = handle
        .prepare(`PRAGMA table_info(collab_document_replicas)`)
        .all() as Array<{ name: string }>;
      expect(replicaCols.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          'staged_encrypted_snapshot',
          'staged_snapshot_generation',
          'staged_snapshot_checksum',
          'staged_encoding_version',
          'staged_snapshot_token',
          'snapshot_commit_token',
          'quarantine_reason',
          'quarantined_at',
        ]),
      );
    } finally {
      await sqlite.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies 0055 once across reopens and round-trips tracker_transactions.base_sync_id', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-mig-0055-'));
    const open = async () => {
      const sqlite = new SQLiteDatabase({ dbDir: tmpDir, schemaDir: path.resolve(__dirname, '..', 'schemas'), slowQueryThresholdMs: 1000, sampleRate: 0 });
      await sqlite.initialize();
      return sqlite;
    };
    let sqlite = await open();
    try {
      await sqlite.query(
        `INSERT INTO tracker_transactions (client_mutation_id, item_id, workspace_path, state, kind, payload, base_sync_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['m1', 'item', '/workspace', 'queued', 'update', '{}', 42],
      );
      // A second launch must neither re-run the ALTER (duplicate column) nor lose the value.
      await sqlite.close();
      sqlite = await open();
      const handle = sqlite.getRawHandle()!;
      expect(handle.prepare(`SELECT COUNT(*) AS n FROM _migrations WHERE version = 55`).get()).toEqual({ n: 1 });
      const { rows } = await sqlite.query<{ base_sync_id: number | null }>(`SELECT base_sync_id FROM tracker_transactions WHERE client_mutation_id = $1`, ['m1']);
      expect(rows.map(row => Number(row.base_sync_id))).toEqual([42]);
    } finally {
      await sqlite.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies 0054: the stamp upsert moves only the disk columns of an existing baseline row', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-mig-0054-'));
    const sqlite = new SQLiteDatabase({
      dbDir: tmpDir,
      schemaDir: path.resolve(__dirname, '..', 'schemas'),
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    try {
      await sqlite.initialize();
      await sqlite.query(
        `INSERT INTO project_file_sync_baseline (project_id, sync_id, content_hash, last_synced_mtime, updated_at)
         VALUES ($1, $2, $3, $4, $5)`,
        ['p', 's1', 'agreed', 100, new Date()],
      );
      // Two rows in one statement: one existing, one without a baseline yet.
      await sqlite.query(diskStampUpsertSql(2), [
        'p', 's1', 'ignored', 999, new Date(), 'disk-1', 12, 200,
        'p', 's2', 'base-2', 300, new Date(), 'disk-2', 34, 300,
      ]);
      const { rows } = await sqlite.query<Record<string, unknown>>(
        `SELECT sync_id, content_hash, last_synced_mtime, disk_hash, disk_size, disk_mtime
         FROM project_file_sync_baseline WHERE project_id = $1 ORDER BY sync_id`,
        ['p'],
      );
      expect(rows.map((r) => [r.sync_id, r.content_hash, Number(r.last_synced_mtime)])).toEqual([
        ['s1', 'agreed', 100],
        ['s2', 'base-2', 300],
      ]);
      expect(rows.map((r) => parseDiskStamp(r))).toEqual([
        { hash: 'disk-1', size: 12, mtime: 200 },
        { hash: 'disk-2', size: 34, mtime: 300 },
      ]);
    } finally {
      await sqlite.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
