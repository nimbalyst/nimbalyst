/**
 * Retiring superseded rows in the tracker outbox (`tracker_transactions`).
 *
 * Every `update` row carries the whole item, so once a newer unconfirmed
 * update for the same item exists, an older one can only ever send stale
 * state. NIM-7336: one oversized plan left an unsendable ~600 KB update row
 * per reconnect until loading the outbox needed 257 MB and failed.
 *
 * "Newer" means later in local enqueue order, never later on the wall clock.
 * `enqueued_at` is written by `causalEnqueuedAt` below as a per-item clock
 * that only moves forward, so a clock set back between two offline edits
 * cannot make the earlier edit look like the later one. Rows enqueued before
 * that clock existed have only their wall-clock time, so they are not trusted
 * to say which is newest: at engine start the store rebuilds one update from
 * the item's local row when that row is still the newest local state, and
 * that rebuilt row is what replays (`TrackerPGLiteStore.consolidatePendingUpdates`).
 *
 * Nothing is deleted at startup. Older rows are only hidden from load and
 * replay, behind a later unconfirmed `update` of the same item, in the same
 * workspace, carrying a whole-item payload, never refused by the room, and
 * with no create or delete of the item between the two. If that replacement
 * is refused, the rows behind it come back. Rows are deleted only when the
 * room accepts their replacement (`ackAndRetireSuperseded`), which follows
 * destructive-data-paths.md: the count per item is logged before the delete,
 * and the delete runs in one transaction guarded on that count. The item
 * itself lives in `tracker_items` and is never touched by this module.
 */
import type { AppDatabase } from '../../database/PGLiteDatabaseWorker';
import { logger } from '../../utils/logger';

type OutboxDatabase = Pick<AppDatabase, 'query' | 'runTransaction'>;

/**
 * True when no create or delete of the item sits between the outer row and
 * `replacement`: an update on either side of one is not interchangeable.
 */
function noKindChangeBetween(replacement: string): string {
  return `NOT EXISTS (
      SELECT 1 FROM tracker_transactions mid
       WHERE mid.workspace_path = tracker_transactions.workspace_path
         AND mid.item_id = tracker_transactions.item_id
         AND mid.kind <> 'update'
         AND mid.enqueued_at > tracker_transactions.enqueued_at
         AND mid.enqueued_at < ${replacement}.enqueued_at
    )`;
}

/**
 * True for an unconfirmed `update` row that a later replayable `update` of the
 * same item supersedes. A replacement the room has refused, for any reason,
 * supersedes nothing: it may never be sent, and its predecessor still carries
 * an edit the room has not seen. The outer table is referenced by name, not
 * alias, so the same text works in a SELECT and a DELETE on both backends.
 */
export const SUPERSEDED_UPDATE = `(
  tracker_transactions.kind = 'update'
  AND tracker_transactions.confirmed_sync_id IS NULL
  AND EXISTS (
    SELECT 1 FROM tracker_transactions newer
     WHERE newer.workspace_path = tracker_transactions.workspace_path
       AND newer.item_id = tracker_transactions.item_id
       AND newer.kind = 'update'
       AND newer.payload IS NOT NULL
       AND newer.confirmed_sync_id IS NULL
       AND newer.last_rejection IS NULL
       AND newer.enqueued_at > tracker_transactions.enqueued_at
       AND ${noKindChangeBetween('newer')}
  )
)`;

const enqueueChains = new Map<string, Promise<unknown>>();

/**
 * Run `write` after every earlier outbox write for the same item has settled,
 * so two enqueues for one item cannot both read the same latest time.
 */
export function serializeOutboxWrite<T>(workspacePath: string, itemId: string, write: () => Promise<T>): Promise<T> {
  const key = `${workspacePath}\u0000${itemId}`;
  const run = (enqueueChains.get(key) ?? Promise.resolve()).then(write, write);
  const settled = run.catch(() => undefined);
  enqueueChains.set(key, settled);
  void settled.then(() => {
    if (enqueueChains.get(key) === settled) enqueueChains.delete(key);
  });
  return run;
}

