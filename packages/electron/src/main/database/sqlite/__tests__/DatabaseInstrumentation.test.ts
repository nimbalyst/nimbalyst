// @vitest-environment node
/**
 * Pure-logic tests for DatabaseInstrumentation. No native binding; mock the
 * SQLite handle so this runs even when better-sqlite3 isn't installed.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DatabaseInstrumentation,
  SLOW_QUERY_PRUNE_EVERY,
  QUERY_SHAPE_KEY_MAX_CHARS,
  SLOW_QUERY_ERROR_MAX_CHARS,
  extractCallSite,
  extractPrimaryTable,
  normalizeSql,
} from '../DatabaseInstrumentation';

describe('normalizeSql', () => {
  it('replaces numeric and string literals with ?', () => {
    expect(normalizeSql(`SELECT * FROM t WHERE id = 5 AND name = 'foo'`)).toBe(
      'select * from t where id = ? and name = ?',
    );
  });
  it('collapses whitespace and strips comments', () => {
    const sql = `SELECT *
      FROM t -- comment
      WHERE id = 5 /* block */ AND name = 'foo'`;
    expect(normalizeSql(sql)).toBe('select * from t where id = ? and name = ?');
  });
  it('replaces $N positional params', () => {
    expect(normalizeSql('SELECT * FROM t WHERE id = $1 AND name = $2')).toBe(
      'select * from t where id = ? and name = ?',
    );
  });
});

describe('extractPrimaryTable', () => {
  it('picks the table from a SELECT', () => {
    expect(extractPrimaryTable('SELECT * FROM ai_sessions WHERE id = ?')).toBe('ai_sessions');
  });
  it('picks the table from an UPDATE', () => {
    expect(extractPrimaryTable('UPDATE tracker_items SET data = ? WHERE id = ?')).toBe(
      'tracker_items',
    );
  });
  it('returns null for unknown shapes', () => {
    expect(extractPrimaryTable('VACUUM;')).toBeNull();
  });
});

describe('extractCallSite', () => {
  it('skips database-layer frames and returns the first app frame', () => {
    const stack = [
      'Error',
      '    at captureStack (/x/SQLiteDatabase.ts:12:1)',
      '    at SQLiteDatabase.runRead (/x/SQLiteDatabase.ts:300:1)',
      '    at DatabaseInstrumentation.beginInFlight (/x/DatabaseInstrumentation.ts:50:1)',
      '    at FooService.list (/x/services/FooService.ts:42:7)',
    ].join('\n');
    expect(extractCallSite(stack)).toContain('FooService.list');
  });
});

describe('DatabaseInstrumentation aggregation', () => {
  it('aggregates by query shape and reports p99', () => {
    const inst = new DatabaseInstrumentation({ sampleRate: 1 });
    for (let i = 0; i < 100; i++) {
      inst.recordQuery({
        sql: `SELECT * FROM ai_sessions WHERE id = ${i}`,
        kind: 'read',
        durationMs: i, // 0..99
      });
    }
    const snap = inst.getSnapshot();
    const sessions = snap.byShape.find((s) => s.shape.includes('ai_sessions'));
    expect(sessions).toBeDefined();
    expect(sessions!.count).toBe(100);
    // p99 ~ 99 (top of 0..99)
    expect(sessions!.p99).toBeGreaterThan(95);
    expect(snap.histogram.read.lt100ms).toBeGreaterThan(0);
  });

  it('always records slow queries even when sampleRate is 0', () => {
    const inst = new DatabaseInstrumentation({ sampleRate: 0, slowQueryThresholdMs: 50 });
    inst.recordQuery({
      sql: 'SELECT * FROM tracker_items',
      kind: 'read',
      durationMs: 100,
    });
    expect(inst.getSnapshot().byShape).toHaveLength(1);
  });

  it('drops non-slow queries when sampleRate is 0', () => {
    const inst = new DatabaseInstrumentation({ sampleRate: 0, slowQueryThresholdMs: 50 });
    inst.recordQuery({
      sql: 'SELECT * FROM tracker_items',
      kind: 'read',
      durationMs: 1,
    });
    expect(inst.getSnapshot().byShape).toHaveLength(0);
    // Histogram still gets the data point so totalQueries reflects reality.
    expect(inst.getSnapshot().totalQueries).toBe(1);
  });

  it('tracks in-flight queries until end()', () => {
    const inst = new DatabaseInstrumentation();
    const h1 = inst.beginInFlight('SELECT 1');
    const h2 = inst.beginInFlight('SELECT 2');
    expect(inst.getSnapshot().inFlight).toHaveLength(2);
    h1.end();
    expect(inst.getSnapshot().inFlight).toHaveLength(1);
    h2.end();
    expect(inst.getSnapshot().inFlight).toHaveLength(0);
  });

  it('records coordinator batch and chunk metrics', () => {
    const inst = new DatabaseInstrumentation();
    inst.recordCoordinatorBatch({ batchSize: 4, durationMs: 2, fsynced: true });
    inst.recordCoordinatorBatch({ batchSize: 6, durationMs: 3, fsynced: true });
    inst.recordCoordinatorChunk({ name: 'fts-rebuild', durationMs: 5, chunkIndex: 0 });
    inst.recordCoordinatorChunk({ name: 'fts-rebuild', durationMs: 5, chunkIndex: 1 });
    inst.recordSlowBgChunk({ name: 'fts-rebuild', durationMs: 80, chunkIndex: 2 });
    const c = inst.getSnapshot().coordinator;
    expect(c.batches).toBe(2);
    expect(c.fsyncs).toBe(2);
    expect(c.avgBatchSize).toBe(5);
    expect(c.bgOps).toBe(1);
    expect(c.slowBgChunks).toBe(1);
  });

  it('recordSlowBgChunk does not throw when the logger does (#1810)', () => {
    // WriteCoordinator calls this after a background chunk has committed.
    const inst = new DatabaseInstrumentation({ log: () => { throw new Error('logger down'); } });
    expect(() => inst.recordSlowBgChunk({ name: 'fts', durationMs: 80, chunkIndex: 0 })).not.toThrow();
  });

  it('reset() clears rolling state but leaves slow-query persistence alone', () => {
    const inst = new DatabaseInstrumentation();
    inst.recordQuery({ sql: 'SELECT 1', kind: 'read', durationMs: 1 });
    inst.reset();
    expect(inst.getSnapshot().byShape).toHaveLength(0);
    expect(inst.getSnapshot().totalQueries).toBe(0);
  });
});

describe('DatabaseInstrumentation slow-query persistence', () => {
  function bindFake(inst: DatabaseInstrumentation) {
    const insert = vi.fn();
    const prune = vi.fn();
    const db = {
      exec: vi.fn(),
      pragma: vi.fn(() => 0),
      prepare: vi.fn((sql: string) => ({ run: sql.includes('DELETE') ? prune : insert })),
    };
    inst.bind(db as never);
    return { insert, prune };
  }

  it('prunes deterministically to the 2,000-row default cap, not on a coin flip', () => {
    const inst = new DatabaseInstrumentation({ sampleRate: 0, slowQueryThresholdMs: 10 });
    const { insert, prune } = bindFake(inst);
    const inserts = SLOW_QUERY_PRUNE_EVERY * 3;
    for (let i = 0; i < inserts; i++) {
      inst.recordQuery({ sql: `SELECT * FROM t WHERE id = ${i}`, kind: 'read', durationMs: 20 });
    }
    expect(insert).toHaveBeenCalledTimes(inserts);
    // First insert of the session, then once every SLOW_QUERY_PRUNE_EVERY.
    expect(prune).toHaveBeenCalledTimes(3);
    expect(prune).toHaveBeenCalledWith(2000);
  });

  it('caps the stored shape text', () => {
    const inst = new DatabaseInstrumentation({ sampleRate: 0, slowQueryThresholdMs: 10 });
    const { insert } = bindFake(inst);
    const columns = Array.from({ length: 2000 }, (_, i) => `col_${i}`).join(', ');
    inst.recordQuery({ sql: `SELECT ${columns} FROM t`, kind: 'read', durationMs: 20 });
    const row = insert.mock.calls[0][0] as { shape: string };
    expect(row.shape.length).toBeLessThanOrEqual(QUERY_SHAPE_KEY_MAX_CHARS);
    expect(row.shape.startsWith('select col_0')).toBe(true);
  });

  it('caps the stored error message', () => {
    const inst = new DatabaseInstrumentation({ sampleRate: 0, slowQueryThresholdMs: 10 });
    const { insert } = bindFake(inst);
    inst.recordQuery({ sql: 'SELECT 1', kind: 'read', durationMs: 20, error: new Error('x'.repeat(100_000)) });
    const row = insert.mock.calls[0][0] as { errorMessage: string };
    expect(row.errorMessage.length).toBeLessThanOrEqual(SLOW_QUERY_ERROR_MAX_CHARS + 3);
  });

  it('never throws out of recordQuery when the insert and the logger both fail', () => {
    // A diagnostic failure must not turn a successful application query into
    // a rejected one (#1810): recordQuery runs on the query's success path.
    const inst = new DatabaseInstrumentation({
      sampleRate: 0,
      slowQueryThresholdMs: 10,
      log: () => { throw new Error('logger down'); },
    });
    const { insert } = bindFake(inst);
    insert.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => inst.recordQuery({ sql: 'SELECT 1', kind: 'read', durationMs: 20 })).not.toThrow();
  });
});

describe('DatabaseInstrumentation oversized statements (#1810)', () => {
  // 40,000 named placeholders, the shape of a generated membership IN-list.
  const hugeInList = (tail: string) =>
    `SELECT * FROM members WHERE id IN (${Array.from({ length: 40_000 }, (_, i) => `@p${i}`).join(', ')}) ${tail}`;

  it('bounds the in-memory shape key for both recordQuery and beginInFlight', () => {
    const inst = new DatabaseInstrumentation();
    inst.recordQuery({ sql: hugeInList(''), kind: 'read', durationMs: 1 });
    const handle = inst.beginInFlight(hugeInList(''));
    const snapshot = inst.getSnapshot();
    expect(snapshot.byShape[0].shape.length).toBeLessThanOrEqual(QUERY_SHAPE_KEY_MAX_CHARS);
    expect(snapshot.inFlight[0].shape.length).toBeLessThanOrEqual(QUERY_SHAPE_KEY_MAX_CHARS);
    handle.end();
  });

  it('keeps oversized statements that differ only in the tail as separate shapes', () => {
    const inst = new DatabaseInstrumentation();
    inst.recordQuery({ sql: hugeInList('ORDER BY id'), kind: 'read', durationMs: 1 });
    inst.recordQuery({ sql: hugeInList('ORDER BY name'), kind: 'read', durationMs: 1 });
    inst.recordQuery({ sql: hugeInList('ORDER BY name'), kind: 'read', durationMs: 1 });
    const counts = inst.getSnapshot().byShape.map((s) => s.count).sort();
    expect(counts).toEqual([1, 2]);
  });

  it('bounds the number of shape buckets when oversized statements vary only in literals', () => {
    // Oversized statements are keyed by a hash of the raw text, so each new
    // literal makes a new key; the aggregate map must still stay bounded.
    const inst = new DatabaseInstrumentation({ maxShapeBuckets: 10 });
    for (let i = 0; i < 50; i++) {
      inst.recordQuery({ sql: hugeInList(`AND org = ${i}`), kind: 'read', durationMs: 1 });
    }
    expect(inst.getSnapshot().byShape).toHaveLength(10);
  });

  it('evicts the least recently seen shape, keeping a hot one', () => {
    const inst = new DatabaseInstrumentation({ maxShapeBuckets: 3 });
    inst.recordQuery({ sql: 'SELECT * FROM hot', kind: 'read', durationMs: 1 });
    for (const table of ['a', 'b', 'c', 'd']) {
      inst.recordQuery({ sql: `SELECT * FROM ${table}`, kind: 'read', durationMs: 1 });
      inst.recordQuery({ sql: 'SELECT * FROM hot', kind: 'read', durationMs: 1 });
    }
    const shapes = inst.getSnapshot().byShape.map((s) => s.shape).sort();
    expect(shapes).toEqual(['select * from c', 'select * from d', 'select * from hot']);
    expect(inst.getSnapshot().byShape.find((s) => s.shape === 'select * from hot')?.count).toBe(5);
  });

  it('leaves ordinary shapes readable and unhashed', () => {
    const inst = new DatabaseInstrumentation();
    inst.recordQuery({ sql: 'SELECT * FROM t WHERE id = 5', kind: 'read', durationMs: 1 });
    expect(inst.getSnapshot().byShape[0].shape).toBe('select * from t where id = ?');
  });
});
