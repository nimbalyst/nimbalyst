/**
 * `SessionStore` over Node-ABI better-sqlite3.
 *
 * The desktop app's `PGLiteSessionStore` writes Postgres-dialect SQL through a
 * translation adapter, because it has to serve both backends. This one only ever
 * talks to SQLite, so it is written in SQLite's own dialect against the same
 * tables. That is a deliberate divergence in the SQL, not in the schema: the
 * DDL is shared (see `db/migrations.ts`), so both hosts read and write the same
 * database file.
 *
 * Two behaviours are load-bearing and copied on purpose:
 *
 *  - `updateMetadata` shallow-MERGES the `metadata` JSON blob and refuses a
 *    non-object payload outright. A string slipping through spreads to
 *    char-by-char numeric keys and re-corrupts on every write.
 *  - `updateMetadata` does NOT touch `updated_at`. That column tracks the last
 *    message, not the last edit, and the session list sorts on it.
 */

import type { Database as SqliteDatabase } from 'better-sqlite3';
import type {
  CreateSessionPayload,
  SessionListOptions,
  SessionMeta,
  SessionSearchOptions,
  SessionStore,
  UpdateSessionMetadataPayload,
} from '@nimbalyst/runtime/ai/adapters/sessionStore';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import {
  fromBool,
  parseJsonColumn,
  parseJsonObjectColumn,
  toBool,
  toIsoText,
  toJsonColumn,
  toMillis,
} from './columns.js';

type Row = Record<string, unknown>;

const SESSION_COLUMNS = `
  s.id, s.workspace_id, s.file_path, s.provider, s.model, s.title, s.session_type,
  s.agent_role, s.created_by_session_id, s.document_context, s.provider_config,
  s.provider_session_id, s.draft_input, s.metadata, s.last_read_timestamp,
  s.has_been_named, s.mode, s.is_archived, s.last_document_state, s.worktree_id,
  s.is_pinned, s.parent_session_id, s.branched_from_session_id,
  s.branch_point_message_id, s.branched_at, s.created_at, s.updated_at
`;

function archiveFilter(includeArchived: boolean): string {
  if (includeArchived) return '';
  return `AND s.is_archived = 0
          AND (s.worktree_id IS NULL OR w.is_archived = 0 OR w.is_archived IS NULL)`;
}

function toSessionData(row: Row): SessionData {
  return {
    id: row.id as string,
    provider: row.provider as string,
    model: (row.model as string) ?? undefined,
    sessionType: (row.session_type as SessionData['sessionType']) ?? undefined,
    mode: (row.mode as SessionData['mode']) ?? undefined,
    agentRole: (row.agent_role as SessionData['agentRole']) ?? 'standard',
    title: (row.title as string) ?? undefined,
    draftInput: (row.draft_input as string) ?? undefined,
    // Transcript rows live in ai_agent_messages; SessionManager loads them separately.
    messages: [],
    workspacePath: row.workspace_id as string,
    worktreeId: (row.worktree_id as string) ?? undefined,
    worktreePath: (row.worktree_path as string) ?? undefined,
    worktreeProjectPath: (row.worktree_project_path as string) ?? undefined,
    parentSessionId: (row.parent_session_id as string) ?? null,
    createdBySessionId: (row.created_by_session_id as string) ?? null,
    createdAt: toMillis(row.created_at)!,
    updatedAt: toMillis(row.updated_at)!,
    metadata: parseJsonObjectColumn(row.metadata),
    documentContext: parseJsonColumn(row.document_context) as SessionData['documentContext'],
    providerConfig: parseJsonColumn(row.provider_config) as SessionData['providerConfig'],
    providerSessionId: (row.provider_session_id as string) ?? undefined,
    lastReadMessageTimestamp: toMillis(row.last_read_timestamp),
    hasBeenNamed: toBool(row.has_been_named),
    isArchived: toBool(row.is_archived),
    isPinned: toBool(row.is_pinned),
    branchedFromSessionId: (row.branched_from_session_id as string) ?? undefined,
    branchPointMessageId: row.branch_point_message_id != null
      ? Number(row.branch_point_message_id)
      : undefined,
    branchedAt: toMillis(row.branched_at),
    branchedFromProviderSessionId:
      (row.branched_from_provider_session_id as string) ?? undefined,
    lastDocumentState: parseJsonColumn(row.last_document_state) as
      SessionData['lastDocumentState'],
  } satisfies SessionData;
}

