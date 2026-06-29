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
  getFieldByRole,
  isMyRecord,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import type { TrackerGroupBy } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import type { TrackerFilterChip } from '../../store/atoms/trackers';
import type { ViewMode } from './TrackerMainView';
import { filterTrackerItemsByTags } from './trackerTagFilterUtils';

export { groupTrackerItems } from '@nimbalyst/runtime/plugins/TrackerPlugin';
export type { TrackerGroup, TrackerGroupBy } from '@nimbalyst/runtime/plugins/TrackerPlugin';

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
