/**
 * Usage Analytics Service
 * Provides aggregated statistics for AI usage and document editing patterns
 */

import type { AppDatabase } from '../database/PGLiteDatabaseWorker';

export interface TokenUsageStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  sessionCount: number;
  messageCount: number;
}

export interface ProviderUsageStats {
  provider: string;
  model: string | null;
  sessionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
}

export interface ProjectUsageStats {
  workspaceId: string;
  sessionCount: number;
  totalTokens: number;
  lastActivity: number;
}

export interface TimeSeriesDataPoint {
  timestamp: number; // Epoch milliseconds
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  sessionCount: number;
}

export interface ActivityHeatmapData {
  hourOfDay: number; // 0-23
  dayOfWeek: number; // 0-6 (Sunday-Saturday)
  activityCount: number;
}

export interface DocumentEditStats {
  workspaceId: string;
  filePath: string;
  editCount: number;
  lastEdited: number;
  sizeBytes: number;
}

export class UsageAnalyticsService {
  constructor(private db: AppDatabase) {}

  private isSQLiteBackend(): boolean {
    const candidate = this.db as AppDatabase & { getEngine?: () => string };
    return candidate.getEngine?.() === 'sqlite';
  }

  private readonly SESSION_TOKEN_USAGE_CTE = `
    WITH session_token_usage AS (
      SELECT
        s.id,
        s.provider,
        s.model,
        s.workspace_id,
        s.created_at,
        s.updated_at,
        COALESCE((s.metadata->'tokenUsage'->>'inputTokens')::bigint, 0) AS input_tokens,
        COALESCE((s.metadata->'tokenUsage'->>'outputTokens')::bigint, 0) AS output_tokens,
        COALESCE(
          (s.metadata->'tokenUsage'->>'totalTokens')::bigint,
          COALESCE((s.metadata->'tokenUsage'->>'inputTokens')::bigint, 0) +
          COALESCE((s.metadata->'tokenUsage'->>'outputTokens')::bigint, 0),
          0
        ) AS total_tokens
      FROM ai_sessions s
      WHERE s.metadata->'tokenUsage' IS NOT NULL
    )
  `;

  /**
   * Get total count of all AI sessions (including those without token data)
   */
  async getAllSessionCount(workspaceId?: string): Promise<number> {
    const whereClause = workspaceId ? `WHERE workspace_id = $1` : '';
    const params = workspaceId ? [workspaceId] : [];

    const result = await this.db.query(
      `SELECT COUNT(DISTINCT id) as total_sessions
      FROM ai_sessions
      ${whereClause}`,
      params
    );

    return parseInt(result.rows[0]?.total_sessions) || 0;
  }

  /**
   * Get overall token usage statistics across all sessions
   */
  async getOverallTokenUsage(workspaceId?: string): Promise<TokenUsageStats> {
    const whereClause = workspaceId ? `WHERE workspace_id = $1` : '';
    const params = workspaceId ? [workspaceId] : [];

    const result = await this.db.query(
      `${this.SESSION_TOKEN_USAGE_CTE}
      SELECT
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COUNT(DISTINCT id) as session_count
      FROM session_token_usage
      ${whereClause}`,
      params
    );

    const row = result.rows[0] || {};

    return {
      totalInputTokens: parseInt(row.total_input_tokens) || 0,
      totalOutputTokens: parseInt(row.total_output_tokens) || 0,
      totalTokens: parseInt(row.total_tokens) || 0,
      sessionCount: parseInt(row.session_count) || 0,
      messageCount: 0, // TODO: Can be calculated from ai_agent_messages if needed
    };
  }

