/**
 * PGLite implementation of QueuedPromptsStore
 *
 * Stores prompts queued from any device for execution.
 * Uses simple row-level atomic updates instead of JSONB array manipulation.
 */

import { createHash, randomUUID } from 'crypto';
import { toMillis } from '../utils/timestampUtils';

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
  };
  createdAt: number;  // epoch ms
  claimedAt?: number; // epoch ms
  completedAt?: number; // epoch ms
  errorMessage?: string;
  deliveryClass?: 'ordinary' | 'control';
  priorityRank?: number;
  producer?: string;
  idempotencyKey?: string;
  requestDigest?: string;
  controlOperation?: string;
  interruptTargetGeneration?: string;
  interruptReceipt?: unknown;
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
  };
}

export interface QueuedPromptsStore {
  /** Create a new queued prompt */
  create(input: CreateQueuedPromptInput): Promise<QueuedPrompt>;

  /** Create or replay one host-owned priority control prompt. */
  createPriorityControlQueuedPrompt(input: {
    sessionId: string;
    prompt: string;
    idempotencyKey: string;
    producer: string;
    controlOperation: string;
  }): Promise<QueuedPrompt>;

  /** Get a specific queued prompt by ID */
  get(id: string): Promise<QueuedPrompt | null>;

  /** Get a queued prompt by its non-null idempotency key. */
  getByIdempotencyKey(key: string): Promise<QueuedPrompt | null>;

  /** Atomically reserve the row's first generation-bound interrupt attempt. */
  reserveInterrupt(input: {
    id: string;
    expectedGeneration: string;
  }): Promise<{ reserved: boolean; row: QueuedPrompt }>;

  /** Persist one bounded interrupt attempt receipt. */
  recordInterruptReceipt(input: { id: string; receipt: unknown }): Promise<QueuedPrompt>;

  /** List all queued prompts for a session */
  listForSession(sessionId: string, options?: { includeCompleted?: boolean }): Promise<QueuedPrompt[]>;

  /** List pending prompts for a session (ready to execute) */
  listPending(sessionId: string): Promise<QueuedPrompt[]>;

  /**
   * Atomically claim a pending prompt for execution.
   * Returns the prompt if successfully claimed, null if already claimed or not found.
   * This is the key atomic operation that prevents duplicate execution.
   */
  claim(id: string): Promise<QueuedPrompt | null>;

  /** Mark a prompt as completed */
  complete(id: string): Promise<void>;

  /** Mark a prompt as failed with an error message */
  fail(id: string, errorMessage: string): Promise<void>;

  /** Delete a queued prompt */
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
  sweepExecutingOnBoot(): Promise<{ completed: number; failed: number; rolledBack: number }>;

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
  sweepExecutingForSession(sessionId: string): Promise<{ completed: number; failed: number; rolledBack: number }>;

  /** Delete all completed/failed prompts older than a certain age */
  cleanup(olderThanMs: number): Promise<number>;
}

type PGliteLike = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
};

type EnsureReadyFn = () => Promise<void>;

/**
 * error_message written by the sweep passes for prompts that were
 * delivered (input row logged) but got no agent output before the turn
 * died (app quit / provider interrupt). Deliberately phrased so a user
 * reading the row knows the recovery action.
 */
const SWEEP_UNANSWERED_ERROR =
  'Prompt was delivered but the turn was interrupted before a response was recorded. Send it again to retry.';

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
    completedAt: toMillis(row.completed_at) ?? undefined,
    errorMessage: row.error_message || undefined,
    deliveryClass: row.delivery_class ?? 'ordinary',
    priorityRank: Number(row.priority_rank ?? 0),
    producer: row.producer || undefined,
    idempotencyKey: row.idempotency_key || undefined,
    requestDigest: row.request_digest || undefined,
    controlOperation: row.control_operation || undefined,
    interruptTargetGeneration: row.interrupt_target_generation || undefined,
    interruptReceipt,
  };
}

