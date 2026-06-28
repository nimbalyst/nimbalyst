/**
 * Truncation primitive for the edit/rewind feature, verified against a REAL
 * PGLite engine so the FK CASCADE (ai_tool_call_file_edits.message_id ->
 * ai_agent_messages.id) and in-place content update are exercised for real --
 * not asserted against a fake SQL adapter.
 *
 * Covers the store methods added in Stage 2:
 *   deleteMessagesAfter / updateMessageContent / getLastUserMessageId / getMessageById
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { createPGLiteAgentMessagesStore } from '../PGLiteAgentMessagesStore';

interface Pg {
  exec(sql: string): Promise<unknown>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

const SESSION = 'sess-rewind-1';

async function seedMessage(
  db: Pg,
  opts: {
    direction: 'input' | 'output';
    content: string;
    searchableText?: string | null;
    messageKind?: 'user' | 'assistant' | 'tool' | 'system' | 'meta' | null;
    source?: string;
  },
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO ai_agent_messages
       (session_id, source, direction, content, hidden, searchable, searchable_text, message_kind, created_at)
     VALUES ($1, $2, $3, $4, FALSE, FALSE, $5, $6, NOW())
     RETURNING id`,
    [SESSION, opts.source ?? 'claude-code', opts.direction, opts.content, opts.searchableText ?? null, opts.messageKind ?? null],
  );
  return Number(rows[0].id);
}

describe('AgentMessages rewind/truncation primitive (real PGLite)', () => {
  let db: Pg;
  let dataDir: string;
  let store: ReturnType<typeof createPGLiteAgentMessagesStore>;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `pglite-rewind-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    db = new PGlite({ dataDir }) as unknown as Pg;
    await (db as unknown as { waitReady: Promise<void> }).waitReady;

    await db.exec(`
      CREATE TABLE ai_sessions (
        id TEXT PRIMARY KEY,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_archived BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE ai_agent_messages (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source TEXT NOT NULL,
        direction TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        hidden BOOLEAN NOT NULL DEFAULT FALSE,
        provider_message_id TEXT,
        searchable BOOLEAN NOT NULL DEFAULT FALSE,
        searchable_text TEXT,
        message_kind TEXT
      );
      CREATE TABLE session_files (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        file_path TEXT NOT NULL,
        link_type TEXT NOT NULL DEFAULT 'edited',
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE ai_tool_call_file_edits (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_file_id TEXT NOT NULL REFERENCES session_files(id) ON DELETE CASCADE,
        message_id BIGINT NOT NULL REFERENCES ai_agent_messages(id) ON DELETE CASCADE,
        tool_use_id TEXT
      );
    `);
    await db.query(`INSERT INTO ai_sessions (id) VALUES ($1)`, [SESSION]);
    store = createPGLiteAgentMessagesStore(db as unknown as Parameters<typeof createPGLiteAgentMessagesStore>[0]);
  });

  afterEach(async () => {
    if (db) await db.close();
    if (dataDir && fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('deletes every message after N and cascades the file-edit link', async () => {
    const u1 = await seedMessage(db, { direction: 'input', content: JSON.stringify({ prompt: 'first' }), searchableText: 'first', messageKind: 'user' });
    const a2 = await seedMessage(db, { direction: 'output', content: 'assistant reply', searchableText: 'assistant reply', messageKind: 'assistant' });
    const t3 = await seedMessage(db, { direction: 'output', content: JSON.stringify({ tool: 'Edit' }), messageKind: 'tool' });
    await db.query(`INSERT INTO session_files (id, session_id, file_path) VALUES ($1, $2, $3)`, ['sf-1', SESSION, 'src/foo.ts']);
    await db.query(`INSERT INTO ai_tool_call_file_edits (session_id, session_file_id, message_id) VALUES ($1, $2, $3)`, [SESSION, 'sf-1', t3]);
    const u4 = await seedMessage(db, { direction: 'input', content: JSON.stringify({ prompt: 'second' }), searchableText: 'second', messageKind: 'user' });
    const a5 = await seedMessage(db, { direction: 'output', content: 'second reply', searchableText: 'second reply', messageKind: 'assistant' });

    const result = await store.deleteMessagesAfter!(SESSION, u1);

    expect(result.deletedIds.slice().sort((x, y) => x - y)).toEqual([a2, t3, u4, a5].slice().sort((x, y) => x - y));

    const remaining = await db.query<{ id: number }>(`SELECT id FROM ai_agent_messages WHERE session_id = $1 ORDER BY id`, [SESSION]);
    expect(remaining.rows.map((r) => Number(r.id))).toEqual([u1]);

    // FK CASCADE removed the tool-call-file-edit link that pointed at message t3.
    const links = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ai_tool_call_file_edits`);
    expect(Number(links.rows[0].c)).toBe(0);
    // session_files itself is NOT cascade-deleted (no FK to messages); rewind
    // service cleans those separately. Confirm the row survives here.
    const files = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM session_files`);
    expect(Number(files.rows[0].c)).toBe(1);
  });

  it('is a no-op (empty deletedIds) when nothing follows N', async () => {
    const u1 = await seedMessage(db, { direction: 'input', content: JSON.stringify({ prompt: 'only' }), searchableText: 'only', messageKind: 'user' });
    const result = await store.deleteMessagesAfter!(SESSION, u1);
    expect(result.deletedIds).toEqual([]);
    const remaining = await db.query<{ id: number }>(`SELECT id FROM ai_agent_messages WHERE session_id = $1`, [SESSION]);
    expect(remaining.rows.map((r) => Number(r.id))).toEqual([u1]);
  });

  it('updates content and searchable_text in place', async () => {
    const u1 = await seedMessage(db, { direction: 'input', content: JSON.stringify({ prompt: 'first' }), searchableText: 'first', messageKind: 'user' });

    await store.updateMessageContent!(SESSION, u1, JSON.stringify({ prompt: 'edited prompt' }), 'edited prompt');

    const row = await store.getMessageById!(SESSION, u1);
    expect(row?.content).toBe(JSON.stringify({ prompt: 'edited prompt' }));
    const raw = await db.query<{ searchable_text: string }>(`SELECT searchable_text FROM ai_agent_messages WHERE id = $1`, [u1]);
    expect(raw.rows[0].searchable_text).toBe('edited prompt');
  });

  it('getLastUserMessageId tracks the most recent user row through truncation', async () => {
    const u1 = await seedMessage(db, { direction: 'input', content: JSON.stringify({ prompt: 'first' }), searchableText: 'first', messageKind: 'user' });
    await seedMessage(db, { direction: 'output', content: 'reply', searchableText: 'reply', messageKind: 'assistant' });
    const u3 = await seedMessage(db, { direction: 'input', content: JSON.stringify({ prompt: 'second' }), searchableText: 'second', messageKind: 'user' });

    expect(await store.getLastUserMessageId!(SESSION)).toBe(u3);

    await store.deleteMessagesAfter!(SESSION, u1);
    expect(await store.getLastUserMessageId!(SESSION)).toBe(u1);
  });

  it('getMessageById returns null for a missing id', async () => {
    expect(await store.getMessageById!(SESSION, 999999)).toBeNull();
  });
});
