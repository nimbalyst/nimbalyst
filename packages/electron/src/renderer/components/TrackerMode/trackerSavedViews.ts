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
  applyFilterSet,
  type TrackerFilterEvaluationContext,
  type TrackerFilterSet,
  type TrackerFieldFilter,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  getCellValue,
  type SortColumn,
  type SortDirection,
  type TypeColumnConfig,
} from '@nimbalyst/runtime/plugins/TrackerPlugin';
import {
  getRecordPriority,
  getRecordStatus,
  getFieldByRole,
  isMyRecord,
  isSameIdentity,
  resolveRoleFieldName,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import type { TrackerFilterChip } from '../../store/atoms/trackers';
import type { ViewMode } from './TrackerMainView';
import { getTrackerItemTags, filterTrackerItemsByTags } from './trackerTagFilterUtils';

/** How items are grouped in a grouped view. `none` = a single flat group. */
export type TrackerGroupBy = 'none' | 'status' | 'priority' | 'assignee' | 'type' | 'tag';

export const STATUS_CHANGED_TO_FILTER_FIELD = 'statusChangedTo';
export const STATUS_CHANGED_FROM_FILTER_FIELD = 'statusChangedFrom';

export function normalizeTrackerGroupBy(value: unknown): TrackerGroupBy {
  if (value === 'owner') return 'assignee';
  if (
    value === 'status'
    || value === 'priority'
    || value === 'assignee'
    || value === 'type'
    || value === 'tag'
  ) {
    return value;
  }
  return 'none';
}

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
  /** Flat list/table sort column. */
  sortBy: SortColumn;
  /** Flat list/table sort direction. */
  sortDirection: SortDirection;
  /** Genuine-open lookback in days; null means any time. */
  recentlyViewedDays: 7 | 30 | 90 | null;
  /**
   * Column layout captured with the view, so restoring a view reproduces the
   * whole table state and not just its filters. `null` means "leave the
   * current column config alone" -- views saved before this existed.
   */
  columnConfig: TypeColumnConfig | null;
  /**
   * Per-column filter set, in the shared `{field, op, value}` language. Applies
   * on top of `activeFilters` (the coarse chips).
   */
  columnFilters: TrackerFilterSet | null;
  /** Scope for the triage inbox view: all types, or the selected type only. */
  inboxScope: 'global' | 'type' | null;
}

export interface SavedView {
  id: string;
  name: string;
  definition: SavedViewDefinition;
  /**
   * Whether this view is shared with the team (synced) rather than local-only.
   * Absent on views saved before sharing existed, which are local.
   */
  shared?: boolean;
}

export function createDefaultViewDefinition(): SavedViewDefinition {
  return {
    selectedType: 'all',
    activeFilters: [],
    viewMode: 'list',
    tagFilter: [],
    groupBy: 'none',
    sortBy: 'lastIndexed',
    sortDirection: 'desc',
    recentlyViewedDays: 30,
    columnConfig: null,
    columnFilters: null,
    inboxScope: null,
  };
}

/** Whether the current unsaved state contains anything worth naming as a view. */
export function hasSavableViewState(definition: SavedViewDefinition): boolean {
  const defaults = createDefaultViewDefinition();
  return definition.selectedType !== defaults.selectedType
    || definition.activeFilters.length > 0
    || definition.tagFilter.length > 0
    || definition.viewMode !== defaults.viewMode
    || definition.groupBy !== defaults.groupBy
    || definition.sortBy !== defaults.sortBy
    || definition.sortDirection !== defaults.sortDirection
    || definition.recentlyViewedDays !== defaults.recentlyViewedDays
    || definition.columnConfig !== null
    || (definition.columnFilters?.clauses.length ?? 0) > 0
    || definition.inboxScope === 'type';
}

/**
 * Coerce a persisted `viewMode` to one this build still renders.
 *
 * `'grid'` was the RevoGrid table's own mode while it sat beside the
 * hand-rolled table; RevoGrid is the table now, so it folds into `'table'`.
 * Saved views also travel between users on different builds, so an unknown
 * literal falls back rather than leaving the main view with no branch to take.
 */
