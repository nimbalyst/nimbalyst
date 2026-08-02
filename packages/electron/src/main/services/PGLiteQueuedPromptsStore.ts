/**
 * PGLite implementation of QueuedPromptsStore
 *
 * Stores prompts queued from any device for execution.
 * Uses simple row-level atomic updates instead of JSONB array manipulation.
 */

import { toMillis } from '../utils/timestampUtils';
import type { PromptProvenance } from '@nimbalyst/runtime/ai/server/types';
import { randomUUID } from 'crypto';

export type QueueSettlementOutcome =
  | 'settled'
  | 'idempotent_same_claim'
  | 'stale_owner'
  | 'recovery_blocked'
  | 'terminal_conflict';

export interface QueueSettlementResult {
  outcome: QueueSettlementOutcome;
  row?: QueuedPrompt;
}

export interface QueueSweepResult {
  completed: number;
  failed: number;
  rolledBack: number;
  completedIds: string[];
  failedIds: string[];
  rolledBackIds: string[];
}

export interface QueuedPrompt {
  id: string;
  sessionId: string;
  prompt: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  attachments?: any[];
  documentContext?: {
    filePath?: string;
    content?: string;
    fileType?: string;
    /** Identifies the origin of this queued prompt (e.g. 'wakeup_resume' for ScheduleWakeup). */
    promptOrigin?: string;
    promptProvenance?: PromptProvenance;
  };
  createdAt: number;  // epoch ms
  claimedAt?: number; // epoch ms
  claimToken?: string;
  dispatchStartedAt?: number;
  settlementProvenance?: string;
  completedAt?: number; // epoch ms
  errorMessage?: string;
  deliveryClass: 'ordinary' | 'control';
  priorityRank: number;
  deliveryReady: boolean;
  producer?: string;
  idempotencyKey?: string;
  requestDigest?: string;
  controlOperation?: string;
  interruptTargetGeneration?: string;
  interruptReservationOwner?: string;
  interruptReceipt?: QueuedPromptInterruptReceipt;
}

export interface QueuedPromptInterruptReceipt {
  generation: string;
  attempted: boolean;
  success: boolean;
  method: string | null;
  error: string | null;
  nativeEntered: boolean;
  recordedAt: number;
}

export interface CreateQueuedPromptInput {
  id: string;
  sessionId: string;
  prompt: string;
  attachments?: any[];
  documentContext?: {
    filePath?: string;
    content?: string;
    fileType?: string;
    /** Identifies the origin of this queued prompt (e.g. 'wakeup_resume' for ScheduleWakeup). */
    promptOrigin?: string;
    promptProvenance?: PromptProvenance;
  };
}

export interface CreatePriorityControlQueuedPromptInput {
  id: string;
  sessionId: string;
  prompt: string;
  producer: string;
  idempotencyKey: string;
  requestDigest: string;
  controlOperation: string;
}

export interface QueuedPromptsStore {
  /** Create a new queued prompt */
  create(input: CreateQueuedPromptInput): Promise<QueuedPrompt>;

  /** Create or replay an idempotent high-priority control prompt. */
  createPriorityControlPrompt(input: CreatePriorityControlQueuedPromptInput): Promise<{
    row: QueuedPrompt;
    replayed: boolean;
  }>;

  /** Get a specific queued prompt by ID */
  get(id: string): Promise<QueuedPrompt | null>;

  /** List all queued prompts for a session */
  listForSession(sessionId: string, options?: { includeCompleted?: boolean }): Promise<QueuedPrompt[]>;

  /** List pending prompts for a session (ready to execute) */
  listPending(sessionId: string): Promise<QueuedPrompt[]>;

  /** Discover pending work after a process restart without changing row state. */
  listPendingSessionIds(options?: { deliveryClass?: 'ordinary' | 'control' }): Promise<string[]>;

  /** Current-upstream queue-driver compatibility alias. */
  listSessionIdsWithPending(): Promise<string[]>;

  /** Terminally fail every pending row when its workspace can no longer be delivered. */
  failAllPendingForSession(sessionId: string, errorMessage: string): Promise<number>;

  /** Atomically reserve the one native interrupt allowed for a control row. */
  reservePriorityInterrupt(input: {
    promptId: string;
    generation: string;
    owner: string;
  }): Promise<{ row: QueuedPrompt; reserved: boolean }>;

  /** Persist the native interrupt result before queue processing is triggered. */
  recordPriorityInterruptReceipt(input: {
    promptId: string;
    generation: string;
    receipt: QueuedPromptInterruptReceipt;
  }): Promise<QueuedPrompt>;