  /**
   * Get token usage broken down by provider and model
   */
  async getUsageByProvider(workspaceId?: string): Promise<ProviderUsageStats[]> {
    const whereClause = workspaceId ? `WHERE workspace_id = $1` : '';
    const params = workspaceId ? [workspaceId] : [];

    const result = await this.db.query(
      `${this.SESSION_TOKEN_USAGE_CTE}
      SELECT
        provider,
        model,
        COUNT(DISTINCT id) as session_count,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens
      FROM session_token_usage
      ${whereClause}
      GROUP BY provider, model
      ORDER BY total_tokens DESC`,
      params
    );

    return result.rows.map((row: any) => ({
      provider: row.provider,
      model: row.model,
      sessionCount: parseInt(row.session_count) || 0,
      totalInputTokens: parseInt(row.total_input_tokens) || 0,
      totalOutputTokens: parseInt(row.total_output_tokens) || 0,
      totalTokens: parseInt(row.total_tokens) || 0,
    }));
  }

  /**
   * Get token usage broken down by project (workspace)
   */
  async getUsageByProject(): Promise<ProjectUsageStats[]> {
    const result = await this.db.query(
      `${this.SESSION_TOKEN_USAGE_CTE}
      SELECT
        workspace_id,
        COUNT(DISTINCT id) as session_count,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        MAX(updated_at) as last_activity_at
      FROM session_token_usage
      GROUP BY workspace_id
      ORDER BY total_tokens DESC`,
      []
    );

    return result.rows.map((row: any) => ({
      workspaceId: row.workspace_id,
      sessionCount: parseInt(row.session_count) || 0,
      totalTokens: parseInt(row.total_tokens) || 0,
      lastActivity: toEpochMs(row.last_activity_at) || Date.now(),
    }));
  }

