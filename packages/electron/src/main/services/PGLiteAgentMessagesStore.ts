/**
 * PGLite implementation of AgentMessagesStore interface from runtime package
 */

import type {
  AgentMessage,
  CreateAgentMessageInput,
} from '@nimbalyst/runtime';
import type { AgentMessagesStore } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';

type PGliteLike = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  runTransaction?(statements: Array<{ sql: string; params?: any[] }>): Promise<void>;
};

type Statement = { sql: string; params: any[] };

/**
 * Run INSERT + session UPDATEs as one atomic unit.
 *
 * Prefer the adapter's `runTransaction`: it ships every statement to the
 * database worker in ONE request, so the batch either committed, did not
 * commit, or (reply lost) has an unknown outcome -- never half-written.
 *
 * The BEGIN/COMMIT fallback is only atomic on PGLite. On SQLite those are
 * no-ops and each statement is its own worker request, so an INSERT can
 * commit before a later UPDATE fails; with the queue's per-row fallback that
 * duplicated rows (GitHub #1988 investigation reproduced 4 rows from 2
 * inputs).
 */
async function writeAtomically(db: PGliteLike, statements: Statement[]): Promise<void> {
  if (db.runTransaction) {
    await db.runTransaction(statements);
    return;
  }
  await db.query('BEGIN', []);
  try {
    for (const statement of statements) {
      await db.query(statement.sql, statement.params);
    }
    await db.query('COMMIT', []);
  } catch (error) {
    try {
      await db.query('ROLLBACK', []);
    } catch (rollbackError) {
      // Keep the original failure: a cleanup error (e.g. the worker already
      // gone) must not replace the cause the caller classifies on.
      console.warn('[PGLiteAgentMessagesStore] ROLLBACK failed after write error:', rollbackError);
    }
    throw error;
  }
}

const INSERT_COLUMNS = `INSERT INTO ai_agent_messages (
            session_id, source, direction, content, metadata, hidden, created_at, provider_message_id, searchable,
            searchable_text, message_kind
          )`;

const UPDATE_SESSION_SQL = `UPDATE ai_sessions SET updated_at = $2, is_archived = FALSE WHERE id = $1`;

type EnsureReadyFn = () => Promise<void>;