  /**
   * Atomically claim a pending prompt for execution.
   * Returns the prompt if successfully claimed, null if already claimed or not found.
   * This is the key atomic operation that prevents duplicate execution.
   */
  claim(id: string, expectedSessionId?: string): Promise<QueuedPrompt | null>;

  /** Atomically mark an admitted prompt as completed for its owning session. */
  /** Persist dispatch intent immediately before the provider/PTY boundary. */
  beginDispatch(id: string, expectedSessionId: string, claimToken: string): Promise<QueueSettlementResult>;

  /** Release an exact claim that failed before dispatch intent was persisted. */
  releaseClaim(id: string, expectedSessionId: string, claimToken: string): Promise<QueueSettlementResult>;

  /** Complete only the exact claim that owns the external dispatch. */
  completeAfterDispatch(id: string, expectedSessionId: string, claimToken: string): Promise<QueueSettlementResult>;

  /** Fail only the exact claim that owns the external dispatch. */
  failAfterDispatch(
    id: string,
    errorMessage: string,
    expectedSessionId: string,
    claimToken: string,
  ): Promise<QueueSettlementResult>;

  /** Atomically replace the contents of an admitted pending prompt. */
  replacePending(input: CreateQueuedPromptInput): Promise<QueuedPrompt | null>;

  /** Delete only an admitted pending prompt owned by the expected session. */
  deletePending(id: string, expectedSessionId: string): Promise<boolean>;

  /** Current-upstream explicit row deletion compatibility. */
  delete(id: string): Promise<void>;

  /**
   * Reset any rows stuck in 'executing' back to 'pending' for the given
   * session. Used on interrupt/cancel and at app startup so a hang or
   * crash mid-execute can't leave a prompt permanently invisible to
   * listPending. Returns the number of rows that were rolled back. Pass
   * sessionId='*' (or use rollbackAllExecuting) to sweep every session.
   */
  rollbackExecuting(sessionId: string): Promise<number>;

  /**
   * Reset every row stuck in 'executing' back to 'pending'. Intended for
   * the one-shot recovery sweep at app startup.
   */
  rollbackAllExecuting(): Promise<number>;

  /**
   * Boot-time sweep over `executing` rows that distinguishes "delivered but
   * agent was still paused at quit" from "crashed before delivery."
   *
   * Why: a queued prompt is in `executing` for the entire duration of an
   * agent turn, including while the agent is paused on AskUserQuestion /
   * ExitPlanMode / permission requests. A naive rollback to `pending`
   * causes the prompt to be re-claimed and re-sent on the next session
   * activation, duplicating the original user input. We instead check
   * whether the prompt was already injected into the conversation by
   * looking for an `ai_agent_messages` input row in the same session
   * dated at or after `claimed_at`, AND whether the agent produced any
   * output row after the claim. Delivered and answered -> `completed`.
   * Delivered but never answered (input row only, e.g. the provider was
   * SIGTERM'd mid-turn at quit, #783) -> `failed` with an error message,
   * a visible terminal state; never `pending`, because a re-claim would
   * re-send the already-delivered input (NIM-615). Not delivered ->
   * roll back to `pending` so a retry can pick it up (genuine crash
   * before send).
   *
   * Returns the count of rows in each bucket.
   */
  sweepExecutingOnBoot(): Promise<QueueSweepResult>;

  /**
   * Delivery-aware single-session variant of the boot sweep. Used by
   * the cancel / interrupt / mobile-sync paths instead of the bare
   * `rollbackExecuting`. Same rationale: clicking cancel mid-turn does
   * not undo the user message that has already landed in
   * `ai_agent_messages`. Rolling such a row back to `pending` causes
   * the queue trigger that follows the abort to immediately re-claim
   * and re-send it, duplicating the input. Mark answered rows
   * `completed`, delivered-but-unanswered rows `failed` (#790: an
   * interrupt sweep used to mark those completed and the session looked
   * silently answered); roll back only rows that never made it to the
   * conversation.
   */
  sweepExecutingForSession(sessionId: string): Promise<QueueSweepResult>;

  /** Delete all completed/failed prompts older than a certain age */
  cleanup(olderThanMs: number): Promise<number>;
}

type PGliteLike = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
};

type EnsureReadyFn = () => Promise<void>;

export const SWEEP_UNANSWERED_ERROR =
  'Prompt was delivered but the turn was interrupted before a response was recorded. Send it again to retry.';

