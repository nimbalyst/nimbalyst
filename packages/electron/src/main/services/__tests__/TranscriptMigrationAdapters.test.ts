// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';

const fixtureDb = vi.hoisted(() => ({ current: null as SQLiteDatabase | null }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    isInitialized: () => true,
    query: (...args: [string, unknown[]]) => fixtureDb.current!.query(...args),
  },
}));

import { createRawMessageStoreAdapter } from '../TranscriptMigrationAdapters';

describe('createRawMessageStoreAdapter (real SQLite backend)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-raw-store-'));
    const db = new SQLiteDatabase({
      dbDir: tmpDir,
      schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
      sampleRate: 0,
    });
    await db.initialize();
    fixtureDb.current = db;
    await db.query(
      `INSERT INTO ai_sessions (id, workspace_id, provider, title) VALUES ($1, $2, $3, $4)`,
      ['s1', '/ws', 'claude-code', 'Session'],
    );
    for (let i = 1; i <= 7; i++) {
      await db.query(
        `INSERT INTO ai_agent_messages (session_id, source, direction, content) VALUES ($1, $2, $3, $4)`,
        ['s1', 'claude-code', 'output', `row ${i}`],
      );
    }
  });

  afterEach(async () => {
    await fixtureDb.current?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pages through a session by id when given a limit', async () => {
    const store = createRawMessageStoreAdapter();
    const contents = async (afterId?: number, limit?: number) =>
      (await store.getMessages('s1', afterId, limit)).map((m) => m.content);

    expect(await contents(undefined, 3)).toEqual(['row 1', 'row 2', 'row 3']);
    const [, , third] = await store.getMessages('s1', undefined, 3);
    expect(await contents(third.id, 3)).toEqual(['row 4', 'row 5', 'row 6']);
    expect(await contents(third.id + 3, 3)).toEqual(['row 7']);
    expect(await contents()).toHaveLength(7);
  });
});