  /**
   * Get time-series data for token usage over a date range
   * @param startDate - Start of range (epoch ms)
   * @param endDate - End of range (epoch ms)
   * @param granularity - 'hour' | 'day' | 'week' | 'month'
   */
  async getTimeSeriesData(
    startDate: number,
    endDate: number,
    granularity: 'hour' | 'day' | 'week' | 'month' = 'day',
    workspaceId?: string
  ): Promise<TimeSeriesDataPoint[]> {
    if (this.isSQLiteBackend()) {
      return this.getTimeSeriesDataPortable(startDate, endDate, granularity, workspaceId);
    }

    const truncFunc = {
      hour: 'hour',
      day: 'day',
      week: 'week',
      month: 'month',
    }[granularity];

    const params = workspaceId ? [startDate, endDate, workspaceId] : [startDate, endDate];

    const timeRangeClause = `created_at >= to_timestamp($1 / 1000.0) AND created_at <= to_timestamp($2 / 1000.0)`;
    const nonCodexWhereClause = workspaceId
      ? `WHERE provider <> 'openai-codex' AND workspace_id = $3 AND ${timeRangeClause}`
      : `WHERE provider <> 'openai-codex' AND ${timeRangeClause}`;
    const codexWorkspaceFilter = workspaceId ? `AND s.workspace_id = $3` : '';

    const result = await this.db.query(
      `${this.SESSION_TOKEN_USAGE_CTE}
      , non_codex_bucketed AS (
        SELECT
          DATE_TRUNC('${truncFunc}', created_at) AS bucket,
          COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
          COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
          COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
          COUNT(DISTINCT id)::bigint AS session_count
        FROM session_token_usage
        ${nonCodexWhereClause}
        GROUP BY DATE_TRUNC('${truncFunc}', created_at)
      )
      , codex_turns_raw AS (
        SELECT
          m.session_id,
          m.created_at,
          s.provider_session_id,
          GREATEST(
            COALESCE((m.content::jsonb->'usage'->>'input_tokens')::bigint, 0) -
            COALESCE((m.content::jsonb->'usage'->>'cached_input_tokens')::bigint, 0),
            0
          ) AS input_tokens,
          COALESCE((m.content::jsonb->'usage'->>'output_tokens')::bigint, 0) AS output_tokens
        FROM ai_agent_messages m
        JOIN ai_sessions s ON s.id = m.session_id
        WHERE s.provider = 'openai-codex'
          ${codexWorkspaceFilter}
          AND m.direction = 'output'
          AND m.metadata->>'eventType' = 'turn.completed'
      )
      , codex_turns AS (
        SELECT
          tr.session_id,
          tr.created_at,
          tr.provider_session_id,
          tr.input_tokens,
          tr.output_tokens
        FROM codex_turns_raw tr
        LEFT JOIN LATERAL (
          SELECT mi.metadata
          FROM ai_agent_messages mi
          WHERE mi.session_id = tr.session_id
            AND mi.direction = 'input'
            AND mi.created_at <= tr.created_at
          ORDER BY mi.created_at DESC
          LIMIT 1
        ) nearest_input ON TRUE
        WHERE COALESCE(nearest_input.metadata->>'promptType', '') <> 'system_reminder'
      )
      , codex_first_turn AS (
        SELECT
          session_id,
          MIN(created_at) AS first_turn_at
        FROM codex_turns
        GROUP BY session_id
      )
      , codex_baseline AS (
        SELECT
          ft.session_id,
          COALESCE(prev.input_tokens, 0) AS baseline_input_tokens,
          COALESCE(prev.output_tokens, 0) AS baseline_output_tokens
        FROM codex_first_turn ft
        JOIN ai_sessions s ON s.id = ft.session_id
        LEFT JOIN LATERAL (
          SELECT
            ct_prev.input_tokens,
            ct_prev.output_tokens
          FROM codex_turns ct_prev
          WHERE ct_prev.provider_session_id = s.provider_session_id
            AND ct_prev.created_at < ft.first_turn_at
          ORDER BY ct_prev.created_at DESC
          LIMIT 1
        ) prev ON TRUE
      )
      , codex_turns_with_prev AS (
        SELECT
          ct.session_id,
          ct.created_at,
          GREATEST(
            ct.input_tokens - COALESCE(
              LAG(ct.input_tokens) OVER (PARTITION BY ct.session_id ORDER BY ct.created_at),
              cb.baseline_input_tokens,
              0
            ),
            0
          ) AS input_tokens,
          GREATEST(
            ct.output_tokens - COALESCE(
              LAG(ct.output_tokens) OVER (PARTITION BY ct.session_id ORDER BY ct.created_at),
              cb.baseline_output_tokens,
              0
            ),
            0
          ) AS output_tokens
        FROM codex_turns ct
        LEFT JOIN codex_baseline cb ON cb.session_id = ct.session_id
      )
      , codex_bucketed AS (
        SELECT
          DATE_TRUNC('${truncFunc}', created_at) AS bucket,
          COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
          COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
          COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total_tokens,
          COUNT(DISTINCT session_id)::bigint AS session_count
        FROM codex_turns_with_prev
        WHERE ${timeRangeClause}
        GROUP BY DATE_TRUNC('${truncFunc}', created_at)
      )
      , combined AS (
        SELECT * FROM non_codex_bucketed
        UNION ALL
        SELECT * FROM codex_bucketed
      )
      SELECT
        EXTRACT(EPOCH FROM bucket) * 1000 as timestamp,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(session_count), 0) as session_count
      FROM combined
      GROUP BY bucket
      ORDER BY timestamp ASC`,
      params
    );

    return result.rows.map((row: any) => ({
      timestamp: parseFloat(row.timestamp),
      inputTokens: parseInt(row.input_tokens) || 0,
      outputTokens: parseInt(row.output_tokens) || 0,
      totalTokens: parseInt(row.total_tokens) || 0,
      sessionCount: parseInt(row.session_count) || 0,
    }));
  }

