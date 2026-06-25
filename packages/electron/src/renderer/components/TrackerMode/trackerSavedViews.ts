/**
 * Saved-view definitions and the pure filter/group logic behind them (NIM-788).
 *
 * A saved view is a named snapshot of the tracker view state — which type is
 * selected, which filter chips are active, the display mode, an optional tag
 * filter, and how items are grouped. Definitions are persisted per workspace
 * via the workspace-settings store (see store/atoms/trackers.ts); this module
 * holds only the types and the pure, side-effect-free filter/group functions so
 * they can be unit-tested without React or IPC.
 */

import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { TrackerIdentity } from '@nimbalyst/runtime';
import {
  getRecordPriority,
  getRecordStatus,
  getFieldByRole,
  isMyRecord,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import type { TrackerFilterChip } from '../../store/atoms/trackers';
import type { ViewMode } from './TrackerMainView';
import { getTrackerItemTags, filterTrackerItemsByTags } from './trackerTagFilterUtils';

/** How items are grouped in a grouped view. `none` = a single flat group. */
export type TrackerGroupBy = 'none' | 'status' | 'priority' | 'assignee' | 'type' | 'tag';

export interface SavedViewDefinition {
  /** Selected type filter: `'all'` or a specific tracker type. */
  selectedType: string;
  /** Active filter chips (intersection). */
  activeFilters: TrackerFilterChip[];
  /** Display mode. */
  viewMode: ViewMode;
  /** Tag filter (OR match); empty = no tag filter. */
  tagFilter: string[];
  /** Grouping for grouped renderings. */
  groupBy: TrackerGroupBy;
}

export interface SavedView {
  id: string;
  name: string;
  definition: SavedViewDefinition;
}

export function createDefaultViewDefinition(): SavedViewDefinition {
  return {
    selectedType: 'all',
    activeFilters: [],
    viewMode: 'list',
    tagFilter: [],
    groupBy: 'none',
  };
}

/**
 * Merge a possibly-partial persisted definition with defaults so older saved
 * views (missing fields added later) load safely.
 */
export function normalizeViewDefinition(raw: Partial<SavedViewDefinition> | undefined | null): SavedViewDefinition {
  const base = createDefaultViewDefinition();
  if (!raw || typeof raw !== 'object') return base;
  return {
    selectedType: typeof raw.selectedType === 'string' ? raw.selectedType : base.selectedType,
    activeFilters: Array.isArray(raw.activeFilters) ? raw.activeFilters : base.activeFilters,
    viewMode: (raw.viewMode as ViewMode) ?? base.viewMode,
    tagFilter: Array.isArray(raw.tagFilter) ? raw.tagFilter.filter((t): t is string => typeof t === 'string') : base.tagFilter,
    groupBy: (raw.groupBy as TrackerGroupBy) ?? base.groupBy,
  };
}

export interface FilterContext {
  /** Current user identity, required for the `mine` chip. */
  identity?: TrackerIdentity | null;
}

/**
 * Apply the row-level predicates of a saved view to a set of items: the `mine`,
 * `unassigned`, and `high-priority` chips, plus the tag filter. This is the pure
 * core of TrackerMainView's filtering. Source-set chips that swap the input list
 * (`archived`) or re-sort/slice it (`recently-updated`) are handled by the
 * caller, since they operate on which items are passed in, not on a predicate.
 */
export function filterTrackerItems(
  items: TrackerRecord[],
  def: Pick<SavedViewDefinition, 'activeFilters' | 'tagFilter'>,
  ctx: FilterContext = {},
): TrackerRecord[] {
  let out = items;

  if (def.activeFilters.includes('mine') && ctx.identity) {
    const id = ctx.identity;
    out = out.filter((r) => isMyRecord(r, id));
  }

  if (def.activeFilters.includes('unassigned')) {
    out = out.filter((r) => !getFieldByRole(r, 'assignee'));
  }

  if (def.activeFilters.includes('high-priority')) {
    out = out.filter((r) => {
      const p = getRecordPriority(r);
      return p === 'critical' || p === 'high';
    });
  }

  out = filterTrackerItemsByTags(out, def.tagFilter);

  return out;
}

export interface TrackerGroup {
  /** Group key: the field value, or `''` for the empty/none bucket. */
  key: string;
  label: string;
  items: TrackerRecord[];
}

function titleCase(value: string): string {
  return value
    .split('-')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function singleGroupValue(item: TrackerRecord, groupBy: Exclude<TrackerGroupBy, 'none' | 'tag'>): string {
  switch (groupBy) {
    case 'status':
      return (getRecordStatus(item) || '').toLowerCase();
    case 'priority':
      return (getRecordPriority(item) || '').toLowerCase();
    case 'type':
      return item.primaryType;
    case 'assignee':
      return ((getFieldByRole(item, 'assignee') as string | undefined) || '');
  }
}

/**
 * Group items for a grouped rendering. `none` returns a single bucket; `tag`
 * groups by the schema tags role (an item with N tags appears in N groups, with
 * a trailing "Untagged" bucket); the rest group by a single-valued field in
 * first-seen order, collecting empty values into a trailing fallback bucket
 * ("Unassigned" for assignee, "None" otherwise).
 */
export function groupTrackerItems(items: TrackerRecord[], groupBy: TrackerGroupBy): TrackerGroup[] {
  if (groupBy === 'none') {
    return [{ key: '', label: 'All', items }];
  }

  if (groupBy === 'tag') {
    const byTag = new Map<string, TrackerRecord[]>();
    const order: string[] = [];
    const untagged: TrackerRecord[] = [];
    for (const item of items) {
      const tags = Array.from(new Set(getTrackerItemTags(item)));
      if (tags.length === 0) {
        untagged.push(item);
        continue;
      }
      for (const tag of tags) {
        const bucket = byTag.get(tag);
        if (bucket) bucket.push(item);
        else {
          byTag.set(tag, [item]);
          order.push(tag);
        }
      }
    }
    const groups: TrackerGroup[] = order.map((tag) => ({ key: tag, label: `#${tag}`, items: byTag.get(tag)! }));
    if (untagged.length > 0) groups.push({ key: '', label: 'Untagged', items: untagged });
    return groups;
  }

  const buckets = new Map<string, TrackerRecord[]>();
  const order: string[] = [];
  for (const item of items) {
    const value = singleGroupValue(item, groupBy);
    const bucket = buckets.get(value);
    if (bucket) bucket.push(item);
    else {
      buckets.set(value, [item]);
      order.push(value);
    }
  }

  const emptyLabel = groupBy === 'assignee' ? 'Unassigned' : 'None';
  // Keep non-empty groups in first-seen order; push the empty bucket last.
  const nonEmpty = order.filter((v) => v !== '');
  const groups: TrackerGroup[] = nonEmpty.map((value) => ({
    key: value,
    label: groupBy === 'type' || groupBy === 'assignee' ? value : titleCase(value),
    items: buckets.get(value)!,
  }));
  if (buckets.has('')) {
    groups.push({ key: '', label: emptyLabel, items: buckets.get('')! });
  }
  return groups;
}
