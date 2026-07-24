/**
 * Tool Usage Service
 *
 * Persists per-tool usage counts into the `tool_usage_counters` table and
 * serves two consumers:
 *   - tip targeting (a rolled-up `mcp:<server>` + built-in-name map), and
 *   - the AI Usage Report Tools tab (top tools, built-in vs MCP, over-time,
 *     per-project, per-provider aggregates).
 *
 * Writes go through the shared `database` facade so the same PG-dialect SQL
 * runs on both PGLite and better-sqlite3 (the dialect translator rewrites
 * `$N` params, `NOW()`, and leaves `ON CONFLICT ... DO UPDATE` untouched).
 */

import { database, type AppDatabase } from '../database/PGLiteDatabaseWorker';
import {
  aggregateToolCalls,
  extractClaudeTools,
  extractCodexTools,
  parseToolName,
  rollupKey,
  toDayBucket,
  type AggregatedToolUsage,
  type ToolCallObservation,
  type ToolUsageRollupRecord,
} from '../../shared/toolUsage';
import { logger } from '../utils/logger';

export interface ToolUsageReportRow {
  toolName: string;
  mcpServer: string | null;
  count: number;
  errorCount: number;
}

export interface ToolUsageReport {
  topTools: ToolUsageReportRow[];
  byKind: { builtin: number; mcp: number };
  byProvider: Array<{ provider: string; count: number }>;
  overTime: Array<{ day: string; count: number }>;
  byProject: Array<{ projectPath: string; count: number }>;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
};

type TransactionStatement = { sql: string; params?: unknown[] };
type BackfillResult = { sessionsProcessed: number; toolCallsCounted: number };

export class ToolUsageService {
  private static instance: ToolUsageService | null = null;
  private backfillPromise: Promise<BackfillResult> | null = null;

  /** Injectable for tests; defaults to the shared backend-selecting facade. */
  constructor(private db: AppDatabase = database) {}

  public static getInstance(): ToolUsageService {
    if (!this.instance) this.instance = new ToolUsageService();
    return this.instance;
  }

  /**
   * Record a response's worth of tool observations. Aggregates in JS, then
   * issues one UPSERT per distinct tool inside a single transaction.
   */
  async recordBatch(
    calls: ReadonlyArray<ToolCallObservation>,
    opts: { provider?: string; projectPath?: string; day?: string } = {},
  ): Promise<void> {
    const aggregated = aggregateToolCalls(calls);
    if (aggregated.length === 0) return;
    await this.upsertAggregated(aggregated, {
      provider: opts.provider ?? '',
      projectPath: opts.projectPath ?? '',
      day: opts.day ?? toDayBucket(),
    });
  }

  private async upsertAggregated(
    aggregated: AggregatedToolUsage[],
    ctx: { provider: string; projectPath: string; day: string },
  ): Promise<void> {
    await this.db.runTransaction(this.buildUpsertStatements(aggregated, ctx));
  }

  private buildUpsertStatements(
    aggregated: AggregatedToolUsage[],
    ctx: { provider: string; projectPath: string; day: string },
  ): TransactionStatement[] {
    return aggregated.map((a) => ({
      sql: `
        INSERT INTO tool_usage_counters
          (tool_name, mcp_server, mcp_tool, provider, project_path, day, count, error_count, first_used, last_used)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        ON CONFLICT (tool_name, provider, project_path, day)
        DO UPDATE SET
          count = tool_usage_counters.count + EXCLUDED.count,
          error_count = tool_usage_counters.error_count + EXCLUDED.error_count,
          last_used = NOW()
      `,
      params: [
        a.toolName,
        a.mcpServer,
        a.mcpTool,
        ctx.provider,
        ctx.projectPath,
        ctx.day,
        a.count,
        a.errorCount,
      ],
    }));
  }

  /**
   * Rolled-up lifetime totals for tip targeting: built-in tools by name, MCP
   * tools collapsed to `mcp:<server>`.
   */
  async getRollup(): Promise<Record<string, ToolUsageRollupRecord>> {
    const { rows } = await this.db.query<{
      tool_name: string;
      mcp_server: string | null;
      count: unknown;
      first_used: string;
      last_used: string;
    }>(
      `SELECT tool_name, mcp_server,
              SUM(count) AS count,
              MIN(first_used) AS first_used,
              MAX(last_used) AS last_used
       FROM tool_usage_counters
       GROUP BY tool_name, mcp_server`,
    );

    const out: Record<string, ToolUsageRollupRecord> = {};
    for (const r of rows) {
      const key = rollupKey(
        r.mcp_server
          ? {
              toolName: r.tool_name,
              mcpServer: r.mcp_server,
              mcpTool: null,
              isMcp: true,
            }
          : parseToolName(r.tool_name),
      );
      const count = num(r.count);
      const existing = out[key];
      if (existing) {
        existing.count += count;
        if (r.first_used < existing.firstUsed)
          existing.firstUsed = r.first_used;
        if (r.last_used > existing.lastUsed) existing.lastUsed = r.last_used;
      } else {
        out[key] = { count, firstUsed: r.first_used, lastUsed: r.last_used };
      }
    }
    return out;
  }

