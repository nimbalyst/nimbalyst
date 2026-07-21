/**
 * PGLite implementation of QueuedPromptsStore
 *
 * Stores prompts queued from any device for execution.
 * Uses simple row-level atomic updates instead of JSONB array manipulation.
 */

import { createHash, randomUUID } from 'crypto';
import { toMillis } from '../utils/timestampUtils';
import {
  hostControlMutationCoordinator,
  type HostControlMutationCoordinator,
  type HostControlStoreIdentity,
} from './HostControlMutationCoordinator';

export function interruptOperationLockKey(priorityRowId: string): string {
  return `priority-interrupt:${priorityRowId}`;
}

export interface QueuedPromptsStoreOptions {
  /** Testable crash/race seam: durable CAS committed, fence not published yet. */
  afterInterruptReservationCommitted?: (input: {
    row: QueuedPrompt;
    takenOver: boolean;
  }) => Promise<void> | void;
  mutationCoordinator?: HostControlMutationCoordinator;
  /** Overrides the durable identity lookup only for adapter-backed tests. */
  storeIdentity?: HostControlStoreIdentity;
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
  interruptReservationOwner?: string;
  interruptLeaseExpiresAt?: number;
  interruptOperationId?: string;
  interruptFence?: number;
  interruptApplicationState?: 'not_started' | 'unknown' | 'not_applied' | 'applied' | 'legacy_unknown';
  interruptStartedAt?: number;
  interruptAppliedAt?: number;
  interruptApplicationReceipt?: unknown;
  interruptCleanupState?: 'pending' | 'claimed' | 'complete';
  interruptCleanupFence?: number;
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
    reservationOwner: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<{ reserved: boolean; takenOver: boolean; row: QueuedPrompt }>;

  /** Fence one owner before it invokes the generation-bound native interrupt. */
  beginInterruptApplication(input: {
    id: string;
    expectedGeneration: string;
    reservationOwner: string;
    operationId: string;
    fence: number;
    now: Date;
  }): Promise<{ started: boolean; row: QueuedPrompt }>;

  /** Re-read the exact live unknown-outcome fence immediately before native entry. */
  verifyInterruptApplication(input: {
    id: string;
    expectedGeneration: string;
    reservationOwner: string;
    operationId: string;
    fence: number;
    now: Date;
  }): Promise<boolean>;

  /** Database-current-time verification and native entry under the OS lock. */
  enterInterruptApplication?<T>(input: {
    id: string;
    expectedGeneration: string;
    reservationOwner: string;
    operationId: string;
    fence: number;
  }, action: () => Promise<T>): Promise<{ owned: true; value: T } | { owned: false }>;

  /** Persist the native result before the caller is allowed to finalize. */
  recordInterruptApplication(input: {
    id: string;
    expectedGeneration: string;
    reservationOwner: string;
    operationId: string;
    fence: number;
    certainty: 'not_applied' | 'applied';
    receipt: unknown;
    appliedAt: Date;
  }): Promise<QueuedPrompt>;

  /** Claim the durable receipt-only cleanup phase without re-entering native code. */
  claimInterruptCleanup(input: {
    id: string;
    expectedGeneration: string;
    reservationOwner: string;
    operationId: string;
    fence: number;
  }): Promise<boolean>;

  /** Persist one bounded interrupt attempt receipt. */
  recordInterruptReceipt(input: {
    id: string;
    expectedGeneration: string;
    reservationOwner: string;
    operationId: string;
    fence: number;
    receipt: unknown;
    finalizedAt: Date;
  }): Promise<QueuedPrompt>;

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

