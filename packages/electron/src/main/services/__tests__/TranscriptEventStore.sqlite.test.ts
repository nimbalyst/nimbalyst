/**
 * Integration test for createTranscriptEventStore against a real SQLite
 * backend, exercising the FTS5 helper path via SQLiteStoreAdapter.
 *
 * The point is to catch shape mismatches between what
 * SQLiteStoreAdapter.searchTranscriptEvents returns and what
 * rowToEvent() in TranscriptEventStore expects to consume.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';
import { createTranscriptEventStore } from '../TranscriptEventStore';

const SCHEMA_DIR = path.resolve(__dirname, '../../database/sqlite/schemas');

async function makeDb(): Promise<{ db: SQLiteDatabase; dbDir: string }> {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-store-sqlite-'));
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

describe('TranscriptEventStore + SQLiteStoreAdapter', () => {
  let db: SQLiteDatabase;
  let dbDir: string;

  beforeEach(async () => {
    ({ db, dbDir } = await makeDb());
    // Seed a session so transcript_events FK doesn't bite.
    await db.query(
      `INSERT INTO ai_sessions (id, workspace_id, title, provider) VALUES ($s, $w, $t, $p)`,
      [{ s: 's1', w: 'ws1', t: 'T', p: 'claude' }],
    );
    await db.query(
      `INSERT INTO ai_sessions (id, workspace_id, title, provider) VALUES ($s, $w, $t, $p)`,
      [{ s: 's2', w: 'ws1', t: 'T2', p: 'claude' }],
    );
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('searchSessions returns events via FTS helper, with the same shape rowToEvent expects', async () => {
    const adapter = createSQLiteStoreAdapter(db);
    const store = createTranscriptEventStore(adapter);

    // Insert through the store so we exercise the same insert path the
    // app uses.
    await store.insertEvent({
      sessionId: 's1',
      sequence: 0,
      createdAt: new Date('2026-05-20T10:00:00Z'),
      eventType: 'user_message',
      searchableText: 'migration to sqlite plan covering FTS',
      payload: { text: 'migration to sqlite plan covering FTS' },
      parentEventId: null,
      searchable: true,
      subagentId: null,
      provider: 'claude',
      providerToolCallId: null,
    });
    await store.insertEvent({
      sessionId: 's1',
      sequence: 1,
      createdAt: new Date('2026-05-20T10:01:00Z'),
      eventType: 'assistant_message',
      searchableText: 'unrelated text about kittens',
      payload: { text: 'unrelated text about kittens' },
      parentEventId: null,
      searchable: true,
      subagentId: null,
      provider: 'claude',
      providerToolCallId: null,
    });
    await store.insertEvent({
      sessionId: 's2',
      sequence: 0,
      createdAt: new Date('2026-05-20T10:02:00Z'),
      eventType: 'user_message',
      searchableText: 'another sqlite migration discussion',
      payload: { text: 'another sqlite migration discussion' },
      parentEventId: null,
      searchable: true,
      subagentId: null,
      provider: 'claude',
      providerToolCallId: null,
    });

    const hits = await store.searchSessions('migration', { limit: 50 });
    expect(hits.length).toBe(2);

    // Verify every event field round-trips through rowToEvent without
    // dropping data. payload should be a parsed object, createdAt a Date,
    // and the id should be a number.
    for (const hit of hits) {
      expect(typeof hit.event.id).toBe('number');
      expect(hit.event.id).toBeGreaterThan(0);
      expect(hit.event.createdAt).toBeInstanceOf(Date);
      expect(hit.event.payload).toBeTypeOf('object');
      expect((hit.event.payload as { text: string }).text).toMatch(/migration|sqlite/i);
      expect(hit.event.provider).toBe('claude');
      expect(typeof hit.event.searchable).toBe('boolean');
      expect(hit.sessionId).toMatch(/^s[12]$/);
    }
  });

  it('searchSessions sessionIds filter restricts results to the named sessions', async () => {
    const adapter = createSQLiteStoreAdapter(db);
    const store = createTranscriptEventStore(adapter);

    for (const sessionId of ['s1', 's2']) {
      await store.insertEvent({
        sessionId,
        sequence: 0,
        createdAt: new Date(),
        eventType: 'user_message',
        searchableText: 'migration content',
        payload: { text: 'migration content' },
        parentEventId: null,
        searchable: true,
        subagentId: null,
        provider: 'claude',
        providerToolCallId: null,
      });
    }

    const onlyS1 = await store.searchSessions('migration', { sessionIds: ['s1'] });
    expect(onlyS1.length).toBe(1);
    expect(onlyS1[0].sessionId).toBe('s1');
  });
});
