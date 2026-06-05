/**
 * SQLiteStoreAdapter integration tests.
 *
 * These open a real on-disk SQLite database (via SQLiteDatabase) seeded
 * with the production schema, then exercise the dialect-aware adapter
 * with the same PG-flavored SQL the stores use. The point is to catch
 * cases where the translator produces syntactically-valid but
 * semantically-wrong SQLite.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../SQLiteStoreAdapter';

const SCHEMA_DIR = path.resolve(__dirname, '../schemas');

async function makeDb(): Promise<{ db: SQLiteDatabase; dbDir: string }> {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-adapter-'));
  const db = new SQLiteDatabase({
    dbDir,
    schemaDir: SCHEMA_DIR,
    log: () => {
      /* quiet */
    },
  });
  await db.initialize();
  return { db, dbDir };
}

describe('SQLiteStoreAdapter', () => {
  let db: SQLiteDatabase;
  let dbDir: string;

  beforeEach(async () => {
    ({ db, dbDir } = await makeDb());
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('runs a basic SELECT with $1 param', async () => {
    const adapter = createSQLiteStoreAdapter(db);
    await adapter.query(
      `INSERT INTO ai_sessions (id, workspace_id, title, provider)
       VALUES ($1, $2, $3, $4)`,
      ['s1', 'ws1', 'Hello', 'claude'],
    );
    const { rows } = await adapter.query<{ id: string; title: string }>(
      `SELECT id, title FROM ai_sessions WHERE id = $1`,
      ['s1'],
    );
    expect(rows).toEqual([{ id: 's1', title: 'Hello' }]);
  });

  it('handles NOW() in SET and WHERE clauses', async () => {
    const adapter = createSQLiteStoreAdapter(db);
    await adapter.query(
      `INSERT INTO ai_sessions (id, workspace_id, title, provider, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      ['s1', 'ws1', 't', 'claude'],
    );
    await adapter.query(
      `UPDATE ai_sessions SET updated_at = NOW() WHERE id = $1`,
      ['s1'],
    );
    const { rows } = await adapter.query<{ updated_at: string }>(
      `SELECT updated_at FROM ai_sessions WHERE id = $1`,
      ['s1'],
    );
    expect(rows[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('handles ANY($N) batch lookups with multiple values', async () => {
    const adapter = createSQLiteStoreAdapter(db);
    for (const id of ['s1', 's2', 's3']) {
      await adapter.query(
        `INSERT INTO ai_sessions (id, workspace_id, title, provider)
         VALUES ($1, $2, $3, $4)`,
        [id, 'ws1', `Session ${id}`, 'claude'],
      );
    }
    const { rows } = await adapter.query<{ id: string }>(
      `SELECT id FROM ai_sessions WHERE id = ANY($1::text[]) ORDER BY id`,
      [['s1', 's3']],
    );
    expect(rows.map((r) => r.id)).toEqual(['s1', 's3']);
  });

  it('handles ANY($N) with an empty array as a no-op', async () => {
    const adapter = createSQLiteStoreAdapter(db);
    await adapter.query(
      `INSERT INTO ai_sessions (id, workspace_id, title, provider)
       VALUES ($1, $2, $3, $4)`,
      ['s1', 'ws1', 't', 'claude'],
    );
    const { rows } = await adapter.query<{ id: string }>(
      `SELECT id FROM ai_sessions WHERE id = ANY($1::text[])`,
      [[]],
    );
    expect(rows).toEqual([]);
  });

  it('handles jsonb_set with a literal path + to_jsonb wrapper', async () => {
    const adapter = createSQLiteStoreAdapter(db);
    await adapter.query(
      `INSERT INTO ai_sessions (id, workspace_id, title, provider, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      ['s1', 'ws1', 't', 'claude', JSON.stringify({ status: 'open' })],
    );
    await adapter.query(
      `UPDATE ai_sessions
       SET metadata = jsonb_set(metadata, '{status}', to_jsonb($1::text))
       WHERE id = $2`,
      ['reviewed', 's1'],
    );
    const { rows } = await adapter.query<{ metadata: string }>(
      `SELECT metadata FROM ai_sessions WHERE id = $1`,
      ['s1'],
    );
    expect(JSON.parse(rows[0].metadata)).toEqual({ status: 'reviewed' });
  });

  it('handles nested jsonb_set chains', async () => {
    const adapter = createSQLiteStoreAdapter(db);
    await adapter.query(
      `INSERT INTO ai_sessions (id, workspace_id, title, provider, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      ['s1', 'ws1', 't', 'claude', JSON.stringify({})],
    );
    await adapter.query(
      `UPDATE ai_sessions
       SET metadata = jsonb_set(
                        jsonb_set(metadata, '{status}', to_jsonb($1::text)),
                        '{updatedAt}', to_jsonb($2::bigint))
       WHERE id = $3`,
      ['reviewed', 1234567890, 's1'],
    );
    const { rows } = await adapter.query<{ metadata: string }>(
      `SELECT metadata FROM ai_sessions WHERE id = $1`,
      ['s1'],
    );
    expect(JSON.parse(rows[0].metadata)).toEqual({
      status: 'reviewed',
      updatedAt: 1234567890,
    });
  });

  it('handles RETURNING * on INSERT', async () => {
    const adapter = createSQLiteStoreAdapter(db);
    const { rows } = await adapter.query<{ id: string; title: string }>(
      `INSERT INTO ai_sessions (id, workspace_id, title, provider)
       VALUES ($1, $2, $3, $4) RETURNING id, title`,
      ['s1', 'ws1', 'Inserted', 'claude'],
    );
    expect(rows).toEqual([{ id: 's1', title: 'Inserted' }]);
  });

  it('FTS searchAgentMessages finds inserted messages via trigger backfill', async () => {
    // Seed an ai_session so the message FK doesn't bite.
    await db.query(
      `INSERT INTO ai_sessions (id, workspace_id, title, provider) VALUES ($s, $w, $t, $p)`,
      [{ s: 's1', w: 'ws1', t: 'T', p: 'claude' }],
    );
    // Insert searchable messages directly (trigger fires when searchable_text IS NOT NULL).
    await db.query(
      `INSERT INTO ai_agent_messages (session_id, source, direction, content, searchable, searchable_text, message_kind)
       VALUES ($s, 'user', 'input', $c, 1, $st, 'user')`,
      [{ s: 's1', c: 'the migration plan covers PGLite and SQLite', st: 'the migration plan covers PGLite and SQLite' }],
    );
    await db.query(
      `INSERT INTO ai_agent_messages (session_id, source, direction, content, searchable, searchable_text, message_kind)
       VALUES ($s, 'assistant', 'output', $c, 1, $st, 'assistant')`,
      [{ s: 's1', c: 'unrelated text about kittens', st: 'unrelated text about kittens' }],
    );

    const adapter = createSQLiteStoreAdapter(db);
    const hits = await adapter.searchAgentMessages!('migration');
    expect(hits.length).toBe(1);
    // Lower bm25 = better match in FTS5.
    expect(hits[0].rank).toBeLessThan(0);
  });
});