  let interruptApplicationReceipt = row.interrupt_application_receipt;
  if (typeof interruptApplicationReceipt === 'string') {
    try {
      interruptApplicationReceipt = JSON.parse(interruptApplicationReceipt);
    } catch {
      interruptApplicationReceipt = undefined;
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
    interruptReservationOwner: row.interrupt_reservation_owner || undefined,
    interruptLeaseExpiresAt: toMillis(row.interrupt_lease_expires_at) ?? undefined,
    interruptOperationId: row.interrupt_operation_id || undefined,
    interruptFence: Number(row.interrupt_fence ?? 0),
    interruptApplicationState: row.interrupt_application_state ?? 'not_started',
    interruptStartedAt: toMillis(row.interrupt_started_at) ?? undefined,
    interruptAppliedAt: toMillis(row.interrupt_applied_at) ?? undefined,
    interruptApplicationReceipt,
    interruptCleanupState: row.interrupt_cleanup_state ?? 'pending',
    interruptCleanupFence: Number(row.interrupt_cleanup_fence ?? 0),
    interruptReceipt: interruptReceipt === null ? undefined : interruptReceipt,
  };
}

function serializeInterruptReceipt(receipt: unknown): string {
  let serializedReceipt: string;
  try {
    const serialized = JSON.stringify(receipt);
    if (serialized === undefined) throw new Error('receipt is not JSON-serializable');
    serializedReceipt = serialized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot record interrupt receipt: ${message}`);
  }
  const receiptSizeBytes = Buffer.byteLength(serializedReceipt, 'utf8');
  if (receiptSizeBytes > 4096) {
    throw new Error(
      `Cannot record interrupt receipt: serialized receipt exceeds 4096 bytes (${receiptSizeBytes} bytes)`,
    );
  }
  return serializedReceipt;
}

export function createPGLiteQueuedPromptsStore(
  db: PGliteLike,
  ensureDbReady?: EnsureReadyFn,
  options?: QueuedPromptsStoreOptions,
): QueuedPromptsStore {
  const coordinator = options?.mutationCoordinator ?? hostControlMutationCoordinator;
  const ensureReady = async () => {
    if (ensureDbReady) {
      await ensureDbReady();
    }
  };
  let storeIdentityPromise: Promise<HostControlStoreIdentity> | undefined;
  const resolveStoreIdentity = (): Promise<HostControlStoreIdentity> => {
    if (options?.storeIdentity) return Promise.resolve(options.storeIdentity);
    storeIdentityPromise ??= (async () => {
      await ensureReady();
      const result = await db.query<{ store_id: string; authority_root: string }>(
        'SELECT store_id, authority_root FROM host_control_store_identity WHERE singleton = 1',
      );
      const row = result.rows[0];
      if (!row?.store_id || !row?.authority_root) {
        throw new Error('host_control_store_identity_missing');
      }
      return { storeId: row.store_id, authorityRoot: row.authority_root };
    })();
    return storeIdentityPromise;
  };
  const withOperationLock = async <T>(operationKey: string, action: () => Promise<T>): Promise<T> => (
    coordinator.withOperationLock(await resolveStoreIdentity(), operationKey, action)
  );

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

    async reserveInterrupt(input) {
      await ensureReady();
      return withOperationLock(interruptOperationLockKey(input.id), async () => {
        const operationId = `priority-interrupt:${createHash('sha256')
          .update(`${input.id}\0${input.expectedGeneration}`)
          .digest('hex')}`;

        const { rows } = await db.query<any>(
        `UPDATE queued_prompts
         SET interrupt_target_generation = $2,
             interrupt_reservation_owner = $3,
             interrupt_lease_expires_at = $4,
             interrupt_operation_id = $5,
             interrupt_fence = interrupt_fence + 1
         WHERE id = $1
           AND interrupt_target_generation IS NULL
           AND interrupt_receipt IS NULL
         RETURNING *`,
        [
          input.id,
          input.expectedGeneration,
          input.reservationOwner,
          input.leaseExpiresAt,
          operationId,
        ],
      );

        if (rows.length > 0) {
          const row = rowToQueuedPrompt(rows[0]);
          await options?.afterInterruptReservationCommitted?.({ row, takenOver: false });
          return { reserved: true, takenOver: false, row };
        }

        const observedResult = await db.query<any>(
        `SELECT * FROM queued_prompts WHERE id = $1`,
        [input.id],
      );
        if (observedResult.rows.length === 0) {
          throw new Error(`Cannot reserve interrupt: queued prompt ${input.id} does not exist`);
        }
        const observed = rowToQueuedPrompt(observedResult.rows[0]);
        if (
        observed.interruptReceipt !== undefined
        || observed.interruptTargetGeneration !== input.expectedGeneration
        || observed.interruptLeaseExpiresAt === undefined
        || !observed.interruptReservationOwner
        || !observed.interruptOperationId
        ) {
          return { reserved: false, takenOver: false, row: observed };
        }

        const takeover = await db.query<any>(
        `UPDATE queued_prompts
         SET interrupt_reservation_owner = $3,
             interrupt_lease_expires_at = $4,
             interrupt_fence = $9,
             interrupt_cleanup_state = CASE
               WHEN interrupt_cleanup_state = 'claimed' THEN 'pending'
               ELSE interrupt_cleanup_state
             END
         WHERE id = $1
           AND interrupt_target_generation = $2
           AND interrupt_receipt IS NULL
           AND interrupt_reservation_owner = $5
           AND interrupt_lease_expires_at = $6
           AND interrupt_operation_id = $7
           AND interrupt_fence = $8
           AND interrupt_application_state = $10
           AND interrupt_lease_expires_at <= NOW()
         RETURNING *`,
        [
          input.id,
          input.expectedGeneration,
          input.reservationOwner,
          input.leaseExpiresAt,
          observed.interruptReservationOwner,
          new Date(observed.interruptLeaseExpiresAt),
          observed.interruptOperationId,
          observed.interruptFence ?? 0,
          (observed.interruptFence ?? 0) + 1,
          observed.interruptApplicationState ?? 'not_started',
        ],
      );
        if (takeover.rows.length > 0) {
          const row = rowToQueuedPrompt(takeover.rows[0]);
          await options?.afterInterruptReservationCommitted?.({ row, takenOver: true });
          return { reserved: true, takenOver: true, row };
        }

        const current = await db.query<any>(
        `SELECT * FROM queued_prompts WHERE id = $1`,
        [input.id]
      );
        if (current.rows.length === 0) {
          throw new Error(`Cannot reserve interrupt: queued prompt ${input.id} does not exist`);
        }
        const row = rowToQueuedPrompt(current.rows[0]);
        return { reserved: false, takenOver: false, row };
      });
    },

    async beginInterruptApplication(input) {
      await ensureReady();
      const result = await db.query<any>(
        `UPDATE queued_prompts
         SET interrupt_application_state = 'unknown',
             interrupt_started_at = $4
         WHERE id = $1
           AND interrupt_target_generation = $2
           AND interrupt_reservation_owner = $3
           AND interrupt_operation_id = $5
           AND interrupt_fence = $6
           AND interrupt_application_state = 'not_started'
           AND interrupt_receipt IS NULL
           AND interrupt_lease_expires_at > NOW()
         RETURNING *`,
        [
          input.id,
          input.expectedGeneration,
          input.reservationOwner,
          input.now,
          input.operationId,
          input.fence,
        ],
      );
      if (result.rows.length > 0) {
        return { started: true, row: rowToQueuedPrompt(result.rows[0]) };
      }
      const current = await db.query<any>('SELECT * FROM queued_prompts WHERE id = $1', [input.id]);
      if (current.rows.length === 0) {
        throw new Error(`Cannot begin interrupt: queued prompt ${input.id} does not exist`);
      }
      return { started: false, row: rowToQueuedPrompt(current.rows[0]) };
    },

    async recordInterruptApplication(input) {
      await ensureReady();
      const serializedReceipt = serializeInterruptReceipt(input.receipt);
      const result = await db.query<any>(
        `UPDATE queued_prompts
         SET interrupt_application_state = $8,
             interrupt_application_receipt = $4,
             interrupt_applied_at = $5
         WHERE id = $1
           AND interrupt_target_generation = $2
           AND interrupt_reservation_owner = $3
           AND interrupt_operation_id = $6
           AND interrupt_fence = $7
           AND interrupt_application_state = 'unknown'
           AND interrupt_receipt IS NULL
           AND interrupt_lease_expires_at > NOW()
         RETURNING *`,
        [
          input.id,
          input.expectedGeneration,
          input.reservationOwner,
          serializedReceipt,
          input.appliedAt,
          input.operationId,
          input.fence,
          input.certainty,
        ],
      );
      if (result.rows.length > 0) return rowToQueuedPrompt(result.rows[0]);
      const current = await db.query<any>('SELECT * FROM queued_prompts WHERE id = $1', [input.id]);
      if (current.rows.length === 0) {
        throw new Error(`Cannot record interrupt application: queued prompt ${input.id} does not exist`);
      }
      const row = rowToQueuedPrompt(current.rows[0]);
      if (
        row.interruptApplicationState === input.certainty
        && row.interruptOperationId === input.operationId
        && row.interruptFence === input.fence
      ) {
        const persisted = JSON.stringify(row.interruptApplicationReceipt);
        if (persisted === serializedReceipt) return row;
        throw new Error('interrupt_application_receipt_conflict');
      }
      throw new Error('interrupt_application_ownership_lost');
    },

    async verifyInterruptApplication(input) {
      await ensureReady();
      const result = await db.query<{ one: number }>(
        `SELECT 1 AS one
         FROM queued_prompts
         WHERE id = $1
           AND interrupt_target_generation = $2
           AND interrupt_reservation_owner = $3
           AND interrupt_operation_id = $4
           AND interrupt_fence = $5
           AND interrupt_application_state = 'unknown'
           AND interrupt_receipt IS NULL
           AND interrupt_lease_expires_at > NOW()`,
        [
          input.id,
          input.expectedGeneration,
          input.reservationOwner,
          input.operationId,
          input.fence,
        ],
      );
      return result.rows.length === 1;
    },

    async enterInterruptApplication(input, action) {
      await ensureReady();
      return withOperationLock(interruptOperationLockKey(input.id), async () => {
        const result = await db.query<{ one: number }>(
          `SELECT 1 AS one
           FROM queued_prompts
           WHERE id = $1
             AND interrupt_target_generation = $2
             AND interrupt_reservation_owner = $3
             AND interrupt_operation_id = $4
             AND interrupt_fence = $5
             AND interrupt_application_state = 'unknown'
             AND interrupt_receipt IS NULL
             AND interrupt_lease_expires_at > NOW()`,
          [
            input.id,
            input.expectedGeneration,
            input.reservationOwner,
            input.operationId,
            input.fence,
          ],
        );
        if (result.rows.length !== 1) return { owned: false as const };
        return { owned: true as const, value: await action() };
      });
    },

    async claimInterruptCleanup(input) {
      await ensureReady();
      return withOperationLock(interruptOperationLockKey(input.id), async () => {
        const result = await db.query<any>(
          `UPDATE queued_prompts
           SET interrupt_cleanup_state = 'claimed',
               interrupt_cleanup_fence = $5
           WHERE id = $1
             AND interrupt_target_generation = $2
             AND interrupt_reservation_owner = $3
             AND interrupt_operation_id = $4
             AND interrupt_fence = $5
             AND interrupt_receipt IS NULL
             AND interrupt_lease_expires_at > NOW()
             AND (
               interrupt_cleanup_state = 'pending'
               OR (interrupt_cleanup_state = 'claimed' AND interrupt_cleanup_fence = $5)
             )
           RETURNING *`,
          [
            input.id,
            input.expectedGeneration,
            input.reservationOwner,
            input.operationId,
            input.fence,
          ],
        );
        return result.rows.length === 1;
      });
    },

    async recordInterruptReceipt(input): Promise<QueuedPrompt> {
      await ensureReady();
      const serializedReceipt = serializeInterruptReceipt(input.receipt);

      const { rows } = await db.query<any>(
        `UPDATE queued_prompts
         SET interrupt_receipt = $2,
             interrupt_reservation_owner = NULL,
             interrupt_lease_expires_at = NULL,
             interrupt_cleanup_state = 'complete'
         WHERE id = $1
           AND interrupt_target_generation = $3
           AND interrupt_reservation_owner = $4
           AND interrupt_operation_id = $5
           AND interrupt_fence = $6
           AND interrupt_receipt IS NULL
           AND interrupt_cleanup_state = 'claimed'
           AND interrupt_cleanup_fence = $6
           AND interrupt_lease_expires_at > NOW()
         RETURNING *`,
        [
          input.id,
          serializedReceipt,
          input.expectedGeneration,
          input.reservationOwner,
          input.operationId,
          input.fence,
        ],
      );

      if (rows.length > 0) return rowToQueuedPrompt(rows[0]);
      const current = await db.query<any>('SELECT * FROM queued_prompts WHERE id = $1', [input.id]);
      if (current.rows.length === 0) {
        throw new Error(`Cannot record interrupt receipt: queued prompt ${input.id} does not exist`);
      }
      const row = rowToQueuedPrompt(current.rows[0]);
      if (row.interruptReceipt !== undefined) return row;
      throw new Error('interrupt_receipt_ownership_lost');
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
