// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadBetterSqlite, nativeBindingOverride } from '../betterSqliteLoader';
import { DatabaseInstrumentation } from '../DatabaseInstrumentation';
import { SQLiteDatabase } from '../SQLiteDatabase';
import { sessionUncommittedFileQuery } from '../../../ipc/sessionUncommittedFileQuery';
import { translateAndBind } from '../dialectTranslator';

vi.mock('node:crypto', async importOriginal => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, createHash: vi.fn(original.createHash) };
});

const Sqlite = loadBetterSqlite();
const dbs: InstanceType<typeof Sqlite>[] = [];
function fixture() {
  const nativeBinding = nativeBindingOverride();
  const db = new Sqlite(':memory:', nativeBinding ? { nativeBinding } : {});
  dbs.push(db);
  const inst = new DatabaseInstrumentation({ slowQueryThresholdMs: 0 });
  inst.bind(db);
  return { db, inst };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) if (db.open) db.close();
});

describe('slow-query persistence bounds', () => {
  it('bounds an oversized failing query in the aggregate, in-flight registry, table and shape index', () => {
    const { db, inst } = fixture();
    const sql = `SELECT * FROM missing WHERE id IN (${'?,'.repeat(40_000)}?)`;
    const handle = inst.beginInFlight(sql);
    let error: Error | undefined;
    try { db.prepare(sql); } catch (caught) { error = caught as Error; }
    expect(error).toBeInstanceOf(Error);
    inst.recordQuery({ sql, error, kind: 'read', durationMs: 1 });
    const snap = inst.getSnapshot();
    const row = db.prepare('SELECT shape, sql_sample, error_message FROM _perf_slow_queries').get() as {
      shape: string; sql_sample: string; error_message: string;
    };
    expect(row.shape).toBe(snap.byShape[0].shape);
    expect(row.shape).toBe(snap.inFlight[0].shape);
    expect(Buffer.byteLength(row.shape, 'utf8')).toBeLessThanOrEqual(512);
    expect(row.shape).toMatch(/^oversized-sql:sha256:[0-9a-f]{64}$/);
    expect(row.sql_sample.length).toBeLessThanOrEqual(2003);
    expect(row.error_message).toBe(error!.message);
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM _perf_slow_queries WHERE shape = ?').all(row.shape);
    expect(JSON.stringify(plan)).toContain('idx_perf_slow_shape');
    expect(db.prepare('SELECT count(*) AS n FROM _perf_slow_queries INDEXED BY idx_perf_slow_shape WHERE shape = ?').get(row.shape)).toEqual({ n: 1 });
    handle.end();
    expect(inst.getSnapshot().inFlight).toEqual([]);
  });

  it('caps an error containing a large statement and retains ordinary diagnostic context', () => {
    const { db, inst } = fixture();
    inst.recordQuery({ sql: 'SELECT 1', kind: 'read', durationMs: 2, params: [1], error: new Error('x'.repeat(100_000)) });
    const row = db.prepare('SELECT shape, params_sample, error_message FROM _perf_slow_queries').get() as {
      shape: string; params_sample: string; error_message: string;
    };
    expect(row.shape).toBe('select ?');
    expect(row.params_sample).toBe('[1]');
    expect(row.error_message.length).toBeLessThanOrEqual(2003);
    expect(row.error_message.endsWith('...')).toBe(true);
  });

  it('keeps the existing parameter-sample bound for slow JSON membership with multibyte paths', () => {
    const { db, inst } = fixture();
    db.exec('CREATE TABLE session_files (session_id TEXT, workspace_id TEXT, file_path TEXT, link_type TEXT, timestamp INTEGER)');
    const paths = new Set(Array.from({ length: 41_288 }, (_, i) => `\u05e2\u05d1\u05e8\u05d9\u05ea/\u{1f600}-${i}.md`));
    const query = sessionUncommittedFileQuery('D:/fixture', paths, 'sqlite');
    const adapted = translateAndBind(query.sql, query.params);
    expect(Object.keys(adapted.binds)).toHaveLength(2);
    expect(db.prepare(adapted.sql).all(adapted.binds)).toEqual([]);
    inst.recordQuery({ sql: adapted.sql, params: Object.values(adapted.binds), kind: 'read', durationMs: 1 });
    const row = db.prepare('SELECT shape, params_sample FROM _perf_slow_queries').get() as { shape: string; params_sample: string };
    expect(row.params_sample.length).toBe(1024);
    expect(Buffer.byteLength(row.params_sample, 'utf8')).toBeGreaterThan(1024);
    expect(row.params_sample.length).toBeLessThan(JSON.stringify(query.params).length);
    expect(Buffer.byteLength(row.shape, 'utf8')).toBeLessThanOrEqual(512);
  });

  it('adds bounded keys alongside legacy large keys and keeps the existing pruning policy', () => {
    const { db } = fixture();
    const inst = new DatabaseInstrumentation({ slowQueryThresholdMs: 0, slowQueryMaxRows: 2 });
    inst.bind(db);
    const legacy = 'legacy-' + 'x'.repeat(1_000_000);
    const insert = db.prepare("INSERT INTO _perf_slow_queries (shape, sql_sample, duration_ms, kind) VALUES (?, 'old', 1, 'read')");
    insert.run(legacy + '-a');
    insert.run(legacy + '-b');
    vi.spyOn(Math, 'random').mockReturnValue(0);
    inst.recordQuery({ sql: 'SELECT 1', kind: 'read', durationMs: 1 });
    const rows = db.prepare('SELECT id, shape FROM _perf_slow_queries ORDER BY id').all() as { id: number; shape: string }[];
    expect(rows.map(row => row.id)).toEqual([2, 3]);
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(digest(rows[0].shape)).toBe(digest(legacy + '-b'));
    expect(rows[1].shape).toBe('select ?');
    expect(db.prepare('SELECT id FROM _perf_slow_queries INDEXED BY idx_perf_slow_shape WHERE shape = ?').get('select ?')).toEqual({ id: 3 });
  });

  it.each(['insert', 'prune'] as const)('contains %s failures and restores query_only', failure => {
    const { db } = fixture();
    const log = vi.fn(() => { throw new Error('logger unavailable'); });
    const guarded = new DatabaseInstrumentation({ slowQueryThresholdMs: 0, slowQueryMaxRows: failure === 'prune' ? 0 : 10_000, log });
    guarded.bind(db);
    if (failure === 'insert') {
      db.exec(`CREATE TRIGGER reject_slow BEFORE INSERT ON _perf_slow_queries BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END`);
    } else {
      db.exec(`INSERT INTO _perf_slow_queries (shape, sql_sample, duration_ms, kind) VALUES ('old', 'old', 1, 'read')`);
      db.exec(`CREATE TRIGGER reject_prune BEFORE DELETE ON _perf_slow_queries BEGIN SELECT RAISE(ABORT, 'fixture prune failure'); END`);
      vi.spyOn(Math, 'random').mockReturnValue(0);
    }
    db.pragma('query_only = ON');
    expect(() => guarded.recordQuery({ sql: 'SELECT 1', kind: 'read', durationMs: 1 })).not.toThrow();
    expect(db.pragma('query_only', { simple: true })).toBe(1);
    expect(log).toHaveBeenCalledOnce();
    expect(() => db.exec('CREATE TABLE prohibited (id INTEGER)')).toThrow(/readonly/i);
  });

  it('contains persistence failure after the database closes, including a failing logger', () => {
    const { db } = fixture();
    const inst = new DatabaseInstrumentation({ slowQueryThresholdMs: 0, log: () => { throw new Error('logger unavailable'); } });
    inst.bind(db);
    db.close();
    expect(() => inst.recordQuery({ sql: 'SELECT 1', kind: 'read', durationMs: 1 })).not.toThrow();
  });

  it('preserves the real application result and SQL error when persistence and its logger fail', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nim-instrumentation-'));
    const sqlite = new SQLiteDatabase({
      dbDir: dir,
      schemaDir: path.resolve(__dirname, '../schemas'),
      slowQueryThresholdMs: 0,
      log: level => { if (level === 'warn') throw new Error('logger unavailable'); },
    });
    try {
      await sqlite.initialize();
      sqlite.getRawHandle()!.exec(`CREATE TRIGGER reject_slow BEFORE INSERT ON _perf_slow_queries BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END`);
      await expect(sqlite.query('SELECT 1 AS value')).resolves.toEqual({ rows: [{ value: 1 }] });
      await expect(sqlite.query('SELECT * FROM truly_missing')).rejects.toThrow(/no such table: truly_missing/);
      expect(sqlite.getInstrumentation().getSnapshot().inFlight).toEqual([]);
    } finally {
      await sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves real query outcomes when oversized-shape hashing fails before and after execution', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nim-hash-failure-'));
    const sqlite = new SQLiteDatabase({ dbDir: dir, schemaDir: path.resolve(__dirname, '../schemas'), slowQueryThresholdMs: 0 });
    const failHash = () => { throw new Error('hash unavailable'); };
    const comment = ` /* ${'x'.repeat(20_000)} */`;
    try {
      await sqlite.initialize();
      vi.mocked(createHash).mockImplementationOnce(failHash).mockImplementationOnce(failHash);
      await expect(sqlite.query('SELECT 1 AS value' + comment)).resolves.toEqual({ rows: [{ value: 1 }] });
      vi.mocked(createHash).mockImplementationOnce(failHash).mockImplementationOnce(failHash);
      await expect(sqlite.query('SELECT * FROM truly_missing' + comment)).rejects.toThrow(/no such table: truly_missing/);
      expect(sqlite.getInstrumentation().getSnapshot().inFlight).toEqual([]);
      expect(sqlite.getInstrumentation().getSnapshot().byShape).toEqual([]);
    } finally {
      await sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
