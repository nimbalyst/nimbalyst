import { randomUUID } from 'crypto';
import { toMillis } from '../utils/timestampUtils';
import {
  hostControlMutationCoordinator,
  type HostControlMutationCoordinator,
  type HostControlStoreIdentity,
} from './HostControlMutationCoordinator';

export type HostControlCleanupStep = 'prompt' | 'attention' | 'terminal';
export type HostControlAttentionCleanupResult = 'settled' | 'already_absent';

export function hostControlReceiptOperationLockKey(reservationKey: string): string {
  return `host-control-receipt:${reservationKey}`;
}

export type HostControlReceiptState =
  | 'reserved'
  | 'injected'
  | 'already_resolved'
  | 'failed';

export interface HostControlReceiptRow {
  id: string;
  reservationKey: string;
  requestDigest: string;
  operation: 'inject_attention_reply';
  sessionId: string;
  eventIdentity: string;
  attentionGeneration?: string;
  state: HostControlReceiptState;
  reservationOwner?: string;
  leaseExpiresAt?: number;
  mutationId?: string;
  mutationFence?: number;
  mutationState?: 'not_started' | 'unknown' | 'not_applied' | 'applied' | 'legacy_unknown';
  mutationStartedAt?: number;
  mutationAppliedAt?: number;
  mutationReceipt?: Record<string, unknown>;
  cleanupPromptState?: 'pending' | 'claimed' | 'complete';
  cleanupPromptFence?: number;
  cleanupAttentionState?: 'pending' | 'claimed' | 'complete';
  cleanupAttentionFence?: number;
  cleanupAttentionResult?: HostControlAttentionCleanupResult;
  cleanupTerminalState?: 'pending' | 'claimed' | 'complete';
  cleanupTerminalFence?: number;
  receipt?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface NativeWinnerOutboxRow {
  id: string;
  reservationKey: string;
  sessionId: string;
  eventIdentity: string;
  attentionGeneration?: string;
  state: 'pending' | 'sent';
  attemptCount: number;
  receipt?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  lastAttemptAt?: number;
  sentAt?: number;
}

export interface HostControlReceiptsStore {
  reserveReceipt(input: {
    reservationKey: string;
    requestDigest: string;
    operation: 'inject_attention_reply';
    sessionId: string;
    eventIdentity: string;
    attentionGeneration?: string;
    reservationOwner: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<HostControlReceiptReservation>;
  beginReceiptMutation(input: {
    id: string;
    reservationOwner: string;
    mutationId: string;
    mutationFence: number;
    now: Date;
    attentionGeneration: string;
  }): Promise<{ started: boolean; row: HostControlReceiptRow }>;
  recordReceiptMutation(input: {
    id: string;
    reservationOwner: string;
    mutationId: string;
    mutationFence: number;
    certainty: 'not_applied' | 'applied';
    receipt: Record<string, unknown>;
    appliedAt: Date;
  }): Promise<HostControlReceiptRow>;
  finalizeReceipt(input: {
    id: string;
    reservationKey: string;
    reservationOwner: string;
    mutationId: string;
    mutationFence: number;
    state: Exclude<HostControlReceiptState, 'reserved'>;
    receipt: Record<string, unknown>;
    now: Date;
  }): Promise<HostControlReceiptRow>;
  getByReservationKey(key: string): Promise<HostControlReceiptRow | null>;
  reserveNativeWinner(input: {
    reservationKey: string;
    sessionId: string;
    eventIdentity: string;
    attentionGeneration?: string;
  }): Promise<{ row: NativeWinnerOutboxRow; isNewReservation: boolean }>;
  listPendingNativeWinners(limit?: number): Promise<NativeWinnerOutboxRow[]>;
  recordNativeWinnerAttempt(input: {
    id: string;
    sent: boolean;
    receipt: Record<string, unknown>;
  }): Promise<NativeWinnerOutboxRow>;
}

export interface HostControlReceiptMutationAuthority {
  begin(
    now: Date,
    attentionGeneration: string,
  ): Promise<{ started: boolean; row: HostControlReceiptRow }>;
  recordApplied(
    certainty: 'not_applied' | 'applied',
    receipt: Record<string, unknown>,
    appliedAt: Date,
  ): Promise<HostControlReceiptRow>;
  verify(attentionGeneration: string): Promise<boolean>;
  verifyCleanup(attentionGeneration: string): Promise<boolean>;
  enterNative<T>(
    attentionGeneration: string,
    action: () => Promise<T>,
  ): Promise<{ owned: true; value: T } | { owned: false }>;
  claimCleanupStep(
    step: HostControlCleanupStep,
    attentionGeneration: string,
  ): Promise<
    | { status: 'claimed' }
    | { status: 'complete'; attentionResult?: HostControlAttentionCleanupResult }
    | false
  >;
  metadataCleanupAuthority(step: 'prompt' | 'attention', attentionGeneration: string): {
    receiptId: string;
    reservationOwner: string;
    mutationId: string;
    mutationFence: number;
    attentionGeneration: string;
    step: 'prompt' | 'attention';
  };
}

export interface HostControlReceiptReservation {
  row: HostControlReceiptRow;
  isNewReservation: boolean;
  status?: 'new' | 'same_owner' | 'taken_over' | 'busy' | 'replay' | 'reconcile';
  mutationAuthority?: HostControlReceiptMutationAuthority;
}

type DatabaseLike = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
};

type EnsureReadyFn = () => Promise<void>;

export interface HostControlReceiptsStoreOptions {
  /** Testable race seam: takeover/insert CAS committed, fence unpublished. */
  afterReceiptReservationCommitted?: (input: {
    row: HostControlReceiptRow;
    takenOver: boolean;
  }) => Promise<void> | void;
  mutationCoordinator?: HostControlMutationCoordinator;
  /** Overrides the durable identity lookup only for adapter-backed tests. */
  storeIdentity?: HostControlStoreIdentity;
}

const MAX_RECEIPT_BYTES = 4096;

function parseReceipt(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hostRow(row: any): HostControlReceiptRow {
  return {
    id: row.id,
    reservationKey: row.reservation_key,
    requestDigest: row.request_digest,
    operation: row.operation,
    sessionId: row.session_id,
    eventIdentity: row.event_identity,
    attentionGeneration: row.attention_generation || undefined,
    state: row.state,
    reservationOwner: row.reservation_owner || undefined,
    leaseExpiresAt: toMillis(row.lease_expires_at) ?? undefined,
    mutationId: row.mutation_id || undefined,
    mutationFence: Number(row.mutation_fence ?? 0),
    mutationState: row.mutation_state ?? 'not_started',
    mutationStartedAt: toMillis(row.mutation_started_at) ?? undefined,
    mutationAppliedAt: toMillis(row.mutation_applied_at) ?? undefined,
    mutationReceipt: parseReceipt(row.mutation_receipt),
    cleanupPromptState: row.cleanup_prompt_state ?? 'pending',
    cleanupPromptFence: Number(row.cleanup_prompt_fence ?? 0),
    cleanupAttentionState: row.cleanup_attention_state ?? 'pending',
    cleanupAttentionFence: Number(row.cleanup_attention_fence ?? 0),
    cleanupAttentionResult: row.cleanup_attention_result ?? undefined,
    cleanupTerminalState: row.cleanup_terminal_state ?? 'pending',
    cleanupTerminalFence: Number(row.cleanup_terminal_fence ?? 0),
    receipt: parseReceipt(row.receipt),
    createdAt: toMillis(row.created_at)!,
    updatedAt: toMillis(row.updated_at)!,
  };
}

function nativeRow(row: any): NativeWinnerOutboxRow {
  return {
    id: row.id,
    reservationKey: row.reservation_key,
    sessionId: row.session_id,
    eventIdentity: row.event_identity,
    attentionGeneration: row.attention_generation || undefined,
    state: row.state,
    attemptCount: Number(row.attempt_count ?? 0),
    receipt: parseReceipt(row.receipt),
    createdAt: toMillis(row.created_at)!,
    updatedAt: toMillis(row.updated_at)!,
    lastAttemptAt: toMillis(row.last_attempt_at) ?? undefined,
    sentAt: toMillis(row.sent_at) ?? undefined,
  };
}

function serializeBoundedReceipt(receipt: Record<string, unknown>): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(receipt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot record host control receipt: ${message}`);
  }
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > MAX_RECEIPT_BYTES) {
    throw new Error(
      `Cannot record host control receipt: serialized receipt exceeds 4096 bytes (${byteLength} bytes)`,
    );
  }
  return serialized;
}

/**
 * Sibling to PGLiteQueuedPromptsStore because this is a non-queue control
 * ledger. The query surface deliberately works through the common adapter so
 * PGLite JSONB and SQLite TEXT receipts decode to the same domain objects.
 */
export function createHostControlReceiptsStore(
  db: DatabaseLike,
  ensureDbReady?: EnsureReadyFn,
  options?: HostControlReceiptsStoreOptions,
): HostControlReceiptsStore {
  const coordinator = options?.mutationCoordinator ?? hostControlMutationCoordinator;
  const ensureReady = async () => {
    if (ensureDbReady) await ensureDbReady();
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

  const beginReceiptMutation: HostControlReceiptsStore['beginReceiptMutation'] = async (input) => {
    await ensureReady();
    const result = await db.query<any>(
      `UPDATE host_control_receipts
       SET mutation_state = 'unknown', mutation_started_at = $3, updated_at = $3,
           attention_generation = COALESCE(attention_generation, $4)
       WHERE id = $1
         AND reservation_owner = $2
         AND mutation_id = $5
         AND mutation_fence = $6
         AND state = 'reserved'
         AND mutation_state = 'not_started'
         AND lease_expires_at > NOW()
         AND (attention_generation IS NULL OR attention_generation = $4)
       RETURNING *`,
      [
        input.id,
        input.reservationOwner,
        input.now,
        input.attentionGeneration,
        input.mutationId,
        input.mutationFence,
      ],
    );
    if (result.rows.length > 0) {
      return { started: true, row: hostRow(result.rows[0]) };
    }
    const current = await db.query<any>(
      'SELECT * FROM host_control_receipts WHERE id = $1',
      [input.id],
    );
    if (current.rows.length === 0) throw new Error('host_control_receipt_not_found');
    return { started: false, row: hostRow(current.rows[0]) };
  };

  const recordReceiptMutation: HostControlReceiptsStore['recordReceiptMutation'] = async (input) => {
    await ensureReady();
    const serialized = serializeBoundedReceipt(input.receipt);
    const result = await db.query<any>(
      `UPDATE host_control_receipts
       SET mutation_state = $7, mutation_receipt = $3,
           mutation_applied_at = $4, updated_at = $4
       WHERE id = $1
         AND reservation_owner = $2
         AND mutation_id = $5
         AND mutation_fence = $6
         AND state = 'reserved'
         AND mutation_state = 'unknown'
         AND lease_expires_at > NOW()
       RETURNING *`,
      [
        input.id,
        input.reservationOwner,
        serialized,
        input.appliedAt,
        input.mutationId,
        input.mutationFence,
        input.certainty,
      ],
    );
    if (result.rows.length > 0) return hostRow(result.rows[0]);
    const current = await db.query<any>(
      'SELECT * FROM host_control_receipts WHERE id = $1',
      [input.id],
    );
    if (current.rows.length === 0) throw new Error('host_control_receipt_not_found');
    const row = hostRow(current.rows[0]);
    if (
      row.mutationState === input.certainty
      && row.mutationId === input.mutationId
      && row.mutationFence === input.mutationFence
    ) {
      if (JSON.stringify(row.mutationReceipt) === serialized) return row;
      throw new Error('host_control_mutation_receipt_conflict');
    }
    throw new Error('host_control_mutation_ownership_lost');
  };

  const mutationAuthority = (
    id: string,
    reservationKey: string,
    reservationOwner: string,
    mutationId: string,
    mutationFence: number,
  ): HostControlReceiptMutationAuthority => {
    const verifyState = async (
      attentionGeneration: string,
      cleanup: boolean,
    ): Promise<boolean> => {
      await ensureReady();
      const statePredicate = cleanup
        ? "mutation_state IN ('applied', 'not_applied')"
        : "mutation_state = 'unknown'";
      const result = await db.query<{ one: number }>(
        `SELECT 1 AS one
         FROM host_control_receipts
         WHERE id = $1
           AND reservation_owner = $2
           AND mutation_id = $3
           AND mutation_fence = $4
           AND state = 'reserved'
           AND ${statePredicate}
           AND attention_generation = $5
           AND lease_expires_at > NOW()`,
        [id, reservationOwner, mutationId, mutationFence, attentionGeneration],
      );
      return result.rows.length === 1;
    };
    const cleanupColumns: Record<HostControlCleanupStep, { state: string; fence: string }> = {
      prompt: { state: 'cleanup_prompt_state', fence: 'cleanup_prompt_fence' },
      attention: { state: 'cleanup_attention_state', fence: 'cleanup_attention_fence' },
      terminal: { state: 'cleanup_terminal_state', fence: 'cleanup_terminal_fence' },
    };
    const claimCleanupStep = async (
      step: HostControlCleanupStep,
      attentionGeneration: string,
    ): Promise<
      | { status: 'claimed' }
      | { status: 'complete'; attentionResult?: HostControlAttentionCleanupResult }
      | false
    > => withOperationLock(
      hostControlReceiptOperationLockKey(reservationKey),
      async () => {
        await ensureReady();
        const column = cleanupColumns[step];
        const mutationStatePredicate = step === 'terminal'
          ? `(mutation_state IN ('not_started', 'unknown', 'not_applied', 'legacy_unknown')
             OR (
               mutation_state = 'applied'
               AND cleanup_prompt_state = 'complete'
               AND cleanup_attention_state = 'complete'
               AND cleanup_attention_result IS NOT NULL
             ))`
          : "mutation_state = 'applied'";
        // Keep the parameter shape identical for every step; terminal cleanup
        // does not use generation as an eligibility predicate, but binding it
        // avoids backend-specific extra-parameter behavior.
        const generationPredicate = step === 'terminal'
          ? 'CAST($5 AS TEXT) = CAST($5 AS TEXT)'
          : 'attention_generation = $5';
        const result = await db.query<any>(
          `UPDATE host_control_receipts
           SET ${column.state} = 'claimed', ${column.fence} = $4,
               updated_at = NOW()
           WHERE id = $1
             AND reservation_owner = $2
             AND mutation_id = $3
             AND mutation_fence = $4
             AND state = 'reserved'
             AND ${mutationStatePredicate}
             AND ${generationPredicate}
             AND lease_expires_at > NOW()
             AND (
               ${column.state} = 'pending'
               OR (${column.state} = 'claimed' AND ${column.fence} = $4)
             )
           RETURNING *`,
          [id, reservationOwner, mutationId, mutationFence, attentionGeneration],
        );
        if (result.rows.length === 1) return { status: 'claimed' };

        // A completed phase is durable success from a previous owner. It must
        // not make a reconstructed owner restart that side effect or strand the
        // following phase. Authority is still checked at database current time.
        const completed = await db.query<{ cleanup_attention_result?: HostControlAttentionCleanupResult }>(
          `SELECT cleanup_attention_result
           FROM host_control_receipts
           WHERE id = $1
             AND reservation_owner = $2
             AND mutation_id = $3
             AND mutation_fence = $4
             AND state = 'reserved'
             AND ${mutationStatePredicate}
             AND ${generationPredicate}
             AND lease_expires_at > NOW()
             AND ${column.state} = 'complete'`,
          [id, reservationOwner, mutationId, mutationFence, attentionGeneration],
        );
        if (completed.rows.length !== 1) return false;
        const attentionResult = step === 'attention'
          ? completed.rows[0].cleanup_attention_result
          : undefined;
        if (step === 'attention' && !attentionResult) return false;
        return { status: 'complete', attentionResult };
      },
    );
    return ({
    begin: (now, attentionGeneration) => beginReceiptMutation({
      id,
      reservationOwner,
      mutationId,
      mutationFence,
      now,
      attentionGeneration,
    }),
    recordApplied: (certainty, receipt, appliedAt) => recordReceiptMutation({
      id,
      reservationOwner,
      mutationId,
      mutationFence,
      certainty,
      receipt,
      appliedAt,
    }),
      verify: (attentionGeneration) => verifyState(attentionGeneration, false),
      verifyCleanup: (attentionGeneration) => verifyState(attentionGeneration, true),
      enterNative: (attentionGeneration, action) => withOperationLock(
        hostControlReceiptOperationLockKey(reservationKey),
        async () => {
          if (!await verifyState(attentionGeneration, false)) return { owned: false as const };
          return { owned: true as const, value: await action() };
        },
      ),
      claimCleanupStep,
      metadataCleanupAuthority: (step, attentionGeneration) => ({
        receiptId: id,
        reservationOwner,
        mutationId,
        mutationFence,
        attentionGeneration,
        step,
      }),
    });
  };

  return {
    async reserveReceipt(input) {
      await ensureReady();
      return withOperationLock(hostControlReceiptOperationLockKey(input.reservationKey), async () => {
      const id = `host-control-${randomUUID()}`;
      const mutationId = `host-mutation:${id}`;
      const publishCommittedFence = async (row: HostControlReceiptRow, takenOver: boolean) => {
        await options?.afterReceiptReservationCommitted?.({ row, takenOver });
      };
      const inserted = await db.query<any>(
         `INSERT INTO host_control_receipts (
           id, reservation_key, request_digest, operation, session_id,
           event_identity, attention_generation, state,
           reservation_owner, lease_expires_at, mutation_id, mutation_fence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $9, $10, 1)
         ON CONFLICT (reservation_key) DO NOTHING
         RETURNING *`,
        [
          id,
          input.reservationKey,
          input.requestDigest,
          input.operation,
          input.sessionId,
          input.eventIdentity,
          input.attentionGeneration ?? null,
          input.reservationOwner,
          input.leaseExpiresAt,
          mutationId,
        ],
      );
      if (inserted.rows.length > 0) {
        const row = hostRow(inserted.rows[0]);
        await publishCommittedFence(row, false);
        return {
          row,
          isNewReservation: true,
          status: 'new' as const,
          mutationAuthority: mutationAuthority(
            row.id,
            input.reservationKey,
            input.reservationOwner,
            row.mutationId!,
            row.mutationFence!,
          ),
        };
      }

      const existing = await db.query<any>(
        'SELECT * FROM host_control_receipts WHERE reservation_key = $1',
        [input.reservationKey],
      );
      if (existing.rows.length === 0) {
        throw new Error('host_control_receipt_reservation_lost');
      }
      const row = hostRow(existing.rows[0]);
      if (row.requestDigest !== input.requestDigest) {
        throw new Error('idempotency_conflict');
      }
      if (row.state !== 'reserved') {
        return {
          row,
          isNewReservation: false,
          status: 'replay' as const,
          mutationAuthority: undefined,
        };
      }

      if (
        row.reservationOwner === input.reservationOwner
        && row.leaseExpiresAt !== undefined
        && row.mutationId
      ) {
        const live = await db.query<{ one: number }>(
          `SELECT 1 AS one FROM host_control_receipts
           WHERE id = $1 AND reservation_owner = $2 AND mutation_id = $3
             AND mutation_fence = $4 AND state = 'reserved'
             AND lease_expires_at > NOW()`,
          [row.id, input.reservationOwner, row.mutationId, row.mutationFence ?? 0],
        );
        if (live.rows.length === 0) {
          // Continue into the exact database-time takeover CAS below.
        } else return {
          row,
          isNewReservation: false,
          status: 'same_owner' as const,
          mutationAuthority: mutationAuthority(
            row.id,
            input.reservationKey,
            input.reservationOwner,
            row.mutationId,
            row.mutationFence ?? 0,
          ),
        };
      }

      if (
        row.leaseExpiresAt === undefined
        || !row.reservationOwner
        || !row.mutationId
      ) {
        return {
          row,
          isNewReservation: false,
          status: 'busy' as const,
          mutationAuthority: undefined,
        };
      }

      const takeover = await db.query<any>(
        `UPDATE host_control_receipts
         SET reservation_owner = $2, lease_expires_at = $3,
              mutation_fence = $8, updated_at = NOW(),
              cleanup_prompt_state = CASE WHEN cleanup_prompt_state = 'claimed' THEN 'pending' ELSE cleanup_prompt_state END,
              cleanup_attention_state = CASE WHEN cleanup_attention_state = 'claimed' THEN 'pending' ELSE cleanup_attention_state END,
              cleanup_attention_result = CASE WHEN cleanup_attention_state = 'claimed' THEN NULL ELSE cleanup_attention_result END,
              cleanup_terminal_state = CASE WHEN cleanup_terminal_state = 'claimed' THEN 'pending' ELSE cleanup_terminal_state END
         WHERE id = $1
           AND state = 'reserved'
           AND receipt IS NULL
           AND reservation_owner = $4
           AND lease_expires_at = $5
           AND mutation_id = $6
           AND mutation_fence = $7
           AND mutation_state = $9
           AND (
              attention_generation = $10
              OR (attention_generation IS NULL AND $10 IS NULL)
           )
           AND lease_expires_at <= NOW()
         RETURNING *`,
        [
          row.id,
          input.reservationOwner,
          input.leaseExpiresAt,
          row.reservationOwner,
          new Date(row.leaseExpiresAt),
          row.mutationId,
          row.mutationFence ?? 0,
          (row.mutationFence ?? 0) + 1,
          row.mutationState ?? 'not_started',
          row.attentionGeneration ?? null,
        ],
      );
      if (takeover.rows.length > 0) {
        const takenOver = hostRow(takeover.rows[0]);
        await publishCommittedFence(takenOver, true);
        return {
          row: takenOver,
          isNewReservation: false,
          status: 'taken_over' as const,
          mutationAuthority: mutationAuthority(
            takenOver.id,
            input.reservationKey,
            input.reservationOwner,
            takenOver.mutationId!,
            takenOver.mutationFence!,
          ),
        };
      }

      const refreshed = await db.query<any>(
        'SELECT * FROM host_control_receipts WHERE id = $1',
        [row.id],
      );
      const busy = hostRow(refreshed.rows[0]);
      return {
        row: busy,
        isNewReservation: false,
        status: busy.state === 'reserved' ? 'busy' as const : 'replay' as const,
        mutationAuthority: undefined,
      };
      });
    },

    beginReceiptMutation,

    recordReceiptMutation,

    async finalizeReceipt(input) {
      await ensureReady();
      return withOperationLock(hostControlReceiptOperationLockKey(input.reservationKey), async () => {
        const serialized = serializeBoundedReceipt(input.receipt);
        const updated = await db.query<any>(
        `UPDATE host_control_receipts
         SET state = $2, receipt = $3, updated_at = NOW(),
             reservation_owner = NULL, lease_expires_at = NULL,
             cleanup_terminal_state = 'complete'
         WHERE id = $1
           AND state = 'reserved'
           AND reservation_owner = $4
           AND mutation_id = $5
           AND mutation_fence = $6
           AND cleanup_terminal_state = 'claimed'
           AND cleanup_terminal_fence = $6
           AND (
             mutation_state <> 'applied'
             OR (
               cleanup_prompt_state = 'complete'
               AND cleanup_attention_state = 'complete'
               AND cleanup_attention_result IS NOT NULL
             )
           )
           AND lease_expires_at > NOW()
         RETURNING *`,
        [
          input.id,
          input.state,
          serialized,
          input.reservationOwner,
          input.mutationId,
          input.mutationFence,
        ],
      );
        if (updated.rows.length > 0) return hostRow(updated.rows[0]);

        const current = await db.query<any>(
        'SELECT * FROM host_control_receipts WHERE id = $1',
        [input.id],
      );
        if (current.rows.length === 0) {
          throw new Error('host_control_receipt_not_found');
        }
        const row = hostRow(current.rows[0]);
        if (row.state !== 'reserved' && row.receipt) return row;
        throw new Error('host_control_receipt_finalization_ownership_lost');
      });
    },

    async getByReservationKey(key) {
      await ensureReady();
      const result = await db.query<any>(
        'SELECT * FROM host_control_receipts WHERE reservation_key = $1',
        [key],
      );
      return result.rows.length > 0 ? hostRow(result.rows[0]) : null;
    },

    async reserveNativeWinner(input) {
      await ensureReady();
      const id = `native-winner-${randomUUID()}`;
      const inserted = await db.query<any>(
        `INSERT INTO native_winner_outbox (
           id, reservation_key, session_id, event_identity,
           attention_generation, state)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         ON CONFLICT (reservation_key) DO NOTHING
         RETURNING *`,
        [
          id,
          input.reservationKey,
          input.sessionId,
          input.eventIdentity,
          input.attentionGeneration ?? null,
        ],
      );
      if (inserted.rows.length > 0) {
        return { row: nativeRow(inserted.rows[0]), isNewReservation: true };
      }
      const existing = await db.query<any>(
        'SELECT * FROM native_winner_outbox WHERE reservation_key = $1',
        [input.reservationKey],
      );
      if (existing.rows.length === 0) throw new Error('native_winner_reservation_lost');
      return { row: nativeRow(existing.rows[0]), isNewReservation: false };
    },

    async listPendingNativeWinners(limit = 20) {
      await ensureReady();
      const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
      const result = await db.query<any>(
        `SELECT * FROM native_winner_outbox
         WHERE state = 'pending'
         ORDER BY created_at, id
         LIMIT $1`,
        [boundedLimit],
      );
      return result.rows.map(nativeRow);
    },

    async recordNativeWinnerAttempt(input) {
      await ensureReady();
      const serialized = serializeBoundedReceipt(input.receipt);
      const now = new Date();
      const result = await db.query<any>(
        `UPDATE native_winner_outbox
         SET state = CASE WHEN $2 THEN 'sent' ELSE state END,
             attempt_count = attempt_count + 1,
             receipt = $3,
             updated_at = $4,
             last_attempt_at = $4,
             sent_at = CASE WHEN $2 THEN $4 ELSE sent_at END
         WHERE id = $1 AND state = 'pending'
         RETURNING *`,
        [input.id, input.sent, serialized, now],
      );
      if (result.rows.length > 0) return nativeRow(result.rows[0]);
      const current = await db.query<any>(
        'SELECT * FROM native_winner_outbox WHERE id = $1',
        [input.id],
      );
      if (current.rows.length === 0) throw new Error('native_winner_outbox_not_found');
      return nativeRow(current.rows[0]);
    },
  };
}

export const HOST_CONTROL_RECEIPT_MAX_BYTES = MAX_RECEIPT_BYTES;