export function createPGLiteQueuedPromptsStore(
  db: PGliteLike,
  ensureDbReady?: EnsureReadyFn
): QueuedPromptsStore {
  const ensureReady = async () => {
    if (ensureDbReady) {
      await ensureDbReady();
    }
  };

  return {
    async create(input: CreateQueuedPromptInput): Promise<QueuedPrompt> {
      await ensureReady();

      const { rows } = await db.query<any>(
        `INSERT INTO queued_prompts (
           id, session_id, prompt, attachments, document_context,
           delivery_class, priority_rank)
         VALUES ($1, $2, $3, $4, $5, 'ordinary', 0)
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
        throw new Error('Failed to create queued prompt');
      }

      console.log(`[QueuedPromptsStore] Created prompt ${input.id} for session ${input.sessionId}`);
      return rowToQueuedPrompt(rows[0]);
    },

    async createPriorityControlQueuedPrompt(input): Promise<QueuedPrompt> {
      await ensureReady();

      const canonicalJson = JSON.stringify({
        sessionId: input.sessionId,
        prompt: input.prompt,
        producer: input.producer,
        controlOperation: input.controlOperation,
      });
      const requestDigest = createHash('sha256').update(canonicalJson).digest('hex');

      // The partial unique index is the serialization point. Matching retries
      // take the no-op update path and return the existing row; a mismatched
      // request fails the UPDATE predicate and therefore returns no row.
      const { rows } = await db.query<any>(
        `INSERT INTO queued_prompts (
           id, session_id, prompt, delivery_class, priority_rank,
           producer, idempotency_key, control_operation, request_digest)
         VALUES ($1, $2, $3, 'control', 100, $4, $5, $6, $7)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
         DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
         WHERE queued_prompts.request_digest = EXCLUDED.request_digest
         RETURNING *`,
        [
          `control-${randomUUID()}`,
          input.sessionId,
          input.prompt,
          input.producer,
          input.idempotencyKey,
          input.controlOperation,
          requestDigest,
        ]
      );

      if (rows.length === 0) {
        throw new Error(`idempotency_conflict:${input.idempotencyKey}`);
      }

      return rowToQueuedPrompt(rows[0]);
    },

    async get(id: string): Promise<QueuedPrompt | null> {
      await ensureReady();

      const { rows } = await db.query<any>(
        `SELECT * FROM queued_prompts WHERE id = $1`,
        [id]
      );

      return rows.length > 0 ? rowToQueuedPrompt(rows[0]) : null;
    },

    async getByIdempotencyKey(key: string): Promise<QueuedPrompt | null> {
      await ensureReady();

      const { rows } = await db.query<any>(
        `SELECT * FROM queued_prompts WHERE idempotency_key = $1`,
        [key]
      );

      return rows.length > 0 ? rowToQueuedPrompt(rows[0]) : null;
    },

    async reserveInterrupt(input): Promise<{ reserved: boolean; row: QueuedPrompt }> {
      await ensureReady();

      const { rows } = await db.query<any>(
        `UPDATE queued_prompts
         SET interrupt_target_generation = $2
         WHERE id = $1 AND interrupt_target_generation IS NULL
         RETURNING *`,
        [input.id, input.expectedGeneration]
      );

      if (rows.length > 0) {
        return { reserved: true, row: rowToQueuedPrompt(rows[0]) };
      }

      const current = await db.query<any>(
        `SELECT * FROM queued_prompts WHERE id = $1`,
        [input.id]
      );
      if (current.rows.length === 0) {
        throw new Error(`Cannot reserve interrupt: queued prompt ${input.id} does not exist`);
      }

      return { reserved: false, row: rowToQueuedPrompt(current.rows[0]) };
    },

    async recordInterruptReceipt(input): Promise<QueuedPrompt> {
      await ensureReady();

      let serializedReceipt: string;
      try {
        const serialized = JSON.stringify(input.receipt);
        if (serialized === undefined) {
          throw new Error('receipt is not JSON-serializable');
        }
        serializedReceipt = serialized;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot record interrupt receipt: ${message}`);
      }

      const receiptSizeBytes = Buffer.byteLength(serializedReceipt, 'utf8');
      if (receiptSizeBytes > 4096) {
        throw new Error(`Cannot record interrupt receipt: serialized receipt exceeds 4096 bytes (${receiptSizeBytes} bytes)`);
      }

      const { rows } = await db.query<any>(
        `UPDATE queued_prompts
         SET interrupt_receipt = $2
         WHERE id = $1
         RETURNING *`,
        [input.id, serializedReceipt]
      );

      if (rows.length === 0) {
        throw new Error(`Cannot record interrupt receipt: queued prompt ${input.id} does not exist`);
      }

      return rowToQueuedPrompt(rows[0]);
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
      query += ` ORDER BY created_at ASC`;

      const { rows } = await db.query<any>(query, [sessionId]);
      return rows.map(rowToQueuedPrompt);
    },

    async listPending(sessionId: string): Promise<QueuedPrompt[]> {
      await ensureReady();

      const { rows } = await db.query<any>(
        `SELECT * FROM queued_prompts
         WHERE session_id = $1 AND status = 'pending'
         ORDER BY priority_rank DESC, created_at ASC, id ASC`,
        [sessionId]
      );

      return rows.map(rowToQueuedPrompt);
    },

    async claim(id: string): Promise<QueuedPrompt | null> {
      await ensureReady();

      // ATOMIC: Only update if status is still 'pending'
      // This is the key operation that prevents duplicate execution
      const { rows } = await db.query<any>(
        `UPDATE queued_prompts
         SET status = 'executing', claimed_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id]
      );

      if (rows.length === 0) {
        console.log(`[QueuedPromptsStore] claim: prompt ${id} not found or already claimed`);
        return null;
      }

      console.log(`[QueuedPromptsStore] claim: successfully claimed prompt ${id}`);
      return rowToQueuedPrompt(rows[0]);
    },

    async complete(id: string): Promise<void> {
      await ensureReady();

      // error_message = NULL: a turn that resolves normally after a sweep
      // provisionally failed the row (buffered output landing late) must
      // not keep the stale sweep error alongside status 'completed'.
      await db.query(
        `UPDATE queued_prompts
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP, error_message = NULL
         WHERE id = $1`,
        [id]
      );

      // console.log(`[QueuedPromptsStore] Marked prompt ${id} as completed`);
    },

    async fail(id: string, errorMessage: string): Promise<void> {
      await ensureReady();

      await db.query(
        `UPDATE queued_prompts
         SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error_message = $2
         WHERE id = $1`,
        [id, errorMessage]
      );

      console.log(`[QueuedPromptsStore] Marked prompt ${id} as failed: ${errorMessage}`);
    },

    async delete(id: string): Promise<void> {
      await ensureReady();

      await db.query(
        `DELETE FROM queued_prompts WHERE id = $1`,
        [id]
      );

      console.log(`[QueuedPromptsStore] Deleted prompt ${id}`);
    },

    async rollbackExecuting(sessionId: string): Promise<number> {
      await ensureReady();

      const { rows } = await db.query<{ id: string }>(
        `UPDATE queued_prompts
         SET status = 'pending', claimed_at = NULL
         WHERE session_id = $1 AND status = 'executing'
         RETURNING id`,
        [sessionId]
      );

      if (rows.length > 0) {
        console.log(`[QueuedPromptsStore] Rolled back ${rows.length} executing prompt(s) for session ${sessionId}`);
      }
      return rows.length;
    },

    async rollbackAllExecuting(): Promise<number> {
      await ensureReady();

      const { rows } = await db.query<{ id: string }>(
        `UPDATE queued_prompts
         SET status = 'pending', claimed_at = NULL
         WHERE status = 'executing'
         RETURNING id`
      );

      if (rows.length > 0) {
        console.log(`[QueuedPromptsStore] Boot sweep: rolled back ${rows.length} executing prompt(s) across all sessions`);
      }
      return rows.length;
    },

    async sweepExecutingOnBoot(): Promise<{ completed: number; failed: number; rolledBack: number }> {
      await ensureReady();

      // Pass 1: rows whose user message was already logged to
      // ai_agent_messages AND that have agent output after the claim --
      // the prompt was delivered and the agent responded (or was paused
      // on an interactive prompt, which also persists as an output row)
      // when the app quit. Mark completed so the next session activation
      // doesn't re-claim and re-send the original prompt.
      //
      // Three branches join in this update:
      //
      // (a) `executing` rows whose input arrived after `claimed_at` AND
      //     that have at least one output row after `claimed_at` --
      //     "delivered then answered/paused". The input row alone does
      //     NOT prove the agent ever responded: a provider SIGTERM'd at
      //     quit leaves the input logged and nothing else, and marking
      //     that completed makes the session look silently answered
      //     (#783). Those rows fall through to pass 2 instead.
      // (b) `pending` rows whose prompt text appears in a later input
      //     for the same session -- leftover corruption from older
      //     builds that ran the blanket `rollbackAllExecuting` sweep on
      //     boot. POSITION > 0 implies the text is already in the
      //     conversation, so the row must not be re-delivered.
      // (c) ordinary `pending` rows older than 24h -- abandoned. Control
      //     rows are excluded because their producer owns retry/finalization;
      //     a generic staleness sweep must not silently complete them. This
      //     catches the long-tail of (b) where the content match misses
      //     because JSON escaping (newlines, quotes, pasted attachments)
      //     differs between the queued prompt and the logged input. A
      //     legitimately-queued ordinary prompt is processed within seconds
      //     of creation; one sitting >24h pending is effectively abandoned
      //     regardless of whether it was technically delivered.
      const completedResult = await db.query<{ id: string }>(
        `UPDATE queued_prompts
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP
         WHERE (
           (status = 'executing' AND claimed_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM ai_agent_messages m
              WHERE m.session_id = queued_prompts.session_id
                AND m.direction = 'input'
                AND m.created_at >= queued_prompts.claimed_at
            )
            AND EXISTS (
              SELECT 1 FROM ai_agent_messages m
              WHERE m.session_id = queued_prompts.session_id
                AND m.direction = 'output'
                AND m.created_at >= queued_prompts.claimed_at
            ))
           OR
           (status = 'pending'
            AND EXISTS (
              SELECT 1 FROM ai_agent_messages m
              WHERE m.session_id = queued_prompts.session_id
                AND m.direction = 'input'
                AND m.created_at >= queued_prompts.created_at
                AND POSITION(queued_prompts.prompt IN m.content) > 0
            ))
           OR
           (status = 'pending'
            AND delivery_class != 'control'
            AND created_at < NOW() - INTERVAL '1 day')
         )
         RETURNING id`
      );

      // Pass 2: still-executing rows whose input WAS delivered but that
      // have no output evidence. The turn died between delivery and any
      // response. Mark failed with a visible error, NOT completed (silent
      // fake success, #783) and NOT pending (a re-claim would re-send the
      // delivered input, regressing NIM-615). The NOT EXISTS makes this
      // pass independently correct rather than relying on pass 1 having
      // consumed the answered rows first (an output row committed between
      // the two statements must not produce a failed-but-answered row).
      const failedResult = await db.query<{ id: string }>(
        `UPDATE queued_prompts
         SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error_message = $1
         WHERE status = 'executing' AND claimed_at IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM ai_agent_messages m
             WHERE m.session_id = queued_prompts.session_id
               AND m.direction = 'input'
               AND m.created_at >= queued_prompts.claimed_at
           )
           AND NOT EXISTS (
             SELECT 1 FROM ai_agent_messages m
             WHERE m.session_id = queued_prompts.session_id
               AND m.direction = 'output'
               AND m.created_at >= queued_prompts.claimed_at
           )
         RETURNING id`,
        [SWEEP_UNANSWERED_ERROR]
      );

      // Pass 3: anything still executing crashed before its input was
      // ever logged. Roll back to pending so it can be retried.
      const rolledBackResult = await db.query<{ id: string }>(
        `UPDATE queued_prompts
         SET status = 'pending', claimed_at = NULL
         WHERE status = 'executing'
         RETURNING id`
      );

      const completed = completedResult.rows.length;
      const failed = failedResult.rows.length;
      const rolledBack = rolledBackResult.rows.length;

      if (completed > 0 || failed > 0 || rolledBack > 0) {
        console.log(
          `[QueuedPromptsStore] Boot sweep: marked ${completed} answered prompt(s) completed, ${failed} delivered-but-unanswered prompt(s) failed, rolled back ${rolledBack} undelivered prompt(s)`
        );
      }

      return { completed, failed, rolledBack };
    },

    async sweepExecutingForSession(sessionId: string): Promise<{ completed: number; failed: number; rolledBack: number }> {
      await ensureReady();

      // Pass 1: same delivery + output-evidence check as
      // sweepExecutingOnBoot, but scoped to a single session. Used on
      // cancel/interrupt to avoid the immediate re-claim that follows
      // when an already-delivered prompt is rolled back to pending.
      const completedResult = await db.query<{ id: string }>(
        `UPDATE queued_prompts
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP
         WHERE status = 'executing'
           AND session_id = $1
           AND claimed_at IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM ai_agent_messages m
             WHERE m.session_id = queued_prompts.session_id
               AND m.direction = 'input'
               AND m.created_at >= queued_prompts.claimed_at
           )
           AND EXISTS (
             SELECT 1 FROM ai_agent_messages m
             WHERE m.session_id = queued_prompts.session_id
               AND m.direction = 'output'
               AND m.created_at >= queued_prompts.claimed_at
           )
         RETURNING id`,
        [sessionId]
      );

      // Pass 2: delivered but no output before the interrupt -- the
      // exact #790 shape ("why did you stop?" was claimed, never
      // answered, and the interrupt sweep marked it completed). Fail it
      // visibly instead; never roll back to pending (re-claim would
      // re-send the delivered input, NIM-615). NOT EXISTS keeps this
      // pass independently correct if an output row commits between the
      // two statements; and if the turn later resolves normally anyway,
      // complete() overwrites the provisional failed and clears the error.
      const failedResult = await db.query<{ id: string }>(
        `UPDATE queued_prompts
         SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error_message = $2
         WHERE status = 'executing'
           AND session_id = $1
           AND claimed_at IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM ai_agent_messages m
             WHERE m.session_id = queued_prompts.session_id
               AND m.direction = 'input'
               AND m.created_at >= queued_prompts.claimed_at
           )
           AND NOT EXISTS (
             SELECT 1 FROM ai_agent_messages m
             WHERE m.session_id = queued_prompts.session_id
               AND m.direction = 'output'
               AND m.created_at >= queued_prompts.claimed_at
           )
         RETURNING id`,
        [sessionId, SWEEP_UNANSWERED_ERROR]
      );

      // Pass 3: roll back anything still executing for this session that
      // never made it to the conversation.
      const rolledBackResult = await db.query<{ id: string }>(
        `UPDATE queued_prompts
         SET status = 'pending', claimed_at = NULL
         WHERE status = 'executing' AND session_id = $1
         RETURNING id`,
        [sessionId]
      );

      const completed = completedResult.rows.length;
      const failed = failedResult.rows.length;
      const rolledBack = rolledBackResult.rows.length;

      if (completed > 0 || failed > 0 || rolledBack > 0) {
        console.log(
          `[QueuedPromptsStore] Session sweep (${sessionId}): marked ${completed} answered prompt(s) completed, ${failed} delivered-but-unanswered prompt(s) failed, rolled back ${rolledBack} undelivered prompt(s)`
        );
      }

      return { completed, failed, rolledBack };
    },

    async cleanup(olderThanMs: number): Promise<number> {
      await ensureReady();

      const cutoffDate = new Date(Date.now() - olderThanMs);

      // Cleanup never reaps control rows; a later dedicated policy must use the actual controller retry horizon.
      const { rows } = await db.query<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM queued_prompts
           WHERE status IN ('completed', 'failed')
             AND delivery_class != 'control'
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
