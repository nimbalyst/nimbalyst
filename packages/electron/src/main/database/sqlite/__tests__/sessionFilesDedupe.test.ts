/**
 * Regression tests for 0026_session_files_dedupe.
 *
 * session_files used to grow one row per attribution: addFileLink issued a plain
 * INSERT and idx_session_files_unique was declared non-unique, so a session that
 * edited the same file N times accumulated N rows. getFilesBySession then shipped
 * the whole duplicate set to the renderer on every session-files:updated event.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../SQLiteDatabase';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

/** The upsert PGLiteSessionFileStore.addFileLink issues, with `?` placeholders. */
const UPSERT_SQL = `INSERT INTO session_files (
  id, session_id, workspace_id, file_path, link_type, timestamp, metadata
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (session_id, file_path, link_type) DO UPDATE SET
  workspace_id = EXCLUDED.workspace_id,
  timestamp = EXCLUDED.timestamp,
  metadata = EXCLUDED.metadata
RETURNING id, timestamp, metadata`;

async function withDb(
  fn: (handle: import('better-sqlite3').Database) => void | Promise<void>,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-sf-dedupe-'));
  const sqlite = new SQLiteDatabase({
    dbDir: tmpDir,
    schemaDir: SCHEMA_DIR,
    slowQueryThresholdMs: 1000,
    sampleRate: 0,
  });
  try {
    await sqlite.initialize();
    const handle = sqlite.getRawHandle()!;
    handle.pragma('foreign_keys = ON');
    await fn(handle);
  } finally {
    await sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Minimal parent rows so the ai_tool_call_file_edits foreign keys hold. */
function seedSession(
  handle: import('better-sqlite3').Database,
  sessionId: string,
): number {
  handle
    .prepare(`INSERT INTO ai_sessions (id, provider) VALUES (?, 'claude')`)
    .run(sessionId);
  const info = handle
    .prepare(
      `INSERT INTO ai_agent_messages (session_id, source, direction, content)
       VALUES (?, 'test', 'output', 'msg')`,
    )
    .run(sessionId);
  return Number(info.lastInsertRowid);
}

function insertFileRow(
  handle: import('better-sqlite3').Database,
  row: { id: string; sessionId: string; filePath: string; linkType: string; ts: string },
): void {
  handle
    .prepare(
      `INSERT INTO session_files
         (id, session_id, workspace_id, file_path, link_type, timestamp, metadata)
       VALUES (?, ?, 'ws', ?, ?, ?, '{}')`,
    )
    .run(row.id, row.sessionId, row.filePath, row.linkType, row.ts);
}

/** Recreate the pre-0026 state: a plain, non-unique index. */
function revertToNonUniqueIndex(handle: import('better-sqlite3').Database): void {
  handle.exec(`
    DROP INDEX IF EXISTS idx_session_files_unique;
    CREATE INDEX idx_session_files_unique
      ON session_files(session_id, file_path, link_type);
  `);
}

function indexIsUnique(
  handle: import('better-sqlite3').Database,
  name: string,
): boolean {
  const rows = handle.prepare(`PRAGMA index_list(session_files)`).all() as Array<{
    name: string;
    unique: number;
  }>;
  return rows.some((r) => r.name === name && r.unique === 1);
}

describe('0026_session_files_dedupe', () => {
  it('leaves idx_session_files_unique actually unique', async () => {
    await withDb((handle) => {
      expect(indexIsUnique(handle, 'idx_session_files_unique')).toBe(true);
    });
  });

  it('collapses a repeat attribution instead of appending a row', async () => {
    await withDb((handle) => {
      seedSession(handle, 's1');
      const upsert = handle.prepare(UPSERT_SQL);

      const first = upsert.get(
        'id-1', 's1', 'ws', '/a/b.ts', 'edited', '2026-01-01T00:00:00.000Z', '{"n":1}',
      ) as { id: string; timestamp: string; metadata: string };
      const second = upsert.get(
        'id-2', 's1', 'ws', '/a/b.ts', 'edited', '2026-01-02T00:00:00.000Z', '{"n":2}',
      ) as { id: string; timestamp: string; metadata: string };

      const count = handle
        .prepare(`SELECT count(*) AS c FROM session_files WHERE session_id = 's1'`)
        .get() as { c: number };

      expect(count.c).toBe(1);
      // The surviving row keeps its original id, so attributions that already
      // reference it stay valid.
      expect(second.id).toBe(first.id);
      expect(second.timestamp).toBe('2026-01-02T00:00:00.000Z');
      expect(second.metadata).toBe('{"n":2}');
    });
  });

  it('keeps rows that differ only by link_type apart', async () => {
    await withDb((handle) => {
      seedSession(handle, 's1');
      const upsert = handle.prepare(UPSERT_SQL);
      upsert.run('id-1', 's1', 'ws', '/a/b.ts', 'edited', '2026-01-01T00:00:00.000Z', '{}');
      upsert.run('id-2', 's1', 'ws', '/a/b.ts', 'read', '2026-01-01T00:00:00.000Z', '{}');

      const count = handle
        .prepare(`SELECT count(*) AS c FROM session_files WHERE session_id = 's1'`)
        .get() as { c: number };
      expect(count.c).toBe(2);
    });
  });

  it('backfills existing duplicates, keeping the newest row per triple', async () => {
    await withDb((handle) => {
      seedSession(handle, 's1');
      revertToNonUniqueIndex(handle);

      insertFileRow(handle, { id: 'old', sessionId: 's1', filePath: '/a/b.ts', linkType: 'edited', ts: '2026-01-01T00:00:00.000Z' });
      insertFileRow(handle, { id: 'mid', sessionId: 's1', filePath: '/a/b.ts', linkType: 'edited', ts: '2026-01-02T00:00:00.000Z' });
      insertFileRow(handle, { id: 'new', sessionId: 's1', filePath: '/a/b.ts', linkType: 'edited', ts: '2026-01-03T00:00:00.000Z' });
      insertFileRow(handle, { id: 'other', sessionId: 's1', filePath: '/c/d.ts', linkType: 'edited', ts: '2026-01-01T00:00:00.000Z' });

      handle.exec(fs.readFileSync(path.join(SCHEMA_DIR, '0026_session_files_dedupe.sql'), 'utf8'));

      const rows = handle
        .prepare(`SELECT id, file_path FROM session_files WHERE session_id = 's1' ORDER BY file_path`)
        .all() as Array<{ id: string; file_path: string }>;

      expect(rows).toEqual([
        { id: 'new', file_path: '/a/b.ts' },
        { id: 'other', file_path: '/c/d.ts' },
      ]);
      expect(indexIsUnique(handle, 'idx_session_files_unique')).toBe(true);
    });
  });

  it('re-points tool-call attributions instead of cascade-deleting them', async () => {
    await withDb((handle) => {
      const messageId = seedSession(handle, 's1');
      revertToNonUniqueIndex(handle);

      insertFileRow(handle, { id: 'old', sessionId: 's1', filePath: '/a/b.ts', linkType: 'edited', ts: '2026-01-01T00:00:00.000Z' });
      insertFileRow(handle, { id: 'new', sessionId: 's1', filePath: '/a/b.ts', linkType: 'edited', ts: '2026-01-02T00:00:00.000Z' });

      // Attribution points at the row the migration is about to delete; the FK is
      // ON DELETE CASCADE, so without re-pointing this row would vanish.
      handle
        .prepare(
          `INSERT INTO ai_tool_call_file_edits (session_id, session_file_id, message_id)
           VALUES ('s1', 'old', ?)`,
        )
        .run(messageId);

      handle.exec(fs.readFileSync(path.join(SCHEMA_DIR, '0026_session_files_dedupe.sql'), 'utf8'));

      const edits = handle
        .prepare(`SELECT session_file_id FROM ai_tool_call_file_edits`)
        .all() as Array<{ session_file_id: string }>;

      expect(edits).toEqual([{ session_file_id: 'new' }]);
    });
  });

  it('is idempotent when re-run against an already-clean table', async () => {
    await withDb((handle) => {
      seedSession(handle, 's1');
      insertFileRow(handle, { id: 'only', sessionId: 's1', filePath: '/a/b.ts', linkType: 'edited', ts: '2026-01-01T00:00:00.000Z' });

      const sql = fs.readFileSync(path.join(SCHEMA_DIR, '0026_session_files_dedupe.sql'), 'utf8');
      handle.exec(sql);
      handle.exec(sql);

      const count = handle
        .prepare(`SELECT count(*) AS c FROM session_files WHERE session_id = 's1'`)
        .get() as { c: number };
      expect(count.c).toBe(1);
      expect(indexIsUnique(handle, 'idx_session_files_unique')).toBe(true);
    });
  });
});
