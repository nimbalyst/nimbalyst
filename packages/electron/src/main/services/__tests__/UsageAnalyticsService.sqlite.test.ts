/**
 * UsageAnalyticsService integration tests against a real SQLite backend.
 *
 * The service was originally written against PGLite and uses PG-only syntax
 * like `(s.metadata->'tokenUsage'->>'inputTokens')::bigint` and
 * `m.content::jsonb->'usage'->>'input_tokens'`. The SQLite dialect translator
 * strips PG type casts (`::bigint`, `::jsonb`), and SQLite >= 3.38 supports
 * the `->` / `->>` JSON operators natively, so the queries should round-trip.
 * These tests assert that by exercising every method against a real
 * SQLiteDatabase seeded with the production schema.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import type { AppDatabase } from '../../database/PGLiteDatabaseWorker';
import { UsageAnalyticsService } from '../UsageAnalyticsService';

const SCHEMA_DIR = path.resolve(__dirname, '../../database/sqlite/schemas');

async function makeDb(): Promise<{ db: AppDatabase; raw: SQLiteDatabase; dbDir: string }> {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-analytics-sqlite-'));
  const raw = new SQLiteDatabase({
    dbDir,
    schemaDir: SCHEMA_DIR,
    log: () => {
      /* quiet */
    },
  });
  await raw.initialize();
  // UsageAnalyticsService probes for `getEngine()` to decide whether to take
  // the portable JS path for getTimeSeriesData. Wrap the raw SQLiteDatabase
  // with a getEngine shim so both code paths are exercised correctly.
  const db = new Proxy(raw as unknown as AppDatabase, {
    get(target, prop, receiver) {
      if (prop === 'getEngine') return () => 'sqlite';
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, raw, dbDir };
}

async function insertSession(
  db: AppDatabase,
  opts: {
    id: string;
    workspaceId?: string;
    provider?: string;
    model?: string | null;
    metadata?: Record<string, unknown>;
    createdAtMs?: number;
    providerSessionId?: string | null;
  },
): Promise<void> {
  const createdAtIso = opts.createdAtMs
    ? new Date(opts.createdAtMs).toISOString()
    : new Date().toISOString();
  await db.query(
    `INSERT INTO ai_sessions
       (id, workspace_id, title, provider, model, metadata,
        provider_session_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [
      opts.id,
      opts.workspaceId ?? 'ws1',
      `Session ${opts.id}`,
      opts.provider ?? 'claude',
      opts.model ?? 'claude-sonnet-4',
      JSON.stringify(opts.metadata ?? {}),
      opts.providerSessionId ?? null,
      createdAtIso,
    ],
  );
}

async function insertMessage(
  db: AppDatabase,
  opts: {
    sessionId: string;
    direction: 'input' | 'output';
    content: unknown;
    metadata?: Record<string, unknown>;
    createdAtMs: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO ai_agent_messages
       (session_id, source, direction, content, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      opts.sessionId,
      'codex',
      opts.direction,
      typeof opts.content === 'string' ? opts.content : JSON.stringify(opts.content),
      JSON.stringify(opts.metadata ?? {}),
      new Date(opts.createdAtMs).toISOString(),
    ],
  );
}

describe('UsageAnalyticsService on SQLite', () => {
  let db: AppDatabase;
  let raw: SQLiteDatabase;
  let dbDir: string;
  let svc: UsageAnalyticsService;

  beforeEach(async () => {
    ({ db, raw, dbDir } = await makeDb());
    svc = new UsageAnalyticsService(db);
  });

  afterEach(async () => {
    await raw.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  describe('SESSION_TOKEN_USAGE_CTE methods', () => {
    it('getOverallTokenUsage sums inputTokens/outputTokens out of metadata JSON', async () => {
      await insertSession(db, {
        id: 's1',
        metadata: {
          tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        },
      });
      await insertSession(db, {
        id: 's2',
        metadata: {
          tokenUsage: { inputTokens: 200, outputTokens: 75 }, // no totalTokens
        },
      });
      // A session with no tokenUsage at all — must be excluded by the CTE
      // WHERE clause `s.metadata->'tokenUsage' IS NOT NULL`.
      await insertSession(db, {
        id: 's3',
        metadata: { other: 'data' },
      });

      const stats = await svc.getOverallTokenUsage();
      expect(stats.totalInputTokens).toBe(300);
      expect(stats.totalOutputTokens).toBe(125);
      // s1 has totalTokens=150; s2 falls back to input+output=275; total=425.
      expect(stats.totalTokens).toBe(425);
      expect(stats.sessionCount).toBe(2);
    });

    it('getOverallTokenUsage filters by workspaceId', async () => {
      await insertSession(db, {
        id: 's-a',
        workspaceId: 'ws-a',
        metadata: { tokenUsage: { inputTokens: 10, outputTokens: 5 } },
      });
      await insertSession(db, {
        id: 's-b',
        workspaceId: 'ws-b',
        metadata: { tokenUsage: { inputTokens: 100, outputTokens: 50 } },
      });

      const stats = await svc.getOverallTokenUsage('ws-a');
      expect(stats.totalInputTokens).toBe(10);
      expect(stats.totalOutputTokens).toBe(5);
      expect(stats.sessionCount).toBe(1);
    });

    it('getUsageByProvider groups by provider+model', async () => {
      await insertSession(db, {
        id: 's1',
        provider: 'claude',
        model: 'claude-sonnet-4',
        metadata: { tokenUsage: { inputTokens: 100, outputTokens: 50 } },
      });
      await insertSession(db, {
        id: 's2',
        provider: 'claude',
        model: 'claude-sonnet-4',
        metadata: { tokenUsage: { inputTokens: 200, outputTokens: 100 } },
      });
      await insertSession(db, {
        id: 's3',
        provider: 'openai',
        model: 'gpt-4',
        metadata: { tokenUsage: { inputTokens: 50, outputTokens: 25 } },
      });

      const rows = await svc.getUsageByProvider();
      expect(rows).toHaveLength(2);
      const claude = rows.find((r) => r.provider === 'claude');
      expect(claude).toBeDefined();
      expect(claude!.sessionCount).toBe(2);
      expect(claude!.totalInputTokens).toBe(300);
      expect(claude!.totalOutputTokens).toBe(150);
      const openai = rows.find((r) => r.provider === 'openai');
      expect(openai!.totalInputTokens).toBe(50);
    });

    it('getUsageByProject groups by workspace_id', async () => {
      await insertSession(db, {
        id: 's1',
        workspaceId: 'ws-a',
        metadata: { tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
        createdAtMs: 1_700_000_000_000,
      });
      await insertSession(db, {
        id: 's2',
        workspaceId: 'ws-b',
        metadata: { tokenUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } },
        createdAtMs: 1_700_001_000_000,
      });

      const rows = await svc.getUsageByProject();
      expect(rows).toHaveLength(2);
      const a = rows.find((r) => r.workspaceId === 'ws-a');
      expect(a!.totalTokens).toBe(150);
      expect(a!.sessionCount).toBe(1);
      expect(a!.lastActivity).toBe(1_700_000_000_000);
    });
  });

  describe('getAllSessionCount', () => {
    it('counts all sessions including ones without tokenUsage', async () => {
      await insertSession(db, { id: 's1', metadata: { tokenUsage: { inputTokens: 1, outputTokens: 1 } } });
      await insertSession(db, { id: 's2', metadata: {} });
      expect(await svc.getAllSessionCount()).toBe(2);
    });
  });

  describe('getTimeSeriesData (portable JS path on SQLite)', () => {
    it('buckets non-codex sessions by day', async () => {
      const day1 = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01T12:00:00Z
      const day2 = Date.UTC(2026, 5, 2, 8, 0, 0);
      await insertSession(db, {
        id: 's1',
        provider: 'claude',
        createdAtMs: day1,
        metadata: { tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
      });
      await insertSession(db, {
        id: 's2',
        provider: 'claude',
        createdAtMs: day1 + 60_000,
        metadata: { tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      });
      await insertSession(db, {
        id: 's3',
        provider: 'openai',
        createdAtMs: day2,
        metadata: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      });

      const series = await svc.getTimeSeriesData(day1 - 1, day2 + 1, 'day');
      expect(series).toHaveLength(2);
      const d1 = series.find((p) => p.timestamp === Date.UTC(2026, 5, 1));
      expect(d1).toBeDefined();
      expect(d1!.inputTokens).toBe(110);
      expect(d1!.outputTokens).toBe(55);
      expect(d1!.totalTokens).toBe(165);
      expect(d1!.sessionCount).toBe(2);
    });

    it('handles codex sessions by walking ai_agent_messages turn deltas', async () => {
      const t0 = Date.UTC(2026, 5, 1, 12, 0, 0);
      await insertSession(db, {
        id: 'codex-1',
        provider: 'openai-codex',
        providerSessionId: 'codex-1',
        createdAtMs: t0,
        metadata: {},
      });
      // First turn: 100 input, 30 output.
      await insertMessage(db, {
        sessionId: 'codex-1',
        direction: 'input',
        content: 'hello',
        metadata: { promptType: 'user' },
        createdAtMs: t0 + 1_000,
      });
      await insertMessage(db, {
        sessionId: 'codex-1',
        direction: 'output',
        content: {
          usage: { input_tokens: 100, output_tokens: 30, cached_input_tokens: 0 },
        },
        metadata: { eventType: 'turn.completed' },
        createdAtMs: t0 + 2_000,
      });
      // Second turn: cumulative 250 input, 80 output -> delta 150 / 50.
      await insertMessage(db, {
        sessionId: 'codex-1',
        direction: 'input',
        content: 'follow up',
        metadata: { promptType: 'user' },
        createdAtMs: t0 + 3_000,
      });
      await insertMessage(db, {
        sessionId: 'codex-1',
        direction: 'output',
        content: {
          usage: { input_tokens: 250, output_tokens: 80, cached_input_tokens: 0 },
        },
        metadata: { eventType: 'turn.completed' },
        createdAtMs: t0 + 4_000,
      });

      const series = await svc.getTimeSeriesData(t0 - 1, t0 + 24 * 3_600_000, 'day');
      expect(series).toHaveLength(1);
      // Two turns aggregated: input 100+150=250, output 30+50=80.
      expect(series[0].inputTokens).toBe(250);
      expect(series[0].outputTokens).toBe(80);
      expect(series[0].totalTokens).toBe(330);
      expect(series[0].sessionCount).toBe(1);
    });

    it('ignores non-turn.completed output rows (filtered in SQL, not JS)', async () => {
      // Regression for the 2026-06-03 crash: the portable path used to SELECT
      // `content` for every codex message and filter in JS, materializing
      // multi-GB assistant/tool-output bodies. Now `turn.completed` is filtered
      // in SQL via `metadata->>'eventType'`, so a huge non-turn output must be
      // excluded entirely and never contribute tokens.
      const t0 = Date.UTC(2026, 5, 1, 12, 0, 0);
      await insertSession(db, {
        id: 'codex-noise',
        provider: 'openai-codex',
        providerSessionId: 'codex-noise',
        createdAtMs: t0,
        metadata: {},
      });
      await insertMessage(db, {
        sessionId: 'codex-noise',
        direction: 'input',
        content: 'hello',
        metadata: { promptType: 'user' },
        createdAtMs: t0 + 1_000,
      });
      // Large assistant output that is NOT a turn.completed event — the kind of
      // row that used to bloat the payload. Its `usage` must be ignored.
      await insertMessage(db, {
        sessionId: 'codex-noise',
        direction: 'output',
        content: { text: 'x'.repeat(50_000), usage: { input_tokens: 9_999, output_tokens: 9_999 } },
        metadata: { eventType: 'agent_message' },
        createdAtMs: t0 + 2_000,
      });
      // The real usage-bearing turn.
      await insertMessage(db, {
        sessionId: 'codex-noise',
        direction: 'output',
        content: { usage: { input_tokens: 100, output_tokens: 30, cached_input_tokens: 0 } },
        metadata: { eventType: 'turn.completed' },
        createdAtMs: t0 + 3_000,
      });

      const series = await svc.getTimeSeriesData(t0 - 1, t0 + 24 * 3_600_000, 'day');
      expect(series).toHaveLength(1);
      expect(series[0].inputTokens).toBe(100);
      expect(series[0].outputTokens).toBe(30);
    });
  });

  describe('document_history methods (regression: were querying nonexistent created_at)', () => {
    it('getDocumentEditStats aggregates by file using timestamp', async () => {
      await db.query(
        `INSERT INTO document_history (workspace_id, file_path, content, size_bytes, timestamp, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['ws1', 'a.md', Buffer.from('hello'), 5, 1_700_000_000_000, '{}'],
      );
      await db.query(
        `INSERT INTO document_history (workspace_id, file_path, content, size_bytes, timestamp, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['ws1', 'a.md', Buffer.from('hello world'), 11, 1_700_001_000_000, '{}'],
      );
      await db.query(
        `INSERT INTO document_history (workspace_id, file_path, content, size_bytes, timestamp, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['ws2', 'b.md', Buffer.from('y'), 1, 1_700_002_000_000, '{}'],
      );
      const stats = await svc.getDocumentEditStats();
      expect(stats).toHaveLength(2);
      const a = stats.find((s) => s.filePath === 'a.md');
      expect(a).toBeDefined();
      expect(a!.editCount).toBe(2);
      expect(a!.sizeBytes).toBe(11);
      expect(a!.lastEdited).toBe(1_700_001_000_000);
    });

    it('getDocumentEditStats filters by workspaceId', async () => {
      await db.query(
        `INSERT INTO document_history (workspace_id, file_path, content, size_bytes, timestamp, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['ws-a', 'a.md', Buffer.from('x'), 1, 1_700_000_000_000, '{}'],
      );
      await db.query(
        `INSERT INTO document_history (workspace_id, file_path, content, size_bytes, timestamp, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['ws-b', 'b.md', Buffer.from('y'), 1, 1_700_000_000_000, '{}'],
      );
      const stats = await svc.getDocumentEditStats('ws-a');
      expect(stats).toHaveLength(1);
      expect(stats[0].workspaceId).toBe('ws-a');
    });

    it('getDocumentEditTimeSeries buckets by day using timestamp', async () => {
      const day1 = Date.UTC(2026, 5, 1, 9, 0, 0);
      const day2 = Date.UTC(2026, 5, 2, 9, 0, 0);
      await db.query(
        `INSERT INTO document_history (workspace_id, file_path, content, size_bytes, timestamp, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['ws1', 'a.md', Buffer.from('x'), 1, day1, '{}'],
      );
      await db.query(
        `INSERT INTO document_history (workspace_id, file_path, content, size_bytes, timestamp, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['ws1', 'a.md', Buffer.from('y'), 1, day1 + 60_000, '{}'],
      );
      await db.query(
        `INSERT INTO document_history (workspace_id, file_path, content, size_bytes, timestamp, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['ws1', 'b.md', Buffer.from('z'), 1, day2, '{}'],
      );
      const series = await svc.getDocumentEditTimeSeries(day1 - 1, day2 + 1, 'day');
      expect(series).toHaveLength(2);
      const d1 = series.find((p) => p.timestamp === Date.UTC(2026, 5, 1));
      const d2 = series.find((p) => p.timestamp === Date.UTC(2026, 5, 2));
      expect(d1!.editCount).toBe(2);
      expect(d2!.editCount).toBe(1);
    });

    it('getDocumentEditTimeSeries respects the [startDate, endDate] range and workspace filter', async () => {
      const day1 = Date.UTC(2026, 5, 1, 9, 0, 0);
      const day2 = Date.UTC(2026, 5, 2, 9, 0, 0);
      const day3 = Date.UTC(2026, 5, 3, 9, 0, 0);
      for (const [ws, ts] of [
        ['ws-a', day1],
        ['ws-a', day2],
        ['ws-b', day2],
        ['ws-a', day3],
      ] as const) {
        await db.query(
          `INSERT INTO document_history (workspace_id, file_path, content, size_bytes, timestamp, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [ws, 'f.md', Buffer.from('x'), 1, ts, '{}'],
        );
      }
      const series = await svc.getDocumentEditTimeSeries(day1, day2, 'day', 'ws-a');
      expect(series).toHaveLength(2);
      expect(series.find((p) => p.timestamp === Date.UTC(2026, 5, 1))!.editCount).toBe(1);
      expect(series.find((p) => p.timestamp === Date.UTC(2026, 5, 2))!.editCount).toBe(1);
    });
  });

  describe('getActivityHeatmap', () => {
    it('counts messages by hour-of-day / day-of-week', async () => {
      await insertSession(db, { id: 's1', metadata: {} });
      // Two messages on the same UTC hour-of-day bucket.
      const ts = Date.UTC(2026, 5, 1, 14, 0, 0); // Monday 14:00 UTC
      await insertMessage(db, {
        sessionId: 's1',
        direction: 'input',
        content: 'a',
        createdAtMs: ts,
      });
      await insertMessage(db, {
        sessionId: 's1',
        direction: 'input',
        content: 'b',
        createdAtMs: ts + 60_000,
      });
      // Output message — excluded by the metric='messages' filter.
      await insertMessage(db, {
        sessionId: 's1',
        direction: 'output',
        content: 'c',
        createdAtMs: ts + 120_000,
      });

      const heat = await svc.getActivityHeatmap(undefined, 'messages', 0);
      expect(heat).toEqual([
        { dayOfWeek: 1, hourOfDay: 14, activityCount: 2 },
      ]);
    });
  });

});
