/**
 * One-time trim of `ai_sessions.metadata.currentTasks` (NIM-7594 follow-up).
 *
 * Before the provider bounded it, the task list kept every Bash call a session
 * ever ran: 27,000 entries and 35MB of one install's 45MB metadata column, one
 * row at 993KB. The session list parsed that column for every session on each
 * refresh until main ran out of heap. New writes are bounded at the source; this
 * pass brings existing rows to the same bound.
 *
 * Destructive-path rules (.claude/rules/destructive-data-paths.md):
 * - Every removed entry is first written to a gzipped JSONL export in userData,
 *   and subagent reports also go to a separate reports file, because some of
 *   them exist nowhere else: tool-output retention replaced their transcript
 *   copies with a tombstone. The transcript is not read to find out which;
 *   scanning it held the single-lane database worker for every other query.
 * - The export is re-read from disk and checked line by line before any row is
 *   touched. If it does not verify, nothing is trimmed and the pass retries on
 *   the next launch.
 * - `onBeforeTrim` fires before the first write.
 * - Only entries that were exported are removed, so a task appended between
 *   the export and the trim survives.
 * - A row whose task list does not parse is skipped, never rewritten.
 *
 * Startup cost: each pass reads rows in small chunks and yields between them,
 * so other queries interleave and main never parses more than a few MB at once.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { persistedTasks, pruneFinishedTasks, type TrackedSystemTask } from '@nimbalyst/runtime/ai/server/providers/claudeCode/systemTaskChunks';
import { sessionMetadataMergeSql } from './sessionMetadataMerge';

export const CURRENT_TASKS_TRIM_MARKER = 'current-tasks-trim-v1';
const CHUNK_ROWS = 10;
const CHUNK_PAUSE_MS = 25;

export interface TrimDatabase {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

type TaskEntry = Record<string, unknown> & { taskId: string };

export interface CurrentTasksTrimPlan {
  kept: unknown[];
  removed: TaskEntry[];
}

/**
 * Decide what a row keeps. Returns null when the row needs no write: the list
 * is not an array, or it is already within the bound with nothing to strip.
 * Entries without a string `taskId` are kept untouched.
 */
export function planCurrentTasksTrim(value: unknown): CurrentTasksTrimPlan | null {
  if (!Array.isArray(value)) return null;
  const valid = value.filter((entry): entry is TaskEntry => !!entry && typeof entry === 'object' && typeof (entry as any).taskId === 'string');
  const map = new Map<string, TrackedSystemTask>();
  for (const entry of valid) map.set(entry.taskId, entry as unknown as TrackedSystemTask);
  pruneFinishedTasks(map);
  const retained = new Set<unknown>(map.values());
  const removed = valid.filter(entry => !retained.has(entry));
  const stripsHeld = [...map.values()].some(task => 'pendingTerminalNotification' in task);
  if (removed.length === 0 && !stripsHeld) return null;
  const invalid = value.filter(entry => !valid.includes(entry as TaskEntry));
  return { kept: [...invalid, ...persistedTasks(map.values())], removed };
}

/** SQLite returns the projected array as JSON text; PGLite returns it parsed. */
function parseTaskList(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return undefined; }
}

const entryKey = (sessionId: string, entry: TaskEntry) => `${sessionId}\u0000${entry.taskId}\u0000${String(entry.startedAt ?? '')}`;

async function* taskRows(db: TrimDatabase) {
  let after = '';
  for (;;) {
    const { rows } = await db.query<{ id: string; workspace_id: string; current_tasks: unknown }>(
      `SELECT id, workspace_id, metadata->'currentTasks' AS current_tasks FROM ai_sessions
       WHERE id > $1 AND metadata->'currentTasks' IS NOT NULL ORDER BY id LIMIT ${CHUNK_ROWS}`, [after]);
    if (rows.length === 0) return;
    for (const row of rows) yield row;
    after = rows[rows.length - 1].id;
    await new Promise(resolve => setTimeout(resolve, CHUNK_PAUSE_MS));
  }
}

class GzipLines {
  readonly gzip = zlib.createGzip();
  readonly done: Promise<void>;
  lines = 0;
  constructor(readonly file: string) {
    this.done = pipeline(this.gzip, fs.createWriteStream(file, { mode: 0o600 }));
  }
  async write(value: unknown): Promise<void> {
    this.lines++;
    if (!this.gzip.write(`${JSON.stringify(value)}\n`)) await new Promise(resolve => this.gzip.once('drain', resolve));
  }
  async close(): Promise<void> {
    this.gzip.end();
    await this.done;
  }
}

/** Re-read an export from disk: every line must parse, and the count must match. */
export async function verifyGzipLines(file: string, expectedLines: number): Promise<boolean> {
  let count = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      JSON.parse(line);
      count++;
    }
  } catch {
    return false;
  }
  return count === expectedLines;
}

export interface CurrentTasksTrimSummary {
  sessions: number;
  entries: number;
  agentReports: number;
  exportPath: string;
  reportsPath: string;
}