  /**
   * Get activity heatmap data (hour of day x day of week)
   * @param workspaceId - Optional workspace filter
   * @param metric - Type of activity to track: sessions, messages, or edits
   * @param timezoneOffsetMinutes - User's timezone offset in minutes (e.g., -300 for EST)
   */
  async getActivityHeatmap(
    workspaceId?: string,
    metric: 'sessions' | 'messages' | 'edits' = 'messages',
    timezoneOffsetMinutes: number = 0
  ): Promise<ActivityHeatmapData[]> {
    // Fetch raw timestamps and bucket them in JS. SQL-level
    // EXTRACT(... FROM ts + INTERVAL 'N minutes') has no portable form
    // (PG INTERVAL arithmetic vs SQLite strftime modifiers diverge once
    // you nest EXTRACT around the offset), so we compute the offset
    // bucket in JS where the math is identical on both backends.
    //
    // getTimezoneOffset() returns positive for west of UTC; we negate so
    // positive offsetMinutes = "shift forward to local."
    const offsetMs = -timezoneOffsetMinutes * 60_000;

    let timestamps: number[];

    if (metric === 'messages') {
      const whereClause = workspaceId
        ? `WHERE session_id IN (SELECT id FROM ai_sessions WHERE workspace_id = $1) AND direction = 'input'`
        : `WHERE direction = 'input'`;
      const params: any[] = workspaceId ? [workspaceId] : [];
      const result = await this.db.query<{ created_at: unknown }>(
        `SELECT created_at FROM ai_agent_messages ${whereClause}`,
        params
      );
      timestamps = result.rows.map((row) => toEpochMs(row.created_at));
    } else if (metric === 'edits') {
      const whereClause = workspaceId ? `WHERE workspace_id = $1` : '';
      const params: any[] = workspaceId ? [workspaceId] : [];
      const result = await this.db.query<{ timestamp: number | string | bigint }>(
        `SELECT timestamp FROM document_history ${whereClause}`,
        params
      );
      timestamps = result.rows.map((row) => Number(row.timestamp));
    } else {
      const whereClause = workspaceId ? `WHERE workspace_id = $1` : '';
      const params: any[] = workspaceId ? [workspaceId] : [];
      const result = await this.db.query<{ created_at: unknown }>(
        `SELECT created_at FROM ai_sessions ${whereClause}`,
        params
      );
      timestamps = result.rows.map((row) => toEpochMs(row.created_at));
    }

    const buckets = new Map<string, number>();
    for (const ms of timestamps) {
      if (!Number.isFinite(ms)) continue;
      const shifted = new Date(ms + offsetMs);
      // Pull UTC fields off the shifted Date so we get the local hour/dow
      // without any further timezone conversion.
      const hour = shifted.getUTCHours();
      const dow = shifted.getUTCDay();
      const key = `${dow}:${hour}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    const out: ActivityHeatmapData[] = [];
    for (const [key, count] of buckets) {
      const [dowStr, hourStr] = key.split(':');
      out.push({
        dayOfWeek: Number(dowStr),
        hourOfDay: Number(hourStr),
        activityCount: count,
      });
    }
    out.sort((a, b) =>
      a.dayOfWeek !== b.dayOfWeek
        ? a.dayOfWeek - b.dayOfWeek
        : a.hourOfDay - b.hourOfDay
    );
    return out;
  }

  /**
   * Get document edit statistics from document_history table
   */
  async getDocumentEditStats(workspaceId?: string): Promise<DocumentEditStats[]> {
    const whereClause = workspaceId ? `WHERE workspace_id = $1` : '';
    const params = workspaceId ? [workspaceId] : [];

    const result = await this.db.query(
      `SELECT
        workspace_id,
        file_path,
        COUNT(*) as edit_count,
        MAX(created_at) as last_edited_at,
        MAX(size_bytes) as size_bytes
      FROM document_history
      ${whereClause}
      GROUP BY workspace_id, file_path
      ORDER BY edit_count DESC
      LIMIT 100`,
      params
    );

    return result.rows.map((row: any) => ({
      workspaceId: row.workspace_id,
      filePath: row.file_path,
      editCount: parseInt(row.edit_count) || 0,
      lastEdited: toEpochMs(row.last_edited_at) || Date.now(),
      sizeBytes: parseInt(row.size_bytes) || 0,
    }));
  }

  /**
   * Get document edit counts over time
   */
  async getDocumentEditTimeSeries(
    startDate: number,
    endDate: number,
    granularity: 'hour' | 'day' | 'week' | 'month' = 'day',
    workspaceId?: string
  ): Promise<{ timestamp: number; editCount: number }[]> {
    if (this.isSQLiteBackend()) {
      const whereClause = workspaceId
        ? `WHERE workspace_id = $3 AND created_at >= to_timestamp($1 / 1000.0) AND created_at <= to_timestamp($2 / 1000.0)`
        : `WHERE created_at >= to_timestamp($1 / 1000.0) AND created_at <= to_timestamp($2 / 1000.0)`;
      const params = workspaceId ? [startDate, endDate, workspaceId] : [startDate, endDate];
      const result = await this.db.query<{ created_at: unknown }>(
        `SELECT created_at FROM document_history ${whereClause}`,
        params,
      );
      return countsByTimeBucket(
        result.rows.map((row) => toEpochMs(row.created_at)),
        granularity,
      ).map(({ timestamp, count }) => ({
        timestamp,
        editCount: count,
      }));
    }

    const truncFunc = {
      hour: 'hour',
      day: 'day',
      week: 'week',
      month: 'month',
    }[granularity];

    const whereClause = workspaceId
      ? `WHERE workspace_id = $3 AND created_at >= to_timestamp($1 / 1000.0) AND created_at <= to_timestamp($2 / 1000.0)`
      : `WHERE created_at >= to_timestamp($1 / 1000.0) AND created_at <= to_timestamp($2 / 1000.0)`;

    const params = workspaceId ? [startDate, endDate, workspaceId] : [startDate, endDate];

    const result = await this.db.query(
      `SELECT
        EXTRACT(EPOCH FROM DATE_TRUNC('${truncFunc}', created_at)) * 1000 as timestamp,
        COUNT(*) as edit_count
      FROM document_history
      ${whereClause}
      GROUP BY DATE_TRUNC('${truncFunc}', created_at)
      ORDER BY timestamp ASC`,
      params
    );

    return result.rows.map((row: any) => ({
      timestamp: parseFloat(row.timestamp),
      editCount: parseInt(row.edit_count) || 0,
    }));
  }

  private async getTimeSeriesDataPortable(
    startDate: number,
    endDate: number,
    granularity: 'hour' | 'day' | 'week' | 'month',
    workspaceId?: string,
  ): Promise<TimeSeriesDataPoint[]> {
    const nonCodexWhereClause = workspaceId
      ? `WHERE provider <> 'openai-codex'
           AND workspace_id = $3
           AND created_at >= to_timestamp($1 / 1000.0)
           AND created_at <= to_timestamp($2 / 1000.0)`
      : `WHERE provider <> 'openai-codex'
           AND created_at >= to_timestamp($1 / 1000.0)
           AND created_at <= to_timestamp($2 / 1000.0)`;
    const nonCodexParams = workspaceId ? [startDate, endDate, workspaceId] : [startDate, endDate];
    const nonCodexRows = await this.db.query<{ id: string; created_at: unknown; metadata: unknown }>(
      `SELECT id, created_at, metadata
       FROM ai_sessions
       ${nonCodexWhereClause}`,
      nonCodexParams,
    );

    const buckets = new Map<number, {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      sessionIds: Set<string>;
    }>();

    for (const row of nonCodexRows.rows) {
      const tokenUsage = readTokenUsage(row.metadata);
      if (!tokenUsage) continue;
      const bucket = bucketStartMs(toEpochMs(row.created_at), granularity);
      if (!Number.isFinite(bucket)) continue;
      const agg = getOrCreateBucket(buckets, bucket);
      agg.inputTokens += tokenUsage.inputTokens;
      agg.outputTokens += tokenUsage.outputTokens;
      agg.totalTokens += tokenUsage.totalTokens;
      agg.sessionIds.add(row.id);
    }

    const codexSessionWhereClause = workspaceId
      ? `WHERE provider = 'openai-codex' AND workspace_id = $1`
      : `WHERE provider = 'openai-codex'`;
    const codexSessionParams = workspaceId ? [workspaceId] : [];
    const codexSessions = await this.db.query<{ id: string; provider_session_id: string | null }>(
      `SELECT id, provider_session_id
       FROM ai_sessions
       ${codexSessionWhereClause}`,
      codexSessionParams,
    );
    if (codexSessions.rows.length === 0) {
      return bucketsToTimeSeries(buckets);
    }

    const providerSessionIdBySession = new Map(
      codexSessions.rows.map((row) => [row.id, row.provider_session_id ?? row.id]),
    );
    const codexSessionIds = codexSessions.rows.map((row) => row.id);
    const codexMessages = await this.db.query<{
      session_id: string;
      created_at: unknown;
      direction: string;
      content: unknown;
      metadata: unknown;
    }>(
      `SELECT session_id, created_at, direction, content, metadata
       FROM ai_agent_messages
       WHERE session_id = ANY($1::text[])
         AND created_at <= to_timestamp($2 / 1000.0)
       ORDER BY session_id ASC, created_at ASC, id ASC`,
      [codexSessionIds, endDate],
    );

    const turnsBySession = new Map<string, Array<{
      sessionId: string;
      providerSessionId: string;
      createdAtMs: number;
      inputTokens: number;
      outputTokens: number;
    }>>();

    const inputPromptTypeBySession = new Map<string, Array<{ createdAtMs: number; promptType: string | null }>>();

    for (const row of codexMessages.rows) {
      const createdAtMs = toEpochMs(row.created_at);
      if (!Number.isFinite(createdAtMs)) continue;
      if (row.direction === 'input') {
        const metadata = parseJsonRecord(row.metadata);
        const promptType = typeof metadata?.promptType === 'string' ? metadata.promptType : null;
        const items = inputPromptTypeBySession.get(row.session_id) ?? [];
        items.push({ createdAtMs, promptType });
        inputPromptTypeBySession.set(row.session_id, items);
        continue;
      }
      if (row.direction !== 'output') continue;
      const metadata = parseJsonRecord(row.metadata);
      if (metadata?.eventType !== 'turn.completed') continue;
      const usage = readCodexUsage(row.content);
      if (!usage) continue;
      const providerSessionId = providerSessionIdBySession.get(row.session_id) ?? row.session_id;
      const items = turnsBySession.get(row.session_id) ?? [];
      items.push({
        sessionId: row.session_id,
        providerSessionId,
        createdAtMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
      turnsBySession.set(row.session_id, items);
    }

    const filteredTurnsBySession = new Map<string, Array<{
      sessionId: string;
      providerSessionId: string;
      createdAtMs: number;
      inputTokens: number;
      outputTokens: number;
    }>>();

    for (const [sessionId, turns] of turnsBySession) {
      const inputs = inputPromptTypeBySession.get(sessionId) ?? [];
      let inputIdx = 0;
      const filtered: typeof turns = [];
      for (const turn of turns) {
        while (inputIdx + 1 < inputs.length && inputs[inputIdx + 1].createdAtMs <= turn.createdAtMs) {
          inputIdx++;
        }
        const nearestPromptType = inputs[inputIdx]?.createdAtMs <= turn.createdAtMs
          ? inputs[inputIdx]?.promptType
          : null;
        if (nearestPromptType === 'system_reminder') continue;
        filtered.push(turn);
      }
      if (filtered.length > 0) {
        filteredTurnsBySession.set(sessionId, filtered);
      }
    }

    const providerTimeline = new Map<string, Array<{
      sessionId: string;
      createdAtMs: number;
      inputTokens: number;
      outputTokens: number;
    }>>();
    for (const turns of filteredTurnsBySession.values()) {
      for (const turn of turns) {
        const items = providerTimeline.get(turn.providerSessionId) ?? [];
        items.push(turn);
        providerTimeline.set(turn.providerSessionId, items);
      }
    }
    for (const items of providerTimeline.values()) {
      items.sort((a, b) => a.createdAtMs - b.createdAtMs);
    }

    const baselineBySession = new Map<string, { inputTokens: number; outputTokens: number }>();
    for (const items of providerTimeline.values()) {
      let prev: { sessionId: string; inputTokens: number; outputTokens: number } | null = null;
      for (const item of items) {
        if (!baselineBySession.has(item.sessionId)) {
          baselineBySession.set(item.sessionId, {
            inputTokens: prev?.inputTokens ?? 0,
            outputTokens: prev?.outputTokens ?? 0,
          });
        }
        prev = item;
      }
    }

    for (const [sessionId, turns] of filteredTurnsBySession) {
      let prevInput = baselineBySession.get(sessionId)?.inputTokens ?? 0;
      let prevOutput = baselineBySession.get(sessionId)?.outputTokens ?? 0;
      for (const turn of turns) {
        const deltaInput = Math.max(turn.inputTokens - prevInput, 0);
        const deltaOutput = Math.max(turn.outputTokens - prevOutput, 0);
        prevInput = turn.inputTokens;
        prevOutput = turn.outputTokens;
        if (turn.createdAtMs < startDate || turn.createdAtMs > endDate) continue;
        const bucket = bucketStartMs(turn.createdAtMs, granularity);
        if (!Number.isFinite(bucket)) continue;
        const agg = getOrCreateBucket(buckets, bucket);
        agg.inputTokens += deltaInput;
        agg.outputTokens += deltaOutput;
        agg.totalTokens += deltaInput + deltaOutput;
        agg.sessionIds.add(turn.sessionId);
      }
    }

    return bucketsToTimeSeries(buckets);
  }
}

/**
 * Coerce a TIMESTAMPTZ column value to epoch milliseconds.
 * PGLite returns Date instances; SQLite returns ISO strings.
 */
function toEpochMs(raw: unknown): number {
  if (raw == null) return NaN;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return new Date(raw).getTime();
  if (typeof raw === 'bigint') return Number(raw);
  return NaN;
}

function parseJsonRecord(raw: unknown): Record<string, any> | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null;
    } catch {
      return null;
    }
  }
  return raw && typeof raw === 'object' ? raw as Record<string, any> : null;
}

function readTokenUsage(rawMetadata: unknown): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} | null {
  const metadata = parseJsonRecord(rawMetadata);
  const tokenUsage = metadata?.tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== 'object') return null;
  const inputTokens = Number((tokenUsage as Record<string, unknown>).inputTokens ?? 0);
  const outputTokens = Number((tokenUsage as Record<string, unknown>).outputTokens ?? 0);
  const totalTokens = Number(
    (tokenUsage as Record<string, unknown>).totalTokens
      ?? (Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0),
  );
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}

function readCodexUsage(rawContent: unknown): {
  inputTokens: number;
  outputTokens: number;
} | null {
  const content = parseJsonRecord(rawContent);
  const usage = content?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Math.max(
    Number((usage as Record<string, unknown>).input_tokens ?? 0)
      - Number((usage as Record<string, unknown>).cached_input_tokens ?? 0),
    0,
  );
  const outputTokens = Number((usage as Record<string, unknown>).output_tokens ?? 0);
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
  };
}

function bucketStartMs(
  timestampMs: number,
  granularity: 'hour' | 'day' | 'week' | 'month',
): number {
  if (!Number.isFinite(timestampMs)) return NaN;
  const d = new Date(timestampMs);
  if (granularity === 'hour') {
    d.setUTCMinutes(0, 0, 0);
    return d.getTime();
  }
  if (granularity === 'day') {
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (granularity === 'week') {
    d.setUTCHours(0, 0, 0, 0);
    const day = d.getUTCDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diffToMonday);
    return d.getTime();
  }
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function countsByTimeBucket(
  timestamps: number[],
  granularity: 'hour' | 'day' | 'week' | 'month',
): Array<{ timestamp: number; count: number }> {
  const buckets = new Map<number, number>();
  for (const timestamp of timestamps) {
    const bucket = bucketStartMs(timestamp, granularity);
    if (!Number.isFinite(bucket)) continue;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, count]) => ({ timestamp, count }));
}

function getOrCreateBucket(
  buckets: Map<number, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    sessionIds: Set<string>;
  }>,
  bucket: number,
): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  sessionIds: Set<string>;
} {
  let agg = buckets.get(bucket);
  if (!agg) {
    agg = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      sessionIds: new Set<string>(),
    };
    buckets.set(bucket, agg);
  }
  return agg;
}

function bucketsToTimeSeries(
  buckets: Map<number, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    sessionIds: Set<string>;
  }>,
): TimeSeriesDataPoint[] {
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, agg]) => ({
      timestamp,
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      totalTokens: agg.totalTokens,
      sessionCount: agg.sessionIds.size,
    }));
}
