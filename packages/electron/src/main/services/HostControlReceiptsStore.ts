import { randomUUID } from 'crypto';
import { toMillis } from '../utils/timestampUtils';

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
  }): Promise<{ row: HostControlReceiptRow; isNewReservation: boolean }>;
  finalizeReceipt(input: {
    id: string;
    state: Exclude<HostControlReceiptState, 'reserved'>;
    receipt: Record<string, unknown>;
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

type DatabaseLike = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
};

type EnsureReadyFn = () => Promise<void>;

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
): HostControlReceiptsStore {
  const ensureReady = async () => {
    if (ensureDbReady) await ensureDbReady();
  };

  return {
    async reserveReceipt(input) {
      await ensureReady();
      const id = `host-control-${randomUUID()}`;
      const inserted = await db.query<any>(
        `INSERT INTO host_control_receipts (
           id, reservation_key, request_digest, operation, session_id,
           event_identity, attention_generation, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved')
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
        ],
      );
      if (inserted.rows.length > 0) {
        return { row: hostRow(inserted.rows[0]), isNewReservation: true };
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
      return { row, isNewReservation: false };
    },

    async finalizeReceipt(input) {
      await ensureReady();
      const serialized = serializeBoundedReceipt(input.receipt);
      const now = new Date();
      const updated = await db.query<any>(
        `UPDATE host_control_receipts
         SET state = $2, receipt = $3, updated_at = $4
         WHERE id = $1 AND state = 'reserved'
         RETURNING *`,
        [input.id, input.state, serialized, now],
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
      if (row.state !== input.state) {
        throw new Error('host_control_receipt_already_finalized');
      }
      return row;
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
