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
import { runMigrations, type Migration } from '../MigrationRunner';
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

  transaction<T extends (...args: any[]) => any>(fn: T): T {
    return ((...args: any[]) => fn(...args)) as T;
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
    fs.writeFileSync(path.join(tmp, '0026_queued_prompt_priority_control.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0027_host_control_receipts.sql'), '-- noop\n');

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
    expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);
    expect(result.skipped).toEqual([]);

    // Second invocation: nothing to apply, all skipped.
    const result2 = runMigrations(db as unknown as import('better-sqlite3').Database, tmp);
    expect(result2.applied).toEqual([]);
    expect(result2.skipped).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);

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
      path.join(tmp, '0026_queued_prompt_priority_control.sql'),
      '-- noop\n',
    );
    fs.writeFileSync(
      path.join(tmp, '0027_host_control_receipts.sql'),
      '-- noop\n',
    );
    const db = new FakeDb();
    runMigrations(db as unknown as import('better-sqlite3').Database, tmp);
    expect(db.execs.some((s) => s.includes('CREATE TABLE foo'))).toBe(true);
    expect(db.execs.some((s) => s.includes('CREATE INDEX bar'))).toBe(true);
  });
});

describe('runMigrations against the real schema dir', () => {
  it('applies the bundled schema through version 27 with host-control receipt parity', async () => {
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
      expect(versions.map((v) => v.version)).toContain(26);
      expect(versions.map((v) => v.version)).toContain(27);

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

      const queuedPromptColumns = handle
        .prepare(`PRAGMA table_info(queued_prompts)`)
        .all() as Array<{ name: string; type: string }>;
      expect(queuedPromptColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          'delivery_class',
          'priority_rank',
          'producer',
          'idempotency_key',
          'request_digest',
          'control_operation',
          'interrupt_target_generation',
          'interrupt_receipt',
        ]),
      );

      const queuedPromptIndexes = handle
        .prepare(`PRAGMA index_list(queued_prompts)`)
        .all() as Array<{ name: string; unique: number; partial: number }>;
      expect(queuedPromptIndexes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'idx_queued_prompts_pending_priority',
          unique: 0,
          partial: 1,
        }),
        expect.objectContaining({
          name: 'idx_queued_prompts_idempotency_key',
          unique: 1,
          partial: 1,
        }),
      ]));

      handle.prepare(`INSERT INTO ai_sessions(id, provider) VALUES (?, ?)`).run('queue-session', 'claude');
      handle.prepare(`
        INSERT INTO queued_prompts(
          id, session_id, prompt, delivery_class, priority_rank, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('control-1', 'queue-session', 'control', 'control', 100, 'duplicate-key');
      expect(() => handle.prepare(`
        INSERT INTO queued_prompts(
          id, session_id, prompt, delivery_class, priority_rank, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('control-2', 'queue-session', 'control', 'control', 100, 'duplicate-key')).toThrow();
      expect(() => handle.prepare(`
        INSERT INTO queued_prompts(id, session_id, prompt, delivery_class)
        VALUES (?, ?, ?, ?)
      `).run('invalid-class', 'queue-session', 'invalid', 'urgent')).toThrow();

      const receiptColumns = handle
        .prepare(`PRAGMA table_info(host_control_receipts)`)
        .all() as Array<{ name: string }>;
      expect(receiptColumns.map((column) => column.name)).toEqual([
        'id', 'reservation_key', 'request_digest', 'operation', 'session_id',
        'event_identity', 'attention_generation', 'state', 'receipt',
        'created_at', 'updated_at',
      ]);
      handle.prepare(`
        INSERT INTO host_control_receipts(
          id, reservation_key, request_digest, operation, session_id,
          event_identity, state)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'receipt-1', 'attention-reply:watch-1', 'digest-1',
        'inject_attention_reply', 'queue-session', 'prompt-1', 'reserved',
      );
      expect(() => handle.prepare(`
        INSERT INTO host_control_receipts(
          id, reservation_key, request_digest, operation, session_id,
          event_identity, state)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'receipt-2', 'attention-reply:watch-1', 'digest-2',
        'inject_attention_reply', 'queue-session', 'prompt-2', 'reserved',
      )).toThrow();
    } finally {
      await sqlite.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('upgrades a version-26 database with both durable control tables idempotently', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-mig-v26-'));
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
      handle.exec(`
        DROP TABLE native_winner_outbox;
        DROP TABLE host_control_receipts;
        DELETE FROM _migrations WHERE version = 27;
      `);

      const upgraded = runMigrations(handle, schemaDir);
      expect(upgraded.applied).toEqual([27]);
      expect(handle.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('host_control_receipts', 'native_winner_outbox')
        ORDER BY name
      `).all()).toEqual([
        { name: 'host_control_receipts' },
        { name: 'native_winner_outbox' },
      ]);

      const rerun = runMigrations(handle, schemaDir);
      expect(rerun.applied).toEqual([]);
      expect(rerun.skipped).toContain(27);
    } finally {
      await sqlite.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('upgrades a version-25 queued_prompts table idempotently without losing rows', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-mig-v25-'));
    const schemaDir = path.join(tmpDir, 'schemas');
    fs.mkdirSync(schemaDir);
    fs.writeFileSync(path.join(schemaDir, '0001_initial.sql'), `
      CREATE TABLE ai_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE queued_prompts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attachments TEXT,
        document_context TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        claimed_at TEXT,
        completed_at TEXT,
        error_message TEXT,
        FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
      );
    `);
    for (let version = 2; version <= 24; version += 1) {
      const migrationName = [
        '', '', 'pending_files_index', 'searchable_text_message_kind',
        'fts_on_searchable_text', 'drop_transcript_events', 'message_kind_index',
        'rebuild_fts_after_kind', 'guard_fts_triggers', 'worktree_pr_linkage',
        'tracker_origin_urn', 'project_file_sync_baseline', 'tracker_type_defs',
        'orgs_and_projects', 'tracker_relationship_index',
        'collab_local_origins_project_id', 'read_receipts', 'tracker_type_navigation',
        'history_preedit_session_index', 'collab_document_replicas',
        'collab_replica_staged_snapshots', 'collab_replica_quarantine_observability',
        'collab_document_assets', 'collab_asset_retry_schedule', 'tracker_personal_state',
      ][version];
      fs.writeFileSync(
        path.join(schemaDir, `${String(version).padStart(4, '0')}_${migrationName}.sql`),
        '-- noop\n',
      );
    }
    fs.writeFileSync(path.join(schemaDir, '0025_account_org_bindings.sql'), `
      INSERT INTO ai_sessions(id) VALUES ('session-v25');
      INSERT INTO queued_prompts(id, session_id, prompt)
      VALUES ('prompt-v25', 'session-v25', 'survive migration');
    `);
    fs.copyFileSync(
      path.resolve(__dirname, '..', 'schemas', '0026_queued_prompt_priority_control.sql'),
      path.join(schemaDir, '0026_queued_prompt_priority_control.sql'),
    );
    fs.copyFileSync(
      path.resolve(__dirname, '..', 'schemas', '0027_host_control_receipts.sql'),
      path.join(schemaDir, '0027_host_control_receipts.sql'),
    );

    const sqlite = new SQLiteDatabase({
      dbDir: path.join(tmpDir, 'db'),
      schemaDir,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    try {
      await sqlite.initialize();
      const handle = sqlite.getRawHandle()!;
      const row = handle.prepare(`
        SELECT id, prompt, delivery_class, priority_rank, request_digest
        FROM queued_prompts WHERE id = ?
      `).get('prompt-v25') as {
        id: string;
        prompt: string;
        delivery_class: string;
        priority_rank: number;
        request_digest: string | null;
      };
      expect(row).toEqual({
        id: 'prompt-v25',
        prompt: 'survive migration',
        delivery_class: 'ordinary',
        priority_rank: 0,
        request_digest: null,
      });
      const upgradedIndexes = handle
        .prepare(`PRAGMA index_list(queued_prompts)`)
        .all() as Array<{ name: string; unique: number; partial: number }>;
      expect(upgradedIndexes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'idx_queued_prompts_pending_priority',
          unique: 0,
          partial: 1,
        }),
        expect.objectContaining({
          name: 'idx_queued_prompts_idempotency_key',
          unique: 1,
          partial: 1,
        }),
      ]));
      expect(() => handle.prepare(`
        INSERT INTO queued_prompts(id, session_id, prompt, delivery_class)
        VALUES (?, ?, ?, ?)
      `).run('invalid-v25-class', 'session-v25', 'invalid', 'urgent')).toThrow();

      const rerun = runMigrations(handle, schemaDir);
      expect(rerun.applied).toEqual([]);
      expect(rerun.skipped).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
        14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
      ]);
    } finally {
      await sqlite.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
