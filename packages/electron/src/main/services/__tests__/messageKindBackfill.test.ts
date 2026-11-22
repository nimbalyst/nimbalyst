// @vitest-environment node
/**
 * Runs the message-kind backfill against a real in-memory better-sqlite3
 * database: what matters is which rows the window SQL admits and what label
 * each ends with, which a mocked handle cannot show.
 */
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';

const settings = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../utils/store', () => ({
  getAppSetting: (key: string) => settings.get(key),
  setAppSetting: (key: string, value: unknown) => { settings.set(key, value); },
  getDatabaseMaintenanceSettings: () => ({ toolOutputRetentionDays: 30 }),
  getToolOutputRetentionCursor: () => 0,
  setToolOutputRetentionCursor: () => {},
}));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));

import {
  runMessageKindBackfill,
  type MessageKindBackfillDb,
  type MessageKindBackfillState,
} from '../messageKindBackfill';
import { scheduleDatabaseRetention } from '../databaseRetentionMaintenance';

function makeDb(): SqliteDatabase {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      direction TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      hidden INTEGER DEFAULT 0,
      searchable_text TEXT,
      message_kind TEXT
    );
  `);
  return db;
}

/** The proxy's `$N` dialect over positional `?` (every statement binds in order), recording each statement. */
function adapter(db: SqliteDatabase, log: string[] = []): MessageKindBackfillDb {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      log.push(sql.trim().split(/\s+/)[0]);
      const stmt = db.prepare(sql.replace(/\$\d+/g, '?'));
      if (stmt.reader) return { rows: stmt.all(...params) as T[] };
      stmt.run(...params);
      return { rows: [] as T[] };
    },
  };
}

function memoryState(cursor = 0): MessageKindBackfillState & { cursors: number[]; complete: boolean } {
  const s = {
    cursors: [] as number[],
    complete: false,
    getCursor: () => s.cursors.at(-1) ?? cursor,
    setCursor: (id: number) => { s.cursors.push(id); },
    isComplete: () => s.complete,
    markComplete: () => { s.complete = true; },
  };
  return s;
}

function insert(db: SqliteDatabase, content: unknown, opts: { source?: string; kind?: string; direction?: string } = {}): number {
  const info = db
    .prepare('INSERT INTO ai_agent_messages (source, direction, content, message_kind) VALUES (?, ?, ?, ?)')
    .run(opts.source ?? 'openai-codex', opts.direction ?? 'output', JSON.stringify(content), opts.kind ?? 'meta');
  return Number(info.lastInsertRowid);
}

function kindOf(db: SqliteDatabase, id: number): { message_kind: string; searchable_text: string | null } {
  return db.prepare('SELECT message_kind, searchable_text FROM ai_agent_messages WHERE id = ?').get(id) as never;
}

const command = { method: 'item/completed', params: { item: { id: 'c1', type: 'commandExecution', aggregatedOutput: 'out' } } };
const turnDone = { method: 'turn/completed', params: {} };
const delta = { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'hi' } };
const failure = { method: 'error', params: { error: { message: 'stream disconnected' } } };

describe('message-kind backfill', () => {
  it('relabels codex meta rows by the classifier and leaves non-rendering frames as meta', async () => {
    const db = makeDb();
    const tool = insert(db, command);
    const system = insert(db, turnDone);
    const stillMeta = insert(db, delta);
    const errored = insert(db, failure);
    const prompt = insert(db, { prompt: 'hi' }, { direction: 'input', kind: 'meta' });

    const result = await runMessageKindBackfill(adapter(db), { state: memoryState(), sleep: async () => {} });

    expect(kindOf(db, tool).message_kind).toBe('tool');
    expect(kindOf(db, system).message_kind).toBe('system');
    expect(kindOf(db, stillMeta).message_kind).toBe('meta');
    expect(kindOf(db, errored)).toEqual({ message_kind: 'system', searchable_text: 'stream disconnected' });
    // Input rows are outside the pass.
    expect(kindOf(db, prompt).message_kind).toBe('meta');
    expect(result.relabeled).toEqual({ tool: 1, system: 2 });
  });

  it('walks bounded id windows, persisting the cursor after each', async () => {
    const db = makeDb();
    for (let i = 0; i < 7; i++) insert(db, command);
    const state = memoryState();
    const sleep = vi.fn(async () => {});

    await runMessageKindBackfill(adapter(db), { state, idWindow: 3, sleep });

    expect(state.cursors).toEqual([3, 6, 7]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(state.complete).toBe(true);
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM ai_agent_messages WHERE message_kind = 'meta'`).get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('resumes from the persisted cursor and skips once complete', async () => {
    const db = makeDb();
    const before = insert(db, command);
    const after = insert(db, command);
    const state = memoryState(before);

    await runMessageKindBackfill(adapter(db), { state, sleep: async () => {} });
    expect(kindOf(db, before).message_kind).toBe('meta');
    expect(kindOf(db, after).message_kind).toBe('tool');

    const log: string[] = [];
    const second = await runMessageKindBackfill(adapter(db, log), { state, sleep: async () => {} });
    expect(second.skipped).toBe(true);
    expect(log).toEqual([]);
  });

  it('is idempotent: a re-run from the start relabels nothing new', async () => {
    const db = makeDb();
    insert(db, command);
    insert(db, turnDone);
    insert(db, delta);
    await runMessageKindBackfill(adapter(db), { state: memoryState(), sleep: async () => {} });
    const snapshot = db.prepare('SELECT id, message_kind FROM ai_agent_messages ORDER BY id').all();

    const log: string[] = [];
    const rerun = await runMessageKindBackfill(adapter(db, log), { state: memoryState(), sleep: async () => {} });

    expect(rerun.relabeled).toEqual({});
    expect(log.filter((s) => s === 'UPDATE')).toEqual([]);
    expect(db.prepare('SELECT id, message_kind FROM ai_agent_messages ORDER BY id').all()).toEqual(snapshot);
  });

  it('runs from the daily retention task, ahead of the tool-output pass', async () => {
    const db = makeDb();
    const id = insert(db, command);
    const order: string[] = [];
    const sql = adapter(db);
    const runner = {
      query: async <T,>(text: string, params?: unknown[]) => {
        if (text.includes('UPDATE')) order.push('backfill');
        return sql.query<T>(text, params);
      },
      toolRetentionRun: async () => {
        order.push('retention');
        return { scanned: 0, rewritten: 0, bytesSaved: 0, durationMs: 0, cutoffIso: '', stoppedEarly: false, lastId: 0 };
      },
    };
    let task: (() => Promise<unknown> | unknown) | null = null;

    scheduleDatabaseRetention(
      { getToolRetentionRunner: () => runner, queuedPromptsStore: { cleanup: async () => 0 } },
      {
        runWhenFirstUsable: (label, fn) => { if (label === 'tool-output-retention') task = fn; },
        setInterval: () => ({}),
      },
    );
    await task!();

    expect(order).toEqual(['backfill', 'retention']);
    expect(kindOf(db, id).message_kind).toBe('tool');
  });
});
