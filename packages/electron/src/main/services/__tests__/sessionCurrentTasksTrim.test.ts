// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { planCurrentTasksTrim, trimSessionCurrentTasks, type TrimDatabase } from '../sessionCurrentTasksTrim';

let tmpDir: string;
let sqlite: SQLiteDatabase;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-trim-'));
  sqlite = new SQLiteDatabase({
    dbDir: tmpDir,
    schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
    slowQueryThresholdMs: 1000,
    sampleRate: 0,
  });
  await sqlite.initialize();
});

afterEach(async () => {
  await sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const readLines = (file: string) => zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

it('exports then trims bloated task lists once, keeping running and recent tasks and exporting agent reports', async () => {
  const bash = (i: number) => ({ taskId: `b${i}`, taskType: 'local_bash', status: 'completed', startedAt: 1000 + i, description: `cmd ${i}`,
    pendingTerminalNotification: { taskId: `b${i}`, outputFile: `/tmp/b${i}` } });
  const agent = (i: number) => ({ taskId: `a${i}`, taskType: 'local_agent', status: 'completed', startedAt: i, toolUseId: `toolu_${i}`, summary: `report ${i}` });
  const bloated = [agent(1), agent(2), { taskId: 'run', taskType: 'local_bash', status: 'running', startedAt: 0 }, ...Array.from({ length: 40 }, (_, i) => bash(i))];
  const small = [bash(1), bash(2)].map(({ pendingTerminalNotification: _held, ...task }) => task);
  const insert = (id: string, metadata: object) => sqlite.query(
    `INSERT INTO ai_sessions (id, provider, workspace_id, metadata) VALUES ($1, 'claude-code', '/p', $2)`, [id, JSON.stringify(metadata)]);
  await insert('bloated', { phase: 'validating', currentTasks: bloated });
  await insert('small', { currentTasks: small });

  const exportDir = path.join(tmpDir, 'exports');
  const onBeforeTrim = vi.fn();
  const statements: string[] = [];
  const db: TrimDatabase = { query: (sql, params) => { statements.push(sql); return sqlite.query(sql, params) as any; } };
  const first = await trimSessionCurrentTasks(db, { exportDir, now: new Date('2026-10-20T00:00:00Z'), onBeforeTrim });
  // The single-lane worker must never scan transcripts for this pass.
  expect(statements.some(sql => sql.includes('ai_agent_messages'))).toBe(false);

  expect(first).toMatchObject({ status: 'trimmed', sessions: 1, entries: 22, agentReports: 2, rowsWritten: 1 });
  expect(onBeforeTrim).toHaveBeenCalledTimes(1);
  if (first.status !== 'trimmed') throw new Error('unreachable');
  const exportedIds = readLines(first.exportPath).map(line => line.entry.taskId);
  expect(exportedIds).toEqual(expect.arrayContaining(['a1', 'a2', 'b0', 'b19']));
  expect(readLines(first.reportsPath).map(line => [line.taskId, line.toolUseId, line.summary])).toEqual([['a1', 'toolu_1', 'report 1'], ['a2', 'toolu_2', 'report 2']]);

  const read = async (id: string) => JSON.parse((await sqlite.query<{ metadata: string }>('SELECT metadata FROM ai_sessions WHERE id = $1', [id])).rows[0].metadata);
  const trimmed = await read('bloated');
  expect(trimmed.phase).toBe('validating');
  expect(trimmed.currentTasks.map((t: any) => t.taskId)).toEqual(['run', ...Array.from({ length: 20 }, (_, i) => `b${i + 20}`)]);
  expect(trimmed.currentTasks.some((t: any) => 'pendingTerminalNotification' in t)).toBe(false);
  expect((await read('small')).currentTasks).toEqual(small);

  // Second launch: the marker makes it a no-op even after the row grows again.
  await sqlite.query(`UPDATE ai_sessions SET metadata = $2 WHERE id = $1`, ['bloated', JSON.stringify({ currentTasks: bloated })]);
  expect(await trimSessionCurrentTasks(sqlite, { exportDir })).toEqual({ status: 'already-done' });
  expect((await read('bloated')).currentTasks).toHaveLength(bloated.length);
});

it('never plans a write for an unparseable or already-bounded list, and keeps malformed entries', () => {
  expect(planCurrentTasksTrim(undefined)).toBeNull();
  expect(planCurrentTasksTrim('[{"taskId":"x"}]')).toBeNull();
  expect(planCurrentTasksTrim([{ taskId: 't', status: 'completed', startedAt: 1 }])).toBeNull();
  const finished = Array.from({ length: 25 }, (_, i) => ({ taskId: `t${i}`, status: 'completed' }));
  const plan = planCurrentTasksTrim([{ note: 'no id' }, ...finished]);
  expect(plan?.kept[0]).toEqual({ note: 'no id' });
  expect(plan?.kept).toHaveLength(21);
  expect(plan?.removed).toHaveLength(5);
});
