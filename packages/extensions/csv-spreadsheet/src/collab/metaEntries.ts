/**
 * Per-entry storage for the Phase 3 metadata fields in the collab meta map.
 *
 * Each entry is its own key in the root `meta` map, namespaced by field:
 * `cellFormats/A1:A3`, `hiddenRows/12`, `conditionalFormats/<id>`. There is no
 * nested `Y.Map` per field, because two clients that each lazily create the
 * nested map under the same key while offline produce two competing maps, and
 * the merge keeps one of them whole: the other client's entries are lost on
 * both sides.
 *
 * Range-keyed fields are ordered (a later entry wins where ranges overlap), and
 * updating a `Y.Map` entry does not move it in iteration order, which is not
 * the same on every peer anyway. So every entry carries an explicit order stamp
 * `o`, larger than every stamp the writer has seen, and the writer's clientID
 * `c`. Readers sort by `(o, c, key)`, which every peer resolves identically.
 * An entry that only has to move later (its value unchanged) gets a separate
 * order key, `cellFormats#/A1`, holding just `{o, c}`; its position is the later
 * of the two stamps. Moving an entry therefore never republishes its value,
 * which would overwrite a collaborator's concurrent edit to it.
 *
 * Docs written by a build that nested these fields are read through, never
 * migrated: that build is still writing its nested map, so copying or deleting
 * it would race its edits. A field reads as the nested entries (sorted by their
 * legacy order, then key, so every peer agrees) followed by the per-entry keys,
 * and a per-entry key shadows the nested entry with the same key. A flat key is
 * written only when the local user changes that entry; clearing an entry the
 * nested map still holds writes a tombstone (`v: null`) rather than touching
 * the nested map. The older build keeps seeing only its nested map, so it does
 * not see edits newer clients make to these fields.
 */

import * as Y from 'yjs';

/** The stored envelope: value (null = tombstone), order stamp, writer clientID. */
interface Entry extends Stamp {
  v: unknown;
}

/** An order stamp, alone under an order key or inside an entry. */
interface Stamp {
  o: number;
  c: number;
}

export interface FieldEntry {
  key: string;
  value: unknown;
}

export interface LegacyField {
  /** Order for nested values that carried one (conditional formats). */
  order?: (value: unknown) => number;
  /** Nested values that wrapped the real value. */
  unwrap?: (value: unknown) => unknown;
}

const SEPARATOR = '/';
const ORDER_MARK = '#';

export function entryKey(field: string, key: string): string {
  return `${field}${SEPARATOR}${key}`;
}

function orderKey(field: string, key: string): string {
  return `${field}${ORDER_MARK}${SEPARATOR}${key}`;
}

function isStamp(value: unknown): value is Stamp {
  return typeof value === 'object' && value !== null
    && typeof (value as Stamp).o === 'number' && typeof (value as Stamp).c === 'number';
}

function isEntry(value: unknown): value is Entry {
  return isStamp(value) && 'v' in value;
}

function compareStamps(a: Stamp, b: Stamp): number {
  return (a.o - b.o) || (a.c - b.c);
}

function laterStamp(a: Stamp | undefined, b: Stamp | undefined): Stamp | null {
  if (!a || !b) return a ?? b ?? null;
  return compareStamps(a, b) >= 0 ? a : b;
}

/** The order-only stamps stored for one field. */
function orderStamps(meta: Y.Map<unknown>, field: string): Map<string, Stamp> {
  const prefix = field + ORDER_MARK + SEPARATOR;
  const out = new Map<string, Stamp>();
  for (const [key, value] of meta.entries()) {
    if (key.startsWith(prefix) && isStamp(value)) out.set(key.slice(prefix.length), { o: value.o, c: value.c });
  }
  return out;
}

/** The per-entry keys stored for one field, tombstones included, unordered. */
function flatEntries(meta: Y.Map<unknown>, field: string): Map<string, Entry> {
  const prefix = field + SEPARATOR;
  const out = new Map<string, Entry>();
  for (const [key, value] of meta.entries()) {
    if (key.startsWith(prefix) && isEntry(value)) out.set(key.slice(prefix.length), value);
  }
  return out;
}