function toSessionMeta(row: Row): SessionMeta {
  const metadata = parseJsonObjectColumn(row.metadata);
  return {
    id: row.id as string,
    provider: row.provider as string,
    model: (row.model as string) ?? undefined,
    sessionType: (row.session_type as SessionMeta['sessionType']) ?? 'session',
    mode: (row.mode as SessionMeta['mode']) ?? undefined,
    agentRole: (row.agent_role as SessionMeta['agentRole']) ?? 'standard',
    title: (row.title as string) || 'Untitled Session',
    workspaceId: row.workspace_id as string,
    worktreeId: (row.worktree_id as string) ?? null,
    parentSessionId: (row.parent_session_id as string) ?? null,
    createdBySessionId: (row.created_by_session_id as string) ?? null,
    childCount: Number(row.child_count ?? 0),
    uncommittedCount: 0,
    createdAt: toMillis(row.created_at)!,
    updatedAt: toMillis(row.effective_updated_at ?? row.updated_at)!,
    // Not computed in the list query; the desktop store omits it for the same reason.
    messageCount: 0,
    isArchived: toBool(row.is_archived),
    isPinned: toBool(row.is_pinned),
    branchedFromSessionId: (row.branched_from_session_id as string) ?? undefined,
    branchPointMessageId: row.branch_point_message_id != null
      ? Number(row.branch_point_message_id)
      : undefined,
    branchedAt: toMillis(row.branched_at),
    hasUnread: metadata.hasUnread === true,
    hasPendingInteractivePrompt: metadata.hasPendingPrompt === true,
    phase: typeof metadata.phase === 'string' ? metadata.phase : undefined,
    tags: Array.isArray(metadata.tags) ? (metadata.tags as string[]) : undefined,
    linkedTrackerItemIds: Array.isArray(metadata.linkedTrackerItemIds)
      ? (metadata.linkedTrackerItemIds as string[])
      : undefined,
  } satisfies SessionMeta;
}

