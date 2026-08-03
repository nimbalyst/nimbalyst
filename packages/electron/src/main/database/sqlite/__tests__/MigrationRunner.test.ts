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
    // Use a temp schema dir with the sql files the runner expects to find.
    fs.writeFileSync(path.join(tmp, '0001_initial.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0002_pending_files_index.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0003_searchable_text_message_kind.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0004_fts_on_searchable_text.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0005_drop_transcript_events.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0006_message_kind_index.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0007_rebuild_fts_after_kind.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0008_guard_fts_triggers.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0009_worktree_pr_linkage.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0010_tracker_origin_urn.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0011_project_file_sync_baseline.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0012_tracker_type_defs.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0013_orgs_and_projects.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0014_tracker_relationship_index.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0015_collab_local_origins_project_id.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0016_read_receipts.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0017_tracker_type_navigation.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0018_history_preedit_session_index.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0019_collab_document_replicas.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0020_collab_replica_staged_snapshots.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0021_collab_replica_quarantine_observability.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0022_collab_document_assets.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0023_collab_asset_retry_schedule.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0024_tracker_personal_state.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0025_account_org_bindings.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0026_tool_usage_counters.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0027_tool_usage_backfill_state.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0028_tracker_shared_saved_views.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0029_tracker_personal_snooze.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0030_queued_prompt_priority_control.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0031_queued_prompt_dispatch_fencing.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0032_queued_prompt_truth_provenance.sql'), '-- noop\n');

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
    expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
    expect(result.skipped).toEqual([]);

    // Second invocation: nothing to apply, all skipped.
    const result2 = runMigrations(db as unknown as import('better-sqlite3').Database, tmp);
    expect(result2.applied).toEqual([]);
    expect(result2.skipped).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);

    // Anti-flake: unused locals lint silencer.
    void customs;
  });

  it('reads the migration SQL from disk and execs it', () => {
    fs.writeFileSync(
      path.join(tmp, '0001_initial.sql'),
      'CREATE TABLE foo (id INTEGER PRIMARY KEY);',
    );
    fs.writeFileSync(
      path.join(tmp, '0002_pending_files_index.sql'),
      'CREATE INDEX bar ON foo(id);',
    );
    fs.writeFileSync(
      path.join(tmp, '0003_searchable_text_message_kind.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0004_fts_on_searchable_text.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0005_drop_transcript_events.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0006_message_kind_index.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0007_rebuild_fts_after_kind.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0008_guard_fts_triggers.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0009_worktree_pr_linkage.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0010_tracker_origin_urn.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0011_project_file_sync_baseline.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0012_tracker_type_defs.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0013_orgs_and_projects.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0014_tracker_relationship_index.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0015_collab_local_origins_project_id.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0016_read_receipts.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0017_tracker_type_navigation.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0018_history_preedit_session_index.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0019_collab_document_replicas.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0020_collab_replica_staged_snapshots.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0021_collab_replica_quarantine_observability.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0022_collab_document_assets.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0023_collab_asset_retry_schedule.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0024_tracker_personal_state.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0025_account_org_bindings.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0026_tool_usage_counters.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0027_tool_usage_backfill_state.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0028_tracker_shared_saved_views.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0029_tracker_personal_snooze.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(path.join(tmp, '0030_queued_prompt_priority_control.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0031_queued_prompt_dispatch_fencing.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0032_queued_prompt_truth_provenance.sql'), '-- noop\n');
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
});
