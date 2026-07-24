/**
 * Thin adapters that bridge existing PGLite stores to the interfaces
 * expected by TranscriptTransformer / TranscriptRuntime.
 *
 * Phase 4 of canonical-transcript-deprecation: only the raw-message adapter
 * remains. The metadata adapter was tied to the dropped canonical_transform_*
 * columns on ai_sessions and is no longer needed.
 */

import type { IRawMessageStore, RawMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptTransformer';
import { database } from '../database/PGLiteDatabaseWorker';

// ---------------------------------------------------------------------------
// IRawMessageStore -- wraps ai_agent_messages queries
// ---------------------------------------------------------------------------

export function createRawMessageStoreAdapter(): IRawMessageStore {
  return {
    async getMessages(sessionId: string, afterId?: number): Promise<RawMessage[]> {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      let sql: string;
      let params: any[];

      if (afterId != null) {
        sql = `SELECT id, session_id, source, direction, content, created_at, metadata, hidden
               FROM ai_agent_messages
               WHERE session_id = $1 AND id > $2
               ORDER BY id ASC`;
        params = [sessionId, afterId];
      } else {
        sql = `SELECT id, session_id, source, direction, content, created_at, metadata, hidden
               FROM ai_agent_messages
               WHERE session_id = $1
               ORDER BY id ASC`;
        params = [sessionId];
      }

      const { rows } = await database.query<any>(sql, params);

      return rows.map((row: any) => {
        let metadata = row.metadata;
        if (typeof metadata === 'string') {
          try {
            metadata = JSON.parse(metadata);
          } catch {
            metadata = undefined;
          }
        }

        return {
          id: Number(row.id),
          sessionId: row.session_id,
          source: row.source,
          direction: row.direction,
          content: row.content,
          createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
          metadata: metadata ?? undefined,
          hidden: row.hidden ?? false,
        };
      });
    },
  };
}

