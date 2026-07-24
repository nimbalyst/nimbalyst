/**
 * No-op guard for tracker projection writes (NIM-1559).
 *
 * The frontmatter/inline projection re-runs on every cold-open scan and on
 * every file-change re-index. Each of those write paths used to stamp
 * `updated = NOW()` unconditionally, so an item's "updated" timestamp
 * advanced even when nothing about it actually changed -- and for shared
 * `fm:` items that bogus timestamp then synced to the whole org, making it
 * impossible to see what really changed.
 *
 * These helpers answer the single question the projection paths need:
 * "would re-projecting these fields (a shallow overlay merged into the
 * stored `data` JSONB) change any value I write, or the markdown body?"
 * If not, the caller preserves the existing `updated` and only advances
 * `last_indexed` (the scan timestamp).
 *
 * The projection upsert merges with `data = tracker_items.data || $new`,
 * a SHALLOW (top-level) JSONB overlay, so only the keys present in the
 * newly-projected `data` can change; keys the indexer never writes
 * (activity, comments, authorIdentity, linkedSessions, ...) are preserved
 * and must NOT be considered. That is why this compares only the keys in
 * `newData`, never the full stored object.
 */

/**
 * Order-insensitive deep equality good enough for projected frontmatter
 * values (scalars, string arrays, small nested objects like `share`).
 * Errs toward "not equal" for exotic shapes -- a false "changed" only
 * reproduces the current unconditional-bump behavior, never data loss.
 */
export function projectionValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    // Treat null/undefined as interchangeable "absent".
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!projectionValueEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, k)) return false;
    if (!projectionValueEqual(aObj[k], bObj[k])) return false;
  }
  return true;
}

/**
 * The `content` column stores `JSON.stringify(markdownBody)` (or NULL).
 * A whole-column `SELECT content` returns that raw JSON string on both
 * backends. Normalize both sides to the stored representation before
 * comparing so a byte-identical body is not seen as a change.
 */
export function projectionContentEqual(
  existingContentRaw: unknown,
  newContentJson: string | null,
): boolean {
  const existing =
    existingContentRaw == null
      ? null
      : typeof existingContentRaw === 'string'
        ? existingContentRaw
        : JSON.stringify(existingContentRaw);
  return (existing ?? null) === (newContentJson ?? null);
}

/**
 * True when re-projecting `newData` onto `existingData` (the shallow
 * `data || newData` overlay) would change any projected value, or the
 * markdown body changed. `existingData` may be the parsed stored JSONB
 * (or `null`/`{}` when there is no prior row -- callers treat a missing
 * row as "changed" before calling this).
 */
export function projectionWouldChange(
  existingData: Record<string, unknown> | null | undefined,
  newData: Record<string, unknown>,
  existingContentRaw?: unknown,
  newContentJson?: string | null,
): boolean {
  const existing = existingData ?? {};
  for (const [key, value] of Object.entries(newData)) {
    // `JSON.stringify` DROPS keys whose value is `undefined`, and the write
    // is a shallow `data || JSON.stringify(newData)` overlay -- so an
    // undefined projected value can never change or clear the stored field
    // (the existing value is preserved). Comparing it would be a false
    // positive: the inline parser emits `description: undefined` /
    // `owner: undefined` for single-line items, while the stored row may
    // carry a rich description/owner added via the UI or sync. Skip them so
    // a no-op re-index does not "detect" a change (NIM-1559).
    if (value === undefined) continue;
    if (!projectionValueEqual(existing[key], value)) return true;
  }
  if (arguments.length >= 3) {
    if (!projectionContentEqual(existingContentRaw, newContentJson ?? null)) {
      return true;
    }
  }
  return false;
}
