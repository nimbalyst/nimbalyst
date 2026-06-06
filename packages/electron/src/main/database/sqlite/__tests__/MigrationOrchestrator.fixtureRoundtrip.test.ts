/**
 * Post-migration feature parity test.
 *
 * Seeds a substantial PGLite fixture covering every table the migrator
 * touches, runs the full MigrationOrchestrator end-to-end, then verifies
 * the SQLite database via the StoreDbAdapter -- exactly the surface the
 * stores see post-cutover. This catches regressions where rows copy
 * correctly but the store-layer SQL or FTS path is broken on SQLite.
 *
 * Existing tests cover:
 *   - PGLiteToSQLiteMigrator.test.ts: per-table row-level translation.
 *   - MigrationOrchestrator.test.ts: orchestrator filesystem cutover.
 *   - SQLiteStoreAdapter.test.ts: FTS5 + translator round-trips.
 *
 * This test fills the gap between them: "after the orchestrator runs,
 * can the stores actually read what they wrote?"
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MigrationOrchestrator, type LivePgliteReader } from '../MigrationOrchestrator';
import type { PGLiteHandle } from '../PGLiteToSQLiteMigrator';

async function openPgliteReader(dataDir: string): Promise<{ reader: LivePgliteReader; close: () => Promise<void> }> {
  const db = new PGlite({ dataDir });
  await (db as unknown as { waitReady: Promise<void> }).waitReady;
  const reader: LivePgliteReader = {
    queryReadOnly: async <T,>(sql: string, params?: unknown[]) =>
      db.query<T>(sql, params) as Promise<{ rows: T[] }>,
  };
  return { reader, close: () => db.close() };
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
import { SQLiteDatabase } from '../SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../SQLiteStoreAdapter';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

describe('MigrationOrchestrator fixture round-trip', () => {
  let tmp: string;
  let userDataPath: string;
  let pgliteDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-orch-roundtrip-'));
    userDataPath = tmp;
    pgliteDir = path.join(userDataPath, 'pglite-db');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function seedFixture(): Promise<void> {
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
        model TEXT,
        title TEXT NOT NULL DEFAULT 'New conversation',
        session_type TEXT DEFAULT 'session',
        agent_role TEXT DEFAULT 'standard',
        metadata JSONB NOT NULL DEFAULT '{}',
        is_archived BOOLEAN NOT NULL DEFAULT FALSE,
        is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
        worktree_id TEXT,
        parent_session_id TEXT,
        created_by_session_id TEXT,
        branched_from_session_id TEXT,
        branch_point_message_id BIGINT,
        branched_at TIMESTAMPTZ,
        mode TEXT DEFAULT 'agent',
        last_activity TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
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
      CREATE TABLE tracker_items (
        id TEXT PRIMARY KEY,
        issue_number INTEGER,
        issue_key TEXT,
        type TEXT NOT NULL,
        data JSONB NOT NULL,
        workspace TEXT NOT NULL,
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
        last_indexed TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE tracker_body_cache (
        item_id TEXT NOT NULL,
        body_version INTEGER NOT NULL,
        content TEXT NOT NULL,
        cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (item_id, body_version)
      );
    `);

    // 3 worktrees
    await db.query(
      `INSERT INTO worktrees(id, workspace_id, name, path, branch)
       VALUES ($1,$2,$3,$4,$5),($6,$7,$8,$9,$10),($11,$12,$13,$14,$15)`,
      [
        'wt-1', 'ws-A', 'auth-refactor', '/tmp/wt-1', 'auth-refactor',
        'wt-2', 'ws-A', 'tracker-fix', '/tmp/wt-2', 'tracker-fix',
        'wt-3', 'ws-A', 'archived-thing', '/tmp/wt-3', 'archived-thing',
      ],
    );
    await db.query(`UPDATE worktrees SET is_archived = TRUE WHERE id = 'wt-3'`);

    // 4 sessions across two workspaces
    await db.query(
      `INSERT INTO ai_sessions(id, workspace_id, provider, title, worktree_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      ['sess-1', 'ws-A', 'claude', 'Auth migration plan', 'wt-1', JSON.stringify({ pinned: true, tags: ['hot'] })],
    );
    await db.query(
      `INSERT INTO ai_sessions(id, workspace_id, provider, title, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      ['sess-2', 'ws-A', 'openai', 'Tracker sync bug', JSON.stringify({ tags: ['hot', 'sync'] })],
    );
    await db.query(
      `INSERT INTO ai_sessions(id, workspace_id, provider, title, parent_session_id)
       VALUES ($1, $2, $3, $4, $5)`,
      ['sess-3', 'ws-A', 'claude', 'Auth follow-up child', 'sess-1'],
    );
    await db.query(
      `INSERT INTO ai_sessions(id, workspace_id, provider, title, is_archived)
       VALUES ($1, $2, $3, $4, $5)`,
      ['sess-4', 'ws-B', 'claude', 'Old archived session', true],
    );
    // Regression: `mode='auto'` comes from the "Allow All" permission feature
    // (sends mode:auto to Claude Code so the classifier gates tools). The SQLite
    // ai_sessions CHECK once allowed only planning/agent and aborted the entire
    // migration on this row.
    await db.query(
      `INSERT INTO ai_sessions(id, workspace_id, provider, title, mode)
       VALUES ($1, $2, $3, $4, $5)`,
      ['sess-5', 'ws-A', 'claude', 'Auto-mode allow-all session', 'auto'],
    );

    // Messages -- mix of searchable=true and false. Phase 2 of
    // canonical-transcript-deprecation: FTS now requires searchable_text,
    // so we populate it on the rows that should be indexed.
    await db.query(
      `INSERT INTO ai_agent_messages(session_id, source, direction, content, searchable, searchable_text, message_kind)
       VALUES ($1,$2,$3,$4,$5,$16,'user'),($6,$7,$8,$9,$10,NULL,'assistant'),($11,$12,$13,$14,$15,$17,'user')`,
      [
        'sess-1', 'user', 'input', 'plan the auth migration sweep', true,
        'sess-1', 'assistant', 'output', 'the rotation cadence should be weekly', false,
        'sess-2', 'user', 'input', 'tracker sync seems stuck on conflict', true,
        'plan the auth migration sweep',
        'tracker sync seems stuck on conflict',
      ],
    );

    // Transcript events for FTS5 testing
    await db.query(
      `INSERT INTO ai_transcript_events(session_id, sequence, event_type, searchable_text, provider, searchable, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb), ($8,$9,$10,$11,$12,$13,$14::jsonb), ($15,$16,$17,$18,$19,$20,$21::jsonb)`,
      [
        'sess-1', 0, 'user_message', 'plan the auth migration sweep', 'claude', true, JSON.stringify({ text: 'plan the auth migration sweep' }),
        'sess-2', 0, 'user_message', 'tracker sync seems stuck on conflict', 'openai', true, JSON.stringify({ text: 'tracker sync seems stuck on conflict' }),
        'sess-1', 1, 'assistant_message', 'auth migration involves rotating provider tokens', 'claude', true, JSON.stringify({ text: 'auth migration involves rotating provider tokens' }),
      ],
    );

    // Trackers
    await db.query(
      `INSERT INTO tracker_items(id, type, data, workspace, type_tags, body_version)
       VALUES ($1, $2, $3::jsonb, $4, $5::text[], $6)`,
      ['tr-1', 'bug', JSON.stringify({ title: 'Login broken', status: 'open' }), 'ws-A', ['ui'], 1],
    );
    await db.query(
      `INSERT INTO tracker_body_cache(item_id, body_version, content)
       VALUES ($1, $2, $3)`,
      ['tr-1', 1, '# Login broken\n\nReproduces on Safari.'],
    );

    await db.close();
  }

  it('feature parity holds after migration: FTS, sessions list, trackers, body cache, archived filter', async () => {
    await seedFixture();

    const { reader, close } = await openPgliteReader(path.join(userDataPath, 'pglite-db'));
    const orch = new MigrationOrchestrator({
      userDataPath,
      schemaDir: SCHEMA_DIR,
      pglite: reader,
      closeRunningPglite: async () => { await close(); },
      reopenPgliteAfterClose: reopenPgliteHandle,
      log: () => undefined,
    });
    const summary = await orch.run();
    expect(summary.foreignKeyViolations).toBe(0);
    expect(summary.integrityCheck).toBe('ok');

    // Open the now-migrated SQLite database via the same surface stores use.
    const sqlite = new SQLiteDatabase({
      dbDir: path.join(userDataPath, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();

    try {
      const adapter = createSQLiteStoreAdapter(sqlite);

      // Sessions list (the PGLite store query, translated via the adapter)
      const { rows: sessionRows } = await adapter.query<{ id: string; title: string }>(
        `SELECT id, title FROM ai_sessions WHERE workspace_id = $1 ORDER BY title`,
        ['ws-A'],
      );
      expect(sessionRows.map((r) => r.id).sort()).toEqual(['sess-1', 'sess-2', 'sess-3', 'sess-5']);

      // Regression: mode='auto' survives migration (CHECK now allows it).
      const { rows: autoModeRows } = await adapter.query<{ mode: string }>(
        `SELECT mode FROM ai_sessions WHERE id = $1`,
        ['sess-5'],
      );
      expect(autoModeRows[0].mode).toBe('auto');

      // Worktrees: archived filter works
      const { rows: activeWt } = await adapter.query<{ id: string }>(
        `SELECT id FROM worktrees WHERE is_archived = false ORDER BY id`,
        [],
      );
      expect(activeWt.map((r) => r.id)).toEqual(['wt-1', 'wt-2']);

      // Tracker item + body cache cold-load via JSON column
      const { rows: trackerRows } = await adapter.query<{ id: string; title: string | null; data: string }>(
        `SELECT id, title, data FROM tracker_items WHERE workspace = $1`,
        ['ws-A'],
      );
      expect(trackerRows.length).toBe(1);
      // Generated `title` column should pull from data->>'title'.
      expect(trackerRows[0].title).toBe('Login broken');

      const { rows: bodyRows } = await adapter.query<{ content: string }>(
        `SELECT content FROM tracker_body_cache WHERE item_id = $1 AND body_version = $2`,
        ['tr-1', 1],
      );
      expect(bodyRows[0].content).toMatch(/Login broken/);

      // FTS over agent messages via the helper
      const msgHits = await adapter.searchAgentMessages!('migration', { limit: 10 });
      // 1 indexed message contains "migration" (the other was searchable=false
      // but the migrator backfills regardless for historical search).
      expect(msgHits.length).toBeGreaterThanOrEqual(1);

      // Note: ai_transcript_events is intentionally not copied by the migrator
      // (see PGLiteToSQLiteMigrator COPY_TABLES doc). The events table is
      // derived from ai_agent_messages by TranscriptTransformer on first
      // session open after migration, so the FTS5 mirror is also empty until
      // then. The agent-messages FTS coverage above already verifies the
      // round-trip path; transcript-events FTS belongs to a TranscriptTransformer
      // integration test, not this round-trip.

      // Session metadata JSON round-trips intact (tags array preserved)
      const { rows: metaRows } = await adapter.query<{ metadata: string }>(
        `SELECT metadata FROM ai_sessions WHERE id = $1`,
        ['sess-2'],
      );
      const meta = JSON.parse(metaRows[0].metadata);
      expect(meta.tags).toEqual(['hot', 'sync']);
    } finally {
      await sqlite.close();
    }
  });
});