/** Entries of a nested map written by an earlier build, in a peer-independent order. */
function nestedEntries(meta: Y.Map<unknown>, field: string, legacy?: LegacyField): FieldEntry[] {
  const nested = meta.get(field);
  if (!(nested instanceof Y.Map)) return [];
  const entries: Array<FieldEntry & { order: number }> = [];
  for (const [key, raw] of nested.entries()) {
    if (raw === undefined || raw === null) continue;
    const value = legacy?.unwrap ? legacy.unwrap(raw) : raw;
    if (value === undefined || value === null) continue;
    entries.push({ key, value, order: legacy?.order ? legacy.order(raw) : 0 });
  }
  entries.sort((a, b) => (a.order - b.order) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return entries.map(({ key, value }) => ({ key, value }));
}

interface Visible extends FieldEntry {
  /** Position in precedence order. */
  index: number;
}

/**
 * The field as readers see it, plus which keys the nested map and the order
 * keys still hold. Unstamped nested entries come first in their legacy order;
 * everything stamped follows by `(o, c, key)`, an entry's stamp being the later
 * of its value stamp and its order key.
 */
function resolve(meta: Y.Map<unknown>, field: string, legacy?: LegacyField): {
  visible: Visible[];
  flat: Map<string, Entry>;
  orders: Map<string, Stamp>;
  nestedKeys: Set<string>;
} {
  const flat = flatEntries(meta, field);
  const orders = orderStamps(meta, field);
  const nested = nestedEntries(meta, field, legacy);
  const items: Array<FieldEntry & { stamp: Stamp | null; rank: number }> = [];
  nested.forEach((entry, rank) => {
    if (!flat.has(entry.key)) items.push({ ...entry, stamp: orders.get(entry.key) ?? null, rank });
  });
  for (const [key, entry] of flat) {
    if (entry.v === null || entry.v === undefined) continue;
    items.push({ key, value: entry.v, stamp: laterStamp(entry, orders.get(key)), rank: 0 });
  }
  items.sort((a, b) => {
    if (!a.stamp || !b.stamp) return a.stamp ? 1 : b.stamp ? -1 : a.rank - b.rank;
    return compareStamps(a.stamp, b.stamp) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
  return {
    visible: items.map(({ key, value }, index) => ({ key, value, index })),
    flat,
    orders,
    nestedKeys: new Set(nested.map((entry) => entry.key)),
  };
}

/** A field's entries in precedence order: earliest first, later entries win. */
export function readField(meta: Y.Map<unknown>, field: string, legacy?: LegacyField): FieldEntry[] {
  return resolve(meta, field, legacy).visible.map(({ key, value }) => ({ key, value }));
}

/** Highest order stamp in the map, so a new stamp sorts after everything this client has seen. */
export function maxOrderStamp(meta: Y.Map<unknown>): number {
  let max = 0;
  for (const [key, value] of meta.entries()) {
    if (key.includes(SEPARATOR) && isStamp(value)) max = Math.max(max, value.o);
  }
  return max;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface WriteFieldOptions {
  clientId: number;
  stamps: { max: number };
  ordered: boolean;
  /** What this client last published or absorbed for the field; null before the first publish. */
  previous: readonly FieldEntry[] | null;
  legacy?: LegacyField;
}

/**
 * Write a field so that reading it back yields `desired` in this order.
 *
 * Only entries the local user changed are written. An entry whose value and
 * relative order already match is left alone, and so is one whose desired
 * value is what this client last saw while the doc now holds something else:
 * that is a collaborator's edit the local state has not absorbed yet. A
 * changed entry is written with a fresh stamp above `stamps.max`; an unchanged
 * one that now has to sort after its predecessor gets only a fresh order key,
 * never a copy of its value. Must run inside a transaction.
 */
export function writeField(
  meta: Y.Map<unknown>,
  field: string,
  desired: readonly FieldEntry[],
  options: WriteFieldOptions,
): void {
  const { clientId, stamps, ordered, previous, legacy } = options;
  const { visible, flat, orders, nestedKeys } = resolve(meta, field, legacy);
  const current = new Map(visible.map((entry) => [entry.key, entry]));
  const before = previous ? new Map(previous.map((entry) => [entry.key, entry.value])) : null;
  const stamp = (): Stamp => {
    stamps.max += 1;
    return { o: stamps.max, c: clientId };
  };
  const dropOrder = (key: string) => {
    if (orders.has(key)) meta.delete(orderKey(field, key));
  };

  let lastIndex = -1;
  for (const { key, value } of desired) {
    const existing = current.get(key);
    if (existing && sameJson(existing.value, value)) {
      if (!ordered || existing.index > lastIndex) {
        lastIndex = existing.index;
        continue;
      }
      // Only the position changed: restamp the order, leave the value alone.
      meta.set(orderKey(field, key), stamp());
      lastIndex = Number.POSITIVE_INFINITY;
      continue;
    }
    const remoteChanged = before !== null && before.has(key) && sameJson(before.get(key), value);
    if (remoteChanged) continue;
    meta.set(entryKey(field, key), { v: value, ...stamp() });
    dropOrder(key);
    lastIndex = Number.POSITIVE_INFINITY;
  }

  const wanted = new Set(desired.map((entry) => entry.key));
  for (const { key } of visible) {
    if (wanted.has(key) || (before !== null && !before.has(key))) continue;
    // The nested map is never edited; a tombstone shadows its entry instead.
    if (nestedKeys.has(key)) meta.set(entryKey(field, key), { v: null, ...stamp() });
    else if (flat.has(key)) meta.delete(entryKey(field, key));
    dropOrder(key);
  }
}