function toMillis(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The `enqueued_at` for a new outbox row: the requested wall-clock time, or one
 * millisecond after the item's latest row if the clock has gone backwards
 * since. Returned as an ISO string because both backends store that exactly;
 * a float through `to_timestamp` can land a millisecond short on SQLite.
 * Call inside `serializeOutboxWrite` for the same item.
 */
export async function causalEnqueuedAt(
  db: Pick<AppDatabase, 'query'>,
  workspacePath: string,
  itemId: string,
  requestedMs: number,
): Promise<string> {
  const result = await db.query<{ latest: Date | string | null }>(
    `SELECT MAX(enqueued_at) AS latest FROM tracker_transactions WHERE workspace_path = $1 AND item_id = $2`,
    [workspacePath, itemId],
  );
  const latest = toMillis(result.rows[0]?.latest);
  return new Date(latest === null ? requestedMs : Math.max(requestedMs, latest + 1)).toISOString();
}

/** Epoch ms for an `enqueued_at` read back from either backend. */
export function enqueuedAtMillis(value: Date | string | null | undefined): number {
  return toMillis(value) ?? Date.now();
}

/** Items in one workspace with more than one replayable update row queued. */
export async function itemsWithStackedUpdates(
  db: Pick<AppDatabase, 'query'>,
  workspacePath: string,
): Promise<Array<{ itemId: string; rows: number }>> {
  const result = await db.query<{ item_id: string; n: number | string }>(
    `SELECT item_id, COUNT(*) AS n
       FROM tracker_transactions
      WHERE workspace_path = $1
        AND kind = 'update'
        AND payload IS NOT NULL
        AND confirmed_sync_id IS NULL
        AND last_rejection IS NULL
      GROUP BY item_id
     HAVING COUNT(*) > 1`,
    [workspacePath],
  );
  return result.rows.map(row => ({ itemId: row.item_id, rows: Number(row.n) }));
}

/**
 * Payload of the item's newest unconfirmed update row, refused or not. A
 * refused rebuild still counts, so a refusal does not cause a rebuild on every
 * launch.
 */
export async function newestUpdatePayload(
  db: Pick<AppDatabase, 'query'>,
  workspacePath: string,
  itemId: string,
): Promise<unknown> {
  const result = await db.query<{ payload: unknown }>(
    `SELECT payload FROM tracker_transactions
      WHERE workspace_path = $1 AND item_id = $2
        AND kind = 'update' AND confirmed_sync_id IS NULL
      ORDER BY enqueued_at DESC, client_mutation_id DESC
      LIMIT 1`,
    [workspacePath, itemId],
  );
  const raw = result.rows[0]?.payload;
  return typeof raw === 'string' ? JSON.parse(raw) : raw ?? null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner);
}

/** Equal as JSON regardless of key order (PGLite's JSONB reorders keys). */
export function samePayload(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Delete an acknowledged row, and with it the older unconfirmed updates of the
 * same item it supersedes. Without this, an older row hidden from replay
 * behind the acknowledged one would come back once that row is gone and
 * resend a stale snapshot. The room accepted the acknowledged row, so it is
 * replayable by definition; the order and no-create/delete rules still apply.
 */
export async function ackAndRetireSuperseded(
  db: OutboxDatabase,
  clientMutationId: string,
): Promise<void> {
  const olderOfAcked = `
    tracker_transactions.kind = 'update'
    AND tracker_transactions.confirmed_sync_id IS NULL
    AND EXISTS (
      SELECT 1 FROM tracker_transactions acked
       WHERE acked.client_mutation_id = $1
         AND acked.kind = 'update'
         AND acked.payload IS NOT NULL
         AND acked.workspace_path = tracker_transactions.workspace_path
         AND acked.item_id = tracker_transactions.item_id
         AND acked.enqueued_at > tracker_transactions.enqueued_at
         AND ${noKindChangeBetween('acked')}
    )`;
  const counted = await db.query<{ item_id: string; n: number | string }>(
    `SELECT item_id, COUNT(*) AS n FROM tracker_transactions WHERE ${olderOfAcked} GROUP BY item_id`,
    [clientMutationId],
  );
  const older = counted.rows.reduce((sum, row) => sum + Number(row.n), 0);
  if (older > 0) {
    logger.main.info('[TrackerOutbox] ack retires', older, 'superseded update row(s) for item', counted.rows[0].item_id);
  }
  await db.runTransaction([
    ...(older > 0
      ? [{ sql: `DELETE FROM tracker_transactions WHERE ${olderOfAcked} RETURNING client_mutation_id`, params: [clientMutationId], expectedRows: older }]
      : []),
    { sql: `DELETE FROM tracker_transactions WHERE client_mutation_id = $1`, params: [clientMutationId] },
  ]);
}
