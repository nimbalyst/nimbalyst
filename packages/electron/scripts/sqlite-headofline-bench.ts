/**
 * Head-of-line blocking bench against the real Nimbalyst SQLite schema.
 *
 * Reproduces the workload from ademczuk/nimbalyst-1#1: a slow FTS5 rewrite
 * on ai_agent_messages running alongside concurrent hot writers
 * (small UPDATEs/INSERTs into ai_sessions + ai_transcript_events) and
 * concurrent readers (session list + transcript lookups).
 *
 * The goal is qualitative: confirm reads stay sub-ms p99 while a long
 * write is in flight when the WriteCoordinator's background lane chunks
 * the slow op, and that bare bs3+WAL (no coordinator) preserves reads
 * but blocks every concurrent hot writer until the slow op completes.
 *
 * Run:
 *   cd packages/electron && npx tsx scripts/sqlite-headofline-bench.ts
 *
 * Numbers vary by hardware; what matters is the relative shape, not the
 * absolute throughput.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SQLiteDatabase } from '../src/main/database/sqlite/SQLiteDatabase';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'src/main/database/sqlite/schemas');

const SLOW_FTS_REBUILD_ROWS = 25_000;
const HOT_WORKERS = 4;
const READER_WORKERS = 4;
const RUN_WINDOW_MS = 4_000;

interface Sample {
  durationMs: number;
}

function p(samples: Sample[], pct: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].map((s) => s.durationMs).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length));
  return sorted[idx];
}

function fmt(n: number): string {
  return n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n).toString();
}

async function seed(db: SQLiteDatabase): Promise<void> {
  await db.exec(
    `INSERT INTO ai_sessions(id, workspace_id, provider, title) VALUES ('bench-session', 'ws-bench', 'claude', 'bench')`,
  );
  const seedStart = Date.now();
  const insert = db.getRawHandle()!.prepare(
    `INSERT INTO ai_agent_messages(session_id, source, direction, content, searchable)
     VALUES ('bench-session', 'user', 'input', ?, 1)`,
  );
  const seedTx = db.getRawHandle()!.transaction((rows: number) => {
    for (let i = 0; i < rows; i++) {
      insert.run(`bench message ${i} sqlite migration plan rotation tokens auth provider claude openai cadence`);
    }
  });
  seedTx(SLOW_FTS_REBUILD_ROWS);
  console.log(`[seed] inserted ${SLOW_FTS_REBUILD_ROWS} messages in ${Date.now() - seedStart}ms`);
}

async function hotWrites(
  db: SQLiteDatabase,
  durationMs: number,
  useCoordinator: boolean,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  const end = Date.now() + durationMs;
  let i = 0;
  while (Date.now() < end) {
    const start = performance.now();
    const sql = `UPDATE ai_sessions SET updated_at = $now, title = $t WHERE id = 'bench-session'`;
    const args = [{ now: new Date().toISOString(), t: `hot-${i++}` }];
    if (useCoordinator) {
      const coord = db.getCoordinator()!;
      const raw = db.getRawHandle()!;
      await coord.write(() =>
        raw.prepare(`UPDATE ai_sessions SET updated_at = ?, title = ? WHERE id = 'bench-session'`).run(
          new Date().toISOString(),
          `hot-${i}`,
        ),
      );
    } else {
      await db.query(sql, args);
    }
    samples.push({ durationMs: performance.now() - start });
    await new Promise((r) => setImmediate(r));
  }
  return samples;
}

async function reads(db: SQLiteDatabase, durationMs: number): Promise<Sample[]> {
  const samples: Sample[] = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    const start = performance.now();
    await db.queryReadOnly(
      `SELECT id, title, updated_at FROM ai_sessions WHERE id = $id`,
      [{ id: 'bench-session' }],
    );
    samples.push({ durationMs: performance.now() - start });
    await new Promise((r) => setImmediate(r));
  }
  return samples;
}

async function slowFtsRebuild(db: SQLiteDatabase, useCoordinator: boolean): Promise<number> {
  const raw = db.getRawHandle()!;
  const start = performance.now();
  if (useCoordinator) {
    const coord = db.getCoordinator()!;
    // Chunked bg-lane FTS rewrite: process 500 rows per chunk and yield.
    const ROWS_PER_CHUNK = 500;
    let cursor = 0;
    await coord.runBackground({
      name: 'fts-rebuild',
      chunksPerTick: 1,
      chunk: () => {
        const rows = raw
          .prepare(
            `SELECT id, content FROM ai_agent_messages WHERE id > ? ORDER BY id LIMIT ?`,
          )
          .all(cursor, ROWS_PER_CHUNK) as Array<{ id: number; content: string }>;
        if (rows.length === 0) return { done: true };
        const update = raw.prepare(
          `INSERT INTO ai_agent_messages_fts(ai_agent_messages_fts, rowid, content)
           VALUES('delete', ?, '')`,
        );
        const insert = raw.prepare(
          `INSERT INTO ai_agent_messages_fts(rowid, content) VALUES (?, ?)`,
        );
        raw.transaction(() => {
          for (const row of rows) {
            update.run(row.id);
            insert.run(row.id, row.content);
          }
        })();
        cursor = rows[rows.length - 1].id;
        return { done: rows.length < ROWS_PER_CHUNK };
      },
    });
  } else {
    // Single un-chunked rebuild: blocks the writer the entire time.
    raw.exec(`INSERT INTO ai_agent_messages_fts(ai_agent_messages_fts) VALUES('rebuild')`);
  }
  return performance.now() - start;
}

interface Scenario {
  label: string;
  useCoordinator: boolean;
}

async function runScenario(scenario: Scenario): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-bench-'));
  const db = new SQLiteDatabase({
    dbDir: tmp,
    schemaDir: SCHEMA_DIR,
    slowQueryThresholdMs: 1_000_000,
    sampleRate: 0,
  });
  await db.initialize();
  try {
    await seed(db);

    // Start slow rebuild + concurrent hot writes + concurrent reads in parallel.
    const overallStart = performance.now();
    const slowPromise = slowFtsRebuild(db, scenario.useCoordinator);
    const hotPromises = Array.from({ length: HOT_WORKERS }, () =>
      hotWrites(db, RUN_WINDOW_MS, scenario.useCoordinator),
    );
    const readPromises = Array.from({ length: READER_WORKERS }, () => reads(db, RUN_WINDOW_MS));

    const [slowDur, hotResults, readResults] = await Promise.all([
      slowPromise,
      Promise.all(hotPromises),
      Promise.all(readPromises),
    ]);
    const wallMs = performance.now() - overallStart;

    const allHot = hotResults.flat();
    const allReads = readResults.flat();
    console.log(`\n=== ${scenario.label} ===`);
    console.log(`  slow FTS rebuild duration:        ${fmt(slowDur)} ms`);
    console.log(`  total wall window:                ${fmt(wallMs)} ms`);
    console.log(`  hot writes completed:             ${allHot.length}`);
    console.log(`    p50 / p95 / p99 / max (ms):     ${fmt(p(allHot, 50))} / ${fmt(p(allHot, 95))} / ${fmt(p(allHot, 99))} / ${fmt(p(allHot, 100))}`);
    console.log(`  read queries completed:           ${allReads.length}`);
    console.log(`    p50 / p95 / p99 / max (ms):     ${fmt(p(allReads, 50))} / ${fmt(p(allReads, 95))} / ${fmt(p(allReads, 99))} / ${fmt(p(allReads, 100))}`);
  } finally {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log('Head-of-line blocking bench (real schema, FTS rebuild + hot writes + reads)');
  console.log(`  hot workers: ${HOT_WORKERS}, reader workers: ${READER_WORKERS}, window: ${RUN_WINDOW_MS}ms\n`);

  await runScenario({ label: 'bs3+WAL direct (no coordinator)', useCoordinator: false });
  await runScenario({ label: 'bs3+WAL + WriteCoordinator (chunked bg lane)', useCoordinator: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
