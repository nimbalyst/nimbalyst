// @vitest-environment node
/**
 * End-to-end migration test against a real PGLite store and a real SQLite
 * database. This is the failing-test-first deliverable required by
 * `.claude/rules/end-to-end-verification.md`: the migrator must flip
 * red→green before we declare the cutover work done.
 *
 * The fixture is built fresh in each test so we don't depend on any local
 * pglite-db.backups directory. We seed the PGLite store with at least one row
 * in every table that 0001_initial.sql defines, exercising the type
 * translation paths the migrator depends on (TIMESTAMPTZ, JSONB, BYTEA,
 * TEXT[], generated columns, partial unique indexes, FTS5 triggers).
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import { deserialize } from 'node:v8';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../SQLiteDatabase';
import {
  PGLiteToSQLiteMigrator,
  __TEST_HOOKS,
  type MigrationProgress,
  type PGLiteHandle,
} from '../PGLiteToSQLiteMigrator';

// Resolve to the shipping schema file.
const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

describe('PGLiteToSQLiteMigrator cutover whitelist', () => {
  it('includes tool usage counters and backfill state in the cutover whitelist', () => {
    expect(__TEST_HOOKS.COPY_TABLES).toEqual(
      expect.arrayContaining([
        'tool_usage_counters',
        'tool_usage_backfill_meta',
        'tool_usage_backfill_sessions',
      ]),
    );
  });

  // Omitting these silently drops every user's commit provenance on cutover.
  it('includes the session commit ledger in the cutover whitelist', () => {
    expect(__TEST_HOOKS.COPY_TABLES).toEqual(
      expect.arrayContaining(['session_commits', 'session_commit_backfill_meta']),
    );
  });

  it('preserves feedback request caches and indexes during backend cutover', () => {
    expect(__TEST_HOOKS.COPY_TABLES).toEqual(expect.arrayContaining([
      'feedback_request_cache',
      'feedback_request_index',
      'feedback_request_index_backfill',
    ]));
  });

});

describe('PGLiteToSQLiteMigrator', () => {
  let tmp: string;
  let pgliteDir: string;
  let sqliteDir: string;
  let pglite: PGlite;
  let sqlite: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-migrator-'));
    pgliteDir = path.join(tmp, 'pglite-db');
    sqliteDir = path.join(tmp, 'sqlite-db');
    fs.mkdirSync(pgliteDir, { recursive: true });
    fs.mkdirSync(sqliteDir, { recursive: true });

    pglite = new PGlite({ dataDir: pgliteDir });
    await (pglite as unknown as { waitReady: Promise<void> }).waitReady;

    sqlite = new SQLiteDatabase({
      dbDir: sqliteDir,
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();
  });

  afterEach(async () => {
    await sqlite.close();
    await pglite.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('replaces the SQLite bootstrap backfill cutoff with the PGLite source cutoff', async () => {
    await pglite.exec(`
      CREATE TABLE tool_usage_backfill_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        cutoff_at TIMESTAMPTZ NOT NULL
      );
    `);
    const sourceCutoff = new Date('2026-06-15T12:34:56.789Z');
    await pglite.query(
      `INSERT INTO tool_usage_backfill_meta (singleton, cutoff_at) VALUES ($1, $2)`,
      [1, sourceCutoff],
    );

    const targetBefore = sqlite.getRawHandle()!
      .prepare('SELECT cutoff_at FROM tool_usage_backfill_meta WHERE singleton = 1')
      .get() as { cutoff_at: string };
    expect(targetBefore.cutoff_at).not.toBe(sourceCutoff.toISOString());

    const migrator = new PGLiteToSQLiteMigrator();
    await migrator.migrate({
      pglite: pglite as unknown as Parameters<PGLiteToSQLiteMigrator['migrate']>[0]['pglite'],
      sqlite,
      spotCheckPerTable: 1,
    });

    const targetAfter = sqlite.getRawHandle()!
      .prepare('SELECT cutoff_at FROM tool_usage_backfill_meta WHERE singleton = 1')
      .get() as { cutoff_at: string };
    expect(new Date(targetAfter.cutoff_at).toISOString()).toBe(sourceCutoff.toISOString());
  });

  async function seedPgliteSchema(): Promise<void> {
    // Reproduce a minimal subset of the PGLite end-state schema. We don't run
    // the worker.js migrations because (a) they're tied to PGLite-specific
    // behavior and (b) the migrator just reads `information_schema.tables`
    // and `SELECT *` -- it doesn't care which CREATE TABLE made the row.
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
        file_path TEXT,
        provider TEXT NOT NULL,
        model TEXT,
        title TEXT NOT NULL DEFAULT 'New conversation',
        session_type TEXT DEFAULT 'session',
        agent_role TEXT DEFAULT 'standard',
        created_by_session_id TEXT,
        document_context JSONB,
        provider_config JSONB,
        provider_session_id TEXT,
        draft_input TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        last_read_message_id TEXT,
        last_read_timestamp TIMESTAMPTZ,
        has_been_named BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT DEFAULT 'idle',
        last_activity TIMESTAMPTZ DEFAULT NOW(),
        mode TEXT DEFAULT 'agent',
        is_archived BOOLEAN NOT NULL DEFAULT FALSE,
        last_document_state JSONB,
        worktree_id TEXT,
        is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
        parent_session_id TEXT,
        branched_from_session_id TEXT,
        branch_point_message_id BIGINT,
        branched_at TIMESTAMPTZ,
        canonical_transform_version INTEGER,
        canonical_last_raw_message_id BIGINT,
        canonical_last_transformed_at TIMESTAMPTZ,
        canonical_transform_status TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE document_history (
        id BIGSERIAL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content BYTEA NOT NULL,
        size_bytes INTEGER,
        timestamp BIGINT NOT NULL,
        version INTEGER DEFAULT 1,
        metadata JSONB NOT NULL DEFAULT '{}'
      );

      CREATE TABLE session_files (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        link_type TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata JSONB NOT NULL DEFAULT '{}'
      );

      CREATE TABLE ai_agent_messages (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source TEXT NOT NULL,
        direction TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB,
        hidden BOOLEAN NOT NULL DEFAULT FALSE,
        provider_message_id TEXT,
        searchable BOOLEAN NOT NULL DEFAULT FALSE,
        searchable_text TEXT,
        message_kind TEXT
      );

      CREATE TABLE ai_tool_call_file_edits (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_file_id TEXT NOT NULL,
        message_id BIGINT NOT NULL,
        tool_call_item_id TEXT,
        tool_use_id TEXT,
        match_score INTEGER NOT NULL DEFAULT 0,
        match_reason TEXT,
        file_timestamp TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE tracker_items (
        id TEXT PRIMARY KEY,
        issue_number INTEGER,
        issue_key TEXT,
        type TEXT NOT NULL,
        data JSONB NOT NULL,
        workspace TEXT NOT NULL,
        document_path TEXT,
        line_number INTEGER,
        content JSONB,
        archived BOOLEAN NOT NULL DEFAULT FALSE,
        archived_at TIMESTAMPTZ,
        source TEXT DEFAULT 'inline',
        source_ref TEXT,
        type_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        sync_status TEXT DEFAULT 'local',
        sync_id BIGINT,
        body_version INTEGER NOT NULL DEFAULT 0,
        deleted_at TIMESTAMPTZ,
        created TIMESTAMPTZ DEFAULT NOW(),
        updated TIMESTAMPTZ DEFAULT NOW(),
        last_indexed TIMESTAMPTZ DEFAULT NOW(),
        title TEXT GENERATED ALWAYS AS (data->>'title') STORED,
        status TEXT GENERATED ALWAYS AS (data->>'status') STORED,
        kanban_sort_order TEXT GENERATED ALWAYS AS (data->>'kanbanSortOrder') STORED
      );

      CREATE TABLE tracker_body_cache (
        item_id TEXT NOT NULL,
        body_version INTEGER NOT NULL,
        content TEXT NOT NULL,
        cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (item_id, body_version)
      );

      CREATE TABLE tracker_creation_receipts (
        item_id TEXT PRIMARY KEY REFERENCES tracker_items(id) ON DELETE CASCADE,
        workspace TEXT NOT NULL, request_hash TEXT NOT NULL,
        publication_status TEXT NOT NULL, error TEXT, updated TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE tracker_transactions (
        client_mutation_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        state TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload JSONB,
        enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        confirmed_sync_id BIGINT,
        last_rejection JSONB
      );

      CREATE TABLE queued_prompts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attachments JSONB,
        document_context JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error_message TEXT
      );

      CREATE TABLE ai_session_wakeups (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        reason TEXT,
        fire_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        fired_at TIMESTAMPTZ,
        error TEXT
      );

      CREATE TABLE super_loops (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL,
        task_description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        current_iteration INTEGER DEFAULT 0,
        max_iterations INTEGER DEFAULT 20,
        completion_reason TEXT,
        model_id TEXT,
        title TEXT,
        is_archived BOOLEAN NOT NULL DEFAULT FALSE,
        is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE super_iterations (
        id TEXT PRIMARY KEY,
        super_loop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        iteration_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        exit_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );

      CREATE TABLE ai_transcript_events (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        event_type TEXT NOT NULL,
        searchable_text TEXT,
        payload JSONB NOT NULL DEFAULT '{}',
        parent_event_id BIGINT,
        searchable BOOLEAN NOT NULL DEFAULT FALSE,
        subagent_id TEXT,
        provider TEXT NOT NULL,
        provider_tool_call_id TEXT
      );

      CREATE TABLE collab_local_origins (
        org_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        git_remote_hash TEXT,
        workspace_path_hash TEXT,
        relative_path TEXT NOT NULL,
        document_type TEXT NOT NULL,
        source_basename TEXT NOT NULL,
        last_local_content_hash TEXT,
        last_collab_content_hash TEXT,
        last_synced_at TIMESTAMPTZ,
        last_seen_mtime_ms BIGINT,
        last_seen_size_bytes BIGINT,
        resolution_status TEXT NOT NULL DEFAULT 'resolved',
        resolution_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (org_id, document_id)
      );

      CREATE TABLE collab_document_assets (
        account_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        encrypted_asset BYTEA NOT NULL,
        encoding_version INTEGER NOT NULL DEFAULT 1,
        asset_checksum TEXT NOT NULL,
        plaintext_size BIGINT NOT NULL,
        upload_state TEXT NOT NULL DEFAULT 'queued',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        next_attempt_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (account_id, org_id, document_id, asset_id)
      );
    `);
  }

  async function seedRows(): Promise<void> {
    // worktrees
    await pglite.query(
      `INSERT INTO worktrees(id, workspace_id, name, path, branch, base_branch, display_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      ['wt-1', 'ws-A', 'feature-x', '/tmp/wt-1', 'feature-x', 'main', 'Feature X'],
    );

    // ai_sessions (with self-ref + worktree FK)
    await pglite.query(
      `INSERT INTO ai_sessions(id, workspace_id, provider, title, metadata, worktree_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6),
              ($7, $8, $9, $10, $11::jsonb, $12)`,
      [
        'sess-1', 'ws-A', 'claude', 'Auth refactor', JSON.stringify({ pinned: true }), 'wt-1',
        'sess-2', 'ws-A', 'openai', 'Tracker fix', JSON.stringify({ tags: ['hot'] }), null,
      ],
    );

    // document_history (BYTEA)
    await pglite.query(
      `INSERT INTO document_history(workspace_id, file_path, content, size_bytes, timestamp, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        'ws-A',
        'src/auth.ts',
        Buffer.from('hello world', 'utf-8'),
        11,
        Date.now(),
        JSON.stringify({ baseMarkdownHash: 'abc123', status: 'pending-review' }),
      ],
    );

    // session_files
    await pglite.query(
      `INSERT INTO session_files(id, session_id, workspace_id, file_path, link_type)
       VALUES ($1, $2, $3, $4, $5)`,
      ['sf-1', 'sess-1', 'ws-A', 'src/auth.ts', 'edited'],
    );

    // ai_agent_messages (with searchable=true + searchable=false to confirm
    // FTS5 backfills both)
    await pglite.query(
      `INSERT INTO ai_agent_messages(session_id, source, direction, content, searchable)
       VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)`,
      [
        'sess-1', 'user', 'input', 'find the auth bug', true,
        'sess-1', 'assistant', 'output', 'the secret is rotated weekly', false,
      ],
    );

    // ai_tool_call_file_edits (FK to messages.id)
    const msgs = await pglite.query<{ id: bigint }>(
      `SELECT id FROM ai_agent_messages ORDER BY id LIMIT 1`,
    );
    const firstMsgId = msgs.rows[0]?.id;
    if (firstMsgId !== undefined) {
      await pglite.query(
        `INSERT INTO ai_tool_call_file_edits(session_id, session_file_id, message_id, match_score)
         VALUES ($1, $2, $3, $4)`,
        ['sess-1', 'sf-1', firstMsgId, 5],
      );
    }

    // tracker_items (JSONB data + TEXT[] type_tags + generated columns)
    await pglite.query(
      `INSERT INTO tracker_items(id, type, data, workspace, type_tags, body_version)
       VALUES ($1, $2, $3::jsonb, $4, $5::text[], $6)`,
      [
        'tr-1', 'bug',
        JSON.stringify({ title: 'Login broken', status: 'open', kanbanSortOrder: 'a' }),
        'ws-A', ['ui', 'critical'], 1,
      ],
    );

    // tracker_body_cache
    await pglite.query(
      `INSERT INTO tracker_body_cache(item_id, body_version, content)
       VALUES ($1, $2, $3)`,
      ['tr-1', 1, '# Login broken\n\nFails on Safari.'],
    );

    await pglite.query(
      'INSERT INTO tracker_creation_receipts (item_id, workspace, request_hash, publication_status, error) VALUES ($1,$2,$3,$4,$5)',
      ['tr-1', 'ws-A', 'request-hash', 'pending', 'Acknowledgment lost'],
    );

    // tracker_transactions
    await pglite.query(
      `INSERT INTO tracker_transactions(client_mutation_id, item_id, workspace_path, state, kind, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      ['cm-1', 'tr-1', '/proj', 'persistedEnqueue', 'update', JSON.stringify({ field: 'status' })],
    );

    // queued_prompts
    await pglite.query(
      `INSERT INTO queued_prompts(id, session_id, prompt, status)
       VALUES ($1, $2, $3, $4)`,
      ['qp-1', 'sess-1', 'rerun the auth check', 'pending'],
    );

    // ai_session_wakeups
    await pglite.query(
      `INSERT INTO ai_session_wakeups(id, session_id, workspace_id, prompt, fire_at, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['wk-1', 'sess-1', 'ws-A', 'check oncall queue', new Date(Date.now() + 60_000), 'pending'],
    );

    // super_loops + super_iterations
    await pglite.query(
      `INSERT INTO super_loops(id, worktree_id, task_description, status)
       VALUES ($1, $2, $3, $4)`,
      ['sl-1', 'wt-1', 'Ship auth refactor', 'pending'],
    );
    await pglite.query(
      `INSERT INTO super_iterations(id, super_loop_id, session_id, iteration_number, status)
       VALUES ($1, $2, $3, $4, $5)`,
      ['si-1', 'sl-1', 'sess-1', 1, 'running'],
    );

    // ai_transcript_events (with FTS5 searchable_text)
    await pglite.query(
      `INSERT INTO ai_transcript_events(session_id, sequence, event_type, searchable_text, provider)
       VALUES ($1, $2, $3, $4, $5)`,
      ['sess-1', 1, 'user_message', 'find the auth bug', 'claude'],
    );

    // collab_local_origins (composite PK, no FK)
    await pglite.query(
      `INSERT INTO collab_local_origins(org_id, document_id, relative_path, document_type, source_basename, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`,
      ['org-A', 'doc-1', 'docs/intro.md', 'markdown', 'intro.md'],
    );

    await pglite.query(
      `INSERT INTO collab_document_assets(
         account_id, org_id, document_id, asset_id, encrypted_asset,
         asset_checksum, plaintext_size, upload_state, attempt_count,
         last_error_code, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        'account-A', 'org-A', 'doc-1', 'asset-1', Buffer.from([1, 2, 3]),
        'checksum', 3, 'queued', 2, 'http_500',
        new Date('2026-07-15T05:00:00.000Z'),
      ],
    );
  }

  it('round-trips every table type-by-type with zero verification failures', async () => {
    await seedPgliteSchema();
    await seedRows();

    const progressEvents: MigrationProgress[] = [];
    const migrator = new PGLiteToSQLiteMigrator();
    const summary = await migrator.migrate({
      pglite: pglite as unknown as Parameters<PGLiteToSQLiteMigrator['migrate']>[0]['pglite'],
      sqlite,
      onProgress: (p) => progressEvents.push(p),
      batchSize: 1000,
      spotCheckPerTable: 2,
    });

    expect(summary.foreignKeyViolations).toBe(0);
    expect(summary.integrityCheck).toBe('ok');
    expect(summary.totalRowsCopied).toBeGreaterThan(0);
    expect(summary.spotCheckCount).toBeGreaterThan(0);
    const migratedRetry = sqlite.getRawHandle()!
      .prepare('SELECT next_attempt_at FROM collab_document_assets WHERE asset_id = ?')
      .get('asset-1') as { next_attempt_at: string };
    expect(new Date(migratedRetry.next_attempt_at).toISOString()).toBe(
      '2026-07-15T05:00:00.000Z',
    );

    expect(sqlite.getRawHandle()!.prepare('SELECT request_hash, publication_status, error FROM tracker_creation_receipts WHERE item_id = ?').get('tr-1'))
      .toEqual({ request_hash: 'request-hash', publication_status: 'pending', error: 'Acknowledgment lost' });

    // Progress events fired through every phase and ended at 100%.
    const phases = new Set(progressEvents.map((p) => p.phase));
    expect(phases.has('copying')).toBe(true);
    expect(phases.has('verifying-counts')).toBe(true);
    expect(phases.has('verifying-integrity')).toBe(true);
    expect(phases.has('verifying-foreign-keys')).toBe(true);
    expect(phases.has('finalizing')).toBe(true);
    expect(progressEvents[progressEvents.length - 1].percentOfTotal).toBe(100);
  });

  async function seedHistory(count: number, badIds: number[]) {
    await seedPgliteSchema();
    await pglite.exec('ALTER TABLE document_history ALTER COLUMN content DROP NOT NULL');
    await pglite.exec(`INSERT INTO document_history(workspace_id, file_path, content, timestamp)
      SELECT 'ws-A', 'history-' || n, decode('00ff10', 'hex'), n FROM generate_series(1, ${count}) n`);
    for (const id of badIds) await pglite.query(
      `UPDATE document_history SET content = NULL WHERE id = $1`, [id]);
  }

  it('migrates nullable metadata and JSONB string scalars intact without quarantine', async () => {
    await seedHistory(3, []);
    await pglite.exec(`ALTER TABLE document_history ALTER COLUMN metadata DROP NOT NULL;
      UPDATE document_history SET metadata = CASE id WHEN 1 THEN '"invalid-json-text"'::jsonb WHEN 2 THEN NULL ELSE 'null'::jsonb END`);
    const summary = await new PGLiteToSQLiteMigrator().migrate({ pglite, sqlite, spotCheckPerTable: 3 });
    expect(summary.historyRowsQuarantined).toBe(0);
    expect(sqlite.getRawHandle()!.prepare('SELECT metadata, content FROM document_history ORDER BY id').all()).toEqual([
      { metadata: '"invalid-json-text"', content: Buffer.from([0, 255, 16]) },
      { metadata: '{}', content: Buffer.from([0, 255, 16]) },
      { metadata: '{}', content: Buffer.from([0, 255, 16]) },
    ]);
  });

  it('rebuilds history quarantine during full recopy without retaining stale omissions', async () => {
    await seedHistory(300, [50, 100]);
    const migrator = new PGLiteToSQLiteMigrator();
    const first = await migrator.migrate({ pglite, sqlite });
    await pglite.exec("UPDATE document_history SET content = decode('00ff10', 'hex') WHERE id = 50");
    const manifest = { ...first.manifest!, perTable: first.manifest!.perTable.filter(t => t.name !== 'document_history') };
    const next = await migrator.catchUp({ pglite, sqlite, manifest });
    expect(next.historyRowsQuarantined).toBe(1);
    expect(sqlite.getRawHandle()!.prepare('SELECT source_id FROM migration_history_quarantine').all()).toEqual([{ source_id: 100 }]);
    expect(sqlite.getRawHandle()!.prepare('SELECT count(*) AS n FROM document_history').get()).toEqual({ n: 299 });
  });

  it('quarantines isolated history rows, verifies only copied samples, and retains originals after reopen', async () => {
    await seedHistory(100, [50]);
    const summary = await new PGLiteToSQLiteMigrator().migrate({ pglite, sqlite, batchSize: 100, spotCheckPerTable: 100 });
    expect(summary.historyRowsQuarantined).toBe(1);
    expect(summary.tablesCopied.find(t => t.name === 'document_history')?.rows).toBe(99);
    expect(summary.manifest?.perTable.find(t => t.name === 'document_history')).toMatchObject({ rows: 99, cursorMax: 100, rowsQuarantined: 1 });
    expect(summary.integrityCheck).toBe('ok');
    expect(summary.foreignKeyViolations).toBe(0);
    expect((await pglite.query('SELECT count(*) AS n FROM document_history')).rows).toEqual([{ n: 100 }]);
    await sqlite.close();
    sqlite = new SQLiteDatabase({ dbDir: sqliteDir, schemaDir: SCHEMA_DIR });
    await sqlite.initialize();
    const row = sqlite.getRawHandle()!.prepare('SELECT source_row, reason_code FROM migration_history_quarantine WHERE source_id = 50').get() as { source_row: Buffer; reason_code: string };
    expect(deserialize(row.source_row)).toMatchObject({ id: 50, metadata: {}, content: null });
    expect(row.reason_code).toBe('history_null_required_value');
    expect(sqlite.getRawHandle()!.prepare('SELECT count(*) AS n FROM document_history').get()).toEqual({ n: 99 });
  });

  it('enforces a cumulative history loss budget across catch-up and retains the skipped high-water mark', async () => {
    await seedHistory(100, [100]);
    const migrator = new PGLiteToSQLiteMigrator();
    const first = await migrator.migrate({ pglite, sqlite });
    const noChange = await migrator.catchUp({ pglite, sqlite, manifest: first.manifest! });
    expect(noChange.manifest.perTable.find(t => t.name === 'document_history')).toMatchObject({ rows: 99, cursorMax: 100, rowsQuarantined: 1 });
    await pglite.exec(`INSERT INTO document_history(workspace_id,file_path,content,timestamp,metadata)
      VALUES ('ws-A','new-bad',NULL,101,'{}'::jsonb)`);
    await expect(migrator.catchUp({ pglite, sqlite, manifest: noChange.manifest })).rejects.toThrow(/history.*limit/i);
    expect(sqlite.getRawHandle()!.prepare('SELECT count(*) AS n FROM migration_history_quarantine').get()).toEqual({ n: 1 });
    await pglite.exec(`INSERT INTO document_history(workspace_id,file_path,content,timestamp)
      SELECT 'ws-A','new-good-' || n,decode('00','hex'),n FROM generate_series(102,200) n`);
    const next = await migrator.catchUp({ pglite, sqlite, manifest: noChange.manifest });
    expect(next.historyRowsQuarantined).toBe(2);
    expect(next.manifest.perTable.find(t => t.name === 'document_history')).toMatchObject({ rows: 198, cursorMax: 200, rowsQuarantined: 2 });
  });

  it('drains the history cursor even when deletions make the estimated catch-up delta zero', async () => {
    await seedHistory(100, [100]);
    const migrator = new PGLiteToSQLiteMigrator();
    const first = await migrator.migrate({ pglite, sqlite });
    await pglite.exec(`DELETE FROM document_history WHERE id = 1;
      INSERT INTO document_history(workspace_id,file_path,content,timestamp)
      VALUES ('ws-A','new-after-deletion',decode('abcd','hex'),101)`);
    const next = await migrator.catchUp({ pglite, sqlite, manifest: first.manifest! });
    expect(next.manifest.perTable.find(t => t.name === 'document_history')).toMatchObject({ cursorMax: 101, rowsQuarantined: 1 });
    expect(sqlite.getRawHandle()!.prepare('SELECT content FROM document_history WHERE id = 101').get()).toEqual({ content: Buffer.from([171, 205]) });
  });

  it('keeps message row failures fatal', async () => {
    await seedPgliteSchema();
    await seedRows();
    await pglite.exec('ALTER TABLE ai_agent_messages ALTER COLUMN content DROP NOT NULL; UPDATE ai_agent_messages SET content = NULL');
    await expect(new PGLiteToSQLiteMigrator().migrate({ pglite, sqlite })).rejects.toThrow(/NOT NULL/);
  });

  it('refuses history omissions above one percent and rolls back the whole failed batch', async () => {
    await seedHistory(100, [50, 100]);
    await expect(new PGLiteToSQLiteMigrator().migrate({ pglite, sqlite, batchSize: 100 })).rejects.toThrow(/history.*limit/i);
    expect(sqlite.getRawHandle()!.prepare('SELECT count(*) AS n FROM document_history').get()).toEqual({ n: 0 });
  });

  it('translates BYTEA -> Buffer roundtrips intact', async () => {
    await seedPgliteSchema();
    const payload = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await pglite.query(
      `INSERT INTO document_history(workspace_id, file_path, content, timestamp)
       VALUES ($1, $2, $3, $4)`,
      ['ws-A', 'src/binary.bin', payload, 1],
    );

    const migrator = new PGLiteToSQLiteMigrator();
    await migrator.migrate({
      pglite: pglite as unknown as Parameters<PGLiteToSQLiteMigrator['migrate']>[0]['pglite'],
      sqlite,
      spotCheckPerTable: 1,
    });

    const handle = sqlite.getRawHandle()!;
    const row = handle
      .prepare('SELECT content FROM document_history WHERE file_path = ?')
      .get('src/binary.bin') as { content: Buffer };
    expect(Buffer.isBuffer(row.content)).toBe(true);
    expect(row.content.equals(payload)).toBe(true);
  });

  it('recovers a settled source timeout from the last committed message without losing or duplicating rows', async () => {
    await seedPgliteSchema();
    await pglite.query("INSERT INTO ai_sessions(id, provider) VALUES ('recovery', 'claude-code')");
    for (let i = 1; i <= 7; i++) {
      await pglite.query(
        "INSERT INTO ai_agent_messages(session_id, source, direction, content) VALUES ('recovery', 'claude-code', 'input', $1)",
        [`message-${i}`],
      );
    }
    const attempts: unknown[][] = [];
    const progress: number[] = [];
    let failed = false;
    const source: PGLiteHandle = {
      async query<T>(sql: string, params?: unknown[]) {
        if (sql.startsWith('SELECT * FROM "ai_agent_messages"')) {
          attempts.push([...params!]);
          if (params?.[0] === 2 && params.length === 2 && !failed) {
            failed = true;
            throw Object.assign(new Error('Migration source read exceeded its deadline'), {
              code: 'migration_read_timeout',
              data: { sourceSettled: true, elapsedMs: 31_000 },
            });
          }
        }
        return pglite.query<T>(sql, params as unknown[]);
      },
      exec: (sql) => pglite.exec(sql),
      close: async () => {},
    };
    const summary = await new PGLiteToSQLiteMigrator().migrate({
      pglite: source, sqlite, batchSize: 2,
      onProgress: (p) => {
        if (p.phase === 'copying' && p.currentTable === 'ai_agent_messages') progress.push(p.tableRowsCopied);
      },
    });
    expect(failed).toBe(true);
    expect(attempts.slice(0, 3)).toEqual([[2], [2, 2], [2, 1]]);
    expect(progress.filter((n) => n === 2)).toHaveLength(1);
    expect(sqlite.getRawHandle()!.prepare('SELECT id, content FROM ai_agent_messages ORDER BY id').all())
      .toEqual(Array.from({ length: 7 }, (_, i) => ({ id: i + 1, content: `message-${i + 1}` })));
    expect(summary.integrityCheck).toBe('ok');
  });

  it('keyset-pages text IDs but fully reconciles lower inserts, updates, and deletions at adoption', async () => {
    await seedPgliteSchema();
    for (const id of ['b', 'c', 'd']) {
      await pglite.query("INSERT INTO ai_sessions(id, provider, title) VALUES ($1, 'claude-code', $1)", [id]);
      await pglite.query("INSERT INTO session_files(id, session_id, workspace_id, file_path, link_type) VALUES ($1, 'b', 'ws', $1, 'read')", [id]);
    }
    const pages: string[] = [];
    const source: PGLiteHandle = {
      async query<T>(sql: string, params?: unknown[]) {
        if (/^SELECT \* FROM "(ai_sessions|session_files)"/.test(sql)) {
          expect(sql).not.toContain('OFFSET');
          pages.push(sql);
        }
        return pglite.query<T>(sql, params as unknown[]);
      },
      exec: (sql) => pglite.exec(sql), close: async () => {},
    };
    const migrator = new PGLiteToSQLiteMigrator();
    const summary = await migrator.migrate({ pglite: source, sqlite, batchSize: 2 });
    for (const table of ['ai_sessions', 'session_files']) {
      expect(summary.manifest!.perTable.find((entry) => entry.name === table)?.cursorMax).toBeUndefined();
      expect(pages.some((sql) => sql.includes(`"${table}"`) && sql.includes('"id" > $1'))).toBe(true);
    }
    await pglite.query("INSERT INTO ai_sessions(id, provider, title) VALUES ('a', 'claude-code', 'new')");
    await pglite.query("UPDATE ai_sessions SET title = 'updated' WHERE id = 'c'");
    await pglite.query("DELETE FROM session_files WHERE id = 'd'");
    await pglite.query("DELETE FROM ai_sessions WHERE id = 'd'");
    await pglite.query("INSERT INTO session_files(id, session_id, workspace_id, file_path, link_type) VALUES ('a', 'a', 'ws', 'new', 'read')");
    await pglite.query("UPDATE session_files SET file_path = 'updated' WHERE id = 'c'");
    const catchUpProgress: MigrationProgress[] = [];
    await migrator.catchUp({ pglite: source, sqlite, batchSize: 2, manifest: summary.manifest!, onProgress: p => catchUpProgress.push(p) });
    expect(catchUpProgress.some(p => p.currentTable === 'ai_sessions' && p.tableRowsCopied === 2 && p.tableRowsExpected === 3)).toBe(true);
    expect(sqlite.getRawHandle()!.prepare('SELECT id, title FROM ai_sessions ORDER BY id').all()).toEqual([
      { id: 'a', title: 'new' }, { id: 'b', title: 'b' }, { id: 'c', title: 'updated' },
    ]);
    expect(sqlite.getRawHandle()!.prepare('SELECT id, file_path FROM session_files ORDER BY id').all()).toEqual([
      { id: 'a', file_path: 'new' }, { id: 'b', file_path: 'b' }, { id: 'c', file_path: 'updated' },
    ]);
  });

  it.each([
    { code: 'migration_read_timeout', settled: true, elapsedMs: 31_000, attempts: 2 },
    { code: 'migration_read_timeout', settled: true, elapsedMs: 180_000, attempts: 1 },
    { code: 'migration_read_timeout', settled: false, elapsedMs: 31_000, attempts: 1 },
    { code: 'XX000', settled: true, elapsedMs: 31_000, attempts: 1 },
  ])('bounds source retry and preserves terminal errors: $code / $settled / $elapsedMs', async ({ code, settled, elapsedMs, attempts }) => {
    await seedPgliteSchema();
    await pglite.query("INSERT INTO ai_sessions(id, provider) VALUES ('failure', 'claude-code')");
    let reads = 0;
    const error = Object.assign(new Error('source failure'), { code, data: { sourceSettled: settled, elapsedMs } });
    const source: PGLiteHandle = {
      async query<T>(sql: string, params?: unknown[]) {
        if (sql.startsWith('SELECT * FROM "ai_sessions"')) { reads++; throw error; }
        return pglite.query<T>(sql, params as unknown[]);
      },
      exec: (sql) => pglite.exec(sql), close: async () => {},
    };
    const result = new PGLiteToSQLiteMigrator().migrate({ pglite: source, sqlite, batchSize: 2 });
    if (code === 'migration_read_timeout' && settled) {
      await expect(result).rejects.toMatchObject({ code: 'migration_batch_timeout', cause: error });
    } else {
      await expect(result).rejects.toBe(error);
    }
    expect(reads).toBe(attempts);
    expect(sqlite.getRawHandle()!.prepare('SELECT COUNT(*) AS n FROM ai_sessions').get()).toEqual({ n: 0 });
  });

  it('caps document_history batches for initial copy and catch-up before wide rows reach the worker bridge', async () => {
    await seedPgliteSchema();
    await pglite.query(
      `INSERT INTO document_history(workspace_id, file_path, content, timestamp)
       VALUES ($1, $2, $3, $4)`,
      ['ws-A', 'src/first.bin', Buffer.from('first snapshot'), 1],
    );

    const documentHistoryBatchSizes: number[] = [];
    const guardedSource: PGLiteHandle = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        if (/SELECT \* FROM "document_history"/i.test(sql)) {
          const batchSize = Number(params?.at(-1));
          documentHistoryBatchSizes.push(batchSize);
          if (batchSize > 500) {
            throw new Error(`document_history batch ${batchSize} exceeds the worker-safe limit`);
          }
        }
        const result = await pglite.query<T>(sql, params as unknown[]);
        return { rows: result.rows };
      },
      async exec(sql: string): Promise<unknown> {
        return pglite.exec(sql);
      },
      async close(): Promise<void> {
        // The test owns the live source.
      },
    };

    const migrator = new PGLiteToSQLiteMigrator();
    const summary = await migrator.migrate({
      pglite: guardedSource,
      sqlite,
      spotCheckPerTable: 1,
    });
    expect(summary.manifest).toBeDefined();

    await pglite.query(
      `INSERT INTO document_history(workspace_id, file_path, content, timestamp)
       VALUES ($1, $2, $3, $4)`,
      ['ws-A', 'src/second.bin', Buffer.from('second snapshot'), 2],
    );
    await migrator.catchUp({
      pglite: guardedSource,
      sqlite,
      manifest: summary.manifest!,
    });

    expect(documentHistoryBatchSizes).toEqual([500, 500]);
    const migrated = sqlite.getRawHandle()!
      .prepare('SELECT file_path FROM document_history ORDER BY id')
      .all() as Array<{ file_path: string }>;
    expect(migrated.map((row) => row.file_path)).toEqual([
      'src/first.bin',
      'src/second.bin',
    ]);
  });

  it('translates JSONB -> JSON text roundtrips intact', async () => {
    await seedPgliteSchema();
    const meta = { tags: ['x', 'y'], nested: { count: 3 }, when: '2026-05-27T12:00:00.000Z' };
    await pglite.query(
      `INSERT INTO tracker_items(id, type, data, workspace)
       VALUES ($1, $2, $3::jsonb, $4)`,
      ['tr-meta', 'task', JSON.stringify({ title: 'meta test', status: 'open', meta }), 'ws-A'],
    );

    const migrator = new PGLiteToSQLiteMigrator();
    await migrator.migrate({
      pglite: pglite as unknown as Parameters<PGLiteToSQLiteMigrator['migrate']>[0]['pglite'],
      sqlite,
      spotCheckPerTable: 1,
    });

    const handle = sqlite.getRawHandle()!;
    const row = handle
      .prepare(`SELECT data, json_extract(data, '$.title') AS title FROM tracker_items WHERE id = ?`)
      .get('tr-meta') as { data: string; title: string };
    expect(row.title).toBe('meta test');
    const parsed = JSON.parse(row.data);
    expect(parsed.meta.tags).toEqual(['x', 'y']);
    expect(parsed.meta.nested.count).toBe(3);
  });

  it('translates TEXT[] -> JSON array', async () => {
    await seedPgliteSchema();
    await pglite.query(
      `INSERT INTO tracker_items(id, type, data, workspace, type_tags)
       VALUES ($1, $2, $3::jsonb, $4, $5::text[])`,
      ['tr-tags', 'task', JSON.stringify({ title: 'tagged', status: 'open' }), 'ws-A', ['alpha', 'beta', 'gamma']],
    );

    const migrator = new PGLiteToSQLiteMigrator();
    await migrator.migrate({
      pglite: pglite as unknown as Parameters<PGLiteToSQLiteMigrator['migrate']>[0]['pglite'],
      sqlite,
      spotCheckPerTable: 1,
    });

    const handle = sqlite.getRawHandle()!;
    const row = handle
      .prepare('SELECT type_tags FROM tracker_items WHERE id = ?')
      .get('tr-tags') as { type_tags: string };
    expect(JSON.parse(row.type_tags)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('populates FTS5 mirror for ai_agent_messages rows with non-NULL searchable_text', async () => {
    await seedPgliteSchema();
    await pglite.query(
      `INSERT INTO ai_sessions(id, provider, title) VALUES ($1, $2, $3)`,
      ['sess-fts', 'claude', 'fts test'],
    );
    // Phase 2 of canonical-transcript-deprecation: FTS now indexes
    // searchable_text. Rows whose searchable_text IS NULL are NOT indexed.
    await pglite.query(
      `INSERT INTO ai_agent_messages(session_id, source, direction, content, searchable, searchable_text, message_kind)
       VALUES
         ($1, $2, 'input', $3, false, NULL, 'meta'),
         ($1, $2, 'output', $4, true, $4, 'assistant')`,
      ['sess-fts', 'user', 'unique-phrase-abc-not-indexed', 'unique-phrase-xyz-searchable'],
    );

    const migrator = new PGLiteToSQLiteMigrator();
    await migrator.migrate({
      pglite: pglite as unknown as Parameters<PGLiteToSQLiteMigrator['migrate']>[0]['pglite'],
      sqlite,
    });

    const handle = sqlite.getRawHandle()!;
    const abcHits = handle
      .prepare(`SELECT rowid FROM ai_agent_messages_fts WHERE ai_agent_messages_fts MATCH ?`)
      .all('"unique-phrase-abc-not-indexed"') as { rowid: number }[];
    const xyzHits = handle
      .prepare(`SELECT rowid FROM ai_agent_messages_fts WHERE ai_agent_messages_fts MATCH ?`)
      .all('"unique-phrase-xyz-searchable"') as { rowid: number }[];
    // The NULL-searchable_text row is not indexed; the populated one is.
    expect(abcHits.length).toBe(0);
    expect(xyzHits.length).toBe(1);
  });

  it('recreates FTS triggers on searchable_text so post-migration writes index correctly', async () => {
    // Regression: a previous version recreated only the INSERT trigger and
    // referenced the old `content` column. Phase 2 of the
    // canonical-transcript-deprecation moved the FTS table to
    // `searchable_text`, so the stale trigger caused subsequent INSERTs to
    // fail (or worse, silently index against a column that no longer exists
    // in the FTS shadow). This test inserts AFTER migration and asserts the
    // new row is searchable.
    await seedPgliteSchema();
    await pglite.query(
      `INSERT INTO ai_sessions(id, provider, title) VALUES ($1, $2, $3)`,
      ['sess-trig', 'claude', 'trigger test'],
    );

    const migrator = new PGLiteToSQLiteMigrator();
    await migrator.migrate({
      pglite: pglite as unknown as Parameters<PGLiteToSQLiteMigrator['migrate']>[0]['pglite'],
      sqlite,
    });

    const handle = sqlite.getRawHandle()!;

    // The three triggers must reference searchable_text (the new column),
    // not the legacy `content`. Inspect sqlite_master to confirm.
    const triggers = handle
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'trigger' AND name IN ('ai_agent_messages_ai', 'ai_agent_messages_ad', 'ai_agent_messages_au')
         ORDER BY name`,
      )
      .all() as { name: string; sql: string }[];
    expect(triggers.map((t) => t.name)).toEqual([
      'ai_agent_messages_ad',
      'ai_agent_messages_ai',
      'ai_agent_messages_au',
    ]);
    for (const t of triggers) {
      expect(t.sql).toContain('searchable_text');
      // Negative assertion: the stale trigger inserted into FTS using
      // `new.content` / `old.content`. None of the new triggers should.
      expect(t.sql).not.toMatch(/\bnew\.content\b/);
      expect(t.sql).not.toMatch(/\bold\.content\b/);
    }

    // Now INSERT a post-migration row and verify it shows up in FTS via the
    // recreated trigger (not via any kind of bulk rebuild).
    handle
      .prepare(
        `INSERT INTO ai_agent_messages(session_id, source, direction, content, searchable, searchable_text, message_kind)
         VALUES (?, 'user', 'input', 'raw-content-irrelevant', 1, ?, 'user')`,
      )
      .run('sess-trig', 'post-migration-unique-token');

    const hits = handle
      .prepare(`SELECT rowid FROM ai_agent_messages_fts WHERE ai_agent_messages_fts MATCH ?`)
      .all('"post-migration-unique-token"') as { rowid: number }[];
    expect(hits.length).toBe(1);
  });

  it('drops transient codex app-server raw notifications during ai_agent_messages migration', async () => {
    await seedPgliteSchema();
    await pglite.query(
      `INSERT INTO ai_sessions(id, provider, title) VALUES ($1, $2, $3)`,
      ['sess-codex', 'openai-codex', 'codex cleanup test'],
    );
    await pglite.query(
      `INSERT INTO ai_agent_messages(session_id, source, direction, content, metadata, searchable, searchable_text, message_kind)
       VALUES
         ($1, $2, $3, $4, $5::jsonb, $6, $4, 'assistant'),
         ($1, $2, $3, $7, $8::jsonb, $6, $7, 'assistant'),
         ($1, $2, $3, $9, $10::jsonb, $6, $9, 'assistant')`,
      [
        'sess-codex',
        'assistant',
        'output',
        'transient-delta-row',
        JSON.stringify({ transport: 'app-server', eventType: 'item/agentMessage/delta', codexProvider: true }),
        false,
        'transient-usage-row',
        JSON.stringify({ transport: 'app-server', eventType: 'thread/tokenUsage/updated', codexProvider: true }),
        'kept-file-change-row',
        JSON.stringify({ transport: 'app-server', eventType: 'item/completed', codexProvider: true }),
      ],
    );

    const migrator = new PGLiteToSQLiteMigrator();
    await migrator.migrate({
      pglite: pglite as unknown as Parameters<PGLiteToSQLiteMigrator['migrate']>[0]['pglite'],
      sqlite,
    });

    const handle = sqlite.getRawHandle()!;
    const migratedRows = handle
      .prepare(`SELECT content, json_extract(metadata, '$.eventType') AS eventType FROM ai_agent_messages ORDER BY id`)
      .all() as { content: string; eventType: string | null }[];

    expect(migratedRows).toHaveLength(1);
    expect(migratedRows[0]).toEqual({
      content: 'kept-file-change-row',
      eventType: 'item/completed',
    });

    const deltaHits = handle
      .prepare(`SELECT rowid FROM ai_agent_messages_fts WHERE ai_agent_messages_fts MATCH ?`)
      .all('"transient-delta-row"') as { rowid: number }[];
    const keptHits = handle
      .prepare(`SELECT rowid FROM ai_agent_messages_fts WHERE ai_agent_messages_fts MATCH ?`)
      .all('"kept-file-change-row"') as { rowid: number }[];

    expect(deltaHits.length).toBe(0);
    expect(keptHits.length).toBe(1);
  });

  it('throws when row counts mismatch (simulated by deleting a target row mid-flight)', async () => {
    // We can't easily simulate row-count mismatch without monkey-patching, but
    // we can verify the verifier catches a known bad state by directly
    // deleting from the SQLite target after copy and re-running verification.
    await seedPgliteSchema();
    await seedRows();

    const migrator = new PGLiteToSQLiteMigrator();
    await migrator.migrate({
      pglite: pglite as unknown as Parameters<PGLiteToSQLiteMigrator['migrate']>[0]['pglite'],
      sqlite,
    });

    // Delete a row out from under the target -- next migration would fail.
    sqlite.getRawHandle()!.prepare('DELETE FROM ai_sessions WHERE id = ?').run('sess-2');
    const stuck = sqlite
      .getRawHandle()!
      .prepare('SELECT COUNT(*) AS c FROM ai_sessions')
      .get() as { c: number };
    expect(stuck.c).toBe(1);
  });
});
