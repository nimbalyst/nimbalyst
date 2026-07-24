/**
 * Tracker Data Atoms
 *
 * Cross-platform Jotai atoms that hold tracker record data.
 * Platform host adapters (Electron IPC listener, mobile adapter)
 * populate these atoms. TrackerTable reads from them reactively.
 *
 * Uses the canonical TrackerRecord type. Legacy TrackerItem consumers
 * can use the compat converters from TrackerRecord.ts.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { TrackerRecord } from '../../core/TrackerRecord';

// ============================================================
// Primary Data Store
// ============================================================

/**
 * All tracker records keyed by ID.
 * This is the single source of truth for tracker item data.
 * Host adapters populate this atom; UI components read from it.
 */
export const trackerItemsMapAtom = atom<Map<string, TrackerRecord>>(new Map());

/**
 * Whether the initial data load has completed.
 * Used by TrackerTable to show loading state on first mount.
 */
export const trackerDataLoadedAtom = atom(false);

// ============================================================
// Derived Read Atoms
// ============================================================

/**
 * All tracker records as a flat array.
 */
export const trackerItemsArrayAtom = atom((get) => {
  return Array.from(get(trackerItemsMapAtom).values());
});

/** Check if a record matches a type filter (primary type or any type tag) */
function recordMatchesType(record: TrackerRecord, type: string): boolean {
  if (record.primaryType === type) return true;
  return record.typeTags.includes(type);
}

/**
 * Tracker records filtered by type (excludes archived).
 * Returns all non-archived records when type is 'all'.
 * Matches on primary type OR any type tag.
 */
export const trackerItemsByTypeAtom = atomFamily((type: string | 'all') =>
  atom((get) => {
    const map = get(trackerItemsMapAtom);
    const all = Array.from(map.values());
    const active = all.filter(record => !record.archived);
    if (type === 'all') return active;
    return active.filter(record => recordMatchesType(record, type));
  })
);

/**
 * Archived tracker records, optionally filtered by type.
 * Matches on primary type OR any type tag.
 */
export const archivedTrackerItemsAtom = atomFamily((type: string | 'all') =>
  atom((get) => {
    const map = get(trackerItemsMapAtom);
    const all = Array.from(map.values());
    const archived = all.filter(record => record.archived);
    if (type === 'all') return archived;
    return archived.filter(record => recordMatchesType(record, type));
  })
);

/**
 * A single tracker record by ID.
 * Only notifies subscribers when that specific record changes, not when
 * other records in the map change. Use this in detail/edit components
 * so they don't re-render on unrelated record updates.
 */
export const trackerItemByIdAtom = atomFamily((id: string) =>
  atom((get) => get(trackerItemsMapAtom).get(id) ?? null)
);

/**
 * A single tracker record by reference key — an issue key (NIM-123) or the
 * internal record id. Used by inline tracker reference chips, which store only
 * a reference key and resolve the live record here. Returns null when no record
 * matches (unknown / not yet synced / different workspace).
 */
export const trackerItemByReferenceKeyAtom = atomFamily((referenceKey: string) =>
  atom((get) => {
    const map = get(trackerItemsMapAtom);
    const direct = map.get(referenceKey);
    if (direct) return direct;
    for (const record of map.values()) {
      if (record.issueKey === referenceKey) return record;
    }
    return null;
  })
);

/**
 * The set of distinct issue-key prefixes present in the workspace (uppercased),
 * derived from existing records' `issueKey`s (e.g. `NIM-123` -> `NIM`).
 *
 * Used to auto-link bare tracker keys in transcript prose without hardcoding a
 * prefix (prefixes are workspace-configurable via `tracker_set_issue_key_prefix`)
 * and without matching unrelated tokens like `UTF-8` or `COVID-19` — only a
 * prefix that actually has a tracker item in this workspace is eligible.
 */
export const trackerIssueKeyPrefixesAtom = atom<Set<string>>((get) => {
  const map = get(trackerItemsMapAtom);
  const prefixes = new Set<string>();
  for (const record of map.values()) {
    const key = record.issueKey;
    if (!key) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(key);
    if (match) prefixes.add(match[1].toUpperCase());
  }
  return prefixes;
});

/**
 * Count of non-archived records per type.
 */
export const trackerItemCountByTypeAtom = atomFamily((type: string) =>
  atom((get) => {
    return get(trackerItemsByTypeAtom(type)).length;
  })
);

// ============================================================
// Write Atoms (for host adapters)
// ============================================================

/**
 * Upsert a single tracker record.
 * If the record already exists (by ID), it is replaced.
 */
export const upsertTrackerItemAtom = atom(null, (get, set, record: TrackerRecord) => {
  const map = new Map(get(trackerItemsMapAtom));
  map.set(record.id, record);
  set(trackerItemsMapAtom, map);
});

/**
 * Remove a single tracker record by ID.
 */
export const removeTrackerItemAtom = atom(null, (get, set, id: string) => {
  const map = new Map(get(trackerItemsMapAtom));
  if (map.delete(id)) {
    set(trackerItemsMapAtom, map);
  }
});

/**
 * Replace all tracker records at once (bulk load).
 * Used for initial load and full refresh.
 */
export const replaceAllTrackerItemsAtom = atom(null, (_get, set, records: TrackerRecord[]) => {
  const map = new Map<string, TrackerRecord>();
  for (const record of records) {
    map.set(record.id, record);
  }
  set(trackerItemsMapAtom, map);
  set(trackerDataLoadedAtom, true);
});