export function normalizeViewMode(raw: unknown, fallback: ViewMode): ViewMode {
  if (raw === 'grid') return 'table';
  if (
    raw === 'list'
    || raw === 'table'
    || raw === 'kanban'
    || raw === 'tag-board'
    || raw === 'inbox'
  ) {
    return raw;
  }
  return fallback;
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
    viewMode: normalizeViewMode(raw.viewMode, base.viewMode),
    tagFilter: Array.isArray(raw.tagFilter) ? raw.tagFilter.filter((t): t is string => typeof t === 'string') : base.tagFilter,
    groupBy: normalizeTrackerGroupBy(raw.groupBy),
    sortBy: typeof raw.sortBy === 'string' ? raw.sortBy : base.sortBy,
    sortDirection: raw.sortDirection === 'asc' || raw.sortDirection === 'desc'
      ? raw.sortDirection
      : base.sortDirection,
    recentlyViewedDays: raw.recentlyViewedDays === null || raw.recentlyViewedDays === 7
      || raw.recentlyViewedDays === 30 || raw.recentlyViewedDays === 90
      ? raw.recentlyViewedDays
      : base.recentlyViewedDays,
    columnConfig: normalizeColumnConfig(raw.columnConfig),
    columnFilters: normalizeColumnFilters(raw.columnFilters),
    inboxScope: raw.inboxScope === 'global' || raw.inboxScope === 'type' ? raw.inboxScope : base.inboxScope,
  };
}

/**
 * Accept a persisted column config only if it is structurally sound. A
 * half-written config would otherwise hide every column on restore.
 */
function normalizeColumnConfig(raw: unknown): TypeColumnConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<TypeColumnConfig>;
  if (!Array.isArray(value.visibleColumns) || value.visibleColumns.length === 0) return null;
  return {
    visibleColumns: value.visibleColumns.filter((c): c is string => typeof c === 'string'),
    columnWidths: value.columnWidths && typeof value.columnWidths === 'object' ? value.columnWidths : {},
    groupBy: typeof value.groupBy === 'string' ? value.groupBy : null,
  };
}

function normalizeColumnFilters(raw: unknown): TrackerFilterSet | null {
  // `null` is reserved for "this view predates column filters -- leave the
  // current table filters alone on apply." A view saved WITH the feature always
  // carries a set (its `clauses` array present), so an explicitly empty set is
  // preserved and clears filters on apply rather than reading as legacy.
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<TrackerFilterSet>;
  if (!Array.isArray(value.clauses)) return null;
  const clauses = value.clauses.filter(
    (c): c is TrackerFieldFilter =>
      Boolean(c) && typeof (c as TrackerFieldFilter).field === 'string'
      && typeof (c as TrackerFieldFilter).op === 'string',
  );
  return { combinator: value.combinator === 'or' ? 'or' : 'and', clauses };
}

/**
 * Serialize a view for the shared-view lane. Only the name and definition
 * travel; `id` rides outside the payload as the row key, and `shared` is a
 * property of *where* the view is stored, not of the view itself.
 */
export function serializeSharedSavedView(view: SavedView): string {
  return JSON.stringify({ name: view.name, definition: view.definition });
}

/**
 * Rebuild a `SavedView` from a shared-store row. Returns null for a payload we
 * can't make sense of so one bad row from a peer (or a future version) can't
 * take out the whole views list.
 */
