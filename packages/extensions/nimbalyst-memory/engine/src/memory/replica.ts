/**
 * The database → replica projection.
 *
 * This is the only sanctioned way a `MemoryRecord` becomes a replica line, and
 * it is written as an allowlist walk rather than a delete-list so that the set
 * of fields that can escape is fixed by a type, not by whoever last edited the
 * exporter. `recallCount` cannot appear in the output of this function without
 * first being added to `DurableMemoryFields`, which is a decision someone has
 * to make on purpose.
 *
 * Phase 4 owns the file format, locations, and hydration. What lives here is
 * the part phase 4 must not be free to re-decide: what a record is allowed to
 * carry off the machine, and in what order.
 */
import {
  DURABLE_MEMORY_FIELDS,
  VOLATILE_MEMORY_FIELDS,
  type DurableMemoryFields,
  type MemoryRecord,
  type MemoryReplicaRecord,
} from './types.js';

/**
 * Pinned field order. `Object.keys` on the allowlist gives insertion order, so
 * the constant doubles as the serialisation order and `JSON.stringify` over the
 * projection is byte-stable across runs without a sort at write time.
 */
const REPLICA_FIELD_ORDER = Object.keys(DURABLE_MEMORY_FIELDS) as (keyof DurableMemoryFields)[];

/** Field names that must never leave the database. Exported for the storage
 * layer, which needs to know which columns to skip, and for tests. */
export const VOLATILE_FIELD_NAMES = Object.keys(VOLATILE_MEMORY_FIELDS) as readonly string[];

/**
 * Project one record for the replica. Arrays are copied so a later mutation of
 * the live record cannot reach through into an already-exported line.
 */
export function toReplicaRecord(record: MemoryRecord): MemoryReplicaRecord {
  const out = {} as DurableMemoryFields;
  for (const key of REPLICA_FIELD_ORDER) copyField(out, record, key);
  return out;
}

/** Copy one allowlisted field. Generic over the key so the value keeps its own
 * type: a widened `Record<string, unknown>` accumulator would let any field
 * through and hand the exclusion back to whoever writes the cast. */
function copyField<K extends keyof DurableMemoryFields>(
  target: DurableMemoryFields,
  source: MemoryRecord,
  key: K
): void {
  const value = source[key];
  target[key] = (Array.isArray(value) ? [...value] : value) as DurableMemoryFields[K];
}

/**
 * Project and order a whole set. Sorted by `factId` because that is what makes
 * two branches adding different memories touch different lines: an append in
 * the middle of a sorted file is a clean git merge, an append at the end is a
 * conflict every time.
 */
export function toReplicaRecords(records: Iterable<MemoryRecord>): MemoryReplicaRecord[] {
  return [...records]
    .map(toReplicaRecord)
    .sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));
}

/**
 * Records that may be written to a *committed* replica.
 *
 * Personal memory is excluded structurally rather than by redaction. Redaction
 * removes secrets; it has nothing to say about a page that is simply nobody
 * else's business, and the harness memory root is personal by construction.
 */
export function committableRecords(records: Iterable<MemoryRecord>): MemoryRecord[] {
  return [...records].filter((r) => r.scope !== 'personal');
}
