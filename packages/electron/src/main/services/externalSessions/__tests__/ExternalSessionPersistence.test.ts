// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { runTransactionStatements } from '../../../database/transactionStatements';
import { createPGLiteSessionStore } from '../../PGLiteSessionStore';
import { ExternalSessionPersistence } from '../ExternalSessionPersistence';
import type { ExternalCursor } from '../types';

const schemaDir = path.resolve(__dirname, '../../../database/sqlite/schemas');
const ref = { providerId: 'claude-code' as const, externalId: 'external', workspacePath: '/workspace', filePath: '/logs/main.jsonl' };
const cursor = (byteOffset: number) => ({ byteOffset, fileSize: byteOffset, inode: 1, lastEntryUuid: `entry-${byteOffset}` });
const message = (id: string) => ({ source: 'claude-code', direction: 'output' as const, content: JSON.stringify({ uuid: id, type: 'assistant' }), providerMessageId: id, createdAt: new Date('2026-09-14T12:00:00Z') });

describe.each(['pglite', 'sqlite'] as const)('ExternalSessionPersistence (%s)', (backend) => {
  let dir: string;
  let db: Pick<SQLiteDatabase, 'query' | 'runTransaction' | 'close'>;
  let persistence: ExternalSessionPersistence;
  async function open() {
    if (backend === 'sqlite') {
      const sqlite = new SQLiteDatabase({ dbDir: dir, schemaDir, sampleRate: 0 });
      await sqlite.initialize();
      db = sqlite;
    } else {
      const pg = new PGlite(path.join(dir, 'pg'));
      await pg.waitReady;
      await pg.exec(`
        CREATE TABLE IF NOT EXISTS ai_sessions (id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_session_id TEXT, workspace_id TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS ai_agent_messages (id BIGSERIAL PRIMARY KEY, session_id TEXT REFERENCES ai_sessions(id) ON DELETE CASCADE, source TEXT NOT NULL, direction TEXT CHECK(direction IN ('input','output')), content TEXT NOT NULL, metadata JSONB, hidden BOOLEAN, created_at TIMESTAMPTZ, provider_message_id TEXT, searchable BOOLEAN, searchable_text TEXT, message_kind TEXT);
      `);
      // Execute the actual PGLite migration, so schema drift fails this contract test.
      const worker = readFileSync(path.resolve(__dirname, '../../../database/worker.js'), 'utf8');
      const migration = worker.match(/\/\/ External session persistence migration\.[\s\S]*?this\.db\.exec\(`([\s\S]*?)`\)/)?.[1];
      if (!migration) throw new Error('Missing external session PGLite migration');
      await pg.exec(migration);
      db = { query: (sql, params) => pg.query(sql, params), runTransaction: async (statements) => { await pg.transaction(tx => runTransactionStatements(tx, statements)); }, close: () => pg.close() };
    }
    persistence = new ExternalSessionPersistence(db);
  }
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'external-session-persistence-'));
    await open();
    await db.query('INSERT INTO ai_sessions (id,provider,provider_session_id,workspace_id) VALUES ($1,$2,$3,$4)', ['local', ref.providerId, ref.externalId, ref.workspacePath]);
  });
  afterEach(async () => { await db?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  const append = (expectedCursor: ExternalCursor | null, next: ExternalCursor, ids: string[], target = ref) => persistence.appendAndAdvance({ ref: target, sessionId: 'local', expectedCursor, cursor: next, messages: ids.map(message) });
  async function ids() { return (await db.query<{ provider_message_id: string }>('SELECT provider_message_id FROM ai_agent_messages ORDER BY id')).rows.map(row => row.provider_message_id); }

  it('appends new entries, deduplicates replay and survives close/reopen with independent sidecar cursors', async () => {
    expect(await persistence.getCursor(ref)).toBeNull();
    await append(null, cursor(100), ['a', 'b']);
    await append(cursor(100), cursor(200), ['b', 'c']);
    expect(await ids()).toEqual(['a', 'b', 'c']);
    await db.close();
    await open();
    expect(await persistence.getCursor(ref)).toEqual(cursor(200));
    // Rotation goes backwards in bytes, while old source identities remain deduplicated.
    await append(cursor(200), cursor(50), ['a', 'd']);
    const sidecar = { ...ref, filePath: '/logs/subagent.jsonl' };
    await append(null, cursor(25), ['sidecar'], sidecar);
    expect(await persistence.getCursor(ref)).toEqual(cursor(50));
    expect(await persistence.getCursor(sidecar)).toEqual(cursor(25));
    expect(await ids()).toEqual(['a', 'b', 'c', 'd', 'sidecar']);
  });

  it('round-trips fallback call authority across restart and includes it in canonical cursor comparisons', async () => {
    const baseline = cursor(100);
    const baselineJson = JSON.stringify({ byteOffset: 100, lastEntryUuid: 'entry-100', fileSize: 100, inode: 1 });
    const storedJson = async () => (await db.query<{ cursor: string }>('SELECT cursor FROM external_session_cursors')).rows[0].cursor;
    await append(null, baseline, []);
    expect(await storedJson()).toBe(baselineJson);
    const fallback = { ...baseline, codexFallbackCalls: ['z', 'a', ' a ', 'a'] };
    await append({ ...baseline, codexFallbackCalls: [] }, fallback, []);
    await db.close();
    await open();
    expect(await persistence.getCursor(ref)).toEqual({ ...baseline, codexFallbackCalls: [' a ', 'a', 'z'] });
    // Byte positions alone cannot authorize a write after fallback authority changed.
    await expect(append(baseline, cursor(200), ['stale'])).rejects.toThrow(/conflict/i);
    expect(await ids()).toEqual([]);
    await append(fallback, { ...baseline, codexFallbackCalls: [] }, []);
    expect(await persistence.getCursor(ref)).toEqual(baseline);
    expect(await storedJson()).toBe(baselineJson);
  });

  it('accepts bounded fallback IDs and rejects malformed or oversized state before any write', async () => {
    const bounded = { ...cursor(100), codexFallbackCalls: ['x'.repeat(512), ...Array.from({ length: 511 }, (_, i) => `call-${i}`)] };
    await append(null, bounded, []);
    expect((await persistence.getCursor(ref))?.codexFallbackCalls).toEqual([...bounded.codexFallbackCalls].sort());
    const malformed = [null, 'call', {}, [1], [''], ['x'.repeat(513)], Array(513).fill('same')];
    for (const value of malformed) {
      const invalid = { ...cursor(200), codexFallbackCalls: value as string[] };
      await expect(append(bounded, invalid, ['invalid'])).rejects.toThrow(/fallback/i);
      await expect(append(invalid, cursor(200), ['invalid'])).rejects.toThrow(/fallback/i);
    }
    expect(await ids()).toEqual([]);
    expect((await persistence.getCursor(ref))?.codexFallbackCalls).toHaveLength(512);
    await db.query('UPDATE external_session_cursors SET cursor = $1', [JSON.stringify({ ...bounded, codexFallbackCalls: null })]);
    await expect(persistence.getCursor(ref)).rejects.toThrow(/fallback/i);
  });

  it('round-trips content markers across restart, fences marker-only changes, and clears to prior JSON shapes', async () => {
    const baseline = cursor(100);
    const baselineJson = JSON.stringify({ byteOffset: 100, lastEntryUuid: 'entry-100', fileSize: 100, inode: 1 });
    const fallback = { ...baseline, codexFallbackCalls: ['a', 'z'] };
    const fallbackJson = JSON.stringify({ ...JSON.parse(baselineJson), codexFallbackCalls: ['a', 'z'] });
    const storedJson = async () => (await db.query<{ cursor: string }>('SELECT cursor FROM external_session_cursors')).rows[0].cursor;
    await append(null, fallback, []);
    expect(await storedJson()).toBe(fallbackJson);
    // Input property order must not affect the persisted CAS representation.
    const marked = { contentMarker: 'a1'.repeat(32), ...fallback };
    await append(fallback, marked, ['a']);
    expect(await storedJson()).toBe(JSON.stringify({ ...JSON.parse(fallbackJson), contentMarker: marked.contentMarker }));
    await db.close();
    await open();
    expect(await persistence.getCursor(ref)).toEqual(marked);
    for (const stale of [fallback, { ...marked, contentMarker: 'b2'.repeat(32) }]) {
      await expect(append(stale, cursor(200), ['stale'])).rejects.toThrow(/conflict/i);
    }
    expect(await ids()).toEqual(['a']);
    await append(marked, fallback, ['a']);
    expect(await storedJson()).toBe(fallbackJson);
    const markerOnly = { ...baseline, contentMarker: marked.contentMarker };
    await append(fallback, markerOnly, []);
    expect(await storedJson()).toBe(JSON.stringify({ ...JSON.parse(baselineJson), contentMarker: marked.contentMarker }));
    await append(markerOnly, baseline, []);
    expect(await storedJson()).toBe(baselineJson);
    expect(await persistence.getCursor(ref)).toEqual(baseline);
  });

  it('rejects malformed content markers on next/expected cursor and persisted reads without appending messages', async () => {
    const baseline = cursor(100);
    await append(null, baseline, []);
    for (const value of [null, 1, {}, [], '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(64) + '\n']) {
      const invalid = { ...cursor(200), contentMarker: value as string };
      await expect(append(baseline, invalid, ['invalid'])).rejects.toThrow(/marker/i);
      await expect(append(invalid, cursor(200), ['invalid'])).rejects.toThrow(/marker/i);
    }
    expect(await ids()).toEqual([]);
    expect(await persistence.getCursor(ref)).toEqual(baseline);
    await db.query('UPDATE external_session_cursors SET cursor = $1', [JSON.stringify({ ...baseline, contentMarker: null })]);
    await expect(persistence.getCursor(ref)).rejects.toThrow(/marker/i);
  });

  it('rolls back a mid-batch failure and permits retry without losing the cursor or duplicating rows', async () => {
    await append(null, cursor(100), ['a']);
    await expect(persistence.appendAndAdvance({ ref, sessionId: 'local', expectedCursor: cursor(100), cursor: cursor(200), messages: [message('b'), { ...message('invalid'), direction: 'invalid' as 'output' }] })).rejects.toThrow();
    expect(await ids()).toEqual(['a']);
    expect(await persistence.getCursor(ref)).toEqual(cursor(100));
    await db.close();
    await open();
    await append(cursor(100), cursor(200), ['b']);
    expect(await ids()).toEqual(['a', 'b']);
  });

  it('fences stale concurrent batches, including a retry after a committed-but-lost response', async () => {
    await append(null, cursor(100), ['a']);
    await expect(append(null, cursor(100), ['a'])).rejects.toThrow(/conflict/i);
    const results = await Promise.allSettled([append(cursor(100), cursor(200), ['b']), append(cursor(100), cursor(300), ['c'])]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await ids()).toHaveLength(2);
  });

  it('resolves indexed provider identity, scopes provider/workspace, supports legacy IDs and rejects ambiguity', async () => {
    expect(await persistence.resolveSessionId(ref)).toBe('local');
    expect(await persistence.resolveSessionId({ ...ref, providerId: 'openai-codex' })).toBeNull();
    expect(await persistence.resolveSessionId({ ...ref, workspacePath: '/elsewhere' })).toBeNull();
    await db.query('INSERT INTO ai_sessions (id,provider,provider_session_id,workspace_id) VALUES ($1,$2,$3,$4)', ['codex', 'openai-codex', ref.externalId, ref.workspacePath]);
    await db.query('INSERT INTO ai_sessions (id,provider,provider_session_id,workspace_id) VALUES ($1,$2,$3,$4)', ['elsewhere', ref.providerId, ref.externalId, '/elsewhere']);
    expect(await persistence.resolveSessionId({ ...ref, providerId: 'openai-codex' })).toBe('codex');
    expect(await persistence.resolveSessionId({ ...ref, workspacePath: '/elsewhere' })).toBe('elsewhere');
    await db.query('INSERT INTO ai_sessions (id,provider,workspace_id) VALUES ($1,$2,$3)', ['legacy', ref.providerId, ref.workspacePath]);
    expect(await persistence.resolveSessionId({ ...ref, externalId: 'legacy' })).toBe('legacy');
    await db.query('INSERT INTO ai_sessions (id,provider,provider_session_id,workspace_id) VALUES ($1,$2,$3,$4)', ['duplicate', ref.providerId, ref.externalId, ref.workspacePath]);
    await expect(persistence.resolveSessionId(ref)).rejects.toThrow(/ambiguous/i);
    const store = createPGLiteSessionStore(db);
    await expect(store.findByProviderSessionId!(ref.providerId, ref.externalId, ref.workspacePath)).rejects.toThrow(/ambiguous/i);
  });

  it.each(['claude-code-cli', 'openai-codex-acp'])('recognizes CLI alias %s and binds worktree cwd to owning workspace', async (alias) => {
    const providerId = alias === 'claude-code-cli' ? 'claude-code' : 'openai-codex';
    await db.query('UPDATE ai_sessions SET provider = $2 WHERE id = $1', ['local', alias]);
    const worktreeRef = { ...ref, providerId, workspacePath: '/worktree', workspaceId: '/workspace' } as const;
    expect(await persistence.resolveSessionId(worktreeRef)).toBe('local');
    // A live provider variant may already have persisted this source identity.
    await db.query('INSERT INTO ai_agent_messages (session_id,source,direction,content,provider_message_id) VALUES ($1,$2,$3,$4,$5)', ['local', alias, 'output', message('a').content, 'a']);
    await persistence.appendAndAdvance({ ref: worktreeRef, sessionId: 'local', expectedCursor: null, cursor: cursor(100), messages: [{ ...message('a'), source: providerId }] });
    expect(await persistence.getCursor(worktreeRef)).toEqual(cursor(100));
    expect(await ids()).toEqual(['a']);
    await expect(persistence.getCursor({ ...worktreeRef, workspaceId: '/wrong' })).rejects.toThrow(/workspace/i);
    expect(await persistence.resolveSessionId({ ...worktreeRef, workspaceId: '/wrong' })).toBeNull();
    await expect(persistence.appendAndAdvance({ ref: { ...worktreeRef, workspaceId: '/wrong' }, sessionId: 'local', expectedCursor: cursor(100), cursor: cursor(200), messages: [{ ...message('b'), source: providerId }] })).rejects.toThrow();
    expect(await ids()).toEqual(['a']);
    await db.query('INSERT INTO ai_sessions (id,provider,provider_session_id,workspace_id) VALUES ($1,$2,$3,$4)', ['duplicate-alias', providerId, ref.externalId, ref.workspacePath]);
    await expect(persistence.resolveSessionId(worktreeRef)).rejects.toThrow(/ambiguous/i);
  });

  it('commits empty complete-line advances and removes cursors when their session is deleted', async () => {
    await append(null, cursor(100), []);
    expect(await ids()).toEqual([]);
    expect(await persistence.getCursor(ref)).toEqual(cursor(100));
    await db.query('DELETE FROM ai_sessions WHERE id = $1', ['local']);
    expect(await persistence.getCursor(ref)).toBeNull();
  });

  it('rejects cross-workspace/provider writes and cursor reads, and missing stable message identities', async () => {
    for (const target of [{ ...ref, workspacePath: '/elsewhere' }, { ...ref, providerId: 'openai-codex' as const }]) {
      await expect(append(null, cursor(100), ['a'], target as typeof ref)).rejects.toThrow();
    }
    await expect(persistence.appendAndAdvance({ ref, sessionId: 'local', expectedCursor: null, cursor: cursor(100), messages: [{ ...message('a'), providerMessageId: undefined }] })).rejects.toThrow(/identity/i);
    expect(await ids()).toEqual([]);
    await append(null, cursor(100), ['a']);
    await expect(persistence.getCursor({ ...ref, workspacePath: '/elsewhere' })).rejects.toThrow(/workspace/i);
  });
});
