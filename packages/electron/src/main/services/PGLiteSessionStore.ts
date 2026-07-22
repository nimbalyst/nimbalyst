/**
 * PGLite implementation of SessionStore interface from runtime package
 */

import { toMillis } from '../utils/timestampUtils';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseJsonObjectColumn } from '../utils/jsonColumn';
import {
  computeSessionPhaseTransition,
  normalizeSessionPhaseMetadataUpdate,
} from './session/sessionPhaseTransition';

import type {
  SessionStore,
  SessionMeta,
  SessionListOptions,
  SessionSearchOptions,
  CreateSessionPayload,
  UpdateSessionMetadataPayload,
  ChatSession,
  AgentMessage
} from '@nimbalyst/runtime';
import type {
  SessionSyncPublicationObligation,
  SessionVisibilityStoreMutation,
} from '@nimbalyst/runtime/ai/adapters/sessionStore';

type PGliteLike = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  /** Native worker-backed statement batch; each backend commits the whole
   * array atomically and returns every statement result. */
  transaction?<T = any>(
    statements: Array<{ sql: string; params?: any[]; expectedRowCount?: 1 }>,
  ): Promise<Array<{ rows: T[] }>>;
  getEngine?(): 'pglite' | 'sqlite';
  /** Present on the production SQLite adapter; used only for dialect selection. */
  searchAgentMessages?: (...args: any[]) => unknown;
  searchTranscriptEventSessions?(
    query: string,
    opts?: {
      limit?: number;
      sessionIds?: string[];
      eventType?: 'user_message' | 'assistant_message' | null;
      cutoffDate?: Date | null;
    },
  ): Promise<Array<{ session_id: string; rank: number }>>;
  searchSessionTitles?(
    workspaceId: string,
    query: string,
    opts?: { includeArchived?: boolean },
  ): Promise<Array<{ session_id: string; rank: number }>>;
};

type EnsureReadyFn = () => Promise<void>;

/**
 * Claim the canonical commit-time visibility authority in the active session
 * database. The filesystem owner record is discovery/recovery metadata only;
 * this row is the sole nonce consulted by protected mutation statements.
 */
