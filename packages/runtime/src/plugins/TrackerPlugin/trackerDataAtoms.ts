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
import { atomFamily } from 'jotai-family';
import type { TrackerRecord } from '../../core/TrackerRecord';
import type { TrackerRelationshipLabelResolver } from './models/trackerGrouping';
import { getRecordTitle } from './trackerRecordAccessors';

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

/**
 * Tracker records an organization surface knows about, sliced by org id.
 *
 * Separate from `trackerItemsMapAtom` on purpose. An org surface sees items
 * across every project in the org, so its records are not the workspace's and
 * must never replace them -- an org body that seeded the workspace map emptied
 * every tracker surface in the project window (#3637). Keeping the two apart
 * means no arrangement of windows and modes can make one clobber the other.
 *
 * Only reference resolution reads this, as a fallback behind the workspace map:
 * counts, grids and pickers are workspace surfaces and stay workspace-only.
 */
export const orgTrackerItemsAtom = atom<Map<string, Map<string, TrackerRecord>>>(new Map());

/**
 * Replace one organization's slice, leaving the other orgs' slices intact.
 */
export const replaceOrgTrackerItemsAtom = atom(
  null,
  (get, set, { orgId, records }: { orgId: string; records: TrackerRecord[] }) => {
    const byOrg = new Map(get(orgTrackerItemsAtom));
    const slice = new Map<string, TrackerRecord>();
    for (const record of records) {
      slice.set(record.id, record);
    }
    byOrg.set(orgId, slice);
    set(orgTrackerItemsAtom, byOrg);
  }
);

// ============================================================
// Derived Read Atoms
// ============================================================

/**
 * All tracker records as a flat array.
 */
export const trackerItemsArrayAtom = atom((get) => {
  return Array.from(get(trackerItemsMapAtom).values());
});

/**
 * Names a referenced item by its record rather than by the snapshot stored on
 * the relationship, which is missing whenever the link was written from the
 * other side and stale after a rename. Grouping surfaces read this so a
 * milestone lane, chip, or row header shows the milestone's current title.
 */
export const trackerRelationshipLabelAtom = atom<TrackerRelationshipLabelResolver>((get) => {
  const items = get(trackerItemsMapAtom);
  return (itemId: string) => {
    const record = items.get(itemId);
    return record ? getRecordTitle(record).trim() || undefined : undefined;
  };
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
 * matches (unknown / not yet synced / outside both the workspace and the org).
 *
 * The workspace wins when both hold the key: it is the copy the rest of the UI
 * edits, so a chip agrees with the grid next to it. Org slices are searched
 * after, which is how a chip in an org room resolves an item belonging to a
 * project this window has not opened.
 */
export const trackerItemByReferenceKeyAtom = atomFamily((referenceKey: string) =>
  atom((get) => {
    const findIn = (map: Map<string, TrackerRecord>): TrackerRecord | null => {
      const direct = map.get(referenceKey);
      if (direct) return direct;
      for (const record of map.values()) {
        if (record.issueKey === referenceKey) return record;
      }
      return null;
    };
    const workspace = findIn(get(trackerItemsMapAtom));
    if (workspace) return workspace;
    for (const slice of get(orgTrackerItemsAtom).values()) {
      const match = findIn(slice);
      if (match) return match;
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
 * Sorted, comma-joined issue-key prefixes. A string, so subscribers are only
 * notified when the prefix set changes, not on every tracker item write.
 */
export const trackerIssueKeyPrefixesKeyAtom = atom((get) =>
  Array.from(get(trackerIssueKeyPrefixesAtom)).sort().join(','),
);

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