  /** Aggregates for the AI Usage Report Tools tab. */
  async getReport(workspaceId?: string): Promise<ToolUsageReport> {
    const where = workspaceId ? `WHERE project_path = $1` : '';
    const params = workspaceId ? [workspaceId] : [];

    const [topRes, kindRes, providerRes, timeRes, projectRes] =
      await Promise.all([
        this.db.query(
          `SELECT tool_name, mcp_server,
                SUM(count) AS count, SUM(error_count) AS error_count
         FROM tool_usage_counters ${where}
         GROUP BY tool_name, mcp_server
         ORDER BY SUM(count) DESC
         LIMIT 100`,
          params,
        ),
        this.db.query(
          `SELECT
           SUM(CASE WHEN mcp_server IS NULL THEN count ELSE 0 END) AS builtin,
           SUM(CASE WHEN mcp_server IS NOT NULL THEN count ELSE 0 END) AS mcp
         FROM tool_usage_counters ${where}`,
          params,
        ),
        this.db.query(
          `SELECT provider, SUM(count) AS count
         FROM tool_usage_counters ${where}
         GROUP BY provider ORDER BY SUM(count) DESC`,
          params,
        ),
        this.db.query(
          `SELECT day, SUM(count) AS count
         FROM tool_usage_counters ${where}
         GROUP BY day ORDER BY day ASC`,
          params,
        ),
        this.db.query(
          `SELECT project_path, SUM(count) AS count
         FROM tool_usage_counters ${where}
         GROUP BY project_path ORDER BY SUM(count) DESC
         LIMIT 100`,
          params,
        ),
      ]);

    const topTools: ToolUsageReportRow[] = topRes.rows.map((r: any) => ({
      toolName: r.tool_name,
      mcpServer: r.mcp_server ?? null,
      count: num(r.count),
      errorCount: num(r.error_count),
    }));

    const kindRow = kindRes.rows[0] as any;
    const byKind = { builtin: num(kindRow?.builtin), mcp: num(kindRow?.mcp) };

    return {
      topTools,
      byKind,
      byProvider: providerRes.rows.map((r: any) => ({
        provider: r.provider || '(unknown)',
        count: num(r.count),
      })),
      overTime: timeRes.rows.map((r: any) => ({
        day: r.day,
        count: num(r.count),
      })),
      byProject: projectRes.rows.map((r: any) => ({
        projectPath: r.project_path || '(none)',
        count: num(r.count),
      })),
    };
  }

  /**
   * Retry-safe historical backfill from raw `ai_agent_messages` for
   * claude-code and codex sessions. Only messages predating the migration
   * cutoff are eligible, and each session's counters + completion marker are
   * committed atomically.
   */
  async backfillFromRawMessages(): Promise<BackfillResult> {
    if (this.backfillPromise) return this.backfillPromise;
    this.backfillPromise = this.runHistoricalBackfill();
    try {
      return await this.backfillPromise;
    } finally {
      this.backfillPromise = null;
    }
  }

  private async runHistoricalBackfill(): Promise<BackfillResult> {
    const cutoffResult = await this.db.query<{ cutoff_at: string }>(
      `SELECT cutoff_at FROM tool_usage_backfill_meta WHERE singleton = 1`,
    );
    const cutoffAt = cutoffResult.rows[0]?.cutoff_at;
    if (!cutoffAt) {
      throw new Error('Tool usage backfill cutoff is unavailable');
    }

    const { rows: sessions } = await this.db.query<{
      id: string;
      provider: string;
      workspace_id: string | null;
    }>(
      `SELECT s.id, s.provider, s.workspace_id
       FROM ai_sessions s
       LEFT JOIN tool_usage_backfill_sessions b ON b.session_id = s.id
       WHERE b.session_id IS NULL
         AND s.provider IN ('claude-code', 'claude-code-cli', 'openai-codex', 'openai-codex-acp')`,
    );

    let sessionsProcessed = 0;
    let toolCallsCounted = 0;

    for (const session of sessions) {
      const isCodex = session.provider.startsWith('openai-codex');
      const { rows: messages } = await this.db.query<{
        content: string;
        created_at: string;
      }>(
        `SELECT content, created_at FROM ai_agent_messages
         WHERE session_id = $1 AND direction = 'output' AND created_at < $2
         ORDER BY id ASC`,
        [session.id, cutoffAt],
      );

      // Claude SDK chunks can repeat the same tool_use block. Codex persistence
      // stores terminal events once, and its item IDs are reused across turns,
      // so only Claude IDs are safe to dedupe session-wide.
      const seenIds = new Set<string>();
      const perDay = new Map<string, ToolCallObservation[]>();

      for (const msg of messages) {
        const day = toDayBucket(new Date(msg.created_at));
        let parsed: any;
        try {
          parsed = JSON.parse(msg.content);
        } catch {
          continue;
        }
        const extracted = isCodex
          ? extractCodexTools(parsed)
          : extractClaudeTools(parsed);
        for (const e of extracted) {
          if (!isCodex && e.id && seenIds.has(e.id)) continue;
          if (!isCodex && e.id) seenIds.add(e.id);
          const list = perDay.get(day) ?? [];
          list.push({ name: e.name, isError: e.isError });
          perDay.set(day, list);
          toolCallsCounted += 1;
        }
      }

      const projectPath = session.workspace_id ?? '';
      const statements: TransactionStatement[] = [];
      for (const [day, observations] of perDay) {
        const aggregated = aggregateToolCalls(observations);
        if (aggregated.length > 0) {
          statements.push(
            ...this.buildUpsertStatements(aggregated, {
              provider: session.provider,
              projectPath,
              day,
            }),
          );
        }
      }
      statements.push({
        sql: `INSERT INTO tool_usage_backfill_sessions (session_id, backfilled_at)
              VALUES ($1, NOW())
              ON CONFLICT (session_id) DO NOTHING`,
        params: [session.id],
      });
      await this.db.runTransaction(statements);
      sessionsProcessed += 1;
    }

    logger.main.info(
      `[ToolUsageService] backfill complete: ${sessionsProcessed} sessions, ${toolCallsCounted} tool calls`,
    );
    return { sessionsProcessed, toolCallsCounted };
  }
}
