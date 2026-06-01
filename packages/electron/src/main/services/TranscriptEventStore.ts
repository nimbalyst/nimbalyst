/**
 * PGLite store for canonical transcript events (ai_transcript_events table).
 *
 * Follows the same patterns as PGLiteAgentMessagesStore and PGLiteSessionStore:
 *   - Accepts a PGliteLike db handle and optional ensureReady callback
 *   - Maps snake_case SQL columns to camelCase TypeScript fields at the boundary
 *   - Uses TIMESTAMPTZ columns (returns Date objects from PGLite)
 */

import type {
  TranscriptEvent,
  TranscriptEventType,
  ITranscriptEventStore,
} from '@nimbalyst/runtime/ai/server/transcript/types';

type TranscriptEventStoreType = ITranscriptEventStore;

type PGliteLike = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  searchTranscriptEvents?(
    query: string,
    opts?: {
      limit?: number;
      sessionIds?: string[];
    },
  ): Promise<Array<Record<string, unknown>>>;
};

type EnsureReadyFn = () => Promise<void>;

// ---------------------------------------------------------------------------
// Row -> domain mapping
// ---------------------------------------------------------------------------

interface TranscriptEventRow {
  id: string | number;
  session_id: string;
  sequence: number;
  created_at: Date | string;
  event_type: string;
  searchable_text: string | null;
  payload: Record<string, unknown> | string;
  parent_event_id: string | number | null;
  searchable: boolean;
  subagent_id: string | null;
  provider: string;
  provider_tool_call_id: string | null;
}

function rowToEvent(row: TranscriptEventRow): TranscriptEvent {
  let payload = row.payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }

  return {
    id: Number(row.id),
    sessionId: row.session_id,
    sequence: row.sequence,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    eventType: row.event_type as TranscriptEventType,
    searchableText: row.searchable_text,
    payload: payload as Record<string, unknown>,
    parentEventId: row.parent_event_id != null ? Number(row.parent_event_id) : null,
    // SQLite stores BOOLEAN as INTEGER 0/1; PG returns native booleans.
    searchable: typeof row.searchable === 'number' ? row.searchable !== 0 : !!row.searchable,
    subagentId: row.subagent_id,
    provider: row.provider,
    providerToolCallId: row.provider_tool_call_id,
  };
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

// Re-export the canonical interface from runtime types
export type { ITranscriptEventStore as TranscriptEventStore } from '@nimbalyst/runtime/ai/server/transcript/types';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const SELECT_COLS = `id, session_id, sequence, created_at, event_type, searchable_text,
  payload, parent_event_id, searchable, subagent_id, provider, provider_tool_call_id`;