export type CurrentTasksTrimResult =
  | { status: 'already-done' }
  | { status: 'nothing-to-trim' }
  | { status: 'export-unverified'; exportPath: string }
  | ({ status: 'trimmed'; rowsWritten: number } & CurrentTasksTrimSummary);

export async function trimSessionCurrentTasks(db: TrimDatabase, options: {
  exportDir: string;
  now?: Date;
  onBeforeTrim?: (summary: CurrentTasksTrimSummary) => void;
  log?: (message: string) => void;
}): Promise<CurrentTasksTrimResult> {
  const log = options.log ?? (() => {});
  await db.query('CREATE TABLE IF NOT EXISTS session_maintenance_markers (id TEXT PRIMARY KEY)');
  if ((await db.query('SELECT id FROM session_maintenance_markers WHERE id = $1', [CURRENT_TASKS_TRIM_MARKER])).rows.length) return { status: 'already-done' };
  const markDone = () => db.query('INSERT INTO session_maintenance_markers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [CURRENT_TASKS_TRIM_MARKER]);

  fs.mkdirSync(options.exportDir, { recursive: true });
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const exportPath = path.join(options.exportDir, `session-task-history-${stamp}.jsonl.gz`);
  const reportsPath = path.join(options.exportDir, `session-agent-reports-${stamp}.jsonl.gz`);
  const exportFile = new GzipLines(exportPath);
  const reportsFile = new GzipLines(reportsPath);

  // Pass 1: export everything that will be removed.
  const exported = new Set<string>();
  const sessions = new Set<string>();
  const startedAt = Date.now();
  try {
    for await (const row of taskRows(db)) {
      const plan = planCurrentTasksTrim(parseTaskList(row.current_tasks));
      if (!plan) continue;
      sessions.add(row.id);
      const reports = plan.removed.filter(entry => entry.taskType === 'local_agent' && typeof entry.summary === 'string' && entry.summary);
      for (const entry of plan.removed) {
        exported.add(entryKey(row.id, entry));
        await exportFile.write({ sessionId: row.id, workspaceId: row.workspace_id, entry });
      }
      for (const entry of reports) {
        await reportsFile.write({
          sessionId: row.id, workspaceId: row.workspace_id, taskId: entry.taskId, toolUseId: entry.toolUseId ?? null,
          description: entry.description ?? null, startedAt: entry.startedAt ?? null, durationMs: entry.durationMs ?? null,
          tokenCount: entry.tokenCount ?? null, summary: entry.summary,
        });
      }
    }
  } finally {
    await exportFile.close();
    await reportsFile.close();
  }

  if (sessions.size === 0) {
    fs.rmSync(exportPath, { force: true });
    fs.rmSync(reportsPath, { force: true });
    await markDone();
    return { status: 'nothing-to-trim' };
  }
  if (!(await verifyGzipLines(exportPath, exportFile.lines)) || !(await verifyGzipLines(reportsPath, reportsFile.lines))) {
    log(`[CurrentTasksTrim] export did not verify; no rows trimmed, will retry next launch: ${exportPath}`);
    return { status: 'export-unverified', exportPath };
  }

  const summary: CurrentTasksTrimSummary = {
    sessions: sessions.size, entries: exportFile.lines, agentReports: reportsFile.lines, exportPath, reportsPath,
  };
  options.onBeforeTrim?.(summary);
  log(`[CurrentTasksTrim] export pass took ${Date.now() - startedAt}ms; trimming ${summary.entries} task entr(ies) from ${summary.sessions} session(s); export ${exportPath}, reports ${reportsPath}`);

  // Pass 2: remove only what was exported.
  let rowsWritten = 0;
  const trimStartedAt = Date.now();
  for await (const row of taskRows(db)) {
    if (!sessions.has(row.id)) continue;
    const list = parseTaskList(row.current_tasks);
    const plan = planCurrentTasksTrim(list);
    if (!plan) continue;
    // A task appended since the export can push an entry out that was never
    // exported; keep that entry rather than lose it.
    const notExported = new Set<unknown>(plan.removed.filter(entry => !exported.has(entryKey(row.id, entry))));
    const kept = notExported.size
      ? (list as unknown[]).filter(entry => !plan.removed.includes(entry as TaskEntry) || notExported.has(entry))
        .map(entry => entry && typeof entry === 'object' && typeof (entry as any).taskId === 'string' ? persistedTasks([entry as TrackedSystemTask])[0] : entry)
      : plan.kept;
    const patch = { currentTasks: kept };
    await db.query(`UPDATE ai_sessions SET metadata = ${sessionMetadataMergeSql("COALESCE(metadata, '{}'::jsonb)", 2, patch)} WHERE id = $1`, [row.id, JSON.stringify(patch)]);
    rowsWritten++;
  }
  await markDone();
  log(`[CurrentTasksTrim] done: ${rowsWritten} row(s) written; trim pass took ${Date.now() - trimStartedAt}ms`);
  return { status: 'trimmed', rowsWritten, ...summary };
}