export function createNodeSessionStore(db: SqliteDatabase): SessionStore {
  return {
    async ensureReady(): Promise<void> {
      // The database is opened and migrated before the store is constructed;
      // there is no lazy-init worker to wait on the way Electron has.
    },

    async create(payload: CreateSessionPayload): Promise<void> {
      const now = Date.now();
      const createdAt = toIsoText(payload.createdAt ?? now);
      const updatedAt = toIsoText(payload.updatedAt ?? now);

      db.prepare(`
        INSERT INTO ai_sessions (
          id, workspace_id, file_path, worktree_id, parent_session_id, provider, model,
          title, session_type, mode, agent_role, created_by_session_id,
          document_context, provider_config, provider_session_id, draft_input, metadata,
          has_been_named, created_at, updated_at,
          branched_from_session_id, branch_point_message_id, branched_at
        ) VALUES (
          @id, @workspaceId, @filePath, @worktreeId, @parentSessionId, @provider, @model,
          @title, @sessionType, @mode, @agentRole, @createdBySessionId,
          @documentContext, @providerConfig, @providerSessionId, @draftInput, @metadata,
          @hasBeenNamed, @createdAt, @updatedAt,
          @branchedFromSessionId, @branchPointMessageId, @branchedAt
        )
        ON CONFLICT (id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          file_path = excluded.file_path,
          worktree_id = excluded.worktree_id,
          parent_session_id = excluded.parent_session_id,
          provider = excluded.provider,
          model = excluded.model,
          title = excluded.title,
          session_type = excluded.session_type,
          mode = excluded.mode,
          agent_role = excluded.agent_role,
          created_by_session_id = excluded.created_by_session_id,
          document_context = excluded.document_context,
          provider_config = excluded.provider_config,
          provider_session_id = excluded.provider_session_id,
          draft_input = excluded.draft_input,
          metadata = excluded.metadata,
          has_been_named = excluded.has_been_named,
          updated_at = excluded.updated_at,
          branched_from_session_id = excluded.branched_from_session_id,
          branch_point_message_id = excluded.branch_point_message_id,
          branched_at = excluded.branched_at
      `).run({
        id: payload.id,
        workspaceId: payload.workspaceId,
        filePath: payload.filePath ?? null,
        worktreeId: payload.worktreeId ?? null,
        parentSessionId: payload.parentSessionId ?? null,
        provider: payload.provider,
        model: payload.model ?? null,
        title: payload.title ?? 'New conversation',
        sessionType: payload.sessionType ?? 'session',
        mode: payload.mode ?? 'agent',
        agentRole: payload.agentRole ?? 'standard',
        createdBySessionId: payload.createdBySessionId ?? null,
        documentContext: toJsonColumn(payload.documentContext),
        providerConfig: toJsonColumn(payload.providerConfig),
        providerSessionId: payload.providerSessionId ?? null,
        draftInput: null,
        metadata: toJsonColumn((payload as { metadata?: unknown }).metadata ?? {}),
        hasBeenNamed: fromBool((payload as { hasBeenNamed?: boolean }).hasBeenNamed),
        createdAt,
        updatedAt,
        branchedFromSessionId: payload.branchedFromSessionId ?? null,
        branchPointMessageId: payload.branchPointMessageId ?? null,
        branchedAt: payload.branchedAt ? toIsoText(payload.branchedAt) : null,
      });
    },

    async updateMetadata(
      sessionId: string,
      update: UpdateSessionMetadataPayload,
    ): Promise<void> {
      const assignments: string[] = [];
      const params: Record<string, unknown> = { id: sessionId };

      const set = (column: string, key: string, value: unknown) => {
        assignments.push(`${column} = @${key}`);
        params[key] = value;
      };

      if (update.provider !== undefined) set('provider', 'provider', update.provider);
      if (update.model !== undefined) set('model', 'model', update.model ?? null);
      if (update.title !== undefined) set('title', 'title', update.title ?? 'New conversation');
      if (update.sessionType !== undefined) set('session_type', 'sessionType', update.sessionType);
      if (update.mode !== undefined) set('mode', 'mode', update.mode);
      if (update.agentRole !== undefined) set('agent_role', 'agentRole', update.agentRole);
      if (update.createdBySessionId !== undefined) {
        set('created_by_session_id', 'createdBySessionId', update.createdBySessionId ?? null);
      }
      if (update.workspaceId !== undefined) set('workspace_id', 'workspaceId', update.workspaceId);
      if (update.filePath !== undefined) set('file_path', 'filePath', update.filePath ?? null);
      if (update.providerConfig !== undefined) {
        set('provider_config', 'providerConfig', toJsonColumn(update.providerConfig));
      }
      if (update.providerSessionId !== undefined) {
        set('provider_session_id', 'providerSessionId', update.providerSessionId ?? null);
      }
      if (update.documentContext !== undefined) {
        set('document_context', 'documentContext', toJsonColumn(update.documentContext));
      }
      if (update.draftInput !== undefined) {
        set('draft_input', 'draftInput', update.draftInput ?? null);
      }

      if (update.metadata !== undefined) {
        const incoming = update.metadata;
        if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
          // Dropping the write is the correct outcome. A string here spreads to
          // numeric keys and the row grows ~9x per read/write cycle.
          console.warn(
            `[NodeSessionStore] refused non-object metadata for session ${sessionId}: `
            + `type=${typeof incoming}, isArray=${Array.isArray(incoming)}`,
          );
        } else {
          const existing = parseJsonObjectColumn(
            (db.prepare('SELECT metadata FROM ai_sessions WHERE id = ?')
              .get(sessionId) as Row | undefined)?.metadata,
          );
          set('metadata', 'metadata', JSON.stringify({ ...existing, ...incoming }));
        }
      }

      const hasBeenNamed = (update as { hasBeenNamed?: boolean }).hasBeenNamed;
      if (hasBeenNamed !== undefined) set('has_been_named', 'hasBeenNamed', fromBool(hasBeenNamed));
      if (update.isArchived !== undefined) {
        set('is_archived', 'isArchived', fromBool(update.isArchived));
      }
      const isPinned = (update as { isPinned?: boolean }).isPinned;
      if (isPinned !== undefined) set('is_pinned', 'isPinned', fromBool(isPinned));
      if (update.parentSessionId !== undefined) {
        set('parent_session_id', 'parentSessionId', update.parentSessionId ?? null);
      }
      if (update.lastDocumentState !== undefined) {
        set('last_document_state', 'lastDocumentState', toJsonColumn(update.lastDocumentState));
      }
      if (update.canonicalTransformVersion !== undefined) {
        set('canonical_transform_version', 'ctv', update.canonicalTransformVersion);
      }
      if (update.canonicalTransformStatus !== undefined) {
        set('canonical_transform_status', 'cts', update.canonicalTransformStatus);
      }
      if (update.canonicalLastTransformedAt !== undefined) {
        set(
          'canonical_last_transformed_at',
          'clta',
          update.canonicalLastTransformedAt ? toIsoText(update.canonicalLastTransformedAt) : null,
        );
      }
      if (update.canonicalLastRawMessageId !== undefined) {
        set('canonical_last_raw_message_id', 'clrmi', update.canonicalLastRawMessageId);
      }

      // Deliberately no `updated_at` here: it tracks the last message, which is
      // what the session list sorts on.
      if (assignments.length === 0) return;

      db.prepare(
        `UPDATE ai_sessions SET ${assignments.join(', ')} WHERE id = @id`,
      ).run(params);

      // A workstream archives as a unit -- children carry the flag themselves
      // because the archive filter only reads a row's own column.
      if (update.isArchived !== undefined) {
        db.prepare('UPDATE ai_sessions SET is_archived = ? WHERE parent_session_id = ?')
          .run(fromBool(update.isArchived), sessionId);
      }
    },

    async get(sessionId: string): Promise<SessionData | null> {
      const row = db.prepare(`
        SELECT ${SESSION_COLUMNS},
               w.path AS worktree_path,
               w.workspace_id AS worktree_project_path,
               branched_from.provider_session_id AS branched_from_provider_session_id
        FROM ai_sessions s
        LEFT JOIN worktrees w ON s.worktree_id = w.id
        LEFT JOIN ai_sessions branched_from ON s.branched_from_session_id = branched_from.id
        WHERE s.id = ?
        LIMIT 1
      `).get(sessionId) as Row | undefined;

      return row ? toSessionData(row) : null;
    },

    async getMany(sessionIds: string[]): Promise<SessionData[]> {
      if (sessionIds.length === 0) return [];
      const placeholders = sessionIds.map(() => '?').join(', ');
      const rows = db.prepare(`
        SELECT ${SESSION_COLUMNS},
               w.path AS worktree_path,
               w.workspace_id AS worktree_project_path,
               branched_from.provider_session_id AS branched_from_provider_session_id
        FROM ai_sessions s
        LEFT JOIN worktrees w ON s.worktree_id = w.id
        LEFT JOIN ai_sessions branched_from ON s.branched_from_session_id = branched_from.id
        WHERE s.id IN (${placeholders})
      `).all(...sessionIds) as Row[];

      return rows.map(toSessionData);
    },

    async list(workspaceId: string, options?: SessionListOptions): Promise<SessionMeta[]> {
      const rows = db.prepare(`
        SELECT ${SESSION_COLUMNS},
               COALESCE(child_stats.child_count, 0) AS child_count,
               MAX(s.updated_at, COALESCE(child_stats.max_child_updated_at, s.updated_at))
                 AS effective_updated_at
        FROM ai_sessions s
        LEFT JOIN worktrees w ON s.worktree_id = w.id
        LEFT JOIN (
          SELECT parent_session_id,
                 COUNT(*) AS child_count,
                 MAX(updated_at) AS max_child_updated_at
          FROM ai_sessions
          WHERE parent_session_id IS NOT NULL AND workspace_id = @workspaceId
          GROUP BY parent_session_id
        ) child_stats ON child_stats.parent_session_id = s.id
        WHERE s.workspace_id = @workspaceId
        ${archiveFilter(options?.includeArchived ?? false)}
        ORDER BY effective_updated_at DESC
      `).all({ workspaceId }) as Row[];

      return rows.map(toSessionMeta);
    },

    async search(
      workspaceId: string,
      query: string,
      options?: SessionSearchOptions,
    ): Promise<SessionMeta[]> {
      if (!query || query.trim().length === 0) {
        return this.list(workspaceId, options);
      }

      const trimmed = query.trim();
      const includeArchived = options?.includeArchived ?? false;
      const direction = options?.direction ?? 'all';
      const timeRange = options?.timeRange ?? '30d';

      let cutoff: string | null = null;
      if (timeRange !== 'all') {
        const days = { '7d': 7, '30d': 30, '90d': 90 }[timeRange];
        cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      }

      // FTS5 over the `searchable_text` mirror, which is what the desktop app's
      // SQLite path uses. bm25 is lower-is-better; invert so a plain descending
      // sort works and title hits can carry the same 2x boost the PG path gives.
      const kindFilter = direction === 'input'
        ? `AND m.message_kind = 'user'`
        : direction === 'output'
          ? `AND m.message_kind = 'assistant'`
          : `AND m.message_kind IN ('user', 'assistant', 'system')`;

      const contentHits = db.prepare(`
        SELECT m.session_id AS session_id, MIN(fts.rank) AS rank
        FROM (
          SELECT rowid, rank FROM ai_agent_messages_fts
          WHERE ai_agent_messages_fts MATCH @q
        ) AS fts
        JOIN ai_agent_messages m ON m.id = fts.rowid
        WHERE 1 = 1 ${kindFilter}
          ${cutoff ? 'AND m.created_at >= @cutoff' : ''}
        GROUP BY m.session_id
      `).all({ q: trimmed, ...(cutoff ? { cutoff } : {}) }) as Array<{
        session_id: string;
        rank: number;
      }>;

      const titleHits = db.prepare(`
        SELECT s.id AS session_id
        FROM ai_sessions s
        LEFT JOIN worktrees w ON s.worktree_id = w.id
        WHERE s.workspace_id = @workspaceId
          AND LOWER(COALESCE(s.title, '')) LIKE @needle
          ${archiveFilter(includeArchived)}
      `).all({ workspaceId, needle: `%${trimmed.toLowerCase()}%` }) as Array<{
        session_id: string;
      }>;

      const ranks = new Map<string, number>();
      for (const hit of contentHits) {
        ranks.set(hit.session_id, hit.rank === 0 ? 1 : 1 / (1 + hit.rank));
      }
      for (const hit of titleHits) {
        ranks.set(hit.session_id, Math.max(ranks.get(hit.session_id) ?? 0, 2));
      }

      const ids = [...ranks.keys()];
      if (ids.length === 0) return [];

      const placeholders = ids.map(() => '?').join(', ');
      const rows = db.prepare(`
        SELECT ${SESSION_COLUMNS},
               COALESCE(child_stats.child_count, 0) AS child_count
        FROM ai_sessions s
        LEFT JOIN worktrees w ON s.worktree_id = w.id
        LEFT JOIN (
          SELECT parent_session_id, COUNT(*) AS child_count
          FROM ai_sessions
          WHERE parent_session_id IS NOT NULL
          GROUP BY parent_session_id
        ) child_stats ON child_stats.parent_session_id = s.id
        WHERE s.id IN (${placeholders})
          AND s.workspace_id = ?
          ${archiveFilter(includeArchived)}
      `).all(...ids, workspaceId) as Row[];

      return rows
        .map((row) => ({ meta: toSessionMeta(row), rank: ranks.get(row.id as string) ?? 0 }))
        .sort((a, b) => (b.rank - a.rank) || (b.meta.updatedAt - a.meta.updatedAt))
        .map((entry) => entry.meta);
    },

    async delete(sessionId: string): Promise<void> {
      db.prepare('DELETE FROM ai_sessions WHERE id = ?').run(sessionId);
    },

    async updateTitleIfNotNamed(sessionId: string, title: string): Promise<boolean> {
      const result = db.prepare(`
        UPDATE ai_sessions
        SET title = ?, has_been_named = 1
        WHERE id = ? AND (has_been_named = 0 OR has_been_named IS NULL)
      `).run(title, sessionId);
      return result.changes > 0;
    },

    async getBranches(sessionId: string): Promise<SessionMeta[]> {
      const rows = db.prepare(`
        SELECT ${SESSION_COLUMNS}, 0 AS child_count
        FROM ai_sessions s
        WHERE s.branched_from_session_id = ?
        ORDER BY s.branched_at DESC
      `).all(sessionId) as Row[];
      return rows.map(toSessionMeta);
    },
  };
}
