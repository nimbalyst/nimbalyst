// @vitest-environment node
/**
 * Pure-logic tests for DatabaseInstrumentation. No native binding; mock the
 * SQLite handle so this runs even when better-sqlite3 isn't installed.
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DatabaseInstrumentation,
  extractCallSite,
  extractPrimaryTable,
  normalizeSql,
} from '../DatabaseInstrumentation';

vi.mock('node:crypto', async importOriginal => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, createHash: vi.fn(original.createHash) };
});

afterEach(() => vi.restoreAllMocks());

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

  it('reset() clears rolling state but leaves slow-query persistence alone', () => {
    const inst = new DatabaseInstrumentation();
    inst.recordQuery({ sql: 'SELECT 1', kind: 'read', durationMs: 1 });
    inst.reset();
    expect(inst.getSnapshot().byShape).toHaveLength(0);
    expect(inst.getSnapshot().totalQueries).toBe(0);
  });
});

describe('bounded diagnostic shapes', () => {
  function record(sql: string, inst = new DatabaseInstrumentation()) {
    const handle = inst.beginInFlight(sql);
    inst.recordQuery({ sql, kind: 'read', durationMs: 1 });
    const snapshot = inst.getSnapshot();
    expect(snapshot.inFlight[0].shape).toBe(snapshot.byShape[0].shape);
    expect(Buffer.byteLength(snapshot.byShape[0].shape, 'utf8')).toBeLessThanOrEqual(512);
    handle.end();
    return snapshot.byShape[0].shape;
  }

  it('keeps a readable 512-byte shape and digests a 513-byte UTF-8 shape', () => {
    const atLimit = 'select ' + 'é'.repeat(252) + 'x';
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(512);
    expect(record(atLimit)).toBe(atLimit);
    expect(record(atLimit + 'x')).toMatch(/^normalized-sql:sha256:[0-9a-f]{64}$/);
  });

  it('groups long normalized equivalents while retaining differences after their shared prefix', () => {
    const prefix = `SELECT ${'column_name, '.repeat(100)}`;
    const inst = new DatabaseInstrumentation();
    const first = record(prefix + 'tail_a FROM records WHERE id = 1', inst);
    record(prefix + 'tail_a FROM records WHERE id = 2', inst);
    const second = record(prefix + 'tail_b FROM records WHERE id = 2');
    expect(first).not.toBe(second);
    expect(inst.getSnapshot().byShape).toHaveLength(1);
    expect(inst.getSnapshot().byShape[0].count).toBe(2);
  });

  it('skips regex normalization and table extraction for oversized raw SQL', () => {
    const sql = `SELECT ${'column_name, '.repeat(110_000)}tail FROM reporting`;
    const replace = String.prototype.replace;
    vi.spyOn(String.prototype, 'replace').mockImplementation(function (
      this: string, ...args: Parameters<typeof String.prototype.replace>
    ) {
      if (this.length > 16_384) throw new Error('unbounded diagnostic regex');
      return Reflect.apply(replace, this, args);
    });
    expect(record(sql)).toMatch(/^oversized-sql:sha256:[0-9a-f]{64}$/);
  });

  it('hashes complete oversized input and deliberately keeps raw literal identity', () => {
    const prefix = `SELECT * FROM reporting WHERE id IN (${'?,'.repeat(20_000)}`;
    const a = record(prefix + '1)');
    expect(record(prefix + '1)')).toBe(a);
    expect(record(prefix + '2)')).not.toBe(a);
    expect(a).toMatch(/^oversized-sql:sha256:[0-9a-f]{64}$/);
  });

  it('uses the raw work budget before a huge comment can normalize to a small shape', () => {
    expect(record(`SELECT 1 /* ${'x'.repeat(16_384)} */`)).toMatch(/^oversized-sql:sha256:/);
  });

  it('normalizes at the raw work limit and hashes immediately beyond it', () => {
    const prefix = 'SELECT 1 /*';
    const sql = prefix + 'x'.repeat(16_384 - prefix.length - 2) + '*/';
    expect(sql.length).toBe(16_384);
    expect(record(sql)).toBe('select ?');
    expect(record(sql + ' ')).toMatch(/^oversized-sql:sha256:/);
  });

  it('does not throw hash failures through either query callback', () => {
    const inst = new DatabaseInstrumentation();
    const sql = `SELECT ${'column_name, '.repeat(2000)}tail`;
    vi.mocked(createHash).mockImplementationOnce(() => { throw new Error('hash unavailable'); });
    expect(() => inst.beginInFlight(sql).end()).not.toThrow();
    vi.mocked(createHash).mockImplementationOnce(() => { throw new Error('hash unavailable'); });
    expect(() => inst.recordQuery({ sql, kind: 'read', durationMs: 1 })).not.toThrow();
    expect(inst.getSnapshot()).toMatchObject({ totalQueries: 1, inFlight: [], byShape: [] });
    expect(inst.getSnapshot().histogram.read.lt10ms).toBe(1);
  });

  it('does not throw normalizer failures through either query callback', () => {
    const sql = 'SELECT diagnostic_failure';
    const replace = String.prototype.replace;
    vi.spyOn(String.prototype, 'replace').mockImplementation(function (
      this: string, ...args: Parameters<typeof String.prototype.replace>
    ) {
      if (String(this) === sql) throw new Error('normalizer unavailable');
      return Reflect.apply(replace, this, args);
    });
    const inst = new DatabaseInstrumentation();
    expect(() => inst.beginInFlight(sql).end()).not.toThrow();
    expect(() => inst.recordQuery({ sql, kind: 'read', durationMs: 1 })).not.toThrow();
    expect(inst.getSnapshot().byShape).toEqual([]);
  });
});
