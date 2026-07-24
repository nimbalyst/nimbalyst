/**
 * Add-wins CRDT for tracker labels.
 *
 * `TrackerItemPayload.labels` is `Record<entryId, LabelEntry>` -- per-element
 * stable IDs let concurrent additions survive across peers (D3 of the
 * tracker-sync redesign). Removals tombstone the matching entries; on merge
 * a tombstone on one side wins over a live entry on the other side AT THE
 * SAME KEY. Different keys with the same `value` (two clients each adding
 * "bug") both survive -- that's the add-wins property.
 *
 * The on-screen value list is a projection of the map: unique `value`s
 * from non-tombstoned entries. The legacy `labels: string[]` API is kept;
 * callers diff-update against the prior map via `applyLabelDiff`.
 */
import type { LabelEntry } from './trackerProtocol';

export type LabelsMap = Record<string, LabelEntry>;

/**
 * Project a CRDT labels map to the user-facing unique value list. Tombstoned
 * entries are excluded; duplicate values from different IDs collapse.
 */
export function projectLabelsToValues(map: LabelsMap | undefined): string[] {
  if (!map) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of Object.values(map)) {
    // Defensive: a corrupted map may carry non-object entries (a known
    // failure mode was a `data->'labelsMap'` round-trip that left character-
    // keyed string entries spread into the map). Skip anything that isn't a
    // proper LabelEntry rather than emitting `undefined`/`null` to the UI.
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.value !== 'string') continue;
    if (entry.tombstone) continue;
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    out.push(entry.value);
  }
  return out;
}

/**
 * Diff a user-facing string[] update against the prior CRDT map. Values
 * present in `newValues` but not represented by a live entry become fresh
 * additions (new IDs). Values represented by live entries but missing from
 * `newValues` get all their live entries tombstoned. Existing tombstones
 * are preserved verbatim.
 *
 * Returns the next CRDT map. The caller persists it; the producer ships it.
 */
export function applyLabelDiff(
  prior: LabelsMap | undefined,
  newValues: string[] | undefined,
  newIdFactory: () => string = defaultIdFactory,
): LabelsMap {
  const next: LabelsMap = { ...(prior ?? {}) };
  const desired = new Set((newValues ?? []).filter((v) => typeof v === 'string'));

  // Index existing live entries by value so we can find what to tombstone
  // and what's already represented.
  const liveByValue = new Map<string, string[]>(); // value -> entryIds
  for (const [id, entry] of Object.entries(next)) {
    if (entry.tombstone) continue;
    const arr = liveByValue.get(entry.value);
    if (arr) arr.push(id);
    else liveByValue.set(entry.value, [id]);
  }

  // Tombstone live entries whose value was removed from the desired set.
  for (const [value, ids] of liveByValue.entries()) {
    if (desired.has(value)) continue;
    for (const id of ids) {
      next[id] = { ...next[id], tombstone: true };
    }
  }

  // Mint a new entry for desired values that have no live representation.
  for (const value of desired) {
    if (liveByValue.has(value)) continue;
    const id = newIdFactory();
    next[id] = { id, value };
  }

  return next;
}

/**
 * Union two CRDT label maps. Per-key, a tombstone on either side wins
 * (remove-wins-by-key); keys present on only one side carry through
 * unchanged. The result is the merged add-wins set both peers should
 * converge on once the delta has propagated in both directions.
 */
export function mergeLabelMaps(
  local: LabelsMap | undefined,
  incoming: LabelsMap | undefined,
): LabelsMap {
  if (!local && !incoming) return {};
  if (!local) return { ...incoming };
  if (!incoming) return { ...local };
  const merged: LabelsMap = { ...local };
  for (const [id, entry] of Object.entries(incoming)) {
    const existing = merged[id];
    if (!existing) {
      merged[id] = entry;
      continue;
    }
    // Same key on both sides. Remove wins; otherwise keep the local entry
    // (value is per-key invariant -- callers MUST NOT mutate value once
    // an id has been issued).
    if (entry.tombstone || existing.tombstone) {
      merged[id] = { ...existing, tombstone: true };
    }
  }
  return merged;
}

/**
 * Coerce the `labels` value read out of a tracker row's JSONB `data`
 * column into the `string[] | undefined` shape the rest of the pipeline
 * (notably `applyLabelDiff`) expects.
 *
 * Why this exists: some legacy rows were written with `data.labels`
 * double-stringified -- i.e. the value of `labels` is a JSON-encoded
 * string like `"[\"editor\", \"lexical\"]"` instead of a JSON array.
 * That broke the backfill path on every startup (`(newValues ?? []).filter
 * is not a function`), the items never got a `sync_id`, and they re-entered
 * the candidate set on every reconnect.
 *
 * Fix at the DB-to-domain boundary so the wrong shape can never reach
 * the labels CRDT. New writes go through the typed payload path and
 * produce `string[]`, so this is a one-way legacy compatibility shim.
 */
export function normalizeLegacyLabelValues(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string');
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      // not JSON -- treat as a no-op rather than crashing the read path
    }
    return undefined;
  }
  return undefined;
}

function defaultIdFactory(): string {
  // Prefer crypto.randomUUID in modern runtimes; fall back to a non-crypto
  // alternative so the helper stays usable in oddball environments. The IDs
  // only need to be locally unique per item -- they never act as auth.
  const c: { randomUUID?: () => string } | undefined =
    typeof globalThis !== 'undefined' ? (globalThis as any).crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `lbl_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}