export function parseSharedSavedView(
  record: { viewId: string; payload: string },
): SavedView | null {
  if (!record?.viewId || typeof record.payload !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as { name?: unknown; definition?: unknown };
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : null;
  if (!name) return null;
  return {
    id: record.viewId,
    name,
    definition: normalizeViewDefinition(raw.definition as Partial<SavedViewDefinition> | null),
    shared: true,
  };
}

/**
 * The list the sidebar renders: local views plus the team's shared views. A
 * view that exists in both (the machine that shared it keeps no local copy, but
 * a rename race can transiently produce one) resolves to the shared row, since
 * that is the copy the team sees.
 */
export function mergeSavedViews(local: SavedView[], shared: SavedView[]): SavedView[] {
  const sharedIds = new Set(shared.map((view) => view.id));
  const localOnly = local.filter((view) => !sharedIds.has(view.id)).map(
    (view) => (view.shared ? { ...view, shared: false } : view),
  );
  return [...localOnly, ...shared];
}

export interface FilterContext {
  /** Current user identity, required for the `mine` chip. */
  identity?: TrackerIdentity | null;
  /** Personal favorite ids for this identity and workspace scope. */
  favoriteItemIds?: ReadonlySet<string>;
  /** Genuine last-opened timestamps by tracker item id. */
  viewedAtByItemId?: ReadonlyMap<string, number>;
  /** Injectable clock for deterministic lookback filtering. */
  nowMs?: number;
}

export type TrackerItemFilterDefinition = Pick<SavedViewDefinition, 'activeFilters' | 'tagFilter'> & {
  /** Selected provenance keys (`native` or an importer provider id). */
  sourceFilter?: string[];
  /** Genuine-open lookback in days; null means any time. */
  recentlyViewedDays?: SavedViewDefinition['recentlyViewedDays'];
  /** Inspectable field clauses used by the right-side filter builder. */
  columnFilters?: TrackerFilterSet | null;
};

/** Provenance key for a record: the importer provider id, or `native`. */
export function recordSourceKey(record: TrackerRecord): string {
  const origin = record.system.origin;
  return origin?.kind === 'external' ? origin.external.providerId : 'native';
}

/** Resolve ordinary, role-backed, and per-user structural fields uniformly. */
export function getTrackerFilterValue(
  record: TrackerRecord,
  field: string,
  context: FilterContext = {},
): unknown {
  switch (field) {
    case 'owner':
    case 'assignee':
      return getFieldByRole(record, 'assignee');
    case 'favorite':
      return context.favoriteItemIds?.has(record.id) ?? false;
    case 'viewed':
      return context.viewedAtByItemId?.get(record.id);
    case STATUS_CHANGED_TO_FILTER_FIELD:
      return getStatusTransitionValues(record, 'to');
    case STATUS_CHANGED_FROM_FILTER_FIELD:
      return getStatusTransitionValues(record, 'from');
    default:
      return getCellValue(record, field);
  }
}

/** Status values captured in the record's durable transition history. */
export function getStatusTransitionValues(
  record: TrackerRecord,
  direction: 'to' | 'from',
): string[] {
  const statusField = resolveRoleFieldName(record.primaryType, 'workflowStatus');
  const valueKey = direction === 'to' ? 'newValue' : 'oldValue';
  return (record.system.activity ?? [])
    .filter(entry => (
      entry.action === 'status_changed'
      || (entry.action === 'updated' && entry.field === statusField)
    ))
    .map(entry => entry[valueKey])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

/** Convert removed left-sidebar presets into equivalent inspectable clauses. */
export function legacyFilterChipsToClauses(
  filters: readonly TrackerFilterChip[],
  recentlyViewedDays: SavedViewDefinition['recentlyViewedDays'] = 30,
): TrackerFieldFilter[] {
  return filters.flatMap((filter): TrackerFieldFilter[] => {
    switch (filter) {
      case 'mine':
        return [{ field: 'owner', op: 'is-current-user' }];
      case 'unassigned':
        return [{ field: 'owner', op: 'is-empty' }];
      case 'high-priority':
        return [{ field: 'priority', op: 'in', value: ['critical', 'high'] }];
      case 'favorites':
        return [{ field: 'favorite', op: '=', value: true }];
      case 'recently-viewed':
        return recentlyViewedDays === null
          ? [{ field: 'viewed', op: 'is-not-empty' }]
          : [{ field: 'viewed', op: 'in-last', value: recentlyViewedDays }];
      case 'recently-edited-by-others':
        return [{ field: 'updatedBy', op: 'is-not-current-user' }];
      case 'recently-updated':
        return [{ field: 'updated', op: 'in-last', value: 30 }];
      case 'archived':
        return [{ field: 'archived', op: '=', value: true }];
    }
  });
}

/**
 * Apply the row-level predicates of a saved view to a set of items: the `mine`,
 * `unassigned`, `high-priority`, and `recently-updated` chips, plus tag and
 * source filters. This is the pure core of TrackerMainView's filtering.
 * `archived` is handled by the caller because it selects the input item set.
 */
export function filterTrackerItems(
  items: TrackerRecord[],
  def: TrackerItemFilterDefinition,
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

  if (def.activeFilters.includes('favorites')) {
    const favorites = ctx.favoriteItemIds ?? new Set<string>();
    out = out.filter((record) => favorites.has(record.id));
  }

  // Apply every row predicate before a recency order/cap so rows and sidebar
  // counts share one deterministic pass.
  out = filterTrackerItemsByTags(out, def.tagFilter);

  if (def.sourceFilter && def.sourceFilter.length > 0) {
    const sources = new Set(def.sourceFilter);
    out = out.filter((record) => sources.has(recordSourceKey(record)));
  }

  const filterEvaluationContext: TrackerFilterEvaluationContext = {
    currentUser: ctx.identity,
    nowMs: ctx.nowMs,
  };
  out = applyFilterSet(
    out,
    def.columnFilters,
    (record, field) => getTrackerFilterValue(record, field, ctx),
    filterEvaluationContext,
  );

  const recordRecencyTime = (record: TrackerRecord): number => {
    const source = record.system.updatedAt || record.system.createdAt || record.system.lastIndexed;
    const timestamp = source ? new Date(source).getTime() : 0;
    return Number.isNaN(timestamp) ? 0 : timestamp;
  };

  if (def.activeFilters.includes('recently-updated')) {
    out = [...out]
      .sort((a, b) => recordRecencyTime(b) - recordRecencyTime(a))
      .slice(0, 50);
  } else if (def.activeFilters.includes('recently-viewed')) {
    const viewed = ctx.viewedAtByItemId ?? new Map<string, number>();
    const days = def.recentlyViewedDays === undefined ? 30 : def.recentlyViewedDays;
    const cutoff = days === null
      ? Number.NEGATIVE_INFINITY
      : (ctx.nowMs ?? Date.now()) - days * 24 * 60 * 60 * 1000;
    out = out
      .filter((record) => {
        const viewedAt = viewed.get(record.id);
        return typeof viewedAt === 'number' && Number.isFinite(viewedAt) && viewedAt >= cutoff;
      })
      .sort((a, b) => (viewed.get(b.id) ?? 0) - (viewed.get(a.id) ?? 0));
  } else if (def.activeFilters.includes('recently-edited-by-others')) {
    const identity = ctx.identity;
    if (!identity) return [];

    const knownActor = (actor: TrackerIdentity | null | undefined): actor is TrackerIdentity => !!actor && [
      actor.email,
      actor.gitEmail,
      actor.gitName,
      actor.displayName,
    ].some((value) => typeof value === 'string' && value.trim().length > 0);

    const editByOther = (record: TrackerRecord): { actor: TrackerIdentity; time: number } | null => {
      if (knownActor(record.system.lastModifiedBy)) {
        return { actor: record.system.lastModifiedBy, time: recordRecencyTime(record) };
      }
      const activity = (record.system.activity ?? [])
        .filter((entry) => knownActor(entry.authorIdentity))
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      return activity ? { actor: activity.authorIdentity, time: activity.timestamp } : null;
    };

    const editTimes = new Map<string, number>();
    out = out.filter((record) => {
      const edit = editByOther(record);
      if (!edit || isSameIdentity(edit.actor, identity)) return false;
      editTimes.set(record.id, edit.time);
      return true;
    });
    out = [...out]
      .sort((a, b) => (editTimes.get(b.id) ?? 0) - (editTimes.get(a.id) ?? 0))
      .slice(0, 50);
  }

  return out;
}

/**
 * Count filtered records within a sidebar type or folder scope. The type scope
 * is applied before the row filters so `recently-updated` matches the selected
 * type/folder view rather than a workspace-global top 50.
 */
export function countFilteredTrackerItemsByTypes(
  items: TrackerRecord[],
  types: readonly string[],
  def: TrackerItemFilterDefinition,
  ctx: FilterContext = {},
): number {
  const wantedTypes = new Set(types);
  const showArchived = def.activeFilters.includes('archived');
  const filtersArchived = (def.columnFilters?.clauses ?? []).some(clause => clause.field === 'archived');
  const scopedItems = items.filter((record) => (
    (filtersArchived || record.archived === showArchived)
    && (wantedTypes.has(record.primaryType) || record.typeTags.some((type) => wantedTypes.has(type)))
  ));

  return filterTrackerItems(scopedItems, def, ctx).length;
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
