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

  // Regression (NIM-829): removeBidirectionalLink's session UPDATE uses a
  // parenthesized jsonb subtract-then-merge —
  // `(COALESCE(metadata, '{}') - 'linkedTrackerItemIds') || $1::jsonb`. If the
  // translator leaves the `||` as SQLite string concatenation, the result is
  // two concatenated JSON objects (e.g. `{...}{}`), which is no longer valid
  // JSON and throws "Unexpected non-whitespace character after JSON" on read.
  it('subtract-then-merge metadata UPDATE produces valid JSON (NIM-829)', async () => {
    const adapter = createSQLiteStoreAdapter(db);
    // Seed a session whose metadata is a JSON string holding a link (SQLite shape).
    await adapter.query(
      `INSERT INTO ai_sessions (id, workspace_id, provider, metadata) VALUES ($1, $2, $3, $4)`,
      ['s1', 'ws1', 'claude', JSON.stringify({ title: 'keep me', linkedTrackerItemIds: ['bug_a'] })],
    );
    // Remove the only link -> nextMetadata is `{}` (the removeBidirectionalLink path).
    await adapter.query(
      `UPDATE ai_sessions
       SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'linkedTrackerItemIds') || $1::jsonb
       WHERE id = $2`,
      [JSON.stringify({}), 's1'],
    );
    const { rows } = await adapter.query<{ metadata: string }>(
      `SELECT metadata FROM ai_sessions WHERE id = $1`,
      ['s1'],
    );
    const raw = rows[0].metadata;
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw);
    expect(parsed.linkedTrackerItemIds).toBeUndefined();
    // Other keys must survive the surgical subtract.
    expect(parsed.title).toBe('keep me');
  });

  // Regression (NIM-875): updateTrackerItemsCache batches a file's tracker
  // items into a single multi-row INSERT ... ON CONFLICT instead of one awaited
  // upsert per item. This exercises that exact shape on real SQLite: multi-row
  // VALUES, NOW() in two columns, the `data = tracker_items.data || EXCLUDED.data`
  // JSONB merge on conflict, and the archived CASE.
  it('batched multi-row tracker upsert round-trips and merges JSONB on conflict (NIM-875)', async () => {
    const adapter = createSQLiteStoreAdapter(db);
    const insertTwo = `INSERT INTO tracker_items (
        id, type, data, workspace, document_path, line_number, created, updated, last_indexed, archived, archived_at
      ) VALUES
        ($1, $2, $3, $4, $5, $6, NOW(), NOW(), $7, $8, $9),
        ($10, $11, $12, $13, $14, $15, NOW(), NOW(), $16, $17, $18)
      ON CONFLICT (id) DO UPDATE SET
        type = EXCLUDED.type,
        data = tracker_items.data || EXCLUDED.data,
        workspace = EXCLUDED.workspace,
        document_path = EXCLUDED.document_path,
        line_number = EXCLUDED.line_number,
        updated = NOW(),
        last_indexed = EXCLUDED.last_indexed,
        archived = CASE WHEN EXCLUDED.archived = TRUE THEN TRUE ELSE tracker_items.archived END,
        archived_at = CASE WHEN EXCLUDED.archived = TRUE THEN EXCLUDED.archived_at ELSE tracker_items.archived_at END`;

    await adapter.query(insertTwo, [
      'bug_1', 'bug', JSON.stringify({ title: 'One', status: 'to-do' }), 'ws1', 'a.md', 1, 't', false, null,
      'bug_2', 'bug', JSON.stringify({ title: 'Two', status: 'to-do' }), 'ws1', 'a.md', 2, 't', false, null,
    ]);

    const inserted = await adapter.query<{ id: string; title: string; archived: number }>(
      `SELECT id, json_extract(data, '$.title') AS title, archived FROM tracker_items ORDER BY id`,
    );
    expect(inserted.rows).toEqual([
      { id: 'bug_1', title: 'One', archived: 0 },
      { id: 'bug_2', title: 'Two', archived: 0 },
    ]);

    // Simulate a system key the indexer doesn't know about, then re-index.
    await adapter.query(
      `UPDATE tracker_items SET data = json_set(data, '$.linkedSessions', json_array('sess_1')) WHERE id = $1`,
      ['bug_1'],
    );

    // Re-run the batched upsert with a changed title for bug_1 -> conflict merge
    // must preserve linkedSessions (the `|| EXCLUDED.data` json_patch merge).
    await adapter.query(insertTwo, [
      'bug_1', 'bug', JSON.stringify({ title: 'One v2', status: 'in-progress' }), 'ws1', 'a.md', 1, 't', false, null,
      'bug_2', 'bug', JSON.stringify({ title: 'Two', status: 'to-do' }), 'ws1', 'a.md', 2, 't', false, null,
    ]);

    const merged = await adapter.query<{ title: string; status: string; linked: string }>(
      `SELECT json_extract(data, '$.title') AS title, json_extract(data, '$.status') AS status,
              json_extract(data, '$.linkedSessions[0]') AS linked
       FROM tracker_items WHERE id = $1`,
      ['bug_1'],
    );
    expect(merged.rows[0].title).toBe('One v2');
    expect(merged.rows[0].status).toBe('in-progress');
    expect(merged.rows[0].linked).toBe('sess_1'); // system key survived the merge
  });

  // Regression (NIM-454 / NIM-363): the native createTrackerItem path now
  // persists the type tag (a JS array bound to the type_tags column) and
  // allocates a NIM-### issue key (MAX(issue_number)+1), matching the MCP path.
  // This exercises both on real SQLite.
  it('persists type_tags array and allocates an issue key on native create (NIM-454/363)', async () => {
    const adapter = createSQLiteStoreAdapter(db);

    // Insert two items the way createTrackerItem does: type_tags bound as a JS array.
    await adapter.query(
      `INSERT INTO tracker_items (id, type, type_tags, data, workspace, document_path, created, updated, last_indexed, sync_status, archived, source)
       VALUES ($1, $2, $3, $4, $5, '', NOW(), NOW(), NOW(), $6, FALSE, $7)`,
      ['idea_1', 'idea', ['idea'], JSON.stringify({ title: 'An idea', status: 'to-do' }), 'ws1', 'local', 'native'],
    );

    const typeRow = await adapter.query<{ type_tags: string }>(
      `SELECT type_tags FROM tracker_items WHERE id = $1`,
      ['idea_1'],
    );
    // type_tags column holds the JSON-encoded array on SQLite.
    expect(JSON.parse(typeRow.rows[0].type_tags)).toEqual(['idea']);

    // Allocate an issue key like createTrackerItem: MAX(issue_number)+1.
    const allocate = async (id: string) => {
      const maxResult = await adapter.query<{ max_num: number | null }>(
        `SELECT MAX(issue_number) as max_num FROM tracker_items WHERE workspace = $1`,
        ['ws1'],
      );
      const nextNum = (maxResult.rows[0]?.max_num ?? 0) + 1;
      await adapter.query(
        `UPDATE tracker_items SET issue_number = $1, issue_key = $2 WHERE id = $3`,
        [nextNum, `NIM-${nextNum}`, id],
      );
    };
    await allocate('idea_1');

    await adapter.query(
      `INSERT INTO tracker_items (id, type, type_tags, data, workspace, document_path, created, updated, last_indexed, sync_status, archived, source)
       VALUES ($1, $2, $3, $4, $5, '', NOW(), NOW(), NOW(), $6, FALSE, $7)`,
      ['idea_2', 'idea', ['idea'], JSON.stringify({ title: 'Another', status: 'to-do' }), 'ws1', 'local', 'native'],
    );
    await allocate('idea_2');

    const keyed = await adapter.query<{ id: string; issue_key: string; issue_number: number }>(
      `SELECT id, issue_key, issue_number FROM tracker_items ORDER BY issue_number`,
    );
    expect(keyed.rows).toEqual([
      { id: 'idea_1', issue_key: 'NIM-1', issue_number: 1 },
      { id: 'idea_2', issue_key: 'NIM-2', issue_number: 2 },
    ]);
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