export function createPGLiteAgentMessagesStore(db: PGliteLike, ensureDbReady?: EnsureReadyFn): AgentMessagesStore {
  const ensureReady = async () => {
    if (!ensureDbReady) return;
    try {
      await ensureDbReady();
    } catch (error) {
      // Readiness failed before any write was sent, so the write provably did
      // not happen. Tag it so AgentMessageWriteQueue holds and retries the
      // batch instead of discarding it (GitHub #1988). Same string as
      // DB_REQUEST_NOT_SUBMITTED in SQLiteDatabaseProxy / AgentMessageWriteQueue.
      const tagged = new Error(
        `Database not ready: ${error instanceof Error ? error.message : String(error)}`,
      ) as Error & { code?: string; cause?: unknown };
      tagged.code = 'DB_REQUEST_NOT_SUBMITTED';
      tagged.cause = error;
      throw tagged;
    }
  };

  return {
    async create(message: CreateAgentMessageInput): Promise<void> {
      await ensureReady();

      // REQUIRE createdAt - it must come from the source (AIProvider)
      // This ensures sync timestamps match exactly
      if (!message.createdAt) {
        throw new Error('message.createdAt is required - timestamp must originate from message source');
      }

      const timestamp = message.createdAt instanceof Date
        ? message.createdAt
        : new Date(message.createdAt);

      // Insert the message and update the session's updated_at to the SAME
      // timestamp, so local DB and sync agree. Sending a new message also
      // unarchives the session: the user wants to continue the conversation.
      await writeAtomically(db, [
        {
          sql: `${INSERT_COLUMNS} VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
          )`,
          params: [
            message.sessionId,
            message.source,
            message.direction,
            message.content,
            message.metadata ? JSON.stringify(message.metadata) : null,
            message.hidden ?? false,
            timestamp,
            message.providerMessageId ?? null,
            message.searchable ?? false,
            message.searchableText ?? null,
            message.messageKind ?? null,
          ],
        },
        { sql: UPDATE_SESSION_SQL, params: [message.sessionId, timestamp] },
      ]);
    },

    async createMany(messages: CreateAgentMessageInput[]): Promise<void> {
      if (messages.length === 0) return;
      await ensureReady();

      // Build a single multi-row INSERT plus one UPDATE per affected session, all
      // inside one transaction. This is the writer-lock-friendly path used by
      // AgentMessageWriteQueue to coalesce the chunk firehose. See plan
      // `nimbalyst-local/plans/agent-message-write-coalescing.md`.

      const rowPlaceholders: string[] = [];
      const rowValues: any[] = [];
      let paramIdx = 1;

      // Track the latest timestamp per session so we can UPDATE ai_sessions.updated_at
      // to the most recent message's timestamp (matching the single-row create() semantics).
      const latestPerSession = new Map<string, Date>();

      for (const message of messages) {
        if (!message.createdAt) {
          throw new Error('message.createdAt is required - timestamp must originate from message source');
        }
        const timestamp = message.createdAt instanceof Date
          ? message.createdAt
          : new Date(message.createdAt);

        rowPlaceholders.push(
          `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}, $${paramIdx + 9}, $${paramIdx + 10})`
        );
        rowValues.push(
          message.sessionId,
          message.source,
          message.direction,
          message.content,
          message.metadata ? JSON.stringify(message.metadata) : null,
          message.hidden ?? false,
          timestamp,
          message.providerMessageId ?? null,
          message.searchable ?? false,
          message.searchableText ?? null,
          message.messageKind ?? null,
        );
        paramIdx += 11;

        const prev = latestPerSession.get(message.sessionId);
        if (!prev || timestamp.getTime() > prev.getTime()) {
          latestPerSession.set(message.sessionId, timestamp);
        }
      }

      // One UPDATE per affected session. Six concurrent sessions => six UPDATEs,
      // not 200.
      const statements: Statement[] = [
        { sql: `${INSERT_COLUMNS} VALUES ${rowPlaceholders.join(', ')}`, params: rowValues },
      ];
      for (const [sessionId, timestamp] of latestPerSession) {
        statements.push({ sql: UPDATE_SESSION_SQL, params: [sessionId, timestamp] });
      }
      await writeAtomically(db, statements);
    },

    async list(sessionId: string, options?: { limit?: number; offset?: number; includeHidden?: boolean }): Promise<AgentMessage[]> {
      await ensureReady();

      // Safeguard: limit maximum messages loaded to prevent OOM from corrupted sessions
      const MAX_MESSAGES = 50000;
      const limit = options?.limit ? Math.min(options.limit, MAX_MESSAGES) : MAX_MESSAGES;
      const offset = options?.offset ?? 0;
      const includeHidden = options?.includeHidden ?? false;

      const query = `SELECT id, session_id, created_at, source, direction, content, metadata, hidden, provider_message_id
         FROM ai_agent_messages
         WHERE session_id = $1${includeHidden ? '' : ' AND hidden = FALSE'}
         ORDER BY id ASC
         LIMIT $2 OFFSET $3`;

      const params: any[] = [sessionId, limit, offset];
      const { rows } = await db.query<any>(query, params);

      // Log warning if we hit the limit (indicates potential corruption)
      if (rows.length >= MAX_MESSAGES) {
        console.warn(`[PGLiteAgentMessagesStore.list] WARNING: Session ${sessionId} has ${rows.length}+ messages (capped at ${MAX_MESSAGES}). May indicate sync corruption.`);
      }

      return rows.map(row => {
        // Parse metadata if it's a string (JSONB may come back as string or object)
        let metadata = row.metadata;
        if (typeof metadata === 'string') {
          try {
            metadata = JSON.parse(metadata);
          } catch {
            // Keep as string if parsing fails
          }
        }

        return {
          id: Number(row.id),
          sessionId: row.session_id,
          createdAt: row.created_at ? new Date(row.created_at) : undefined,
          source: row.source,
          direction: row.direction,
          content: row.content,
          metadata: metadata ?? undefined,
          hidden: row.hidden ?? false,
          providerMessageId: row.provider_message_id ?? undefined,
        };
      });
    },

    async listTail(sessionId: string, limit: number, options?: { includeHidden?: boolean }): Promise<AgentMessage[]> {
      await ensureReady();

      const boundedLimit = Math.max(1, Math.min(limit, 50000));
      const includeHidden = options?.includeHidden ?? false;
      const { rows } = await db.query<any>(
        `SELECT id, session_id, created_at, source, direction, content, metadata, hidden, provider_message_id
         FROM (
           SELECT id, session_id, created_at, source, direction, content, metadata, hidden, provider_message_id
           FROM ai_agent_messages
           WHERE session_id = $1${includeHidden ? '' : ' AND hidden = FALSE'}
           ORDER BY id DESC
           LIMIT $2
         ) tail
         ORDER BY id ASC`,
        [sessionId, boundedLimit],
      );

      return rows.map(row => {
        let metadata = row.metadata;
        if (typeof metadata === 'string') {
          try {
            metadata = JSON.parse(metadata);
          } catch {
            // Keep as string if parsing fails
          }
        }

        return {
          id: Number(row.id),
          sessionId: row.session_id,
          createdAt: row.created_at ? new Date(row.created_at) : undefined,
          source: row.source,
          direction: row.direction,
          content: row.content,
          metadata: metadata ?? undefined,
          hidden: row.hidden ?? false,
          providerMessageId: row.provider_message_id ?? undefined,
        };
      });
    },
  };
}