const PROVENANCE_DISPATCH_STARTED = 'dispatch_started';
const PROVENANCE_DISPATCH_COMPLETED = 'dispatch_completed';
const PROVENANCE_DISPATCH_FAILED = 'dispatch_failed';
const PROVENANCE_SWEEP_INTERRUPT = 'sweep_interrupt';
const PROVENANCE_SWEEP_BOOT = 'sweep_boot';

function rowToQueuedPrompt(row: any): QueuedPrompt {
  // Parse JSONB fields
  let attachments = row.attachments;
  if (typeof attachments === 'string') {
    try {
      attachments = JSON.parse(attachments);
    } catch {
      attachments = undefined;
    }
  }

  let documentContext = row.document_context;
  if (typeof documentContext === 'string') {
    try {
      documentContext = JSON.parse(documentContext);
    } catch {
      documentContext = undefined;
    }
  }

  let interruptReceipt = row.interrupt_receipt;
  if (typeof interruptReceipt === 'string') {
    try {
      interruptReceipt = JSON.parse(interruptReceipt);
    } catch {
      interruptReceipt = undefined;
    }
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    prompt: row.prompt,
    status: row.status,
    attachments,
    documentContext,
    createdAt: toMillis(row.created_at)!,
    claimedAt: toMillis(row.claimed_at) ?? undefined,
    claimToken: row.claim_token || undefined,
    dispatchStartedAt: toMillis(row.dispatch_started_at) ?? undefined,
    settlementProvenance: row.settlement_provenance || undefined,
    completedAt: toMillis(row.completed_at) ?? undefined,
    errorMessage: row.error_message || undefined,
    deliveryClass: row.delivery_class === 'control' ? 'control' : 'ordinary',
    priorityRank: Number(row.priority_rank ?? 0),
    deliveryReady: row.delivery_ready !== false && row.delivery_ready !== 0,
    producer: row.producer || undefined,
    idempotencyKey: row.idempotency_key || undefined,
    requestDigest: row.request_digest || undefined,
    controlOperation: row.control_operation || undefined,
    interruptTargetGeneration: row.interrupt_target_generation || undefined,
    interruptReservationOwner: row.interrupt_reservation_owner || undefined,
    interruptReceipt: interruptReceipt || undefined,
  };
}