export async function claimVisibilityStorageDatabaseFence(
  db: Pick<PGliteLike, 'query'>,
  rootIdentity: string,
  ownerId: string,
): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS session_visibility_storage_fence (
    root_identity TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL
  )`);
  await db.query(
    `INSERT INTO session_visibility_storage_fence (root_identity, owner_id)
     VALUES ($1, $2)
     ON CONFLICT (root_identity) DO UPDATE SET owner_id = EXCLUDED.owner_id`,
    [rootIdentity, ownerId],
  );
}

function buildSessionArchiveFilter(includeArchived: boolean, sessionAlias = 's', worktreeAlias = 'w'): string {
  if (includeArchived) {
    return '';
  }

  return `AND (${sessionAlias}.is_archived = FALSE OR ${sessionAlias}.is_archived IS NULL)
          AND (${sessionAlias}.worktree_id IS NULL OR ${worktreeAlias}.is_archived = FALSE OR ${worktreeAlias}.is_archived IS NULL)`;
}

// Shared with other JSON-typed column readers; see ../utils/jsonColumn.ts
// for the metadata-corruption postmortem.
const normalizeJsonObject = parseJsonObjectColumn;
const VISIBILITY_MUTATION_LEDGER_KEY = '__nimbalystVisibilityMutationIds';
const SYNC_PUBLICATION_OBLIGATION_KEY = '__nimbalystSyncPublicationObligation';
const INTERNAL_SYNC_PUBLICATION = Symbol('nimbalystSyncPublicationObligation');
const HOST_ONLY_METADATA_KEYS = [
  VISIBILITY_MUTATION_LEDGER_KEY,
  SYNC_PUBLICATION_OBLIGATION_KEY,
] as const;

function isSQLiteStoreAdapter(db: PGliteLike): boolean {
  return db.getEngine?.() === 'sqlite' || typeof db.searchAgentMessages === 'function';
}

function publicSessionMetadata(value: unknown): Record<string, unknown> {
  const metadata = { ...normalizeJsonObject(value) };
  for (const key of HOST_ONLY_METADATA_KEYS) delete metadata[key];
  return metadata;
}

function visibilityMutationRecords(value: unknown): Record<string, string | null> {
  const ledger = normalizeJsonObject(value)[VISIBILITY_MUTATION_LEDGER_KEY];
  if (Array.isArray(ledger)) {
    return Object.fromEntries(
      ledger.filter((id): id is string => typeof id === 'string').map((id) => [id, null]),
    );
  }
  if (!ledger || typeof ledger !== 'object') return {};
  return Object.fromEntries(
    Object.entries(ledger).filter((entry): entry is [string, string] => (
      typeof entry[0] === 'string' && typeof entry[1] === 'string'
    )),
  );
}

function normalizeWorkspaceComparisonPath(value: string): string {
  const resolved = path.resolve(value.trim()).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function visibilityMutationFingerprint(
  sessionId: string,
  mutation: SessionVisibilityStoreMutation,
): string {
  return createHash('sha256').update(JSON.stringify({
    sessionId,
    operation: mutation.operation,
    workspaceComparisonPath: mutation.workspaceComparisonPath,
    expected: mutation.expected,
    after: mutation.after,
    destinationSessionId: mutation.destinationSessionId ?? null,
  })).digest('hex');
}

/**
 * Parse a TEXT column that's supposed to hold JSON back into the value the
 * runtime expects. Under PGLite (JSONB) reads return parsed values directly,
 * under SQLite (TEXT) reads return raw strings. Without this normalization
 * any caller doing `{ ...session.metadata }` or `session.documentContext.foo`
 * silently iterates the string character by character (metadata) or returns
 * `undefined` for every field access (documentContext / providerConfig /
 * lastDocumentState). The metadata case is especially nasty because the
 * spread output gets re-serialized and written back, growing the row ~9x
 * per cycle until a single session metadata column hits hundreds of MB.
 * See `updateSessionTokenUsage` in SessionManager and the
 * `feedback_local_state_vs_server_state` memory.
 */
function parseJsonColumn(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length === 0) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}


// Module-level reference for standalone functions
let moduleDb: PGliteLike | null = null;
let moduleEnsureReady: EnsureReadyFn | null = null;

export interface HostControlMetadataCleanupAuthority {
  receiptId: string;
  reservationOwner: string;
  mutationId: string;
  mutationFence: number;
  attentionGeneration: string;
  step: 'prompt' | 'attention';
}

export type HostControlAttentionCleanupResult = 'settled' | 'already_absent';
export type HostControlPromptCleanupResult = 'cleared' | 'already_absent';

export interface HostControlAttentionOccurrence {
  eventIdentity: string;
  attentionGeneration: string;
}

function isExactPendingAttention(
  value: unknown,
  occurrence: HostControlAttentionOccurrence,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.kind === 'interactive_prompt'
    && event.status === 'pending'
    && event.attentionGeneration === occurrence.attentionGeneration
    && (event.promptId === occurrence.eventIdentity || event.toolUseId === occurrence.eventIdentity);
}

function validateAttentionTransition(
  expected: Record<string, unknown>,
  next: Record<string, unknown>,
  occurrence: HostControlAttentionOccurrence,
  result: HostControlAttentionCleanupResult,
): void {
  const before = Array.isArray(expected.attentionEvents) ? expected.attentionEvents : [];
  const after = Array.isArray(next.attentionEvents) ? next.attentionEvents : [];
  if (result === 'already_absent') {
    if (before.some((event) => isExactPendingAttention(event, occurrence))
      || JSON.stringify(expected) !== JSON.stringify(next)) {
      throw new Error('host_control_attention_absence_transition_invalid');
    }
    return;
  }
  if (!before.some((event) => isExactPendingAttention(event, occurrence))
    || after.length !== before.length
    || after.some((event) => isExactPendingAttention(event, occurrence))) {
    throw new Error('host_control_attention_settlement_transition_invalid');
  }
  for (let index = 0; index < before.length; index += 1) {
    if (!isExactPendingAttention(before[index], occurrence)
      && JSON.stringify(before[index]) !== JSON.stringify(after[index])) {
      throw new Error('host_control_attention_nonoccurrence_mutated');
    }
  }
  for (const key of new Set([...Object.keys(expected), ...Object.keys(next)])) {
    if (key !== 'attentionEvents' && key !== 'attentionSummary'
      && JSON.stringify(expected[key]) !== JSON.stringify(next[key])) {
      throw new Error('host_control_attention_unrelated_metadata_mutated');
    }
  }
}

function validatePromptTransition(
  expected: Record<string, unknown>,
  next: Record<string, unknown>,
  eventIdentity: string,
  attentionGeneration: string,
  result: HostControlPromptCleanupResult,
): void {
  const exactA = expected.hasPendingPrompt === true
    && expected.pendingPromptId === eventIdentity
    && expected.pendingPromptGeneration === attentionGeneration;
  if (result === 'already_absent') {
    if (exactA || JSON.stringify(expected) !== JSON.stringify(next)) {
      throw new Error('host_control_prompt_absence_transition_invalid');
    }
    return;
  }
  if (!exactA
    || next.hasPendingPrompt !== false
    || next.pendingPromptId !== null
    || next.pendingPromptGeneration !== null) {
    throw new Error('host_control_prompt_clear_transition_invalid');
  }
  for (const key of new Set([...Object.keys(expected), ...Object.keys(next)])) {
    if (!['hasPendingPrompt', 'pendingPromptId', 'pendingPromptGeneration'].includes(key)
      && JSON.stringify(expected[key]) !== JSON.stringify(next[key])) {
      throw new Error('host_control_prompt_unrelated_metadata_mutated');
    }
  }
}

/**
 * Commit one optimistic session-metadata transition only while the exact Jean
 * cleanup step and lease are current in the same database statement. This is
 * deliberately outside the runtime SessionStore contract: it is a narrow host
 * control authority seam, not a general metadata update API.
 */
export async function compareUpdateSessionMetadataWithHostControlAuthority(input: {
  sessionId: string;
  expectedMetadata: Record<string, unknown>;
  nextMetadata: Record<string, unknown>;
  authority: HostControlMetadataCleanupAuthority;
  /** Required only for the attention phase, whose effect and replay fact
   * must be committed by the same guarded transaction. */
  attentionResult?: HostControlAttentionCleanupResult;
  attentionOccurrence?: HostControlAttentionOccurrence;
  promptResult?: HostControlPromptCleanupResult;
  promptEventIdentity?: string;
}): Promise<boolean> {
  if (!moduleDb) throw new Error('session_store_not_initialized');
  if (moduleEnsureReady) await moduleEnsureReady();
  const cleanupStateColumn = input.authority.step === 'prompt'
    ? 'cleanup_prompt_state'
    : 'cleanup_attention_state';
  const cleanupFenceColumn = input.authority.step === 'prompt'
    ? 'cleanup_prompt_fence'
    : 'cleanup_attention_fence';
  const mutationStatePredicate = input.authority.step === 'attention' || input.authority.step === 'prompt'
    ? "h.mutation_state = 'applied'"
    : "h.mutation_state IN ('applied', 'not_applied')";
  const metadataParams = [
    input.sessionId,
    JSON.stringify(input.nextMetadata),
    JSON.stringify(input.expectedMetadata),
    input.authority.receiptId,
    input.authority.reservationOwner,
    input.authority.mutationId,
    input.authority.mutationFence,
    input.authority.attentionGeneration,
  ];
  const metadataUpdate = `UPDATE ai_sessions
    SET metadata = $2
    WHERE id = $1
      AND metadata = $3
      AND EXISTS (
        SELECT 1 FROM host_control_receipts h
        WHERE h.id = $4
          AND h.reservation_owner = $5
          AND h.mutation_id = $6
          AND h.mutation_fence = $7
          AND h.attention_generation = $8
          AND h.state = 'reserved'
          AND ${mutationStatePredicate}
          AND h.${cleanupStateColumn} = 'claimed'
          AND h.${cleanupFenceColumn} = $7
          AND h.lease_expires_at > NOW()
      )
    RETURNING id`;

  // I3-R/I3-Z: exact-A settlement and proved A-absence each pair their
  // metadata CAS with the immutable replay fact in one guarded native batch.
  // Each required row count is checked *inside* that callback, so a second
  // authority miss throws and rolls back the first statement.
  if (input.authority.step === 'attention' || input.authority.step === 'prompt') {
    if (!moduleDb.transaction) {
      throw new Error('session_store_atomic_transaction_unavailable');
    }
    if (input.authority.step === 'prompt') {
      if (!input.promptResult || !input.promptEventIdentity) {
        throw new Error('host_control_prompt_result_required');
      }
      validatePromptTransition(
        input.expectedMetadata,
        input.nextMetadata,
        input.promptEventIdentity,
        input.authority.attentionGeneration,
        input.promptResult,
      );
      const expectedSerialized = JSON.stringify(input.expectedMetadata);
      const nextSerialized = JSON.stringify(input.nextMetadata);
      const unchanged = input.promptResult === 'already_absent';
      const promptSessionUpdate = unchanged
        ? `UPDATE ai_sessions SET metadata = metadata
              WHERE id = $1 AND metadata = $2
                AND EXISTS (SELECT 1 FROM host_control_receipts h
                  WHERE h.id = $3 AND h.reservation_owner = $4 AND h.mutation_id = $5
                    AND h.mutation_fence = $6 AND h.attention_generation = $7
                    AND h.event_identity = $8 AND h.state = 'reserved' AND h.mutation_state = 'applied'
                    AND h.cleanup_prompt_state = 'claimed' AND h.cleanup_prompt_fence = $6
                    AND h.lease_expires_at > NOW()) RETURNING id`
        : `UPDATE ai_sessions SET metadata = $2
              WHERE id = $1 AND metadata = $3
                AND EXISTS (SELECT 1 FROM host_control_receipts h
                  WHERE h.id = $4 AND h.reservation_owner = $5 AND h.mutation_id = $6
                    AND h.mutation_fence = $7 AND h.attention_generation = $8
                    AND h.event_identity = $9 AND h.state = 'reserved' AND h.mutation_state = 'applied'
                    AND h.cleanup_prompt_state = 'claimed' AND h.cleanup_prompt_fence = $7
                    AND h.lease_expires_at > NOW()) RETURNING id`;
      const results = await moduleDb.transaction<{ id: string }>([
        {
          sql: promptSessionUpdate,
          params: unchanged
            ? [input.sessionId, expectedSerialized, input.authority.receiptId, input.authority.reservationOwner, input.authority.mutationId, input.authority.mutationFence, input.authority.attentionGeneration, input.promptEventIdentity]
            : [input.sessionId, nextSerialized, expectedSerialized, input.authority.receiptId, input.authority.reservationOwner, input.authority.mutationId, input.authority.mutationFence, input.authority.attentionGeneration, input.promptEventIdentity],
          expectedRowCount: 1,
        },
        {
          sql: `UPDATE host_control_receipts SET cleanup_prompt_state = 'complete', updated_at = NOW()
                WHERE id = $1 AND reservation_owner = $2 AND mutation_id = $3 AND mutation_fence = $4
                  AND attention_generation = $5 AND event_identity = $6 AND state = 'reserved'
                  AND mutation_state = 'applied' AND cleanup_prompt_state = 'claimed'
                  AND cleanup_prompt_fence = $4 AND lease_expires_at > NOW()
                  AND EXISTS (SELECT 1 FROM ai_sessions s WHERE s.id = $7 AND s.metadata = $8) RETURNING id`,
          params: [input.authority.receiptId, input.authority.reservationOwner, input.authority.mutationId, input.authority.mutationFence, input.authority.attentionGeneration, input.promptEventIdentity, input.sessionId, unchanged ? expectedSerialized : nextSerialized],
          expectedRowCount: 1,
        },
      ]);
      return results[0]?.rows.length === 1 && results[1]?.rows.length === 1;
    }
    if (
      input.attentionResult !== 'settled'
      && input.attentionResult !== 'already_absent'
    ) {
      throw new Error('host_control_attention_result_required');
    }
    const occurrence = input.attentionOccurrence;
    if (!occurrence || !occurrence.eventIdentity
      || occurrence.attentionGeneration !== input.authority.attentionGeneration) {
      throw new Error('host_control_attention_occurrence_required');
    }
    validateAttentionTransition(
      input.expectedMetadata,
      input.nextMetadata,
      occurrence,
      input.attentionResult,
    );
    const isAlreadyAbsent = input.attentionResult === 'already_absent';
    const expectedSerialized = JSON.stringify(input.expectedMetadata);
    const nextSerialized = JSON.stringify(input.nextMetadata);
    const settledMetadataUpdate = `${metadataUpdate.replace(
      'AND h.state = \'reserved\'',
      "AND h.event_identity = $9\n          AND h.state = 'reserved'",
    )}`;
    const sessionUpdate = isAlreadyAbsent
      ? `UPDATE ai_sessions
         SET metadata = metadata
         WHERE id = $1
           AND metadata = $2
           AND EXISTS (
             SELECT 1 FROM host_control_receipts h
             WHERE h.id = $3
               AND h.reservation_owner = $4
               AND h.mutation_id = $5
               AND h.mutation_fence = $6
               AND h.attention_generation = $7
               AND h.event_identity = $8
               AND h.state = 'reserved'
               AND h.mutation_state = 'applied'
               AND h.cleanup_attention_state = 'claimed'
               AND h.cleanup_attention_fence = $6
               AND h.lease_expires_at > NOW()
           )
         RETURNING id`
      : settledMetadataUpdate;
    const sessionParams = isAlreadyAbsent
      ? [
        input.sessionId,
        expectedSerialized,
        input.authority.receiptId,
        input.authority.reservationOwner,
        input.authority.mutationId,
        input.authority.mutationFence,
        input.authority.attentionGeneration,
        occurrence.eventIdentity,
      ]
      : [...metadataParams, occurrence.eventIdentity];
    const metadataForReceipt = isAlreadyAbsent ? expectedSerialized : nextSerialized;
    const results = await moduleDb.transaction<{ id: string }>([
      { sql: sessionUpdate, params: sessionParams, expectedRowCount: 1 },
      {
        sql: `UPDATE host_control_receipts
              SET cleanup_attention_state = 'complete',
                  cleanup_attention_result = $9,
                  updated_at = NOW()
              WHERE id = $1
                AND reservation_owner = $2
                AND mutation_id = $3
                AND mutation_fence = $4
                AND state = 'reserved'
                AND mutation_state = 'applied'
                AND attention_generation = $5
                AND event_identity = $8
                AND cleanup_attention_state = 'claimed'
                AND cleanup_attention_fence = $4
                AND lease_expires_at > NOW()
                AND EXISTS (
                  SELECT 1 FROM ai_sessions s
                  WHERE s.id = $6 AND s.metadata = $7
                )
              RETURNING id`,
        params: [
          input.authority.receiptId,
          input.authority.reservationOwner,
          input.authority.mutationId,
          input.authority.mutationFence,
          input.authority.attentionGeneration,
          input.sessionId,
          metadataForReceipt,
          occurrence.eventIdentity,
          input.attentionResult,
        ],
        expectedRowCount: 1,
      },
    ]);
    const metadataCommitted = results[0]?.rows.length === 1;
    const receiptCommitted = results[1]?.rows.length === 1;
    if (metadataCommitted !== receiptCommitted) {
      // The predicates are intentionally equivalent under one transaction.
      // Treat an impossible asymmetric backend result as a hard failure rather
      // than inventing an attention-cleanup result for replay.
      throw new Error('host_control_attention_settlement_atomicity_violation');
    }
    return metadataCommitted;
  }

  const result = await moduleDb.query<{ id: string }>(metadataUpdate, metadataParams);
  return result.rows.length === 1;
}

/**
 * Get the database instance for direct queries (e.g., migrations)
 */
export function getDatabase(): PGliteLike | null {
  return moduleDb;
}

// Use AgentMessage from runtime for sync compatibility
type SyncedMessage = AgentMessage;

/**
 * Get all sessions for sync (no workspace filter)
 * Uses the module-level db reference set by createPGLiteSessionStore
 */
export async function getAllSessionsForSync(includeMessages = false): Promise<Array<{
  id: string;
  title: string;
  provider: string;
  model?: string;
  mode?: string;
  sessionType?: string;
  parentSessionId?: string;
  agentRole?: string;
  createdBySessionId?: string | null;
  worktreeId?: string;
  isArchived?: boolean;
  isPinned?: boolean;
  branchedFromSessionId?: string;
  branchPointMessageId?: number;
  branchedAt?: number;
  workspaceId?: string;
  workspacePath?: string;
  messageCount: number;
  updatedAt: number;
  createdAt: number;
  metadata?: Record<string, any>;
  messages?: SyncedMessage[];
}>> {
  // Log stack trace to identify callers
  // const stack = new Error().stack?.split('\n').slice(1, 5).join('\n') || 'no stack';
  // console.log('[PGLiteSessionStore] getAllSessionsForSync called from:\n' + stack);

  const startTime = performance.now();
  if (!moduleDb) {
    throw new Error('Session store not initialized');
  }
  if (moduleEnsureReady) {
    await moduleEnsureReady();
  }
  const ensureTime = performance.now() - startTime;

  const queryStart = performance.now();
  // The COUNT(m.id) projection used to live here, but the mapper below hardcodes
  // messageCount: 0, so the LEFT JOIN + GROUP BY produced ~2.4s of wasted work
  // on databases with ~1k sessions. Stripped down to an indexed SELECT.
  const { rows } = await moduleDb.query<any>(
    `SELECT s.id, s.provider, s.model, s.mode, s.session_type, s.parent_session_id, s.agent_role, s.created_by_session_id, s.title, s.workspace_id, s.draft_input,
            s.worktree_id, s.is_archived, s.is_pinned, s.branched_from_session_id, s.branch_point_message_id, s.branched_at,
            s.created_at, s.updated_at, s.metadata
     FROM ai_sessions s
     ORDER BY s.updated_at DESC`
  );
  const queryTime = performance.now() - queryStart;

  // Filter out sessions without workspace_id - they are legacy data that cannot be routed correctly
  // Do NOT fall back to 'default' as that masks the real issue (missing workspace tracking)
  const validRows = rows.filter((row: any) => {
    if (!row.workspace_id) {
      console.warn(`[PGLiteSessionStore] Skipping session ${row.id} - missing workspace_id (legacy data)`);
      return false;
    }
    return true;
  });

  const sessions = validRows.map((row: any) => {
    return {
      id: row.id,
      title: row.title || 'Untitled',
      provider: row.provider || 'unknown',
      model: row.model,
      mode: row.mode,
      sessionType: row.session_type || 'session',
      parentSessionId: row.parent_session_id || undefined,
      agentRole: row.agent_role || 'standard',
      createdBySessionId: row.created_by_session_id || undefined,
      worktreeId: row.worktree_id || undefined,
      isArchived: row.is_archived ?? false,
      isPinned: row.is_pinned ?? false,
      branchedFromSessionId: row.branched_from_session_id || undefined,
      branchPointMessageId: row.branch_point_message_id || undefined,
      branchedAt: toMillis(row.branched_at) ?? undefined,
      // workspace_id is required - we filtered out sessions without it above
      workspaceId: row.workspace_id,
      workspacePath: row.workspace_id, // workspace_id is the path in this system
      // NOTE: Do NOT include draftInput in bulk sync - it should only sync when actually changed
      // Including it here causes spurious metadata_updated events for all sessions on startup
      messageCount: 0,
      updatedAt: toMillis(row.updated_at)!,
      createdAt: toMillis(row.created_at)!,
      // Sync clients (mobile, peer devices) expect a parsed object here.
      // See `parseJsonColumn` for the SQLite/PGLite shape difference.
      metadata: publicSessionMetadata(row.metadata),
      messages: undefined as SyncedMessage[] | undefined,
    };
  });

  // Optionally fetch messages for each session (include hidden - mobile filters client-side)
  if (includeMessages) {
    for (const session of sessions) {
      const { rows: msgRows } = await moduleDb.query<any>(
        `SELECT id, session_id, created_at, source, direction, content, metadata, hidden
         FROM ai_agent_messages
         WHERE session_id = $1
         ORDER BY created_at ASC`,
        [session.id]
      );
      session.messages = msgRows.map((m: any): AgentMessage => ({
        id: m.id,
        sessionId: m.session_id,
        createdAt: m.created_at instanceof Date ? m.created_at : new Date(toMillis(m.created_at)!),
        source: m.source,
        direction: m.direction,
        content: m.content,
        metadata: m.metadata,
        hidden: m.hidden ?? false,
      }));
    }
  }

  // const totalTime = performance.now() - startTime;
  // console.log(`[PGLiteSessionStore] getAllSessionsForSync() - ensureReady: ${ensureTime.toFixed(1)}ms, query: ${queryTime.toFixed(1)}ms, total: ${totalTime.toFixed(1)}ms, rows: ${rows.length}`);
  return sessions;
}

/**
 * Get messages for a session created after a given timestamp.
 * Used for delta sync - only fetch messages newer than the server's last sync.
 *
 * @param sessionId The session ID
 * @param sinceTimestamp Epoch milliseconds - only return messages created AFTER this time (0 = all)
 */
export async function getSessionMessagesForSync(
  sessionId: string,
  sinceTimestamp: number = 0
): Promise<SyncedMessage[]> {
  if (!moduleDb) {
    throw new Error('Session store not initialized');
  }
  if (moduleEnsureReady) {
    await moduleEnsureReady();
  }

  // Convert milliseconds to Date for PostgreSQL comparison
  const sinceDate = new Date(sinceTimestamp);

  const { rows: msgRows } = await moduleDb.query<any>(
    `SELECT id, session_id, created_at, source, direction, content, metadata, hidden
     FROM ai_agent_messages
     WHERE session_id = $1 AND created_at > $2
     ORDER BY created_at ASC`,
    [sessionId, sinceDate]
  );

  return msgRows.map((m: any): AgentMessage => ({
    id: m.id,
    sessionId: m.session_id,
    createdAt: m.created_at instanceof Date ? m.created_at : new Date(toMillis(m.created_at)!),
    source: m.source,
    direction: m.direction,
    content: m.content,
    metadata: m.metadata,
    hidden: m.hidden ?? false,
  }));
}

/**
 * Batch-fetch messages for multiple sessions, each with its own sinceTimestamp.
 * Replaces the N+1 pattern of calling getSessionMessagesForSync() per session.
 * Returns a Map from sessionId -> messages.
 */
export async function getSessionMessagesForSyncBatch(
  requests: Array<{ sessionId: string; sinceTimestamp: number }>
): Promise<Map<string, SyncedMessage[]>> {
  const result = new Map<string, SyncedMessage[]>();
  if (requests.length === 0) return result;

  if (!moduleDb) {
    throw new Error('Session store not initialized');
  }
  if (moduleEnsureReady) {
    await moduleEnsureReady();
  }

  // Use the earliest sinceTimestamp across all requests as a lower bound,
  // then filter per-session in JS. This avoids building a complex SQL query
  // with per-session timestamps, while still doing only ONE database query.
  const earliestSince = Math.min(...requests.map(r => r.sinceTimestamp));
  const sinceDate = new Date(earliestSince);

  const sessionIds = requests.map(r => r.sessionId);
  const placeholders = sessionIds.map((_, i) => `$${i + 2}`).join(', ');

  const { rows: msgRows } = await moduleDb.query<any>(
    `SELECT id, session_id, created_at, source, direction, content, metadata, hidden
     FROM ai_agent_messages
     WHERE session_id IN (${placeholders}) AND created_at > $1
     ORDER BY created_at ASC`,
    [sinceDate, ...sessionIds]
  );

  // Build a per-session sinceTimestamp lookup for JS-side filtering
  const sinceMap = new Map<string, number>();
  for (const req of requests) {
    sinceMap.set(req.sessionId, req.sinceTimestamp);
    result.set(req.sessionId, []);
  }

  for (const m of msgRows) {
    const sessionSince = sinceMap.get(m.session_id) ?? 0;
    const createdAt = m.created_at instanceof Date ? m.created_at : new Date(toMillis(m.created_at)!);
    // Filter: only include messages newer than this session's sinceTimestamp
    if (createdAt.getTime() > sessionSince) {
      const arr = result.get(m.session_id);
      if (arr) {
        arr.push({
          id: m.id,
          sessionId: m.session_id,
          createdAt,
          source: m.source,
          direction: m.direction,
          content: m.content,
          metadata: m.metadata,
          hidden: m.hidden ?? false,
        });
      }
    }
  }

  return result;
}

export function createPGLiteSessionStore(db: PGliteLike, ensureDbReady?: EnsureReadyFn): SessionStore {
  // Store db reference for module-level functions
  moduleDb = db;
  moduleEnsureReady = ensureDbReady ?? null;
  const ensureReady = async () => {
    if (ensureDbReady) {
      await ensureDbReady();
    }
  };

  const store: SessionStore = {
    async ensureReady(): Promise<void> {
      await ensureReady();
    },

    async create(payload: CreateSessionPayload): Promise<void> {
      await ensureReady();
      const now = Date.now();
      const createdAtMs = payload.createdAt ?? now;
      const updatedAtMs = payload.updatedAt ?? now;

      // Convert epoch milliseconds to Date objects
      // TIMESTAMPTZ columns handle Date objects correctly
      const createdAt = new Date(createdAtMs);
      const updatedAt = new Date(updatedAtMs);

      const branchedAt = payload.branchedAt ? new Date(payload.branchedAt) : null;
      const conflictMetadata = isSQLiteStoreAdapter(db)
        ? `json_patch(EXCLUDED.metadata, json_object(
            '${VISIBILITY_MUTATION_LEDGER_KEY}', json_extract(ai_sessions.metadata, '$.${VISIBILITY_MUTATION_LEDGER_KEY}'),
            '${SYNC_PUBLICATION_OBLIGATION_KEY}', COALESCE(
              json_extract(EXCLUDED.metadata, '$.${SYNC_PUBLICATION_OBLIGATION_KEY}'),
              json_extract(ai_sessions.metadata, '$.${SYNC_PUBLICATION_OBLIGATION_KEY}')
            )
          ))`
        : `(EXCLUDED.metadata::jsonb - '${VISIBILITY_MUTATION_LEDGER_KEY}' - '${SYNC_PUBLICATION_OBLIGATION_KEY}') ||
          CASE WHEN ai_sessions.metadata ? '${VISIBILITY_MUTATION_LEDGER_KEY}'
            THEN jsonb_build_object('${VISIBILITY_MUTATION_LEDGER_KEY}', ai_sessions.metadata -> '${VISIBILITY_MUTATION_LEDGER_KEY}')
            ELSE '{}'::jsonb END ||
          CASE WHEN EXCLUDED.metadata ? '${SYNC_PUBLICATION_OBLIGATION_KEY}'
            THEN jsonb_build_object('${SYNC_PUBLICATION_OBLIGATION_KEY}', EXCLUDED.metadata -> '${SYNC_PUBLICATION_OBLIGATION_KEY}')
            WHEN ai_sessions.metadata ? '${SYNC_PUBLICATION_OBLIGATION_KEY}'
            THEN jsonb_build_object('${SYNC_PUBLICATION_OBLIGATION_KEY}', ai_sessions.metadata -> '${SYNC_PUBLICATION_OBLIGATION_KEY}')
            ELSE '{}'::jsonb END`;
      const publication = (payload as CreateSessionPayload & {
        [INTERNAL_SYNC_PUBLICATION]?: SessionSyncPublicationObligation;
      })[INTERNAL_SYNC_PUBLICATION];
      const insertMetadata = {
        ...publicSessionMetadata((payload as any).metadata ?? {}),
        ...(publication ? { [SYNC_PUBLICATION_OBLIGATION_KEY]: publication } : {}),
      };

      await db.query(
        `INSERT INTO ai_sessions (
          id, workspace_id, file_path, worktree_id, parent_session_id, provider, model, title, session_type, mode,
          agent_role, created_by_session_id,
          document_context, provider_config, provider_session_id, draft_input, metadata,
          has_been_named, created_at, updated_at,
          branched_from_session_id, branch_point_message_id, branched_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12,
          $13, $14, $15, $16, $17,
          $18, $19, $20,
          $21, $22, $23
        )
        ON CONFLICT (id) DO UPDATE SET
          file_path = EXCLUDED.file_path,
          worktree_id = EXCLUDED.worktree_id,
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          session_type = EXCLUDED.session_type,
          mode = EXCLUDED.mode,
          agent_role = EXCLUDED.agent_role,
          created_by_session_id = EXCLUDED.created_by_session_id,
          document_context = EXCLUDED.document_context,
          provider_config = EXCLUDED.provider_config,
          provider_session_id = EXCLUDED.provider_session_id,
          draft_input = EXCLUDED.draft_input,
          metadata = ${conflictMetadata},
          updated_at = EXCLUDED.updated_at,
          branched_from_session_id = EXCLUDED.branched_from_session_id,
          branch_point_message_id = EXCLUDED.branch_point_message_id,
          branched_at = EXCLUDED.branched_at
      `,
        [
          payload.id,
          payload.workspaceId,
          payload.filePath ?? null,
          payload.worktreeId ?? null,
          payload.parentSessionId ?? null,  // Parent session ID for hierarchical workstreams
          payload.provider,
          payload.model ?? null,
          payload.title ?? 'New conversation',
          payload.sessionType ?? 'session',
          payload.mode ?? 'agent',
          payload.agentRole ?? 'standard',
          payload.createdBySessionId ?? null,
          payload.documentContext ?? null,
          payload.providerConfig ?? null,
          payload.providerSessionId ?? null,
          null,
          insertMetadata,
          (payload as any).hasBeenNamed ?? false,
          createdAt,
          updatedAt,
          payload.branchedFromSessionId ?? null,  // Branch tracking - separate from parent
          payload.branchPointMessageId ?? null,
          branchedAt,
        ]
      );

      // TODO: Debug logging - uncomment if needed
      // console.log('[PGLiteSessionStore] Session created successfully in database');
    },

    async createWithSyncPublicationObligation(
      payload: CreateSessionPayload,
      obligation: SessionSyncPublicationObligation,
    ): Promise<void> {
      const internalPayload = {
        ...payload,
        [INTERNAL_SYNC_PUBLICATION]: {
          ...obligation,
          sessionId: payload.id,
          workspaceId: payload.workspaceId,
        },
      } as CreateSessionPayload;
      await store.create(internalPayload);
    },

    async listSyncPublicationObligations(
      limit: number,
    ): Promise<SessionSyncPublicationObligation[]> {
      await ensureReady();
      const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
      const predicate = isSQLiteStoreAdapter(db)
        ? `CASE WHEN json_valid(metadata) THEN
             json_type(metadata, '$.${SYNC_PUBLICATION_OBLIGATION_KEY}') = 'object'
             AND json_type(metadata, '$.${SYNC_PUBLICATION_OBLIGATION_KEY}.obligationId') = 'text'
             AND json_type(metadata, '$.${SYNC_PUBLICATION_OBLIGATION_KEY}.workspaceId') = 'text'
             AND json_type(metadata, '$.${SYNC_PUBLICATION_OBLIGATION_KEY}.createdAt') IN ('integer', 'real')
           ELSE FALSE END`
        : `metadata ? '${SYNC_PUBLICATION_OBLIGATION_KEY}'
           AND jsonb_typeof(metadata -> '${SYNC_PUBLICATION_OBLIGATION_KEY}') = 'object'
           AND jsonb_typeof(metadata -> '${SYNC_PUBLICATION_OBLIGATION_KEY}' -> 'obligationId') = 'string'
           AND jsonb_typeof(metadata -> '${SYNC_PUBLICATION_OBLIGATION_KEY}' -> 'workspaceId') = 'string'
           AND jsonb_typeof(metadata -> '${SYNC_PUBLICATION_OBLIGATION_KEY}' -> 'createdAt') = 'number'`;
      await db.query(`CREATE TABLE IF NOT EXISTS session_sync_publication_cursor (
        cursor_name TEXT PRIMARY KEY,
        last_session_id TEXT NOT NULL
      )`);
      const cursorName = 'create-publication-v1';
      const cursorResult = await db.query<{ last_session_id: string }>(
        'SELECT last_session_id FROM session_sync_publication_cursor WHERE cursor_name = $1',
        [cursorName],
      );
      const cursor = cursorResult.rows[0]?.last_session_id ?? '';
      let { rows } = await db.query<{ id: string; metadata: unknown }>(
        `SELECT id, metadata FROM ai_sessions
         WHERE id > $1 AND ${predicate}
         ORDER BY id LIMIT $2`,
        [cursor, boundedLimit],
      );
      if (rows.length === 0 && cursor) {
        ({ rows } = await db.query<{ id: string; metadata: unknown }>(
          `SELECT id, metadata FROM ai_sessions
           WHERE ${predicate}
           ORDER BY id LIMIT $1`,
          [boundedLimit],
        ));
      }
      if (rows.length > 0) {
        await db.query(
          `INSERT INTO session_sync_publication_cursor (cursor_name, last_session_id)
           VALUES ($1, $2)
           ON CONFLICT (cursor_name) DO UPDATE SET last_session_id = EXCLUDED.last_session_id`,
          [cursorName, rows[rows.length - 1].id],
        );
      }
      return rows.flatMap((row) => {
        const value = normalizeJsonObject(row.metadata)[SYNC_PUBLICATION_OBLIGATION_KEY];
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const candidate = value as Partial<SessionSyncPublicationObligation>;
        if (
          typeof candidate.obligationId !== 'string'
          || typeof candidate.workspaceId !== 'string'
          || typeof candidate.createdAt !== 'number'
        ) return [];
        return [{
          obligationId: candidate.obligationId.slice(0, 200),
          sessionId: row.id,
          workspaceId: candidate.workspaceId,
          createdAt: candidate.createdAt,
        }];
      });
    },

    async clearSyncPublicationObligation(
      sessionId: string,
      obligationId: string,
    ): Promise<boolean> {
      await ensureReady();
      const sql = isSQLiteStoreAdapter(db)
        ? `UPDATE ai_sessions
           SET metadata = json_remove(metadata, '$.${SYNC_PUBLICATION_OBLIGATION_KEY}')
           WHERE id = $1
             AND json_extract(metadata, '$.${SYNC_PUBLICATION_OBLIGATION_KEY}.obligationId') = $2
           RETURNING id`
        : `UPDATE ai_sessions
           SET metadata = metadata - '${SYNC_PUBLICATION_OBLIGATION_KEY}'
           WHERE id = $1
             AND metadata -> '${SYNC_PUBLICATION_OBLIGATION_KEY}' ->> 'obligationId' = $2
           RETURNING id`;
      const { rows } = await db.query<{ id: string }>(sql, [sessionId, obligationId]);
      return rows.length === 1;
    },


    async updateMetadata(sessionId: string, metadata: UpdateSessionMetadataPayload): Promise<void> {
      await ensureReady();
      const updates: string[] = [];
      const values: any[] = [sessionId];

      const pushUpdate = (clause: string, value: any) => {
        updates.push(`${clause} $${values.length + 1}`);
        values.push(value);
      };

      if (metadata.provider !== undefined) pushUpdate('provider =', metadata.provider);
      if (metadata.model !== undefined) pushUpdate('model =', metadata.model);
      if (metadata.title !== undefined) pushUpdate('title =', metadata.title ?? 'New conversation');
      if (metadata.sessionType !== undefined) pushUpdate('session_type =', metadata.sessionType);
      if (metadata.mode !== undefined) pushUpdate('mode =', metadata.mode);
      if (metadata.agentRole !== undefined) pushUpdate('agent_role =', metadata.agentRole);
      if (metadata.createdBySessionId !== undefined) pushUpdate('created_by_session_id =', metadata.createdBySessionId ?? null);
      if (metadata.workspaceId !== undefined) pushUpdate('workspace_id =', metadata.workspaceId);
      if (metadata.filePath !== undefined) pushUpdate('file_path =', metadata.filePath ?? null);
      if (metadata.providerConfig !== undefined) pushUpdate('provider_config =', metadata.providerConfig ?? null);
      if (metadata.providerSessionId !== undefined) pushUpdate('provider_session_id =', metadata.providerSessionId ?? null);
      if (metadata.documentContext !== undefined) pushUpdate('document_context =', metadata.documentContext ?? null);
      if (metadata.draftInput !== undefined) pushUpdate('draft_input =', metadata.draftInput ?? null);
      // NOTE: tokenUsage removed - it's derived from ai_agent_messages /context responses
      // NOTE: queuedPrompts removed - now uses separate queued_prompts table for atomic operations
      // Handle metadata field (the JSON blob) - do a shallow merge.
      //
      // Defense-in-depth: refuse any payload that isn't a plain object.
      // A caller passing a string here (e.g. a SQLite read that returned
      // the raw JSON text and got threaded back into update unchanged)
      // would otherwise spread to char-by-char numeric keys, get JSON-
      // stringified, written back, and re-corrupted on the next read.
      // We saw a single session's metadata column grow to 216 MB this
      // way before catching it. Drop the update on the floor and log
      // loudly so the upstream caller surfaces in main.log instead of
      // silently amplifying corruption.
      if (metadata.metadata !== undefined) {
        const incoming = metadata.metadata;
        if (
          incoming === null ||
          typeof incoming !== 'object' ||
          Array.isArray(incoming)
        ) {
          console.warn(
            `[PGLiteSessionStore] updateMetadata refused non-object metadata for session ${sessionId}: type=${typeof incoming}, isArray=${Array.isArray(incoming)}`,
          );
        } else {
          const normalizedIncoming = { ...normalizeSessionPhaseMetadataUpdate(incoming) };
          for (const key of HOST_ONLY_METADATA_KEYS) delete normalizedIncoming[key];
          const { rows } = await db.query<{ metadata: unknown }>(
            `SELECT metadata FROM ai_sessions WHERE id = $1`,
            [sessionId],
          );
          const existingMetadata = normalizeJsonObject(rows[0]?.metadata);
          const merged: Record<string, any> = { ...existingMetadata, ...normalizedIncoming };
          for (const key of HOST_ONLY_METADATA_KEYS) delete merged[key];
          // Record workflow-phase transitions into metadata.activity[] so the
          // session's lifecycle history is self-contained and renderable on the
          // project-graph timeline (see session/sessionPhaseTransition.ts). This
          // is the single chokepoint for every phase change -- the
          // update_session_meta MCP tool and the kanban UI both land here. Only
          // the workflow `phase` is tracked; operational status flips too often
          // for the bounded log.
          const incomingPhase = normalizedIncoming.phase;
          if (typeof incomingPhase === 'string') {
            const transition = computeSessionPhaseTransition(
              existingMetadata as Record<string, any>,
              incomingPhase,
              null,
              Date.now(),
            );
            if (transition.changed) merged.activity = transition.metadata.activity;
          }
          const parameter = `$${values.length + 1}`;
          if (isSQLiteStoreAdapter(db)) {
            updates.push(`metadata = json_patch(${parameter}, json_object(
              '${VISIBILITY_MUTATION_LEDGER_KEY}', json_extract(metadata, '$.${VISIBILITY_MUTATION_LEDGER_KEY}'),
              '${SYNC_PUBLICATION_OBLIGATION_KEY}', json_extract(metadata, '$.${SYNC_PUBLICATION_OBLIGATION_KEY}')
            ))`);
          } else {
            updates.push(`metadata = (${parameter}::jsonb - '${VISIBILITY_MUTATION_LEDGER_KEY}' - '${SYNC_PUBLICATION_OBLIGATION_KEY}') ||
              CASE WHEN metadata ? '${VISIBILITY_MUTATION_LEDGER_KEY}'
                THEN jsonb_build_object('${VISIBILITY_MUTATION_LEDGER_KEY}', metadata -> '${VISIBILITY_MUTATION_LEDGER_KEY}')
                ELSE '{}'::jsonb END ||
              CASE WHEN metadata ? '${SYNC_PUBLICATION_OBLIGATION_KEY}'
                THEN jsonb_build_object('${SYNC_PUBLICATION_OBLIGATION_KEY}', metadata -> '${SYNC_PUBLICATION_OBLIGATION_KEY}')
                ELSE '{}'::jsonb END`);
          }
          values.push(JSON.stringify(merged));
        }
      }
      if ((metadata as any).hasBeenNamed !== undefined) pushUpdate('has_been_named =', (metadata as any).hasBeenNamed);
      if (metadata.isArchived !== undefined) pushUpdate('is_archived =', metadata.isArchived);
      if ((metadata as any).isPinned !== undefined) pushUpdate('is_pinned =', (metadata as any).isPinned);
      if (metadata.parentSessionId !== undefined) pushUpdate('parent_session_id =', metadata.parentSessionId);
      if (metadata.lastDocumentState !== undefined) pushUpdate('last_document_state =', metadata.lastDocumentState);
      // Canonical transcript transform status columns
      if (metadata.canonicalTransformVersion !== undefined) pushUpdate('canonical_transform_version =', metadata.canonicalTransformVersion);
      if (metadata.canonicalTransformStatus !== undefined) pushUpdate('canonical_transform_status =', metadata.canonicalTransformStatus);
      if (metadata.canonicalLastTransformedAt !== undefined) pushUpdate('canonical_last_transformed_at =', metadata.canonicalLastTransformedAt);
      if (metadata.canonicalLastRawMessageId !== undefined) pushUpdate('canonical_last_raw_message_id =', metadata.canonicalLastRawMessageId);

      // NOTE: We intentionally do NOT update updated_at here. The updated_at timestamp
      // should only change when messages are added (via PGLiteAgentMessagesStore.create),
      // so that session history sorting accurately reflects the last message time.
      if (!updates.length) {
        // Nothing to update - no-op
        return;
      }

      const setClause = updates.join(', ');
      await db.query(
        `UPDATE ai_sessions SET ${setClause} WHERE id=$1`,
        values
      );
    },

    async applyVisibilityMutation(
      sessionId: string,
      mutation: SessionVisibilityStoreMutation,
    ): Promise<boolean> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `SELECT metadata, is_pinned, parent_session_id, title, has_been_named, workspace_id
         FROM ai_sessions WHERE id = $1`,
        [sessionId],
      );
      const current = rows[0];
      if (
        !current ||
        normalizeWorkspaceComparisonPath(current.workspace_id) !== mutation.workspaceComparisonPath
      ) return false;

      const rawMetadata = current.metadata;
      const existingMetadata = normalizeJsonObject(rawMetadata);
      const records = visibilityMutationRecords(existingMetadata);
      const fingerprint = visibilityMutationFingerprint(sessionId, mutation);
      if (Object.prototype.hasOwnProperty.call(records, mutation.mutationId)) {
        return records[mutation.mutationId] === fingerprint;
      }
      const nextMetadata = {
        ...existingMetadata,
        [VISIBILITY_MUTATION_LEDGER_KEY]: { ...records, [mutation.mutationId]: fingerprint },
      };
      const sqlite = isSQLiteStoreAdapter(db);
      const updates: string[] = [];
      const predicates: string[] = ['id = $1', 'workspace_id = $2'];
      const values: unknown[] = [sessionId, current.workspace_id];
      const addValue = (value: unknown): string => {
        values.push(value);
        return `$${values.length}`;
      };
      const same = (column: string, value: unknown) => {
        const parameter = addValue(value);
        predicates.push(sqlite ? `${column} IS ${parameter}` : `${column} IS NOT DISTINCT FROM ${parameter}`);
      };

      if (mutation.expected.isPinned !== undefined) same('is_pinned', mutation.expected.isPinned);
      if (mutation.expected.parentSessionId !== undefined) same('parent_session_id', mutation.expected.parentSessionId);
      if (mutation.expected.title !== undefined) same('title', mutation.expected.title);
      if (mutation.expected.hasBeenNamed !== undefined) same('has_been_named', mutation.expected.hasBeenNamed);
      if (mutation.after.isPinned !== undefined) updates.push(`is_pinned = ${addValue(mutation.after.isPinned)}`);
      if (mutation.after.parentSessionId !== undefined) updates.push(`parent_session_id = ${addValue(mutation.after.parentSessionId)}`);
      if (mutation.after.title !== undefined) updates.push(`title = ${addValue(mutation.after.title)}`);
      if (mutation.after.hasBeenNamed !== undefined) updates.push(`has_been_named = ${addValue(mutation.after.hasBeenNamed)}`);

      const oldMetadataValue = sqlite
        ? (rawMetadata === null || rawMetadata === undefined
            ? null
            : typeof rawMetadata === 'string' ? rawMetadata : JSON.stringify(existingMetadata))
        : (rawMetadata === null || rawMetadata === undefined ? null : JSON.stringify(existingMetadata));
      const oldMetadataParameter = addValue(oldMetadataValue);
      predicates.push(sqlite
        ? `metadata IS ${oldMetadataParameter}`
        : `metadata IS NOT DISTINCT FROM ${oldMetadataParameter}::jsonb`);
      const nextMetadataParameter = addValue(JSON.stringify(nextMetadata));
      updates.push(sqlite
        ? `metadata = ${nextMetadataParameter}`
        : `metadata = ${nextMetadataParameter}::jsonb`);

      if (mutation.destinationSessionId) {
        const destinationId = addValue(mutation.destinationSessionId);
        const destinationWorkspace = addValue(mutation.workspaceComparisonPath);
        const destinationComparison = process.platform === 'win32'
          ? `LOWER(REPLACE(RTRIM(destination.workspace_id, '/\\'), '\\', '/'))`
          : `RTRIM(destination.workspace_id, '/')`;
        predicates.push(`EXISTS (
          SELECT 1 FROM ai_sessions destination
          WHERE destination.id = ${destinationId}
            AND ${destinationComparison} = ${destinationWorkspace}
            AND destination.session_type = 'workstream'
            AND destination.parent_session_id IS NULL
            AND destination.worktree_id IS NULL
            AND (destination.is_archived = FALSE OR destination.is_archived IS NULL)
        )`);
      }

      // The canonical physical-root owner nonce participates in the same
      // statement as the visibility CAS. owner.json is discovery-only, so no
      // second live-authority fact can diverge between preflight and commit.
      const storageFence = (mutation as any)[
        Symbol.for('nimbalyst.visibility-storage-fence')
      ] as {
        rootIdentity: string;
        ownerId: string;
      } | undefined;
      if (storageFence) {
        const fenceRoot = addValue(storageFence.rootIdentity);
        const fenceOwner = addValue(storageFence.ownerId);
        predicates.push(`EXISTS (
          SELECT 1 FROM session_visibility_storage_fence storage_fence
          WHERE storage_fence.root_identity = ${fenceRoot}
            AND storage_fence.owner_id = ${fenceOwner}
        )`);
      }
      const result = await db.query<{ applied: number }>(
        `UPDATE ai_sessions SET ${updates.join(', ')}
         WHERE ${predicates.join(' AND ')}
         RETURNING 1 AS applied`,
        values,
      );
      return result.rows.length === 1;
    },

    async hasVisibilityMutation(
      sessionId: string,
      mutationId: string,
      mutationIdentity?: string,
    ): Promise<boolean> {
      await ensureReady();
      const { rows } = await db.query<{ metadata: unknown }>(
        'SELECT metadata FROM ai_sessions WHERE id = $1',
        [sessionId],
      );
      const records = visibilityMutationRecords(rows[0]?.metadata);
      if (!Object.prototype.hasOwnProperty.call(records, mutationId)) return false;
      return mutationIdentity === undefined || records[mutationId] === mutationIdentity;
    },

    async get(sessionId: string): Promise<ChatSession | null> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `SELECT s.*,
         EXTRACT(EPOCH FROM s.last_read_timestamp) * 1000 AS last_read_ms,
         w.path AS worktree_path,
         w.workspace_id AS worktree_project_path,
         w.is_archived AS worktree_is_archived,
         branched_from.provider_session_id AS branched_from_provider_session_id
         FROM ai_sessions s
         LEFT JOIN worktrees w ON s.worktree_id = w.id
         LEFT JOIN ai_sessions branched_from ON s.branched_from_session_id = branched_from.id
         WHERE s.id=$1 LIMIT 1`,
        [sessionId]
      );
      const row = rows[0];
      if (!row) return null;

      // NOTE: tokenUsage is no longer stored in ai_sessions
      // It's derived from ai_agent_messages /context responses when loading sessions
      // Parse JSON columns at the boundary so downstream callers (e.g.
      // SessionManager.updateSessionTokenUsage) can safely spread them.
      // See `parseJsonColumn` for the SQLite-vs-PGLite read-shape mismatch.
      const metadata = publicSessionMetadata(row.metadata);

      return {
        id: row.id,
        provider: row.provider,
        model: row.model ?? undefined,
        sessionType: row.session_type ?? undefined,
        mode: row.mode ?? undefined,
        agentRole: row.agent_role ?? 'standard',
        title: row.title ?? undefined,
        draftInput: row.draft_input ?? undefined,
        messages: [], // Messages are now stored in ai_agent_messages table
        workspacePath: row.workspace_id,
        worktreeId: row.worktree_id ?? undefined,
        worktreePath: row.worktree_path ?? undefined,
        worktreeProjectPath: row.worktree_project_path ?? undefined,
        worktreeIsArchived: row.worktree_path
          ? Boolean(row.worktree_is_archived ?? false)
          : undefined,
        parentSessionId: row.parent_session_id ?? null,  // Hierarchical workstream support
        createdBySessionId: row.created_by_session_id ?? null,
        createdAt: toMillis(row.created_at)!,
        updatedAt: toMillis(row.updated_at)!,
        metadata,
        documentContext: parseJsonColumn(row.document_context) ?? undefined,
        providerConfig: parseJsonColumn(row.provider_config) ?? undefined,
        providerSessionId: row.provider_session_id ?? undefined,
        lastReadMessageTimestamp: row.last_read_ms ? Number(row.last_read_ms) : undefined,
        hasBeenNamed: row.has_been_named ?? false,
        isArchived: Boolean(row.is_archived ?? false),
        isPinned: row.is_pinned ?? false,
        // Branch tracking fields - SEPARATE from hierarchical parentSessionId
        branchedFromSessionId: row.branched_from_session_id ?? undefined,
        branchPointMessageId: row.branch_point_message_id ? parseInt(row.branch_point_message_id) : undefined,
        branchedAt: toMillis(row.branched_at) ?? undefined,
        branchedFromProviderSessionId: row.branched_from_provider_session_id ?? undefined,
        // Document context service state for transition detection
        lastDocumentState:
          (parseJsonColumn(row.last_document_state) as
            | { filePath: string; contentHash: string }
            | undefined) ?? undefined,
      } satisfies ChatSession;
    },

    async getMany(sessionIds: string[]): Promise<ChatSession[]> {
      if (sessionIds.length === 0) return [];
      await ensureReady();

      // Use ANY($1::text[]) for batch query - much more efficient than N individual queries
      const { rows } = await db.query<any>(
        `SELECT s.*,
         EXTRACT(EPOCH FROM s.last_read_timestamp) * 1000 AS last_read_ms,
         w.path AS worktree_path,
         w.workspace_id AS worktree_project_path,
         branched_from.provider_session_id AS branched_from_provider_session_id
         FROM ai_sessions s
         LEFT JOIN worktrees w ON s.worktree_id = w.id
         LEFT JOIN ai_sessions branched_from ON s.branched_from_session_id = branched_from.id
         WHERE s.id = ANY($1::text[])`,
        [sessionIds]
      );

      return rows.map((row: any) => {
        // Parse JSON columns at the boundary -- see `parseJsonColumn`.
        const metadata = publicSessionMetadata(row.metadata);
        return {
          id: row.id,
          provider: row.provider,
          model: row.model ?? undefined,
          sessionType: row.session_type ?? undefined,
          mode: row.mode ?? undefined,
          agentRole: row.agent_role ?? 'standard',
          title: row.title ?? undefined,
          draftInput: row.draft_input ?? undefined,
          messages: [],
          workspacePath: row.workspace_id,
          worktreeId: row.worktree_id ?? undefined,
          worktreePath: row.worktree_path ?? undefined,
          worktreeProjectPath: row.worktree_project_path ?? undefined,
          parentSessionId: row.parent_session_id ?? null,
          createdBySessionId: row.created_by_session_id ?? null,
          createdAt: toMillis(row.created_at)!,
          updatedAt: toMillis(row.updated_at)!,
          metadata,
          documentContext: parseJsonColumn(row.document_context) ?? undefined,
          providerConfig: parseJsonColumn(row.provider_config) ?? undefined,
          providerSessionId: row.provider_session_id ?? undefined,
          lastReadMessageTimestamp: row.last_read_ms ? Number(row.last_read_ms) : undefined,
          hasBeenNamed: row.has_been_named ?? false,
          isArchived: row.is_archived ?? false,
          isPinned: row.is_pinned ?? false,
          branchedFromSessionId: row.branched_from_session_id ?? undefined,
          branchPointMessageId: row.branch_point_message_id ? parseInt(row.branch_point_message_id) : undefined,
          branchedAt: toMillis(row.branched_at) ?? undefined,
          branchedFromProviderSessionId: row.branched_from_provider_session_id ?? undefined,
        } satisfies ChatSession;
      });
    },

    async list(workspaceId: string, options?: SessionListOptions): Promise<SessionMeta[]> {
      const startTime = performance.now();
      await ensureReady();
      const ensureTime = performance.now() - startTime;
      const includeArchived = options?.includeArchived ?? false;
      const archiveFilter = buildSessionArchiveFilter(includeArchived);

      const queryStart = performance.now();
      // Query includes parent_session_id and child_count for hierarchical session support
      // child_count and max child updated_at are pre-aggregated once per parent session
      // so list rendering does not pay for correlated subqueries on every row.
      // branched_from_session_id is separate from parent_session_id (branch vs hierarchy)
      // metadata is included for hasUnread state (transient UI state stored in DB for cross-device sync)
      // NOTE: message_count removed - it required an expensive LEFT JOIN on ai_agent_messages
      // that was slow with many sessions. The count is not essential for the list view.
      const { rows } = await db.query<any>(
        `SELECT s.id, s.provider, s.model, s.session_type, s.mode, s.agent_role, s.created_by_session_id, s.title, s.workspace_id,
                s.worktree_id, s.parent_session_id, s.created_at, s.updated_at, s.is_archived, s.is_pinned,
                s.branched_from_session_id, s.branch_point_message_id, s.branched_at, s.metadata,
                COALESCE(child_stats.child_count, 0) as child_count,
                GREATEST(s.updated_at, COALESCE(child_stats.max_child_updated_at, s.updated_at)) as effective_updated_at
         FROM ai_sessions s
         LEFT JOIN worktrees w ON s.worktree_id = w.id
         LEFT JOIN (
           SELECT
             parent_session_id,
             COUNT(*) AS child_count,
             MAX(updated_at) AS max_child_updated_at
           FROM ai_sessions
           WHERE parent_session_id IS NOT NULL
             AND workspace_id = $1
           GROUP BY parent_session_id
         ) child_stats ON child_stats.parent_session_id = s.id
         WHERE s.workspace_id=$1 ${archiveFilter}
         ORDER BY effective_updated_at DESC`,
        [workspaceId]
      );
      const queryTime = performance.now() - queryStart;
      const totalTime = performance.now() - startTime;
      // console.log(`[PGLiteSessionStore] list() - ensureReady: ${ensureTime.toFixed(1)}ms, query: ${queryTime.toFixed(1)}ms, total: ${totalTime.toFixed(1)}ms, rows: ${rows.length}`);
      return rows.map(row => {
        const createdAt = toMillis(row.created_at)!;
        // For workstream parents, use the effective timestamp that includes child activity
        const updatedAt = toMillis(row.effective_updated_at ?? row.updated_at)!;
        const branchedAt = toMillis(row.branched_at) ?? undefined;
        const childCount = parseInt(row.child_count) || 0;
        // Parse JSON columns at the boundary -- see `parseJsonColumn`.
        // Without this, `metadata.tags`, `metadata.phase`, `metadata.hasUnread`
        // etc. all read as undefined under the SQLite backend (because
        // `metadata` is a raw JSON string), so kanban tags/phase disappear
        // from the session list view.
        const metadata = publicSessionMetadata(row.metadata);
        const nestedMetadata = normalizeJsonObject(metadata.metadata);
        return {
          id: row.id,
          provider: row.provider,
          model: row.model ?? undefined,
          sessionType: row.session_type || 'session',
          mode: row.mode ?? undefined,
          agentRole: row.agent_role ?? 'standard',
          title: row.title || 'Untitled Session',
          workspaceId: row.workspace_id,
          worktreeId: row.worktree_id ?? null,
          parentSessionId: row.parent_session_id ?? null,
          createdBySessionId: row.created_by_session_id ?? null,
          childCount,
          uncommittedCount: 0,
          createdAt,
          updatedAt,
          messageCount: 0,  // Not computed in list query for performance - loaded lazily if needed
          isArchived: row.is_archived ?? false,
          isPinned: row.is_pinned ?? false,
          // Branch tracking - SEPARATE from hierarchical parentSessionId
          branchedFromSessionId: row.branched_from_session_id ?? undefined,
          branchPointMessageId: row.branch_point_message_id ? parseInt(row.branch_point_message_id) : undefined,
          branchedAt,
          hasUnread: nestedMetadata.hasUnread === true || metadata.hasUnread === true,
          // Authoritative pending-interactive-prompt bit. Written by
          // setSessionPendingPrompt() on every prompt open/resolve so the
          // sidebar indicator survives renderer reloads and reaches mobile.
          // Replaces the legacy `metadata.pendingAskUserQuestion` flag,
          // which nothing was writing.
          hasPendingInteractivePrompt: !!metadata.hasPendingPrompt,
          // Kanban board phase and tags from metadata JSONB
          phase: typeof metadata.phase === 'string' ? metadata.phase : undefined,
          tags: Array.isArray(metadata.tags) ? metadata.tags : undefined,
          // Linked tracker item IDs from metadata JSONB
          linkedTrackerItemIds: Array.isArray(metadata.linkedTrackerItemIds) ? metadata.linkedTrackerItemIds : undefined,
        } satisfies SessionMeta & { hasPendingInteractivePrompt?: boolean; phase?: string; tags?: string[]; linkedTrackerItemIds?: string[] };
      });
    },

    async search(workspaceId: string, query: string, options?: SessionSearchOptions): Promise<SessionMeta[]> {
      await ensureReady();

      // If query is empty, return all sessions (same as list)
      if (!query || query.trim().length === 0) {
        return this.list(workspaceId, options);
      }

      const includeArchived = options?.includeArchived ?? false;
      const archiveFilter = buildSessionArchiveFilter(includeArchived);

      // Default to 30 days to reduce database load
      const timeRange = options?.timeRange ?? '30d';
      const direction = options?.direction ?? 'all';

      const searchTerms = query.trim();

      // Calculate cutoff date for time range filter
      let cutoffDate: Date | null = null;
      if (timeRange !== 'all') {
        const daysMap = { '7d': 7, '30d': 30, '90d': 90 };
        const days = daysMap[timeRange];
        cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
      }

      // Hydrate ai_sessions rows for a set of session IDs. Used by both backends.
      const hydrateSessions = async (sessionIds: string[]): Promise<any[]> => {
        if (sessionIds.length === 0) return [];
        const { rows } = await db.query<any>(
          `SELECT
            s.id,
            s.provider,
            s.model,
            s.session_type,
            s.mode,
            s.agent_role,
            s.created_by_session_id,
            s.title,
            s.workspace_id,
            s.worktree_id,
            s.parent_session_id,
            s.created_at,
            s.updated_at,
            s.is_archived,
            s.is_pinned,
            s.branched_from_session_id,
            s.branch_point_message_id,
            s.branched_at,
            COALESCE(child_stats.child_count, 0) as child_count
          FROM ai_sessions s
          LEFT JOIN worktrees w ON s.worktree_id = w.id
          LEFT JOIN (
            SELECT parent_session_id, COUNT(*) AS child_count
            FROM ai_sessions
            WHERE parent_session_id IS NOT NULL AND workspace_id = $2
            GROUP BY parent_session_id
          ) child_stats ON child_stats.parent_session_id = s.id
          WHERE s.id = ANY($1)
            AND s.workspace_id = $2
            ${archiveFilter}`,
          [sessionIds, workspaceId]
        );
        return rows;
      };

      // Build a map of session ID -> best rank from both sources
      const sessionRanks = new Map<string, number>();
      const sessionRows = new Map<string, any>();

      if (db.searchTranscriptEventSessions) {
        // SQLite path: use FTS5 helpers, then hydrate session rows.
        // bm25 returns lower-is-better; invert into "higher is better" rank
        // so the sort order below matches the PG ts_rank_cd semantics.
        const bm25ToRank = (bm25: number) => (bm25 === 0 ? 1 : 1 / (1 + bm25));

        const [titleHits, contentHits] = await Promise.all([
          db.searchSessionTitles!(workspaceId, searchTerms, { includeArchived }),
          db.searchTranscriptEventSessions(searchTerms, {
            cutoffDate,
            eventType: direction === 'input' ? 'user_message' : direction === 'output' ? 'assistant_message' : null,
          }),
        ]);

        // Title matches outweigh content matches, mirroring the PG `* 2` boost.
        const titleRanks = new Map<string, number>();
        for (const hit of titleHits) {
          titleRanks.set(hit.session_id, bm25ToRank(hit.rank) * 2);
        }
        const contentRanks = new Map<string, number>();
        for (const hit of contentHits) {
          contentRanks.set(hit.session_id, bm25ToRank(hit.rank));
        }

        const allIds = Array.from(new Set([...titleRanks.keys(), ...contentRanks.keys()]));
        const hydrated = await hydrateSessions(allIds);
        for (const row of hydrated) {
          const t = titleRanks.get(row.id) ?? 0;
          const c = contentRanks.get(row.id) ?? 0;
          const rank = Math.max(t, c);
          sessionRanks.set(row.id, rank);
          sessionRows.set(row.id, { ...row, rank });
        }
      } else {
        // PGLite path: inline to_tsvector / plainto_tsquery + ts_rank_cd.
        const titleQuery = db.query<any>(
        `SELECT
          s.id,
          s.provider,
          s.model,
          s.session_type,
          s.mode,
          s.agent_role,
          s.created_by_session_id,
          s.title,
          s.workspace_id,
          s.worktree_id,
          s.parent_session_id,
          s.created_at,
          s.updated_at,
          s.is_archived,
          s.is_pinned,
          s.branched_from_session_id,
          s.branch_point_message_id,
          s.branched_at,
          ts_rank_cd(to_tsvector('english', COALESCE(s.title, '')), plainto_tsquery('english', $2)) * 2 as rank,
          COALESCE(child_stats.child_count, 0) as child_count
        FROM ai_sessions s
        LEFT JOIN worktrees w ON s.worktree_id = w.id
        LEFT JOIN (
          SELECT parent_session_id, COUNT(*) AS child_count
          FROM ai_sessions
          WHERE parent_session_id IS NOT NULL AND workspace_id = $1
          GROUP BY parent_session_id
        ) child_stats ON child_stats.parent_session_id = s.id
        WHERE s.workspace_id = $1
          AND to_tsvector('english', COALESCE(s.title, '')) @@ plainto_tsquery('english', $2)
          ${archiveFilter}`,
        [workspaceId, searchTerms]
      );

      const contentQuery = (() => {
        const contentQueryParams: any[] = [searchTerms];
        // Phase 2 of canonical-transcript-deprecation: search the raw
        // ai_agent_messages.searchable_text column directly. The legacy
        // ai_transcript_events index is being retired in Phase 4.
        let contentQuerySql = `SELECT DISTINCT t.session_id,
            MAX(ts_rank_cd(to_tsvector('english', COALESCE(t.searchable_text, '')), plainto_tsquery('english', $1))) as rank
          FROM ai_agent_messages t
          WHERE t.searchable_text IS NOT NULL
            AND t.message_kind IN ('user', 'assistant', 'system')
            AND to_tsvector('english', COALESCE(t.searchable_text, '')) @@ plainto_tsquery('english', $1)`;

        if (cutoffDate) {
          contentQueryParams.push(cutoffDate);
          contentQuerySql += ` AND t.created_at >= $${contentQueryParams.length}`;
        }

        if (direction === 'input') {
          contentQuerySql += ` AND t.message_kind = 'user'`;
        } else if (direction === 'output') {
          contentQuerySql += ` AND t.message_kind = 'assistant'`;
        }

        contentQuerySql += ' GROUP BY t.session_id';
        return db.query<any>(contentQuerySql, contentQueryParams);
      })();

      const [titleResult, contentResult] = await Promise.all([titleQuery, contentQuery]);

      // Add title matches
      for (const row of titleResult.rows) {
        sessionRanks.set(row.id, row.rank);
        sessionRows.set(row.id, row);
      }

      // Get content match session IDs that aren't already in title results
      const contentSessionIds = contentResult.rows
        .map((r: any) => r.session_id)
        .filter((id: string) => !sessionRows.has(id));

      // If we have content matches not in title results, fetch their session data
      if (contentSessionIds.length > 0) {
        const contentSessions = await hydrateSessions(contentSessionIds);

        // Add content matches with their ranks
        const contentRankMap = new Map<string, number>(
          contentResult.rows.map((r: any) => [r.session_id, Number(r.rank ?? 0)]),
        );
        for (const row of contentSessions) {
          const contentRank = contentRankMap.get(row.id) || 0;
          const existingRank = sessionRanks.get(row.id) || 0;
          sessionRanks.set(row.id, Math.max(existingRank, contentRank));
          if (!sessionRows.has(row.id)) {
            sessionRows.set(row.id, { ...row, rank: contentRank });
          }
        }
      }

      // Also update ranks for sessions found in both title and content
      for (const contentRow of contentResult.rows) {
        if (sessionRows.has(contentRow.session_id)) {
          const existingRank = sessionRanks.get(contentRow.session_id) || 0;
          sessionRanks.set(contentRow.session_id, Math.max(existingRank, contentRow.rank));
        }
      }
      } // end PGLite branch

      // Convert to array and sort by rank DESC, updated_at DESC
      const rows = Array.from(sessionRows.values())
        .map(row => ({ ...row, max_rank: sessionRanks.get(row.id) || row.rank }))
        .sort((a, b) => {
          if (b.max_rank !== a.max_rank) return b.max_rank - a.max_rank;
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        });

      return rows.map(row => {
        const createdAt = toMillis(row.created_at)!;
        const updatedAt = toMillis(row.updated_at)!;
        const branchedAt = toMillis(row.branched_at) ?? undefined;
        const childCount = parseInt(row.child_count) || 0;
        return {
          id: row.id,
          provider: row.provider,
          model: row.model ?? undefined,
          sessionType: row.session_type || 'session',
          mode: row.mode ?? undefined,
          agentRole: row.agent_role ?? 'standard',
          title: row.title || 'Untitled Session',
          workspaceId: row.workspace_id,
          worktreeId: row.worktree_id ?? null,
          parentSessionId: row.parent_session_id ?? null,
          createdBySessionId: row.created_by_session_id ?? null,
          childCount,
          uncommittedCount: 0,
          createdAt,
          updatedAt,
          messageCount: 0,  // Not computed in search query for performance
          isArchived: row.is_archived ?? false,
          isPinned: row.is_pinned ?? false,
          branchedFromSessionId: row.branched_from_session_id ?? undefined,
          branchPointMessageId: row.branch_point_message_id ? parseInt(row.branch_point_message_id) : undefined,
          branchedAt,
        } satisfies SessionMeta;
      });
    },

    async getBranches(sessionId: string): Promise<SessionMeta[]> {
      await ensureReady();
      // Find all sessions that were branched FROM this session (not hierarchical children)
      const { rows } = await db.query<any>(
        `SELECT s.id, s.provider, s.model, s.session_type, s.mode, s.agent_role, s.created_by_session_id, s.title, s.workspace_id,
                s.worktree_id, s.parent_session_id, s.created_at, s.updated_at, s.is_archived, s.is_pinned,
                s.branched_from_session_id, s.branch_point_message_id, s.branched_at
         FROM ai_sessions s
         WHERE s.branched_from_session_id=$1
         ORDER BY s.branched_at DESC`,
        [sessionId]
      );
      return rows.map(row => {
        const createdAt = toMillis(row.created_at)!;
        const updatedAt = toMillis(row.updated_at)!;
        const branchedAt = toMillis(row.branched_at) ?? undefined;
        return {
          id: row.id,
          provider: row.provider,
          model: row.model ?? undefined,
          sessionType: row.session_type || 'session',
          mode: row.mode ?? undefined,
          agentRole: row.agent_role ?? 'standard',
          title: row.title || 'Untitled Session',
          workspaceId: row.workspace_id,
          worktreeId: row.worktree_id ?? null,
          parentSessionId: row.parent_session_id ?? null,
          createdBySessionId: row.created_by_session_id ?? null,
          childCount: 0,  // Not computed in branch query
          uncommittedCount: 0,
          createdAt,
          updatedAt,
          messageCount: 0,
          isArchived: row.is_archived ?? false,
          isPinned: row.is_pinned ?? false,
          branchedFromSessionId: row.branched_from_session_id ?? undefined,
          branchPointMessageId: row.branch_point_message_id ? parseInt(row.branch_point_message_id) : undefined,
          branchedAt,
        } satisfies SessionMeta;
      });
    },

    async delete(sessionId: string): Promise<void> {
      await ensureReady();
      await db.query('DELETE FROM ai_sessions WHERE id=$1', [sessionId]);
    },

    async updateTitleIfNotNamed(sessionId: string, title: string): Promise<boolean> {
      await ensureReady();
      // NOTE: We intentionally do NOT update updated_at here. The updated_at timestamp
      // should only change when messages are added, so session history sorting
      // accurately reflects the last message time.
      const { rows } = await db.query<{ affected_rows: number }>(
        `UPDATE ai_sessions
         SET title = $2, has_been_named = true
         WHERE id = $1 AND (has_been_named = false OR has_been_named IS NULL)
         RETURNING 1 as affected_rows`,
        [sessionId, title]
      );
      return rows.length > 0;
    },

    // Note: claimQueuedPrompt has been moved to the new queued_prompts table
    // See PGLiteQueuedPromptsStore.ts for the new implementation
  };
  return store;
}
