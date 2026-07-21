/**
 * SQLiteStoreAdapter
 *
 * Drop-in replacement for the `{ query(sql, params) }` adapter the PGLite
 * stores consume. It runs every SQL statement through the PG -> SQLite
 * dialect translator before handing it to `SQLiteDatabase`.
 *
 * This lets us keep the existing 3.7k lines of PGLite store code unchanged
 * for the bulk of their SQL. Calls that need FTS or other irreducible
 * PG-only constructs (jsonb_array_elements_text, EXTRACT(... FROM
 * timestamp + INTERVAL ...)) must be refactored at the callsite to use
 * one of the helper methods on this adapter -- they are NOT silently
 * translated.
 *
 * See dialectTranslator.ts for the exact rewrite set.
 */

import type { SQLiteDatabase } from './SQLiteDatabase';
import type { SQLiteDatabaseProxy } from './SQLiteDatabaseProxy';

/**
 * Either the in-process SQLiteDatabase (tests) or the worker-hosted proxy
 * (production). Both expose the same async `query<T>(sql, params)` surface
 * the dialect translator + FTS helpers need.
 */
type AnySqlite = SQLiteDatabase | SQLiteDatabaseProxy;

interface ResultBearingTransactionDatabase {
  runTransaction<T = unknown>(
    statements: StoreDbTransactionStatement[],
  ): Promise<Array<{ rows: T[] }>>;
}

export interface StoreDbTransactionStatement {
  sql: string;
  params?: unknown[];
  /** Exactly-one-row CAS guard. Enforced by the native transaction callback. */
  expectedRowCount?: 1;
}

export interface SQLiteStoreAdapterOptions {
  /**
   * Optional logger for translation warnings (e.g. "saw FTS construct that
   * the translator can't handle; callsite needs to use searchSessions").
   */
  log?: (level: 'warn' | 'info', msg: string, meta?: unknown) => void;
}

/**
 * The shape every PGLite store expects from its `dbAdapter`:
 *   { query<T>(sql, params?): Promise<{ rows: T[] }> }
 *
 * Plus dialect-specific helpers callsites must use directly when the
 * translator can't fold them in.
 */
export interface StoreDbAdapter {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;

  /**
   * Execute an ordered statement batch in the backend's native transaction
   * and retain each statement's rows. This is intentionally a statement-array
   * API rather than the PGLite callback-style transaction helper: it has the
   * same atomic semantics on the SQLite and PGLite worker backends.
   */
  transaction<T = unknown>(
    statements: StoreDbTransactionStatement[],
  ): Promise<Array<{ rows: T[] }>>;

  /**
   * Full-text search over `ai_agent_messages.content`. Returns ranked
   * `(id, rank)` rows. PGLite implementation uses `to_tsvector / @@`;
   * SQLite implementation uses the `ai_agent_messages_fts` virtual table.
   * Callsites that previously embedded this inline must call this helper.
   */
  searchAgentMessages?(
    query: string,
    opts?: { limit?: number },
  ): Promise<Array<{ id: number; rank: number }>>;

  /**
   * Full-text search over `ai_agent_messages.searchable_text`, grouped by
   * session. Returns `(session_id, rank)` rows. Mirror of `searchAgentMessages`.
   *
   * The `eventType` filter is a legacy alias: `user_message` -> message_kind
   * `user`, `assistant_message` -> message_kind `assistant`, null -> the
   * default `user|assistant|system` set.
   */
  searchTranscriptEventSessions?(
    query: string,
    opts?: {
      limit?: number;
      sessionIds?: string[];
      eventType?: 'user_message' | 'assistant_message' | null;
      cutoffDate?: Date | null;
    },
  ): Promise<Array<{ session_id: string; rank: number }>>;

  searchTranscriptEvents?(
    query: string,
    opts?: {
      limit?: number;
      sessionIds?: string[];
    },
  ): Promise<Array<Record<string, unknown>>>;

  /**
   * Full-text search over session titles. Returns `(session_id, rank)`.
   */
  searchSessionTitles?(
    workspaceId: string,
    query: string,
    opts?: { includeArchived?: boolean },
  ): Promise<Array<{ session_id: string; rank: number }>>;
}

/**
 * Wrap a SQLiteDatabase so it looks like the PGLite dbAdapter the stores
 * already consume. Every `query()` call goes through the dialect translator.
 */
