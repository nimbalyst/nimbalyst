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
import { createPGLiteAgentMessagesStore } from '../../../services/PGLiteAgentMessagesStore';

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

  it('writes an agent-message batch atomically: a failed session UPDATE leaves no message rows (#1988)', async () => {
    // On SQLite, BEGIN/COMMIT used to be no-ops and each statement its own
    // request, so the INSERT committed before the UPDATE failed, and the
    // queue's per-row retry then duplicated the rows.
    const adapter = createSQLiteStoreAdapter(db);
    await adapter.query(
      `INSERT INTO ai_sessions (id, workspace_id, title, provider) VALUES ($1, $2, $3, $4)`,
      ['s1', 'ws1', 'Hello', 'claude'],
    );
    await db.exec(
      `CREATE TRIGGER fail_session_update BEFORE UPDATE ON ai_sessions BEGIN SELECT RAISE(ABORT, 'session update failed'); END;`,
    );
    const store = createPGLiteAgentMessagesStore(adapter);
    const message = (content: string) => ({
      sessionId: 's1',
      source: 'claude-code',
      direction: 'output' as const,
      content,
      createdAt: new Date(1_000),
    });

    await expect(store.createMany!([message('a'), message('b')])).rejects.toThrow(/session update failed/);
    await expect(store.create(message('c'))).rejects.toThrow(/session update failed/);

    const { rows } = await adapter.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ai_agent_messages`);
    expect(Number(rows[0].n)).toBe(0);

    await db.exec(`DROP TRIGGER fail_session_update;`);
    await store.createMany!([message('a'), message('b')]);
    const after = await adapter.query<{ content: string }>(`SELECT content FROM ai_agent_messages ORDER BY id`);
    expect(after.rows.map((r) => r.content)).toEqual(['a', 'b']);
  });

  it('matches a Cyrillic title substring regardless of query and title case', async () => {
    const adapter = createSQLiteStoreAdapter(db);
    await adapter.query(
      'INSERT INTO ai_sessions (id, workspace_id, title, provider) VALUES ($1, $2, $3, $4)',
      ['s1', 'ws1', 'Пост-запуск', 'claude'],
    );
    for (const query of ['пост', 'ПОСТ', 'ПоСт']) {
      const hits = await adapter.searchSessionTitles!('ws1', query);
      expect(hits.map(hit => hit.session_id)).toEqual(['s1']);
    }
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

  // Regression (#1403): `HistoryManager` retires pending-review tags with a
  // *literal* jsonb value, `jsonb_set(metadata, '{status}', '"reviewed"')`,
  // rather than a bound `to_jsonb($1::text)`. Postgres parses that literal as
  // jsonb and stores the string `reviewed`; SQLite's json_set stores whatever
  // text it is handed, so the row landed as `{"status":"\"reviewed\""}` — a
  // value that satisfies neither the pending-review nor the reviewed predicate.
  // 2,613 rows on one dev machine reached that state before this was caught.
  // The string-level translator test could not see it: the SQL was
  // syntactically fine and only the stored value was wrong.
  it('jsonb_set with a literal value stores parsed JSON, not the raw text (#1403)', async () => {
    const adapter = createSQLiteStoreAdapter(db);
    await adapter.query(
      `INSERT INTO ai_sessions (id, workspace_id, title, provider, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      ['s1', 'ws1', 't', 'claude', JSON.stringify({ status: 'pending-review' })],
    );
    await adapter.query(
      `UPDATE ai_sessions
       SET metadata = jsonb_set(
                        jsonb_set(metadata, '{status}', '"reviewed"'),
                        '{updatedAt}', to_jsonb($1::bigint))
       WHERE id = $2`,
      [1234567890, 's1'],
    );

    const { rows } = await adapter.query<{ metadata: string }>(
      `SELECT metadata FROM ai_sessions WHERE id = $1`,
      ['s1'],
    );
    expect(JSON.parse(rows[0].metadata)).toEqual({
      status: 'reviewed',
      updatedAt: 1234567890,
    });

    // And the predicate the readers actually use must match it.
    const { rows: matched } = await adapter.query<{ id: string }>(
      `SELECT id FROM ai_sessions WHERE metadata->>'status' = $1`,
      ['reviewed'],
    );
    expect(matched.map((r) => r.id)).toEqual(['s1']);
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

  // Native creates persist their type tag but deliberately leave both issue
  // identity columns empty. Personal items and team drafts never reach the
  // team's server-side sequence; a published item receives its key from the
  // TrackerRoom instead of this local SQLite projection.
  it('persists type_tags and leaves the issue key unassigned on native create', async () => {
    const adapter = createSQLiteStoreAdapter(db);

    // Insert the way createTrackerItem does: type_tags bound as a JS array and
    // no client-side issue identity columns in the statement.
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

    const identity = await adapter.query<{ issue_key: string | null; issue_number: number | null }>(
      `SELECT issue_key, issue_number FROM tracker_items WHERE id = $1`,
      ['idea_1'],
    );
    expect(identity.rows[0]).toEqual({ issue_key: null, issue_number: null });
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