export function createPGLiteQueuedPromptsStore(
  db: PGliteLike,
  ensureDbReady?: EnsureReadyFn
): QueuedPromptsStore {
  let dialectPromise: Promise<'pglite' | 'sqlite'> | null = null;
  const ensureReady = async () => {
    if (ensureDbReady) {
      await ensureDbReady();
    }
  };

  const getDialect = (): Promise<'pglite' | 'sqlite'> => {
    if (!dialectPromise) {
      const probePromise = (async () => {
        try {
          const probe = await db.query<{ kind: string }>(
            `SELECT jsonb_typeof('{}'::jsonb) AS kind`,
          );
          if (probe.rows[0]?.kind === 'object') return 'pglite';
        } catch (pgliteError) {
          try {
            const probe = await db.query<{ valid: number | boolean }>(
              `SELECT json_valid('{}') AS valid`,
            );
            if (probe.rows[0]?.valid === 1 || probe.rows[0]?.valid === true) return 'sqlite';
          } catch {
            // Preserve the first backend/readability failure. No queue state
            // has changed, so callers fail closed without an ambiguous claim.
            throw pgliteError;
          }
        }
        throw new Error('Unable to determine queued-prompts database dialect');
      })();
      dialectPromise = probePromise;
      void probePromise.catch(() => {
        // A transient database outage must fail this claim closed without
        // poisoning the store singleton forever. A later recovery gets a new
        // read-only dialect probe before retrying the atomic UPDATE.
        if (dialectPromise === probePromise) dialectPromise = null;
      });
    }
    return dialectPromise;
  };

  const getMetadataReadyClause = async (): Promise<string> => {
    const dialect = await getDialect();
    return dialect === 'sqlite'
      ? `(
           s.metadata IS NULL
           OR CASE
                WHEN json_valid(s.metadata) = 1 THEN
                  json_type(s.metadata) = 'object'
                  AND (
                    json_type(s.metadata, '$.modelChangeReconciliation') IS NULL
                    OR json_type(s.metadata, '$.modelChangeReconciliation') = 'null'
                  )
                ELSE FALSE
              END
         )`
      : `(
           s.metadata IS NULL
           OR (
             jsonb_typeof(s.metadata) = 'object'
             AND (
               s.metadata->'modelChangeReconciliation' IS NULL
               OR s.metadata->'modelChangeReconciliation' = 'null'::jsonb
             )
           )
         )`;
  };

  const classifyMutationMiss = async (
    id: string,
    expectedSessionId: string,
    claimToken: string,
    isIdempotent: (row: QueuedPrompt) => boolean,
  ): Promise<QueueSettlementResult> => {
    const metadataReadyClause = await getMetadataReadyClause();
    const { rows } = await db.query<any>(
      `SELECT q.*,
              EXISTS (
                SELECT 1
                FROM ai_sessions s
                WHERE s.id = q.session_id
                  AND ${metadataReadyClause}
              ) AS metadata_ready
       FROM queued_prompts q
       WHERE q.id = $1
       LIMIT 1`,
      [id],
    );
    const raw = rows[0];
    if (!raw || raw.session_id !== expectedSessionId || raw.claim_token !== claimToken) {
      return { outcome: 'stale_owner' };
    }
    const row = rowToQueuedPrompt(raw);
    if (raw.metadata_ready === false || raw.metadata_ready === 0) {
      return { outcome: 'recovery_blocked', row };
    }
    if (isIdempotent(row)) {
      return { outcome: 'idempotent_same_claim', row };
    }
    return { outcome: 'terminal_conflict', row };
  };

  const sweepExecuting = async (
    sessionId: string | null,
    provenance: typeof PROVENANCE_SWEEP_INTERRUPT | typeof PROVENANCE_SWEEP_BOOT,
  ): Promise<QueueSweepResult> => {
    await ensureReady();
    const metadataReadyClause = await getMetadataReadyClause();
    const { rows } = await db.query<{ id: string; status: QueuedPrompt['status'] }>(
      `UPDATE queued_prompts
       SET status = CASE WHEN dispatch_started_at IS NULL THEN 'pending' ELSE 'failed' END,
           claimed_at = CASE WHEN dispatch_started_at IS NULL THEN NULL ELSE claimed_at END,
           claim_token = CASE WHEN dispatch_started_at IS NULL THEN NULL ELSE claim_token END,
           completed_at = CASE WHEN dispatch_started_at IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
           error_message = CASE WHEN dispatch_started_at IS NULL THEN NULL ELSE $3 END,
           settlement_provenance = CASE WHEN dispatch_started_at IS NULL THEN NULL ELSE $2 END
       WHERE status = 'executing'
         AND claim_token IS NOT NULL
         AND ($1::text IS NULL OR session_id = $1::text)
         AND EXISTS (
           SELECT 1
           FROM ai_sessions s
           WHERE s.id = queued_prompts.session_id
             AND ${metadataReadyClause}
         )
       RETURNING id, status`,
      [sessionId, provenance, SWEEP_UNANSWERED_ERROR],
    );
    const failedIds = rows.filter((row) => row.status === 'failed').map((row) => row.id);
    const rolledBackIds = rows.filter((row) => row.status === 'pending').map((row) => row.id);
    return {
      completed: 0,
      failed: failedIds.length,
      rolledBack: rolledBackIds.length,
      completedIds: [],
      failedIds,
      rolledBackIds,
    };
  };

  return {
    async create(input: CreateQueuedPromptInput): Promise<QueuedPrompt> {
      await ensureReady();
      const metadataReadyClause = await getMetadataReadyClause();

      const { rows } = await db.query<any>(
        `INSERT INTO queued_prompts (id, session_id, prompt, attachments, document_context)
         SELECT $1, $2, $3, $4, $5
         FROM ai_sessions s
         WHERE s.id = $2
           AND ${metadataReadyClause}
         RETURNING *`,
        [
          input.id,
          input.sessionId,
          input.prompt,
          input.attachments ? JSON.stringify(input.attachments) : null,
          input.documentContext ? JSON.stringify(input.documentContext) : null,
        ]
      );

      if (rows.length === 0) {
        throw new Error('Queued prompt creation was not admitted');
      }

      console.log(`[QueuedPromptsStore] Created prompt ${input.id} for session ${input.sessionId}`);
      return rowToQueuedPrompt(rows[0]);
    },

    async createPriorityControlPrompt(
      input: CreatePriorityControlQueuedPromptInput
    ): Promise<{ row: QueuedPrompt; replayed: boolean }> {
      await ensureReady();

      const { rows } = await db.query<any>(
        `INSERT INTO queued_prompts (
           id, session_id, prompt, delivery_class, priority_rank, delivery_ready, producer,
           idempotency_key, request_digest, control_operation
         )
         VALUES ($1, $2, $3, 'control', 100, FALSE, $4, $5, $6, $7)
         ON CONFLICT (session_id, idempotency_key)
           WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING *`,
        [
          input.id,
          input.sessionId,
          input.prompt,
          input.producer,
          input.idempotencyKey,
          input.requestDigest,
          input.controlOperation,
        ]
      );

      if (rows.length > 0) {
        return { row: rowToQueuedPrompt(rows[0]), replayed: false };
      }

      const existing = await db.query<any>(
        `SELECT * FROM queued_prompts
         WHERE session_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [input.sessionId, input.idempotencyKey]
      );
      if (existing.rows.length === 0) {
        throw new Error('Failed to create or replay priority control prompt');
      }
      if (existing.rows[0].request_digest !== input.requestDigest) {
        throw new Error('idempotency_conflict: key was already used for a different request');
      }
      return { row: rowToQueuedPrompt(existing.rows[0]), replayed: true };
    },

    async get(id: string): Promise<QueuedPrompt | null> {
      await ensureReady();

      const { rows } = await db.query<any>(
        `SELECT * FROM queued_prompts WHERE id = $1`,
        [id]
      );

      return rows.length > 0 ? rowToQueuedPrompt(rows[0]) : null;
    },

    async listForSession(
      sessionId: string,
      options?: { includeCompleted?: boolean }
    ): Promise<QueuedPrompt[]> {
      await ensureReady();

      const includeCompleted = options?.includeCompleted ?? false;

      let query = `SELECT * FROM queued_prompts WHERE session_id = $1`;
      if (!includeCompleted) {
        query += ` AND status NOT IN ('completed', 'failed')`;
      }
      query += ` ORDER BY priority_rank DESC, created_at ASC, id ASC`;

      const { rows } = await db.query<any>(query, [sessionId]);
      return rows.map(rowToQueuedPrompt);
    },

    async listPending(sessionId: string): Promise<QueuedPrompt[]> {
      await ensureReady();

      const { rows } = await db.query<any>(
        `SELECT * FROM queued_prompts
         WHERE session_id = $1 AND status = 'pending' AND delivery_ready = TRUE
         ORDER BY priority_rank DESC, created_at ASC, id ASC`,
        [sessionId]
      );

      return rows.map(rowToQueuedPrompt);
    },

    async listSessionIdsWithPending(): Promise<string[]> {
      await ensureReady();
      const { rows } = await db.query<{ session_id: string }>(
        `SELECT DISTINCT session_id FROM queued_prompts WHERE status = 'pending'`,
      );
      return rows.map((row) => row.session_id);
    },

    async failAllPendingForSession(sessionId: string, errorMessage: string): Promise<number> {
      await ensureReady();
      const { rows } = await db.query<{ id: string }>(
        `UPDATE queued_prompts
         SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error_message = $2
         WHERE session_id = $1 AND status = 'pending'
         RETURNING id`,
        [sessionId, errorMessage],
      );
      return rows.length;
    },

    async listPendingSessionIds(
      options?: { deliveryClass?: 'ordinary' | 'control' }
    ): Promise<string[]> {
      await ensureReady();

      const deliveryClass = options?.deliveryClass;
      const { rows } = await db.query<{ session_id: string }>(
        `SELECT session_id
         FROM queued_prompts
         WHERE status = 'pending' AND delivery_ready = TRUE
           AND ($1 IS NULL OR delivery_class = $1)
         GROUP BY session_id
         ORDER BY MIN(created_at) ASC, session_id ASC`,
        [deliveryClass ?? null]
      );
      return rows.map((row) => row.session_id);
    },

    async reservePriorityInterrupt(input): Promise<{ row: QueuedPrompt; reserved: boolean }> {
      await ensureReady();

      let rows: any[] = [];
      try {
        const result = await db.query<any>(
          `UPDATE queued_prompts AS target
           SET interrupt_target_generation = $2,
               interrupt_reservation_owner = $3
           WHERE target.id = $1
             AND target.delivery_class = 'control'
             AND target.interrupt_receipt IS NULL
             AND target.interrupt_reservation_owner IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM queued_prompts AS incumbent
               WHERE incumbent.session_id = target.session_id
                 AND incumbent.interrupt_target_generation = $2
                 AND incumbent.id <> target.id
             )
           RETURNING *`,
          [input.promptId, input.generation, input.owner]
        );
        rows = result.rows;
      } catch (error) {
        const code = (error as { code?: string })?.code;
        const message = error instanceof Error ? error.message : String(error);
        if (code !== '23505' && code !== 'SQLITE_CONSTRAINT_UNIQUE' && !/unique|duplicate/i.test(message)) {
          throw error;
        }
        // A concurrent row won the unique (session,generation) fence.
      }
      if (rows.length > 0) {
        return { row: rowToQueuedPrompt(rows[0]), reserved: true };
      }

      await db.query<any>(
        `UPDATE queued_prompts AS target
         SET interrupt_reservation_owner = incumbent.interrupt_reservation_owner,
             interrupt_receipt = incumbent.interrupt_receipt,
             delivery_ready = CASE
               WHEN incumbent.interrupt_receipt IS NULL THEN target.delivery_ready
               ELSE incumbent.delivery_ready
             END
         FROM queued_prompts AS incumbent
         WHERE target.id = $1
           AND target.delivery_class = 'control'
           AND target.interrupt_target_generation IS NULL
           AND target.interrupt_reservation_owner IS NULL
           AND target.interrupt_receipt IS NULL
           AND incumbent.session_id = target.session_id
           AND incumbent.interrupt_target_generation = $2
           AND incumbent.interrupt_reservation_owner IS NOT NULL
           AND incumbent.id <> target.id`,
        [input.promptId, input.generation]
      );

      const existing = await db.query<any>(
        `SELECT * FROM queued_prompts WHERE id = $1 LIMIT 1`,
        [input.promptId]
      );
      if (existing.rows.length === 0) {
        throw new Error(`Priority control prompt ${input.promptId} not found`);
      }
      return { row: rowToQueuedPrompt(existing.rows[0]), reserved: false };
    },

    async recordPriorityInterruptReceipt(input): Promise<QueuedPrompt> {
      await ensureReady();

      const reservation = await db.query<any>(
        `SELECT * FROM queued_prompts
         WHERE id = $1
           AND interrupt_target_generation = $2
         LIMIT 1`,
        [input.promptId, input.generation]
      );
      if (reservation.rows.length === 0) {
        throw new Error('Failed to record priority interrupt receipt');
      }
      const reservedRow = rowToQueuedPrompt(reservation.rows[0]);
      if (reservedRow.interruptReceipt) {
        return reservedRow;
      }
      if (!reservedRow.interruptReservationOwner) {
        throw new Error('Failed to record priority interrupt receipt');
      }

      const { rows } = await db.query<any>(
        `UPDATE queued_prompts
         SET interrupt_receipt = $3,
             delivery_ready = $4
         WHERE session_id = $5
           AND interrupt_reservation_owner = $6
           AND interrupt_receipt IS NULL
           AND (
             (id = $1 AND interrupt_target_generation = $2)
             OR (id <> $1 AND interrupt_target_generation IS NULL)
           )
         RETURNING *`,
        [
          input.promptId,
          input.generation,
          JSON.stringify(input.receipt),
          input.receipt.success,
          reservedRow.sessionId,
          reservedRow.interruptReservationOwner,
        ]
      );
      const winner = rows.find((row) => row.id === input.promptId);
      if (winner) {
        return rowToQueuedPrompt(winner);
      }
      const existing = await db.query<any>(
        `SELECT * FROM queued_prompts WHERE id = $1 LIMIT 1`,
        [input.promptId]
      );
      if (existing.rows.length === 0) {
        throw new Error(`Priority control prompt ${input.promptId} not found`);
      }
      const row = rowToQueuedPrompt(existing.rows[0]);
      if (
        row.interruptTargetGeneration !== input.generation
        || !row.interruptReceipt
      ) {
        throw new Error('Failed to record priority interrupt receipt');
      }
      return row;
    },

    async claim(id: string, expectedSessionId?: string): Promise<QueuedPrompt | null> {
      await ensureReady();

      const metadataReadyClause = await getMetadataReadyClause();
      const claimToken = randomUUID();

      // One UPDATE owns both queue reservation and durable recovery admission.
      // The authoritative session comes from the row itself; expectedSessionId
      // additionally prevents a public caller from claiming another session's
      // row. A missing/unreadable session, malformed metadata, pending marker,
      // lost delivery readiness, or concurrent claimant leaves the row pending.
      const { rows } = await db.query<any>(
        `UPDATE queued_prompts
         SET status = 'executing',
             claimed_at = CURRENT_TIMESTAMP,
             claim_token = $3,
             dispatch_started_at = NULL,
             settlement_provenance = NULL,
             completed_at = NULL,
             error_message = NULL
         WHERE id = $1
           AND status = 'pending'
           AND delivery_ready = TRUE
           AND ($2::text IS NULL OR session_id = $2::text)
           AND EXISTS (
             SELECT 1
             FROM ai_sessions s
             WHERE s.id = queued_prompts.session_id
               AND ${metadataReadyClause}
           )
         RETURNING *`,
        [id, expectedSessionId ?? null, claimToken]
      );

      if (rows.length === 0) {
        console.log(`[QueuedPromptsStore] claim: prompt ${id} not found or already claimed`);
        return null;
      }

      console.log(`[QueuedPromptsStore] claim: successfully claimed prompt ${id}`);
      return rowToQueuedPrompt(rows[0]);
    },

    async beginDispatch(
      id: string,
      expectedSessionId: string,
      claimToken: string,
    ): Promise<QueueSettlementResult> {
      await ensureReady();
      const metadataReadyClause = await getMetadataReadyClause();
      const { rows } = await db.query<any>(
        `UPDATE queued_prompts
         SET dispatch_started_at = CURRENT_TIMESTAMP,
             settlement_provenance = $4
         WHERE id = $1
           AND session_id = $2::text
           AND claim_token = $3
           AND status = 'executing'
           AND dispatch_started_at IS NULL
           AND EXISTS (
             SELECT 1 FROM ai_sessions s
             WHERE s.id = queued_prompts.session_id
               AND ${metadataReadyClause}
           )
         RETURNING *`,
        [id, expectedSessionId, claimToken, PROVENANCE_DISPATCH_STARTED],
      );
      if (rows.length > 0) return { outcome: 'settled', row: rowToQueuedPrompt(rows[0]) };
      return classifyMutationMiss(
        id,
        expectedSessionId,
        claimToken,
        (row) => row.status === 'executing' && row.dispatchStartedAt !== undefined,
      );
    },

    async releaseClaim(
      id: string,
      expectedSessionId: string,
      claimToken: string,
    ): Promise<QueueSettlementResult> {
      await ensureReady();
      const metadataReadyClause = await getMetadataReadyClause();
      const { rows } = await db.query<any>(
        `UPDATE queued_prompts
         SET status = 'pending',
             claimed_at = NULL,
             claim_token = NULL,
             dispatch_started_at = NULL,
             settlement_provenance = NULL,
             completed_at = NULL,
             error_message = NULL
         WHERE id = $1
           AND session_id = $2::text
           AND claim_token = $3
           AND status = 'executing'
           AND dispatch_started_at IS NULL
           AND EXISTS (
             SELECT 1 FROM ai_sessions s
             WHERE s.id = queued_prompts.session_id
               AND ${metadataReadyClause}
           )
         RETURNING *`,
        [id, expectedSessionId, claimToken],
      );
      if (rows.length > 0) return { outcome: 'settled', row: rowToQueuedPrompt(rows[0]) };
      return classifyMutationMiss(id, expectedSessionId, claimToken, () => false);
    },

    async completeAfterDispatch(
      id: string,
      expectedSessionId: string,
      claimToken: string,
    ): Promise<QueueSettlementResult> {
      await ensureReady();
      const metadataReadyClause = await getMetadataReadyClause();
      const { rows } = await db.query<any>(
        `UPDATE queued_prompts
         SET status = 'completed',
             completed_at = CURRENT_TIMESTAMP,
             error_message = NULL,
             settlement_provenance = $4
         WHERE id = $1
           AND session_id = $2::text
           AND claim_token = $3
           AND dispatch_started_at IS NOT NULL
           AND (
             status = 'executing'
             OR (
               status = 'failed'
               AND settlement_provenance IN ($5, $6)
             )
           )
           AND EXISTS (
             SELECT 1 FROM ai_sessions s
             WHERE s.id = queued_prompts.session_id
               AND ${metadataReadyClause}
           )
         RETURNING *`,
        [
          id,
          expectedSessionId,
          claimToken,
          PROVENANCE_DISPATCH_COMPLETED,
          PROVENANCE_SWEEP_INTERRUPT,
          PROVENANCE_SWEEP_BOOT,
        ],
      );
      if (rows.length > 0) return { outcome: 'settled', row: rowToQueuedPrompt(rows[0]) };
      return classifyMutationMiss(
        id,
        expectedSessionId,
        claimToken,
        (row) => row.status === 'completed' && row.settlementProvenance === PROVENANCE_DISPATCH_COMPLETED,
      );
    },

    async failAfterDispatch(
      id: string,
      errorMessage: string,
      expectedSessionId: string,
      claimToken: string,
    ): Promise<QueueSettlementResult> {
      await ensureReady();
      const metadataReadyClause = await getMetadataReadyClause();
      const { rows } = await db.query<any>(
        `UPDATE queued_prompts
         SET status = 'failed',
             completed_at = CURRENT_TIMESTAMP,
             error_message = $4,
             settlement_provenance = $5
         WHERE id = $1
           AND session_id = $2::text
           AND claim_token = $3
           AND status = 'executing'
           AND dispatch_started_at IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM ai_sessions s
             WHERE s.id = queued_prompts.session_id
               AND ${metadataReadyClause}
           )
         RETURNING *`,
        [id, expectedSessionId, claimToken, errorMessage, PROVENANCE_DISPATCH_FAILED],
      );
      if (rows.length > 0) return { outcome: 'settled', row: rowToQueuedPrompt(rows[0]) };
      return classifyMutationMiss(
        id,
        expectedSessionId,
        claimToken,
        (row) => row.status === 'failed' && row.settlementProvenance === PROVENANCE_DISPATCH_FAILED,
      );
    },

    async replacePending(input: CreateQueuedPromptInput): Promise<QueuedPrompt | null> {
      await ensureReady();
      const metadataReadyClause = await getMetadataReadyClause();
      const { rows } = await db.query<any>(
        `UPDATE queued_prompts
         SET prompt = $3,
             attachments = $4,
             document_context = $5
         WHERE id = $1
           AND session_id = $2::text
           AND status = 'pending'
           AND EXISTS (
             SELECT 1 FROM ai_sessions s
             WHERE s.id = queued_prompts.session_id
               AND ${metadataReadyClause}
           )
         RETURNING *`,
        [
          input.id,
          input.sessionId,
          input.prompt,
          input.attachments !== undefined ? JSON.stringify(input.attachments) : null,
          input.documentContext !== undefined ? JSON.stringify(input.documentContext) : null,
        ],
      );
      return rows.length > 0 ? rowToQueuedPrompt(rows[0]) : null;
    },

    async deletePending(id: string, expectedSessionId: string): Promise<boolean> {
      await ensureReady();
      const metadataReadyClause = await getMetadataReadyClause();
      const { rows } = await db.query<{ id: string }>(
        `DELETE FROM queued_prompts
         WHERE id = $1
           AND session_id = $2::text
           AND status = 'pending'
           AND EXISTS (
             SELECT 1 FROM ai_sessions s
             WHERE s.id = queued_prompts.session_id
               AND ${metadataReadyClause}
           )
         RETURNING id`,
        [id, expectedSessionId],
      );
      return rows.length > 0;
    },

    async delete(id: string): Promise<void> {
      await ensureReady();
      await db.query(`DELETE FROM queued_prompts WHERE id = $1`, [id]);
    },

    async rollbackExecuting(sessionId: string): Promise<number> {
      const result = await sweepExecuting(sessionId, PROVENANCE_SWEEP_INTERRUPT);
      return result.rolledBack;
    },

    async rollbackAllExecuting(): Promise<number> {
      const result = await sweepExecuting(null, PROVENANCE_SWEEP_BOOT);
      return result.rolledBack;
    },

    async sweepExecutingOnBoot(): Promise<QueueSweepResult> {
      return sweepExecuting(null, PROVENANCE_SWEEP_BOOT);
    },

    async sweepExecutingForSession(sessionId: string): Promise<QueueSweepResult> {
      return sweepExecuting(sessionId, PROVENANCE_SWEEP_INTERRUPT);
    },

    async cleanup(olderThanMs: number): Promise<number> {
      await ensureReady();

      const cutoffDate = new Date(Date.now() - olderThanMs);

      const { rows } = await db.query<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM queued_prompts
           WHERE status IN ('completed', 'failed')
             AND completed_at < $1
           RETURNING 1
         )
         SELECT COUNT(*) as count FROM deleted`,
        [cutoffDate]
      );

      const count = parseInt(rows[0]?.count || '0', 10);
      if (count > 0) {
        console.log(`[QueuedPromptsStore] Cleaned up ${count} old prompts`);
      }

      return count;
    },
  };
}