export function createSQLiteStoreAdapter(
  db: AnySqlite,
  _opts: SQLiteStoreAdapterOptions = {},
): StoreDbAdapter {
  return {
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      // SQLiteDatabase.adaptSqlForSQLite handles dialect translation
      // internally via dialectTranslator. This adapter is a thin pass-through
      // whose value is the FTS helpers below, not query rewriting.
      return db.query<T>(sql, params);
    },

    async transaction<T = unknown>(
      statements: StoreDbTransactionStatement[],
    ): Promise<Array<{ rows: T[] }>> {
      const resultBearingDb: ResultBearingTransactionDatabase = db;
      return resultBearingDb.runTransaction<T>(statements);
    },

    async searchAgentMessages(query, opts) {
      const limit = opts?.limit ?? 100;
      // FTS5 MATCH against the shadow table. `rowid` corresponds to
      // `ai_agent_messages.id` because we set content_rowid='id'.
      const { rows } = await db.query<{ id: number; rank: number }>(
        `SELECT rowid AS id, bm25(ai_agent_messages_fts) AS rank
         FROM ai_agent_messages_fts
         WHERE ai_agent_messages_fts MATCH $q
         ORDER BY rank
         LIMIT $lim`,
        [{ q: query, lim: limit }],
      );
      return rows;
    },

    async searchTranscriptEventSessions(query, opts) {
      const limit = opts?.limit ?? 100;
      // Phase 2 of canonical-transcript-deprecation: search is now served by
      // `ai_agent_messages_fts` over the extracted `searchable_text` column.
      // The legacy event_type filter (`user_message` / `assistant_message`)
      // is mapped to the new `message_kind` classification.
      const binds: Record<string, unknown> = { q: query, lim: limit };
      const extra: string[] = [];

      if (opts?.sessionIds && opts.sessionIds.length > 0) {
        const placeholders = opts.sessionIds.map((_, i) => `$sid${i}`).join(', ');
        extra.push(`t.session_id IN (${placeholders})`);
        opts.sessionIds.forEach((id, i) => {
          binds[`sid${i}`] = id;
        });
      }
      if (opts?.eventType === 'user_message') {
        extra.push(`t.message_kind = 'user'`);
      } else if (opts?.eventType === 'assistant_message') {
        extra.push(`t.message_kind = 'assistant'`);
      } else {
        extra.push(`t.message_kind IN ('user', 'assistant', 'system')`);
      }
      if (opts?.cutoffDate) {
        binds.cutoff = opts.cutoffDate.toISOString();
        extra.push('t.created_at >= $cutoff');
      }

      const sql = `SELECT t.session_id,
                          MIN(fts.rank) AS rank
                   FROM (
                     SELECT rowid, rank
                     FROM ai_agent_messages_fts
                     WHERE ai_agent_messages_fts MATCH $q
                   ) AS fts
                   JOIN ai_agent_messages AS t ON t.id = fts.rowid
                   WHERE ${extra.length > 0 ? extra.join(' AND ') : '1=1'}
                   GROUP BY t.session_id
                   ORDER BY rank
                   LIMIT $lim`;
      const { rows } = await db.query<{ session_id: string; rank: number }>(sql, [binds]);
      return rows;
    },

    async searchTranscriptEvents(query, opts) {
      const limit = opts?.limit ?? 100;
      // Phase 2: the on-disk derived events table is going away. This helper
      // now returns ai_agent_messages rows whose searchable_text matches and
      // whose message_kind is a user-visible kind. Callers re-derive
      // canonical events from the in-memory runtime if they need them.
      const binds: Record<string, unknown> = { q: query, lim: limit };
      const extra: string[] = [`t.message_kind IN ('user', 'assistant', 'system')`];

      if (opts?.sessionIds && opts.sessionIds.length > 0) {
        const placeholders = opts.sessionIds.map((_, i) => `$sid${i}`).join(', ');
        extra.push(`t.session_id IN (${placeholders})`);
        opts.sessionIds.forEach((id, i) => {
          binds[`sid${i}`] = id;
        });
      }

      const sql = `SELECT t.id, t.session_id, t.created_at, t.source, t.direction,
                          t.content, t.metadata, t.hidden, t.searchable_text, t.message_kind
                   FROM (
                     SELECT rowid, rank
                     FROM ai_agent_messages_fts
                     WHERE ai_agent_messages_fts MATCH $q
                   ) AS fts
                   JOIN ai_agent_messages AS t ON t.id = fts.rowid
                   WHERE ${extra.length > 0 ? extra.join(' AND ') : '1=1'}
                   ORDER BY fts.rank
                   LIMIT $lim`;
      const { rows } = await db.query<Record<string, unknown>>(sql, [binds]);
      return rows;
    },

    async searchSessionTitles(workspaceId, query, opts) {
      // ai_sessions doesn't have an FTS5 mirror in the current schema (the
      // GIN(to_tsvector(title)) PG index doesn't have a direct SQLite
      // counterpart since titles are short). We fall back to LIKE-based
      // search; the PG implementation also LOWERs and rank_cd's by token
      // overlap, so this is a behavioral diff: SQLite gives substring
      // matches without ranking. Acceptable for short titles.
      const includeArchived = opts?.includeArchived ?? false;
      const archiveClause = includeArchived
        ? ''
        : `AND (s.is_archived = 0 OR s.is_archived IS NULL)
           AND (s.worktree_id IS NULL OR w.is_archived = 0 OR w.is_archived IS NULL)`;
      const sql = `SELECT s.id AS session_id, 1.0 AS rank
                   FROM ai_sessions AS s
                   LEFT JOIN worktrees AS w ON s.worktree_id = w.id
                   WHERE s.workspace_id = $wid
                     AND LOWER(COALESCE(s.title, '')) LIKE $needle
                     ${archiveClause}`;
      const { rows } = await db.query<{ session_id: string; rank: number }>(sql, [
        { wid: workspaceId, needle: `%${query.toLowerCase()}%` },
      ]);
      return rows;
    },
  };
}
