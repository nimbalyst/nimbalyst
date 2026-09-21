import type { CreateAgentMessageInput } from '@nimbalyst/runtime/ai/server/types';
import type { AppDatabase } from '../../database/PGLiteDatabaseWorker';
import type { TransactionStatement } from '../../database/transactionStatements';
import { providerSessionAliases, resolveProviderSessionId } from '../PGLiteSessionStore';
import type { ExternalCursor, ExternalSessionRef } from './types';

export type ExternalSessionIdentity = Pick<ExternalSessionRef, 'providerId' | 'externalId' | 'workspacePath'> & {
  /** Owning workspace for DB/list visibility; workspacePath remains the verified log cwd. */
  workspaceId?: string;
};
export type ExternalFileIdentity = ExternalSessionIdentity & Pick<ExternalSessionRef, 'filePath'>;
export interface ExternalAppendInput {
  ref: ExternalFileIdentity;
  sessionId: string;
  expectedCursor: ExternalCursor | null;
  cursor: ExternalCursor;
  /** Map sourceEntryId to providerMessageId and timestamp to createdAt. */
  messages: Omit<CreateAgentMessageInput, 'sessionId'>[];
}

/** One worker-owned commit for a bounded source batch. The caller serializes session
 * resolve/create and invokes canonical transcript processing only after this resolves.
 * A rejected/timeout commit may already have landed: reload the cursor before retrying.
 * Stable provider message IDs deduplicate rereads; stale cursor snapshots fail closed.
 */
export class ExternalSessionPersistence {
  constructor(
    private readonly db: Pick<AppDatabase, 'query' | 'runTransaction'>,
    private readonly ensureReady: () => Promise<void> = async () => {},
  ) {}

  async resolveSessionId(ref: ExternalSessionIdentity): Promise<string | null> {
    await this.ensureReady();
    return resolveProviderSessionId(this.db, ref.providerId, ref.externalId, ref.workspaceId ?? ref.workspacePath, ref.workspacePath);
  }

  async getCursor(ref: ExternalFileIdentity): Promise<ExternalCursor | null> {
    await this.ensureReady();
    const { rows } = await this.db.query<{ workspace_path: string; session_workspace_id: string; cursor: string | null }>(
      `SELECT c.workspace_path, c.cursor, s.workspace_id AS session_workspace_id FROM external_session_cursors c
       JOIN ai_sessions s ON s.id = c.session_id
       WHERE c.provider = $1 AND c.external_id = $2 AND c.file_path = $3`,
      [ref.providerId, ref.externalId, ref.filePath],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.workspace_path !== ref.workspacePath ||
        (row.session_workspace_id !== (ref.workspaceId ?? ref.workspacePath) && row.session_workspace_id !== ref.workspacePath)) {
      throw new Error('External cursor workspace mismatch');
    }
    if (row.cursor === null) return null;
    return normalizeCursor(JSON.parse(row.cursor) as ExternalCursor);
  }

  async appendAndAdvance(input: ExternalAppendInput): Promise<void> {
    const { ref, sessionId, messages } = input;
    const [canonicalProvider, alias] = providerSessionAliases(ref.providerId);
    const expected = input.expectedCursor === null ? null : encodeCursor(input.expectedCursor);
    const next = encodeCursor(input.cursor);
    const statements: TransactionStatement[] = [
      {
        sql: `SELECT id FROM ai_sessions WHERE id = $1 AND provider IN ($2, $5) AND workspace_id IN ($3, $6)
              AND (provider_session_id = $4 OR (id = $4 AND provider_session_id IS NULL))`,
        params: [sessionId, canonicalProvider, ref.workspaceId ?? ref.workspacePath, ref.externalId, alias, ref.workspacePath],
        expectedRows: 1,
      },
      {
        sql: `INSERT INTO external_session_cursors (provider, external_id, file_path, workspace_path, session_id, cursor)
              VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (provider, external_id, file_path) DO NOTHING`,
        params: [ref.providerId, ref.externalId, ref.filePath, ref.workspacePath, sessionId],
      },
      {
        sql: `UPDATE external_session_cursors SET cursor = $6
              WHERE provider = $1 AND external_id = $2 AND file_path = $3 AND workspace_path = $4 AND session_id = $5
                AND (cursor = $7 OR (cursor IS NULL AND $7 IS NULL)) RETURNING session_id`,
        params: [ref.providerId, ref.externalId, ref.filePath, ref.workspacePath, sessionId, next, expected],
        expectedRows: 1,
      },
    ];
    let latest: Date | undefined;
    for (const message of messages) {
      if (!message.providerMessageId || message.source !== ref.providerId) {
        throw new Error('External message requires stable provider identity and matching source');
      }
      const timestamp = message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt ?? '');
      if (!Number.isFinite(timestamp.getTime())) throw new Error('External message requires a valid source timestamp');
      if (!latest || timestamp > latest) latest = timestamp;
      statements.push({
        sql: `INSERT INTO ai_agent_messages
              (session_id, source, direction, content, metadata, hidden, created_at, provider_message_id, searchable, searchable_text, message_kind)
              SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
              WHERE NOT EXISTS (SELECT 1 FROM ai_agent_messages
                WHERE session_id = $1 AND source IN ($2, $12) AND direction = $3 AND provider_message_id = $8)`,
        params: [sessionId, message.source, message.direction, message.content,
          message.metadata ? JSON.stringify(message.metadata) : null, message.hidden ?? false, timestamp,
          message.providerMessageId, message.searchable ?? false, message.searchableText ?? null, message.messageKind ?? null, alias],
      });
    }
    if (latest) statements.push({
      sql: `UPDATE ai_sessions SET updated_at = $2 WHERE id = $1 AND (updated_at IS NULL OR updated_at < $2)`,
      params: [sessionId, latest],
    });
    await this.ensureReady();
    await this.db.runTransaction(statements);
  }
}

function encodeCursor(cursor: ExternalCursor): string {
  return JSON.stringify(normalizeCursor(cursor));
}

function normalizeCursor(cursor: ExternalCursor): ExternalCursor {
  if (!Number.isSafeInteger(cursor.byteOffset) || cursor.byteOffset < 0 ||
      !Number.isSafeInteger(cursor.fileSize) || cursor.fileSize < cursor.byteOffset ||
      (cursor.inode !== null && (!Number.isSafeInteger(cursor.inode) || cursor.inode < 0)) ||
      (cursor.lastEntryUuid !== null && typeof cursor.lastEntryUuid !== 'string')) {
    throw new Error('Invalid external session cursor');
  }
  // Keep the original four-key JSON unchanged when fallback authority is absent.
  const normalized: ExternalCursor = { byteOffset: cursor.byteOffset, lastEntryUuid: cursor.lastEntryUuid, fileSize: cursor.fileSize, inode: cursor.inode };
  const calls = cursor.codexFallbackCalls;
  if (calls !== undefined) {
    if (!Array.isArray(calls) || calls.length > 512) throw new Error('Invalid Codex fallback call state');
    for (const id of calls) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 512) throw new Error('Invalid Codex fallback call identity');
    }
    if (calls.length > 0) normalized.codexFallbackCalls = [...new Set(calls)].sort();
  }
  // Add new optional keys last so old cursor JSON remains byte-identical.
  if (cursor.contentMarker !== undefined) {
    if (typeof cursor.contentMarker !== 'string' || cursor.contentMarker.length !== 64 || !/^[0-9a-f]{64}$/.test(cursor.contentMarker)) {
      throw new Error('Invalid external cursor content marker');
    }
    normalized.contentMarker = cursor.contentMarker;
  }
  return normalized;
}
