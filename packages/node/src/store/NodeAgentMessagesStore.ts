/**
 * `AgentMessagesStore` over Node-ABI better-sqlite3.
 *
 * `ai_agent_messages` is the sole source of truth for a transcript, so this is
 * the store that decides whether a headless turn is durable. Two invariants
 * carried over from the desktop implementation:
 *
 *  - `createdAt` is REQUIRED and must come from the message's source. The
 *    provider stamps it so a row, the session's `updated_at` and any later sync
 *    index all agree on one timestamp.
 *  - the insert and the session's `updated_at` bump are one transaction, and the
 *    session is un-archived by the same write.
 */

import type { Database as SqliteDatabase } from 'better-sqlite3';
import type {
  AgentMessagesStore,
} from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import type { AgentMessage, CreateAgentMessageInput } from '@nimbalyst/runtime/ai/server/types';
import { fromBool, parseJsonColumn, toBool, toIsoText } from './columns.js';

type Row = Record<string, unknown>;

/** Guard against a corrupted session loading unboundedly into memory. */
const MAX_MESSAGES = 50_000;

const SELECT_COLUMNS = `
  id, session_id, created_at, source, direction, content, metadata, hidden,
  provider_message_id
`;

function toAgentMessage(row: Row): AgentMessage {
  return {
    id: Number(row.id),
    sessionId: row.session_id as string,
    createdAt: row.created_at ? new Date(row.created_at as string) : undefined,
    source: row.source as AgentMessage['source'],
    direction: row.direction as AgentMessage['direction'],
    content: row.content as string,
    metadata: (parseJsonColumn(row.metadata) as AgentMessage['metadata']) ?? undefined,
    hidden: toBool(row.hidden),
    providerMessageId: (row.provider_message_id as string) ?? undefined,
  } as AgentMessage;
}

function requireCreatedAt(message: CreateAgentMessageInput): Date {
  if (!message.createdAt) {
    throw new Error(
      'message.createdAt is required - timestamp must originate from message source',
    );
  }
  return message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt);
}

export function createNodeAgentMessagesStore(db: SqliteDatabase): AgentMessagesStore {
  const insert = db.prepare(`
    INSERT INTO ai_agent_messages (
      session_id, source, direction, content, metadata, hidden, created_at,
      provider_message_id, searchable, searchable_text, message_kind
    ) VALUES (
      @sessionId, @source, @direction, @content, @metadata, @hidden, @createdAt,
      @providerMessageId, @searchable, @searchableText, @messageKind
    )
  `);

  const touchSession = db.prepare(
    'UPDATE ai_sessions SET updated_at = ?, is_archived = 0 WHERE id = ?',
  );

  const bindings = (message: CreateAgentMessageInput) => {
    const createdAt = requireCreatedAt(message);
    return {
      sessionId: message.sessionId,
      source: message.source,
      direction: message.direction,
      content: message.content,
      metadata: message.metadata ? JSON.stringify(message.metadata) : null,
      hidden: fromBool(message.hidden),
      createdAt: toIsoText(createdAt),
      providerMessageId: message.providerMessageId ?? null,
      searchable: fromBool(message.searchable),
      searchableText: message.searchableText ?? null,
      messageKind: message.messageKind ?? null,
      _createdAt: createdAt,
    };
  };

  const writeBatch = db.transaction((messages: CreateAgentMessageInput[]) => {
    const latestPerSession = new Map<string, Date>();

    for (const message of messages) {
      const bound = bindings(message);
      const { _createdAt, ...columns } = bound;
      insert.run(columns);

      const previous = latestPerSession.get(message.sessionId);
      if (!previous || _createdAt.getTime() > previous.getTime()) {
        latestPerSession.set(message.sessionId, _createdAt);
      }
    }

    // One UPDATE per affected session, not per message.
    for (const [sessionId, timestamp] of latestPerSession) {
      touchSession.run(toIsoText(timestamp), sessionId);
    }
  });

  return {
    async create(message: CreateAgentMessageInput): Promise<void> {
      writeBatch([message]);
    },

    async createMany(messages: CreateAgentMessageInput[]): Promise<void> {
      if (messages.length === 0) return;
      writeBatch(messages);
    },

    async list(
      sessionId: string,
      options?: { limit?: number; offset?: number; includeHidden?: boolean },
    ): Promise<AgentMessage[]> {
      const limit = options?.limit ? Math.min(options.limit, MAX_MESSAGES) : MAX_MESSAGES;
      const offset = options?.offset ?? 0;
      const hiddenFilter = options?.includeHidden ? '' : 'AND hidden = 0';

      const rows = db.prepare(`
        SELECT ${SELECT_COLUMNS}
        FROM ai_agent_messages
        WHERE session_id = ? ${hiddenFilter}
        ORDER BY id ASC
        LIMIT ? OFFSET ?
      `).all(sessionId, limit, offset) as Row[];

      if (rows.length >= MAX_MESSAGES) {
        console.warn(
          `[NodeAgentMessagesStore] session ${sessionId} has ${rows.length}+ messages `
          + `(capped at ${MAX_MESSAGES})`,
        );
      }

      return rows.map(toAgentMessage);
    },

    async listTail(
      sessionId: string,
      limit: number,
      options?: { includeHidden?: boolean },
    ): Promise<AgentMessage[]> {
      const bounded = Math.max(1, Math.min(limit, MAX_MESSAGES));
      const hiddenFilter = options?.includeHidden ? '' : 'AND hidden = 0';

      const rows = db.prepare(`
        SELECT ${SELECT_COLUMNS} FROM (
          SELECT ${SELECT_COLUMNS}
          FROM ai_agent_messages
          WHERE session_id = ? ${hiddenFilter}
          ORDER BY id DESC
          LIMIT ?
        )
        ORDER BY id ASC
      `).all(sessionId, bounded) as Row[];

      return rows.map(toAgentMessage);
    },

    async getMessageCounts(sessionIds: string[]): Promise<Map<string, number>> {
      const counts = new Map<string, number>();
      if (sessionIds.length === 0) return counts;

      const placeholders = sessionIds.map(() => '?').join(', ');
      const rows = db.prepare(`
        SELECT session_id, COUNT(*) AS count
        FROM ai_agent_messages
        WHERE session_id IN (${placeholders})
        GROUP BY session_id
      `).all(...sessionIds) as Array<{ session_id: string; count: number }>;

      for (const row of rows) counts.set(row.session_id, Number(row.count));
      return counts;
    },
  };
}