export function createTranscriptEventStore(
  db: PGliteLike,
  ensureDbReady?: EnsureReadyFn,
): TranscriptEventStoreType {
  const ensureReady = async () => {
    if (ensureDbReady) {
      await ensureDbReady();
    }
  };

  return {
    async insertEvent(event): Promise<TranscriptEvent> {
      await ensureReady();

      const { rows } = await db.query<TranscriptEventRow>(
        `INSERT INTO ai_transcript_events (
          session_id, sequence, created_at, event_type, searchable_text,
          payload, parent_event_id, searchable, subagent_id, provider, provider_tool_call_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING ${SELECT_COLS}`,
        [
          event.sessionId,
          event.sequence,
          event.createdAt,
          event.eventType,
          event.searchableText,
          JSON.stringify(event.payload),
          event.parentEventId,
          event.searchable,
          event.subagentId,
          event.provider,
          event.providerToolCallId,
        ],
      );

      return rowToEvent(rows[0]);
    },

    async insertEvents(events): Promise<TranscriptEvent[]> {
      await ensureReady();
      if (events.length === 0) return [];

      // Build one multi-row INSERT so the whole batch crosses the worker
      // boundary in a single IPC round-trip and writes inside a single
      // transaction. PG-style `$N` placeholders are translated to `?` by the
      // SQLite dialect translator; PGLite consumes them natively.
      //
      // SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 32,766 on modern
      // builds. With 11 columns/row, chunking at 1,000 rows/call leaves
      // plenty of headroom and keeps individual transactions bounded for
      // progress observability on very large sessions.
      const COLS_PER_ROW = 11;
      const CHUNK_ROWS = 1_000;
      const all: TranscriptEvent[] = [];
      for (let start = 0; start < events.length; start += CHUNK_ROWS) {
        const slice = events.slice(start, start + CHUNK_ROWS);
        const valueClauses: string[] = [];
        const params: any[] = [];
        for (let i = 0; i < slice.length; i++) {
          const base = i * COLS_PER_ROW;
          const ph: string[] = [];
          for (let c = 1; c <= COLS_PER_ROW; c++) ph.push(`$${base + c}`);
          valueClauses.push(`(${ph.join(', ')})`);
          const e = slice[i];
          params.push(
            e.sessionId,
            e.sequence,
            e.createdAt,
            e.eventType,
            e.searchableText,
            JSON.stringify(e.payload),
            e.parentEventId,
            e.searchable,
            e.subagentId,
            e.provider,
            e.providerToolCallId,
          );
        }

        const sql = `INSERT INTO ai_transcript_events (
            session_id, sequence, created_at, event_type, searchable_text,
            payload, parent_event_id, searchable, subagent_id, provider, provider_tool_call_id
          ) VALUES ${valueClauses.join(', ')}
          RETURNING ${SELECT_COLS}`;

        const { rows } = await db.query<TranscriptEventRow>(sql, params);
        for (const r of rows) all.push(rowToEvent(r));
      }
      return all;
    },

    async updateEventPayload(id, payload): Promise<void> {
      await ensureReady();

      await db.query(
        `UPDATE ai_transcript_events SET payload = $1 WHERE id = $2`,
        [JSON.stringify(payload), id],
      );
    },

    async mergeEventPayload(id, partialPayload): Promise<void> {
      await ensureReady();

      const { rows } = await db.query<{ payload: Record<string, unknown> | string | null }>(
        `SELECT payload FROM ai_transcript_events WHERE id = $1`,
        [id],
      );
      const existingPayload = rows[0]?.payload;
      let normalizedPayload: Record<string, unknown> = {};
      if (typeof existingPayload === 'string') {
        try {
          normalizedPayload = JSON.parse(existingPayload);
        } catch {
          normalizedPayload = {};
        }
      } else if (existingPayload && typeof existingPayload === 'object') {
        normalizedPayload = existingPayload;
      }

      await db.query(
        `UPDATE ai_transcript_events SET payload = $1 WHERE id = $2`,
        [JSON.stringify({ ...normalizedPayload, ...partialPayload }), id],
      );
    },

    async updateEventText(id, searchableText): Promise<void> {
      await ensureReady();

      await db.query(
        `UPDATE ai_transcript_events SET searchable_text = $1 WHERE id = $2`,
        [searchableText, id],
      );
    },

    async getSessionEvents(sessionId, options): Promise<TranscriptEvent[]> {
      await ensureReady();

      const MAX_EVENTS = 50000;
      const limit = options?.limit ? Math.min(options.limit, MAX_EVENTS) : MAX_EVENTS;
      const offset = options?.offset ?? 0;

      const conditions = ['session_id = $1'];
      const params: any[] = [sessionId];

      if (options?.eventTypes && options.eventTypes.length > 0) {
        const placeholders = options.eventTypes.map((_, i) => `$${params.length + i + 1}`).join(', ');
        conditions.push(`event_type IN (${placeholders})`);
        params.push(...options.eventTypes);
      }

      if (options?.createdAfter) {
        params.push(options.createdAfter);
        conditions.push(`created_at >= $${params.length}`);
      }

      if (options?.createdBefore) {
        params.push(options.createdBefore);
        conditions.push(`created_at <= $${params.length}`);
      }

      params.push(limit, offset);
      const sql = `SELECT ${SELECT_COLS}
        FROM ai_transcript_events
        WHERE ${conditions.join(' AND ')}
        ORDER BY sequence ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`;

      const { rows } = await db.query<TranscriptEventRow>(sql, params);
      return rows.map(rowToEvent);
    },

    async getNextSequence(sessionId): Promise<number> {
      await ensureReady();

      const { rows } = await db.query<{ max_seq: number | null }>(
        `SELECT MAX(sequence) as max_seq FROM ai_transcript_events WHERE session_id = $1`,
        [sessionId],
      );

      return (rows[0]?.max_seq ?? -1) + 1;
    },

    async findByProviderToolCallId(providerToolCallId, sessionId): Promise<TranscriptEvent | null> {
      await ensureReady();

      // Order by id DESC to return the most recent event with this tool call ID.
      // Codex recycles IDs across different tool types within a session
      // (e.g., item_5 for both a command_execution and an mcp_tool_call),
      // so multiple events may share the same provider_tool_call_id.
      // The latest one is the event we want to update on completion.
      //
      // Scoped by session_id: Codex's short per-turn item IDs (e.g. item_1)
      // collide across sessions. Without this filter, a matching tool name
      // from a previous session causes processDescriptor to dedupe against
      // that row and skip creating the canonical event in the current
      // session -- which hides the custom tool widget (e.g. git commit
      // proposal) entirely.
      const { rows } = await db.query<TranscriptEventRow>(
        `SELECT ${SELECT_COLS}
          FROM ai_transcript_events
          WHERE provider_tool_call_id = $1 AND session_id = $2
          ORDER BY id DESC
          LIMIT 1`,
        [providerToolCallId, sessionId],
      );

      return rows.length > 0 ? rowToEvent(rows[0]) : null;
    },

    async findActiveToolCallByRawProviderId(rawProviderToolCallId, sessionId): Promise<TranscriptEvent | null> {
      await ensureReady();

      // Match either a legacy event whose provider_tool_call_id equals the
      // raw id directly, or a new event whose provider_tool_call_id is a
      // Codex synthetic edit-group ID derived from the raw id. The synthetic
      // format is `nimtc|<encodeURIComponent(rawId)>|<ts>|<idx>`, so we LIKE
      // against `nimtc|<escapedEncodedRawId>|%`.
      //
      // Status filtering is performed in JS since the payload column is
      // stored as JSON text in some environments.
      const encoded = encodeURIComponent(rawProviderToolCallId);
      const escaped = encoded
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      const synthPattern = `nimtc|${escaped}|%`;

      const { rows } = await db.query<TranscriptEventRow>(
        `SELECT ${SELECT_COLS}
          FROM ai_transcript_events
          WHERE session_id = $1
            AND event_type = 'tool_call'
            AND (provider_tool_call_id = $2 OR provider_tool_call_id LIKE $3 ESCAPE '\\')
          ORDER BY id DESC
          LIMIT 10`,
        [sessionId, rawProviderToolCallId, synthPattern],
      );

      for (const row of rows) {
        const event = rowToEvent(row);
        const status = (event.payload as Record<string, unknown> | undefined)?.status;
        if (status === 'running' || status === 'pending' || status == null) {
          return event;
        }
      }
      return null;
    },

    async getMultiSessionEvents(sessionIds, options): Promise<TranscriptEvent[]> {
      await ensureReady();

      if (sessionIds.length === 0) return [];

      const conditions: string[] = [];
      const params: any[] = [];

      // session_id = ANY($1)
      params.push(sessionIds);
      conditions.push(`session_id = ANY($${params.length}::text[])`);

      if (options?.eventTypes && options.eventTypes.length > 0) {
        const placeholders = options.eventTypes.map((_, i) => `$${params.length + i + 1}`).join(', ');
        conditions.push(`event_type IN (${placeholders})`);
        params.push(...options.eventTypes);
      }

      if (options?.createdAfter) {
        params.push(options.createdAfter);
        conditions.push(`created_at >= $${params.length}`);
      }

      if (options?.createdBefore) {
        params.push(options.createdBefore);
        conditions.push(`created_at <= $${params.length}`);
      }

      const sql = `SELECT ${SELECT_COLS}
        FROM ai_transcript_events
        WHERE ${conditions.join(' AND ')}
        ORDER BY session_id, sequence ASC`;

      const { rows } = await db.query<TranscriptEventRow>(sql, params);
      return rows.map(rowToEvent);
    },

    async searchSessions(query, options): Promise<Array<{ event: TranscriptEvent; sessionId: string }>> {
      await ensureReady();

      const limit = options?.limit ?? 100;

      const sqliteRows = await db.searchTranscriptEvents?.(query, {
        limit,
        sessionIds: options?.sessionIds,
      });
      let rows: TranscriptEventRow[];
      if (sqliteRows) {
        rows = sqliteRows as unknown as TranscriptEventRow[];
      } else {
        let sql: string;
        let params: any[];

        if (options?.sessionIds && options.sessionIds.length > 0) {
          const placeholders = options.sessionIds.map((_, i) => `$${i + 3}`).join(', ');
          sql = `SELECT ${SELECT_COLS}
            FROM ai_transcript_events
            WHERE searchable = TRUE
              AND to_tsvector('english', COALESCE(searchable_text, '')) @@ plainto_tsquery('english', $1)
              AND session_id IN (${placeholders})
            ORDER BY ts_rank_cd(to_tsvector('english', COALESCE(searchable_text, '')), plainto_tsquery('english', $1)) DESC
            LIMIT $2`;
          params = [query, limit, ...options.sessionIds];
        } else {
          sql = `SELECT ${SELECT_COLS}
            FROM ai_transcript_events
            WHERE searchable = TRUE
              AND to_tsvector('english', COALESCE(searchable_text, '')) @@ plainto_tsquery('english', $1)
            ORDER BY ts_rank_cd(to_tsvector('english', COALESCE(searchable_text, '')), plainto_tsquery('english', $1)) DESC
            LIMIT $2`;
          params = [query, limit];
        }

        rows = (await db.query<TranscriptEventRow>(sql, params)).rows;
      }
      return rows.map((row) => ({
        event: rowToEvent(row),
        sessionId: row.session_id,
      }));
    },

    async getTailEvents(sessionId, count, options): Promise<TranscriptEvent[]> {
      await ensureReady();

      const conditions = ['session_id = $1'];
      const params: any[] = [sessionId];

      if (options?.excludeEventTypes && options.excludeEventTypes.length > 0) {
        const placeholders = options.excludeEventTypes.map((_, i) => `$${params.length + i + 1}`).join(', ');
        conditions.push(`event_type NOT IN (${placeholders})`);
        params.push(...options.excludeEventTypes);
      }

      params.push(count);
      const sql = `SELECT ${SELECT_COLS}
        FROM ai_transcript_events
        WHERE ${conditions.join(' AND ')}
        ORDER BY sequence DESC
        LIMIT $${params.length}`;

      const { rows } = await db.query<TranscriptEventRow>(sql, params);
      return rows.map(rowToEvent).reverse();
    },

    async deleteSessionEvents(sessionId): Promise<void> {
      await ensureReady();
      await db.query(`DELETE FROM ai_transcript_events WHERE session_id = $1`, [sessionId]);
    },

    async deleteEventsAtOrAfterSequence(sessionId, sequence): Promise<void> {
      await ensureReady();
      await db.query(
        `DELETE FROM ai_transcript_events WHERE session_id = $1 AND sequence >= $2`,
        [sessionId, sequence],
      );
    },

    async getEventById(id): Promise<TranscriptEvent | null> {
      await ensureReady();

      const { rows } = await db.query<TranscriptEventRow>(
        `SELECT ${SELECT_COLS} FROM ai_transcript_events WHERE id = $1`,
        [id],
      );

      return rows.length > 0 ? rowToEvent(rows[0]) : null;
    },

    async getChildEvents(parentEventId): Promise<TranscriptEvent[]> {
      await ensureReady();

      const { rows } = await db.query<TranscriptEventRow>(
        `SELECT ${SELECT_COLS}
          FROM ai_transcript_events
          WHERE parent_event_id = $1
          ORDER BY sequence ASC`,
        [parentEventId],
      );

      return rows.map(rowToEvent);
    },

    async getSubagentEvents(subagentId, sessionId): Promise<TranscriptEvent[]> {
      await ensureReady();

      const { rows } = await db.query<TranscriptEventRow>(
        `SELECT ${SELECT_COLS}
          FROM ai_transcript_events
          WHERE subagent_id = $1 AND session_id = $2
          ORDER BY sequence ASC`,
        [subagentId, sessionId],
      );

      return rows.map(rowToEvent);
    },
  };
}
