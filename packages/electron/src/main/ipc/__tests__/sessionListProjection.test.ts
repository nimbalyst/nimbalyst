// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { readSessionLaunchCounts } from '../sessionListProjection';

describe.each(['sqlite', 'pglite'] as const)('launch provenance on %s', backend => {
  it('counts direct launches including archived drafts, independently of grouping, and refreshes after deletion', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'session-launch-counts-'));
    const db = backend === 'sqlite'
      ? new SQLiteDatabase({ dbDir: dir, schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), sampleRate: 0 })
      : new PGlite();
    try {
      if (db instanceof SQLiteDatabase) await db.initialize();
      else await db.exec(`CREATE TABLE ai_sessions (
        id TEXT PRIMARY KEY, provider TEXT, workspace_id TEXT,
        created_by_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL,
        parent_session_id TEXT, is_archived BOOLEAN DEFAULT FALSE
      )`);
      const insert = (id: string, creator: string | null, workspace = '/project') => db.query(
        `INSERT INTO ai_sessions (id, provider, workspace_id, created_by_session_id, parent_session_id)
         VALUES ($1, 'claude-code', $2, $3, $4)`, [id, workspace, creator, id === 'group' ? null : 'group']);
      await insert('group', null);
      await insert('plan', null);
      await insert('coordinator', 'plan');
      await insert('worker-a', 'coordinator');
      await insert('worker-b', 'coordinator');
      await insert('sibling', null);
      await insert('other-workspace', 'coordinator', '/other');
      await db.query("UPDATE ai_sessions SET is_archived = TRUE WHERE id = 'worker-b'");

      expect(await readSessionLaunchCounts(db, '/project')).toEqual({ plan: 1, coordinator: 2 });
      expect(await readSessionLaunchCounts(db, '/empty')).toEqual({});
      await db.query("DELETE FROM ai_sessions WHERE id IN ('worker-a', 'worker-b')");
      expect(await readSessionLaunchCounts(db, '/project')).toEqual({ plan: 1 });
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
