/**
 * Matrix projection for the Pulse prototype.
 *
 * The unit is deliberately conservative: a cell counts **distinct artifacts
 * with a recorded event loaded for that bucket**. The model has no work-thread
 * entity, so this file never reports one. Last-observed timestamps are a
 * separate, separately labelled measure -- they are one observation, not a work
 * interval. An empty cell means no loaded events, which is not evidence that
 * nothing happened.
 */
import type {
  PrototypeEvent,
  PrototypeModel,
  PrototypeRange,
} from '../contracts';
import type { ProjectGraphNode } from '../../types';
import { bucketIndexFor, resolveBuckets, type PulseBucket, type PulseBucketUnit } from './pulseBuckets';

export type PulseRowKind = 'area' | 'artifact' | 'unassigned';
export type PulseSortMode = 'recent' | 'volume' | 'name';

/** The grid renders at most this many rows; the rest are counted, not dropped. */
export const DEFAULT_MAX_ROWS = 40;

export interface PulseCell {
  bucketIndex: number;
  /** Distinct artifacts with a recorded (non last-observed) event here. */
  activeArtifacts: number;
  /** Distinct artifacts whose only signal here is a last-observed timestamp. */
  lastObservedOnly: number;
  eventCount: number;
  events: PrototypeEvent[];
  /**
   * `outside-loaded` means the bucket ends before the earliest event in the
   * whole loaded model. That is one global bound across all sources, not a
   * per-source coverage statement: a source with a shorter horizon can leave
   * `gap` buckets that are equally unloaded.
   */
  coverage: 'observed' | 'gap' | 'outside-loaded';
}

export interface PulseRow {
  id: string;
  kind: PulseRowKind;
  label: string;
  sublabel?: string;
  /** Membership basis for area rows; node type for artifact rows. */
  basis?: string;
  areaId?: string;
  nodeId?: string;
  cells: PulseCell[];
  eventsInRange: number;
  activeArtifactsInRange: number;
  /** Most recent loaded event across all time -- the recency scan signal. */
  lastEventAt: number | null;
  lastEventProvenance: PrototypeEvent['provenance'] | null;
  lastEventInRange: boolean;
  /** All-time membership size, so a bounded row list can state its total. */
  memberCount: number;
}

export interface PulseMatrix {
  rows: PulseRow[];
  /** Every row in scope, counted before the display cap. */
  rowsTotal: number;
  buckets: PulseBucket[];
  unit: PulseBucketUnit;
  escalatedFrom: PulseBucketUnit | null;
  maxCellValue: number;
  eventsInRange: number;
  distinctArtifactsInRange: number;
  /** Distinct artifacts seen only as a last-observed timestamp in range. */
  lastObservedOnlyArtifacts: number;
  earliestLoadedEventAt: number | null;
  hasPartialEdgeBucket: boolean;
  scopeAreaId: string | null;
  scopeAreaLabel: string | null;
  scopeAreaBasis: string | null;
}

export interface BuildMatrixOptions {
  selectedAreaId?: string | null;
  unit?: PulseBucketUnit | null;
  sort?: PulseSortMode;
  maxRows?: number;
  /** View-only display names supplied by the shell's rename affordance. */
  areaLabelOverrides?: Record<string, string>;
}

export const UNASSIGNED_ROW_ID = '__pulse_unassigned__';

interface PlacedEvent {
  event: PrototypeEvent;
  bucketIndex: number;
}

interface RowSpec {
  id: string;
  kind: PulseRowKind;
  label: string;
  sublabel?: string;
  basis?: string;
  areaId?: string;
  nodeId?: string;
  /** All-time membership for area rows; null when the row is one artifact. */
  memberIds: string[] | null;
  memberCount: number;
}

interface RowStat {
  spec: RowSpec;
  placed: PlacedEvent[];
  eventsInRange: number;
  activeArtifactsInRange: number;
  lastEventAt: number | null;
  lastEventProvenance: PrototypeEvent['provenance'] | null;
  lastEventInRange: boolean;
}

/** Most recent loaded event per node across all time. */
export function lastEventByNode(model: PrototypeModel): Map<string, PrototypeEvent> {
  const latest = new Map<string, PrototypeEvent>();
  for (const event of model.events) {
    const current = latest.get(event.nodeId);
    if (!current || event.at > current.at) latest.set(event.nodeId, event);
  }
  return latest;
}

function areaIdsForNode(model: PrototypeModel, nodeId: string): string[] {
  const memberships = model.memberships.get(nodeId);
  if (!memberships || memberships.length === 0) return [];
  return memberships.map((membership) => membership.areaId);
}

function sortStats(stats: RowStat[], sort: PulseSortMode): RowStat[] {
  const byName = (a: RowStat, b: RowStat) => a.spec.label.localeCompare(b.spec.label);
  return [...stats].sort((a, b) => {
    if (sort === 'name') return byName(a, b);
    if (sort === 'volume') {
      if (b.eventsInRange !== a.eventsInRange) return b.eventsInRange - a.eventsInRange;
      return byName(a, b);
    }
    // 'recent': anything active in the window outranks anything that is not,
    // then most-recent-first, so scanning top-down is scanning by recency.
    if (a.lastEventInRange !== b.lastEventInRange) return a.lastEventInRange ? -1 : 1;
    const aAt = a.lastEventAt ?? -Infinity;
    const bAt = b.lastEventAt ?? -Infinity;
    if (aAt !== bAt) return bAt - aAt;
    return byName(a, b);
  });
}

function buildCells(
  placed: PlacedEvent[],
  buckets: PulseBucket[],
  earliestLoadedEventAt: number | null,
): PulseCell[] {
  const cells: PulseCell[] = buckets.map((bucket) => ({
    bucketIndex: bucket.index,
    activeArtifacts: 0,
    lastObservedOnly: 0,
    eventCount: 0,
    events: [],
    coverage:
      earliestLoadedEventAt !== null && bucket.calendarEndMs < earliestLoadedEventAt
        ? ('outside-loaded' as const)
        : ('gap' as const),
  }));

  const recorded = new Map<number, Set<string>>();
  const observed = new Map<number, Set<string>>();
  for (const entry of placed) {
    const cell = cells[entry.bucketIndex];
    if (!cell) continue;
    cell.events.push(entry.event);
    cell.eventCount += 1;
    cell.coverage = 'observed';
    const target = entry.event.provenance === 'last-observed' ? observed : recorded;
    let set = target.get(entry.bucketIndex);
    if (!set) {
      set = new Set();
      target.set(entry.bucketIndex, set);
    }
    set.add(entry.event.nodeId);
  }

  for (const cell of cells) {
    const rec = recorded.get(cell.bucketIndex);
    const obs = observed.get(cell.bucketIndex);
    cell.activeArtifacts = rec ? rec.size : 0;
    let onlyObserved = 0;
    if (obs) {
      for (const nodeId of obs) if (!rec || !rec.has(nodeId)) onlyObserved += 1;
    }
    cell.lastObservedOnly = onlyObserved;
  }
  return cells;
}

export function buildPulseMatrix(
  model: PrototypeModel,
  range: PrototypeRange,
  options: BuildMatrixOptions = {},
): PulseMatrix {
  const { unit, buckets, escalatedFrom } = resolveBuckets(range, options.unit ?? null);
  const maxRows = Math.max(1, options.maxRows ?? DEFAULT_MAX_ROWS);
  const sort = options.sort ?? 'recent';
  const overrides = options.areaLabelOverrides ?? {};

  let earliestLoadedEventAt: number | null = null;
  for (const event of model.events) {
    if (earliestLoadedEventAt === null || event.at < earliestLoadedEventAt) {
      earliestLoadedEventAt = event.at;
    }
  }

  const scopeArea = options.selectedAreaId
    ? model.areas.find((area) => area.id === options.selectedAreaId) ?? null
    : null;
  const scopeMembers = scopeArea
    ? new Set(scopeArea.nodeIds.filter((nodeId) => model.nodeById.has(nodeId)))
    : null;
  const lastEvents = lastEventByNode(model);

  // ---- Place every in-range event into its row(s) and bucket. ----
  const placedByRow = new Map<string, PlacedEvent[]>();
  const inRangeArtifacts = new Set<string>();
  const inRangeRecorded = new Set<string>();
  const inRangeObserved = new Set<string>();
  let eventsInRange = 0;

  for (const event of model.events) {
    if (event.at < range.startMs || event.at > range.endMs) continue;
    if (scopeMembers && !scopeMembers.has(event.nodeId)) continue;
    const bucketIndex = bucketIndexFor(buckets, event.at);
    if (bucketIndex < 0) continue;

    eventsInRange += 1;
    inRangeArtifacts.add(event.nodeId);
    if (event.provenance === 'last-observed') inRangeObserved.add(event.nodeId);
    else inRangeRecorded.add(event.nodeId);

    let rowIds: string[];
    if (scopeMembers) {
      rowIds = [event.nodeId];
    } else {
      const areaIds = areaIdsForNode(model, event.nodeId);
      rowIds = areaIds.length > 0 ? areaIds : [UNASSIGNED_ROW_ID];
    }
    for (const rowId of rowIds) {
      const list = placedByRow.get(rowId);
      if (list) list.push({ event, bucketIndex });
      else placedByRow.set(rowId, [{ event, bucketIndex }]);
    }
  }

  // ---- Enumerate the FULL row universe before any display cap, so the
  // reported total and the sort both see every row in scope. ----
  const specs: RowSpec[] = [];
  if (scopeArea && scopeMembers) {
    for (const nodeId of scopeMembers) {
      const node = model.nodeById.get(nodeId);
      if (!node) continue;
      specs.push({
        id: nodeId,
        kind: 'artifact',
        nodeId,
        label: node.label,
        sublabel: node.sublabel,
        basis: node.type,
        memberIds: null,
        memberCount: 1,
      });
    }
  } else {
    for (const area of model.areas) {
      specs.push({
        id: area.id,
        kind: 'area',
        areaId: area.id,
        label: overrides[area.id] ?? area.label,
        basis: area.basis,
        memberIds: area.nodeIds,
        memberCount: area.nodeIds.length,
      });
    }
    if (placedByRow.has(UNASSIGNED_ROW_ID)) {
      specs.push({
        id: UNASSIGNED_ROW_ID,
        kind: 'unassigned',
        label: 'Unassigned',
        sublabel: 'no area membership',
        basis: 'records with no area membership in the loaded model',
        memberIds: null,
        memberCount: 0,
      });
    }
  }

  // ---- Cheap per-row aggregates: no cell arrays are allocated yet, so a
  // three-thousand-member area costs three thousand small objects, not
  // three thousand bucket arrays. ----
  const stats: RowStat[] = specs.map((spec) => {
    const placed = placedByRow.get(spec.id) ?? [];
    const artifacts = new Set<string>();
    for (const entry of placed) artifacts.add(entry.event.nodeId);

    let latest: PrototypeEvent | null = null;
    if (spec.kind === 'artifact' && spec.nodeId) {
      latest = lastEvents.get(spec.nodeId) ?? null;
    } else if (spec.memberIds) {
      for (const nodeId of spec.memberIds) {
        const candidate = lastEvents.get(nodeId);
        if (candidate && (!latest || candidate.at > latest.at)) latest = candidate;
      }
    } else {
      // Unassigned row: it has no declared membership list, so its recency can
      // only come from the events actually placed in it.
      for (const entry of placed) {
        if (!latest || entry.event.at > latest.at) latest = entry.event;
      }
    }

    return {
      spec: spec.kind === 'unassigned' ? { ...spec, memberCount: artifacts.size } : spec,
      placed,
      eventsInRange: placed.length,
      activeArtifactsInRange: artifacts.size,
      lastEventAt: latest ? latest.at : null,
      lastEventProvenance: latest ? latest.provenance : null,
      lastEventInRange:
        latest !== null && latest.at >= range.startMs && latest.at <= range.endMs,
    };
  });

  const sorted = sortStats(stats, sort);
  const visible = sorted.slice(0, maxRows);

  let maxCellValue = 0;
  const rows: PulseRow[] = visible.map((stat) => {
    const cells = buildCells(stat.placed, buckets, earliestLoadedEventAt);
    for (const cell of cells) {
      if (cell.activeArtifacts > maxCellValue) maxCellValue = cell.activeArtifacts;
    }
    return {
      id: stat.spec.id,
      kind: stat.spec.kind,
      label: stat.spec.label,
      sublabel: stat.spec.sublabel,
      basis: stat.spec.basis,
      areaId: stat.spec.areaId,
      nodeId: stat.spec.nodeId,
      cells,
      eventsInRange: stat.eventsInRange,
      activeArtifactsInRange: stat.activeArtifactsInRange,
      lastEventAt: stat.lastEventAt,
      lastEventProvenance: stat.lastEventProvenance,
      lastEventInRange: stat.lastEventInRange,
      memberCount: stat.spec.memberCount,
    };
  });

  let observedOnlyCount = 0;
  for (const nodeId of inRangeObserved) if (!inRangeRecorded.has(nodeId)) observedOnlyCount += 1;

  return {
    rows,
    rowsTotal: sorted.length,
    buckets,
    unit,
    escalatedFrom,
    maxCellValue,
    eventsInRange,
    distinctArtifactsInRange: inRangeArtifacts.size,
    lastObservedOnlyArtifacts: observedOnlyCount,
    earliestLoadedEventAt,
    hasPartialEdgeBucket: buckets.some((bucket) => bucket.partial),
    scopeAreaId: scopeArea ? scopeArea.id : null,
    scopeAreaLabel: scopeArea ? overrides[scopeArea.id] ?? scopeArea.label : null,
    scopeAreaBasis: scopeArea ? scopeArea.basis : null,
  };
}

/** Five-step ramp. `heatLegend` derives its printed ranges from this function. */
export function heatStep(value: number, maxValue: number): number {
  if (value <= 0) return 0;
  if (maxValue <= 1) return 4;
  const ratio = value / maxValue;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** Smallest value in 1..maxValue whose step is at least `target`, else null. */
function firstValueAtStep(target: number, maxValue: number): number | null {
  let low = 1;
  let high = maxValue;
  let found: number | null = null;
  // heatStep is monotonic in `value`, so a binary search finds the boundary.
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (heatStep(mid, maxValue) >= target) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found;
}

export interface HeatLegendEntry {
  step: number;
  label: string;
}

/**
 * The legend is read back out of `heatStep` rather than restated from the same
 * ratios, so it can never advertise a step no value maps to. At maxValue 2, for
 * instance, only steps 2 and 4 are reachable and only those are listed.
 */
export function heatLegend(maxValue: number): HeatLegendEntry[] {
  if (maxValue <= 0) return [];
  const bounds: Array<{ step: number; from: number }> = [];
  for (let target = 1; target <= 4; target += 1) {
    const from = firstValueAtStep(target, maxValue);
    if (from === null) continue;
    const step = heatStep(from, maxValue);
    if (bounds.some((entry) => entry.step === step)) continue;
    bounds.push({ step, from });
  }
  bounds.sort((a, b) => a.from - b.from);
  return bounds.map((entry, index) => {
    const to = index + 1 < bounds.length ? bounds[index + 1].from - 1 : maxValue;
    return {
      step: entry.step,
      label: entry.from === to ? `${entry.from}` : `${entry.from}–${to}`,
    };
  });
}

/**
 * Selected rows are held by stable id, never by grid index. Re-sorting the rows
 * moves coordinates around underneath the grid, and an index-anchored selection
 * would silently come to mean a different set of artifacts.
 */
export interface PulseSelection {
  rowIds: string[];
  anchorRowId: string;
  headRowId: string;
  anchorCol: number;
  headCol: number;
}

export function selectionColumns(selection: PulseSelection): {
  colStart: number;
  colEnd: number;
} {
  return {
    colStart: Math.min(selection.anchorCol, selection.headCol),
    colEnd: Math.max(selection.anchorCol, selection.headCol),
  };
}

/**
 * Row ids this matrix's scope could name, whether or not they are displayed.
 *
 * Deliberately the model's universe and not `matrix.rows`: a row below the
 * display cap is still a real row, and `PulseSelectionSummary.rowsOutOfView`
 * exists to say its events are not counted. Validating against the drawn rows
 * would delete it from the selection and take that disclosure with it.
 */
export function validRowIds(model: PrototypeModel, matrix: PulseMatrix): Set<string> {
  if (matrix.scopeAreaId) {
    const area = model.areas.find((candidate) => candidate.id === matrix.scopeAreaId);
    return new Set((area?.nodeIds ?? []).filter((nodeId) => model.nodeById.has(nodeId)));
  }
  const ids = new Set(model.areas.map((area) => area.id));
  ids.add(UNASSIGNED_ROW_ID);
  return ids;
}

/**
 * A selection carried across a model update.
 *
 * A progressive index republishes the model on every tick, so throwing the
 * selection away on model identity discards the reader's work several times a
 * second. Only ids the refreshed model no longer has are dropped; the anchor
 * and head re-seat on survivors, and the column span is untouched because the
 * buckets are validated separately by the caller. Returns the same object when
 * nothing changed, so React state does not churn.
 */
export function pruneSelection(
  model: PrototypeModel,
  matrix: PulseMatrix,
  selection: PulseSelection,
): PulseSelection | null {
  const valid = validRowIds(model, matrix);
  const rowIds = selection.rowIds.filter((id) => valid.has(id));
  if (
    rowIds.length === selection.rowIds.length &&
    valid.has(selection.anchorRowId) &&
    valid.has(selection.headRowId)
  ) {
    return selection;
  }
  if (rowIds.length === 0) return null;
  return {
    ...selection,
    rowIds,
    anchorRowId: valid.has(selection.anchorRowId) ? selection.anchorRowId : rowIds[0],
    headRowId: valid.has(selection.headRowId) ? selection.headRowId : rowIds[rowIds.length - 1],
  };
}

/**
 * Identity of the column axis: same signature means column indices still name
 * the same buckets, so a selection spanning them is still meaningful. Built
 * from the unclipped calendar boundaries, so a range end that advances inside
 * the bucket it already covered — as it does whenever the shell derives the end
 * from a snapshot timestamp — does not invalidate anything.
 */
export function bucketSignature(matrix: PulseMatrix): string {
  const first = matrix.buckets[0];
  const last = matrix.buckets[matrix.buckets.length - 1];
  return [
    matrix.unit,
    matrix.buckets.length,
    first?.calendarStartMs ?? 0,
    last?.calendarEndMs ?? 0,
  ].join('|');
}

/** Row ids between two indices, inclusive, in current display order. */
export function rowIdsBetween(rows: PulseRow[], from: number, to: number): string[] {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(rows.length - 1, Math.max(from, to));
  const ids: string[] = [];
  for (let index = start; index <= end; index += 1) ids.push(rows[index].id);
  return ids;
}

export interface PulseEpisode {
  nodeId: string;
  label: string;
  type: string;
  events: PrototypeEvent[];
  firstAt: number;
  lastAt: number;
  recordedCount: number;
  lastObservedCount: number;
}

export interface PulseSelectionSummary {
  colStart: number;
  colEnd: number;
  rowLabels: string[];
  /** Rows the selection names. */
  rowsSelected: number;
  /** Selected rows no longer among the displayed rows, counted not hidden. */
  rowsOutOfView: number;
  events: PrototypeEvent[];
  eventCount: number;
  distinctArtifacts: number;
  kindCounts: Record<PrototypeEvent['kind'], number>;
  recordedCount: number;
  lastObservedCount: number;
  episodes: PulseEpisode[];
  /** Deterministic, source-counted heading. Never a generated narrative. */
  heading: string;
  includesPartialBucket: boolean;
  includesOutsideLoaded: boolean;
}

const KIND_NOUNS: Record<PrototypeEvent['kind'], [string, string]> = {
  created: ['record created', 'records created'],
  commit: ['commit', 'commits'],
  status: ['status change', 'status changes'],
  'last-activity': ['last-observed timestamp', 'last-observed timestamps'],
};

function plural(count: number, kind: PrototypeEvent['kind']): string {
  const [one, many] = KIND_NOUNS[kind];
  return `${count} ${count === 1 ? one : many}`;
}

export function summarizeSelection(
  matrix: PulseMatrix,
  selection: PulseSelection,
  nodeById: Map<string, ProjectGraphNode>,
): PulseSelectionSummary {
  const { colStart, colEnd } = selectionColumns(selection);
  const wanted = new Set(selection.rowIds);
  const seen = new Set<string>();
  const events: PrototypeEvent[] = [];
  const rowLabels: string[] = [];
  let rowsVisible = 0;
  let includesPartialBucket = false;
  let includesOutsideLoaded = false;

  for (const row of matrix.rows) {
    if (!wanted.has(row.id)) continue;
    rowsVisible += 1;
    rowLabels.push(row.label);
    for (let colIndex = colStart; colIndex <= colEnd; colIndex += 1) {
      const cell = row.cells[colIndex];
      if (!cell) continue;
      if (cell.coverage === 'outside-loaded') includesOutsideLoaded = true;
      for (const event of cell.events) {
        // A node in two areas contributes the same event to two rows.
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        events.push(event);
      }
    }
  }
  for (let colIndex = colStart; colIndex <= colEnd; colIndex += 1) {
    if (matrix.buckets[colIndex]?.partial) includesPartialBucket = true;
  }

  events.sort((a, b) => b.at - a.at);

  const kindCounts: Record<PrototypeEvent['kind'], number> = {
    created: 0,
    commit: 0,
    status: 0,
    'last-activity': 0,
  };
  let recordedCount = 0;
  let lastObservedCount = 0;
  const byNode = new Map<string, PulseEpisode>();

  for (const event of events) {
    kindCounts[event.kind] += 1;
    if (event.provenance === 'last-observed') lastObservedCount += 1;
    else recordedCount += 1;

    let episode = byNode.get(event.nodeId);
    if (!episode) {
      const node = nodeById.get(event.nodeId);
      episode = {
        nodeId: event.nodeId,
        label: node?.label ?? event.nodeId,
        type: node?.type ?? 'unknown',
        events: [],
        firstAt: event.at,
        lastAt: event.at,
        recordedCount: 0,
        lastObservedCount: 0,
      };
      byNode.set(event.nodeId, episode);
    }
    episode.events.push(event);
    episode.firstAt = Math.min(episode.firstAt, event.at);
    episode.lastAt = Math.max(episode.lastAt, event.at);
    if (event.provenance === 'last-observed') episode.lastObservedCount += 1;
    else episode.recordedCount += 1;
  }

  const episodes = [...byNode.values()].sort((a, b) => b.lastAt - a.lastAt);
  const parts = (Object.keys(kindCounts) as Array<PrototypeEvent['kind']>)
    .filter((kind) => kindCounts[kind] > 0)
    .map((kind) => plural(kindCounts[kind], kind));
  const artifacts = byNode.size;
  const heading =
    artifacts === 0
      ? 'No loaded events in this selection'
      : `${artifacts} ${artifacts === 1 ? 'artifact' : 'artifacts'} · ${parts.join(' · ')}`;

  return {
    colStart,
    colEnd,
    rowLabels,
    rowsSelected: wanted.size,
    rowsOutOfView: wanted.size - rowsVisible,
    events,
    eventCount: events.length,
    distinctArtifacts: artifacts,
    kindCounts,
    recordedCount,
    lastObservedCount,
    episodes,
    heading,
    includesPartialBucket,
    includesOutsideLoaded,
  };
}

export type PulseStatusClass = 'open' | 'terminal' | 'unrecognized';

/**
 * Status vocabularies are per-project and open-ended, so this recognizes only
 * the states it can actually name. Anything else is `unrecognized` and is
 * reported as unrecognized -- never promoted into "unresolved work", which is
 * an assertion the model cannot support.
 */
const TERMINAL_STATUSES = new Set([
  'done',
  'closed',
  'complete',
  'completed',
  'resolved',
  'fixed',
  'shipped',
  'released',
  'deployed',
  'published',
  'merged',
  'verified',
  'cancelled',
  'canceled',
  'rejected',
  'declined',
  'dismissed',
  'duplicate',
  'wontfix',
  'wont-fix',
  'will-not-fix',
  'not-planned',
  'abandoned',
  'superseded',
  'obsolete',
  'invalid',
  'failed',
  'error',
  'errored',
]);

const OPEN_STATUSES = new Set([
  'open',
  'active',
  'new',
  'todo',
  'to-do',
  'backlog',
  'triage',
  'planned',
  'planning',
  'draft',
  'ready',
  'started',
  'doing',
  'running',
  'in-progress',
  'inprogress',
  'in-development',
  'in-review',
  'review',
  'reviewing',
  'needs-review',
  'blocked',
  'on-hold',
  'paused',
  'waiting',
  'pending',
  'reopened',
  'investigating',
  'needs-info',
  'proposed',
]);

export function normalizeStatus(status: string): string {
  return status.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/** Longest status string the disclosure line will print before clipping. */
const MAX_STATUS_LABEL = 32;

/** How many distinct values the disclosure line names; the rest are counted. */
const MAX_STATUS_EXAMPLES = 3;

/**
 * A status value as it can safely be shown.
 *
 * Status is free text per project, and live data has whole stopped-work notes
 * and code comments sitting in the field. Printing four of those verbatim turns
 * the "statuses this view does not recognize" line into a wall of prose, so the
 * value is clipped to its head and marked — the reader still sees enough to
 * recognize it, and nothing is silently rewritten.
 */
export function statusLabel(status: string): string {
  const collapsed = status.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= MAX_STATUS_LABEL) return collapsed;
  return `${collapsed.slice(0, MAX_STATUS_LABEL - 1).trimEnd()}…`;
}

export function classifyStatus(status: string | undefined): PulseStatusClass | null {
  if (!status || status.trim().length === 0) return null;
  const normalized = normalizeStatus(status);
  if (TERMINAL_STATUSES.has(normalized)) return 'terminal';
  if (OPEN_STATUSES.has(normalized)) return 'open';
  return 'unrecognized';
}

/**
 * Archiving is a filing decision, on its own axis from whether the work is
 * finished. A record can be archived while its work is still open, and a
 * finished record is routinely never archived, so `archived` is read from the
 * explicit flag and never inferred from a terminal state — or the reverse.
 */
export function isArchived(node: ProjectGraphNode): boolean {
  if (node.fields?.archived === true) return true;
  return node.status !== undefined && normalizeStatus(node.status) === 'archived';
}

export interface PulseStateItem {
  node: ProjectGraphNode;
  lastEventAt: number | null;
}

/**
 * Current state census for the rows in view. This is state, not activity: it is
 * never bucketed, never summed with events, and says nothing about the selected
 * window. `unrecognized` records are held apart from `open` ones so a custom
 * status is never silently asserted to be unresolved work.
 */
export interface PulseStateCensus {
  open: PulseStateItem[];
  openTotal: number;
  unrecognized: PulseStateItem[];
  unrecognizedTotal: number;
  /**
   * A bounded sample of the distinct unrecognized status values, clipped for
   * length. Examples only — `unrecognizedStatusTotal` is how many there are.
   */
  unrecognizedStatuses: string[];
  /** Distinct unrecognized status values, counted before the example bound. */
  unrecognizedStatusTotal: number;
  statuslessTotal: number;
  closedTotal: number;
  /** Explicitly archived records, counted on their own axis — see isArchived. */
  archived: PulseStateItem[];
  archivedTotal: number;
  /**
   * Records carrying a close timestamp *and* a status this view recognizes as
   * non-terminal. The adapters have conflated archive and completion with
   * closure, so the explicit status wins and the disagreement is reported
   * rather than resolved silently.
   */
  closureConflicts: number;
  scopeSize: number;
}

export function openStateItems(
  model: PrototypeModel,
  matrix: PulseMatrix,
  limit = 12,
): PulseStateCensus {
  const scopeIds = new Set<string>();
  if (matrix.scopeAreaId) {
    const area = model.areas.find((candidate) => candidate.id === matrix.scopeAreaId);
    for (const nodeId of area?.nodeIds ?? []) scopeIds.add(nodeId);
  } else {
    // Every area in the row universe, not just the ones above the display cap,
    // so the census total does not shrink when rows are truncated.
    for (const area of model.areas) {
      for (const nodeId of area.nodeIds) scopeIds.add(nodeId);
    }
  }

  const lastEvents = lastEventByNode(model);
  const open: PulseStateItem[] = [];
  const unrecognized: PulseStateItem[] = [];
  const archived: PulseStateItem[] = [];
  const unrecognizedStatuses = new Set<string>();
  let statuslessTotal = 0;
  let closedTotal = 0;
  let archivedTotal = 0;
  let closureConflicts = 0;

  for (const nodeId of scopeIds) {
    const node = model.nodeById.get(nodeId);
    if (!node) continue;
    const item = { node, lastEventAt: lastEvents.get(nodeId)?.at ?? null };

    // Counted on its own axis: archived says where the record is filed, not
    // whether the work finished, so it never feeds the closed total.
    if (isArchived(node)) {
      archivedTotal += 1;
      if (archived.length < limit) archived.push(item);
    }

    const state = classifyStatus(node.status);
    if (state === 'terminal') {
      closedTotal += 1;
      continue;
    }
    if (state === null) {
      // No status to weigh against it, so a close timestamp is all there is.
      if (node.closedAt !== undefined) closedTotal += 1;
      else statuslessTotal += 1;
      continue;
    }
    // An explicit non-terminal status outranks a close timestamp: the adapters
    // set `closedAt` from signals that are not closure, and an in-review record
    // is still open work. The disagreement is counted, not silently resolved.
    if (node.closedAt !== undefined) closureConflicts += 1;
    // Archived records are listed on the archive axis instead of in the
    // open-work scan, but they are never counted as finished.
    if (isArchived(node)) continue;
    if (state === 'open') open.push(item);
    else {
      unrecognized.push(item);
      if (node.status) unrecognizedStatuses.add(statusLabel(node.status));
    }
  }

  // Recency first, then label, so records with no dated event still have a
  // stable order instead of falling out in scope-iteration order.
  const byRecency = (a: PulseStateItem, b: PulseStateItem) => {
    const delta = (b.lastEventAt ?? -Infinity) - (a.lastEventAt ?? -Infinity);
    if (delta !== 0 && Number.isFinite(delta)) return delta;
    if (a.lastEventAt !== b.lastEventAt) return a.lastEventAt === null ? 1 : -1;
    return a.node.label.localeCompare(b.node.label);
  };
  open.sort(byRecency);
  unrecognized.sort(byRecency);
  archived.sort(byRecency);

  return {
    open: open.slice(0, limit),
    openTotal: open.length,
    unrecognized: unrecognized.slice(0, Math.max(1, Math.floor(limit / 2))),
    unrecognizedTotal: unrecognized.length,
    unrecognizedStatuses: [...unrecognizedStatuses].sort().slice(0, MAX_STATUS_EXAMPLES),
    unrecognizedStatusTotal: unrecognizedStatuses.size,
    statuslessTotal,
    closedTotal,
    archived: archived.slice(0, Math.max(1, Math.floor(limit / 2))),
    archivedTotal,
    closureConflicts,
    scopeSize: scopeIds.size,
  };
}

export interface PeriodTotals {
  events: number;
  artifacts: number;
}

export type CoverageState = 'covered' | 'partial' | 'unloaded' | 'unknown';

/**
 * What a delta is entitled to claim.
 *
 * `complete` — both periods sit inside bounds the sources vouched for, so the
 * difference is a difference in what happened, as far as these sources go.
 * `observed` — a difference in the records that were loaded, and nothing more.
 * `null` — the periods are not commensurable at all.
 */
export type DeltaBasis = 'complete' | 'observed' | null;

export interface PeriodComparison {
  current: PeriodTotals;
  previous: PeriodTotals;
  /** Null only when the periods are not commensurable; never a bare zero. */
  deltaEvents: number | null;
  deltaArtifacts: number | null;
  deltaBasis: DeltaBasis;
  /** True only for a `complete` basis: the comprehensive claim. */
  comparable: boolean;
  equalDuration: boolean;
  currentCoverage: CoverageState;
  previousCoverage: CoverageState;
  /** What the reader needs to know before reading the delta, in one sentence. */
  note: string;
  scopeAreaId: string | null;
}

function periodTotals(
  model: PrototypeModel,
  range: PrototypeRange,
  scope: Set<string> | null,
): PeriodTotals {
  const artifacts = new Set<string>();
  let events = 0;
  for (const event of model.events) {
    if (event.at < range.startMs || event.at > range.endMs) continue;
    if (scope && !scope.has(event.nodeId)) continue;
    events += 1;
    artifacts.add(event.nodeId);
  }
  return { events, artifacts: artifacts.size };
}

/** How much of `range` the sources say they actually retrieved. */
function coverageFor(model: PrototypeModel, range: PrototypeRange): CoverageState {
  const coverage = model.periodCoverage;
  // No statement from the loader is "unknown". It is emphatically NOT the
  // earliest loaded event: that is one global bound across every source, and
  // reading it as coverage turns an unloaded window into an apparent quiet one.
  if (!coverage) return 'unknown';
  // The shell reports an unestablished lower bound as `startMs: 0` with
  // `complete: false` when some source cannot say how far back it retrieved.
  // That is unknown, not unloaded: one source's silence is not a statement
  // about the others, and calling the period unloaded would invent one.
  if (coverage.startMs <= 0 && !coverage.complete) return 'unknown';
  if (range.endMs < coverage.startMs || range.startMs > coverage.endMs) return 'unloaded';
  if (range.startMs < coverage.startMs || range.endMs > coverage.endMs) return 'partial';
  return coverage.complete ? 'covered' : 'partial';
}

/**
 * The current period against the one immediately before it.
 *
 * The comparison window is supplied by the shell, not derived here, so the
 * elapsed-duration decision for a partial current period is made in one place.
 * Both sides are counted over the same scope and the same unit, and a delta is
 * only offered when the two windows are the same length and the sources say
 * they loaded the earlier one. Everything else is reported as not comparable —
 * an unloaded period is unknown, never quiet.
 */
export function comparePeriods(
  model: PrototypeModel,
  range: PrototypeRange,
  comparisonRange: PrototypeRange,
  options: { selectedAreaId?: string | null } = {},
): PeriodComparison {
  const scopeArea = options.selectedAreaId
    ? model.areas.find((area) => area.id === options.selectedAreaId) ?? null
    : null;
  const scope = scopeArea
    ? new Set(scopeArea.nodeIds.filter((nodeId) => model.nodeById.has(nodeId)))
    : null;

  const current = periodTotals(model, range, scope);
  const previous = periodTotals(model, comparisonRange, scope);
  const currentSpan = range.endMs - range.startMs;
  const previousSpan = comparisonRange.endMs - comparisonRange.startMs;
  // One second of slack: a range built from calendar boundaries can differ by
  // a rounding of the inclusive end without being a different length.
  const equalDuration = Math.abs(currentSpan - previousSpan) <= 1000;
  const previousCoverage = coverageFor(model, comparisonRange);
  // Both ends are gated. The preceding period being covered says nothing about
  // the current one, and gating on it alone published a comprehensive delta
  // over a current period the sources had never retrieved.
  const currentCoverage = coverageFor(model, range);
  const bothCovered = currentCoverage === 'covered' && previousCoverage === 'covered';
  const eitherUnloaded = currentCoverage === 'unloaded' || previousCoverage === 'unloaded';
  const deltaBasis: DeltaBasis = !equalDuration
    ? null
    : bothCovered
      ? 'complete'
      : eitherUnloaded
        ? null
        : 'observed';
  const comparable = deltaBasis === 'complete';
  const reason = model.periodCoverage?.reason;

  let note: string;
  if (!equalDuration) {
    note = `The two periods are not the same length (${Math.round(currentSpan / 86_400_000)}d against ${Math.round(previousSpan / 86_400_000)}d), so no delta is shown.`;
  } else if (eitherUnloaded) {
    const which =
      currentCoverage === 'unloaded' && previousCoverage === 'unloaded'
        ? 'Both periods are'
        : currentCoverage === 'unloaded'
          ? 'This period is'
          : 'The preceding period is';
    note = `${which} outside what the sources loaded, so the counts below are not a measure of what happened then.`;
  } else if (deltaBasis === 'observed') {
    // Counts are still shown, and still a fact about what was loaded. What is
    // withheld is the claim that they cover everything that happened.
    note =
      currentCoverage === 'unknown' || previousCoverage === 'unknown'
        ? 'Retrieval bounds are not established for every source, so this compares the records that were loaded rather than everything that happened.'
        : 'Only part of one period is inside the loaded retrieval bounds, so this compares the records that were loaded rather than everything that happened.';
  } else if (previous.events === 0) {
    note = 'No loaded events fall in the preceding period. That is an absence of records, not a statement that the period was quiet.';
  } else {
    note = 'Both periods are the same length and inside the loaded retrieval bounds.';
  }
  if (reason && !comparable) note = `${note} ${reason}`;

  return {
    current,
    previous,
    deltaEvents: deltaBasis ? current.events - previous.events : null,
    deltaArtifacts: deltaBasis ? current.artifacts - previous.artifacts : null,
    deltaBasis,
    comparable,
    equalDuration,
    currentCoverage,
    previousCoverage,
    note,
    scopeAreaId: scopeArea ? scopeArea.id : null,
  };
}

export interface GridPosition {
  row: number;
  col: number;
}

/** Focus held the way a selection is: by the row's id, never by its position. */
export interface GridFocus {
  rowId: string;
  col: number;
}

export interface KeyModifiers {
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Pure grid navigation so the keyboard path is testable without a DOM. Returns
 * null for keys the grid does not own, which is how application shortcuts stay
 * unswallowed.
 */
export function moveGridFocus(
  position: GridPosition,
  key: string,
  rowCount: number,
  colCount: number,
  modifiers: KeyModifiers = {},
): GridPosition | null {
  // A chord belongs to the application. Shift is the grid's own range gesture.
  if (modifiers.metaKey || modifiers.ctrlKey || modifiers.altKey) return null;
  if (rowCount <= 0 || colCount <= 0) return null;
  const clampRow = (value: number) => Math.max(0, Math.min(rowCount - 1, value));
  const clampCol = (value: number) => Math.max(0, Math.min(colCount - 1, value));
  switch (key) {
    case 'ArrowUp':
      return { row: clampRow(position.row - 1), col: clampCol(position.col) };
    case 'ArrowDown':
      return { row: clampRow(position.row + 1), col: clampCol(position.col) };
    case 'ArrowLeft':
      return { row: clampRow(position.row), col: clampCol(position.col - 1) };
    case 'ArrowRight':
      return { row: clampRow(position.row), col: clampCol(position.col + 1) };
    case 'Home':
      return { row: clampRow(position.row), col: 0 };
    case 'End':
      return { row: clampRow(position.row), col: colCount - 1 };
    case 'PageUp':
      return { row: 0, col: clampCol(position.col) };
    case 'PageDown':
      return { row: rowCount - 1, col: clampCol(position.col) };
    default:
      return null;
  }
}

/**
 * The same move, resolved against the row that currently holds focus.
 *
 * Holding focus as a row index means a re-sort silently moves it onto a
 * different artifact, and the next arrow key steps from somewhere the reader
 * never was. Resolving the id each time keeps focus on the row it was put on,
 * wherever the sort has since placed it. A row that has left the display (a
 * scope change, or the row cap) falls back to the first row rather than to a
 * stale coordinate.
 */
export function moveGridFocusById(
  rows: Array<{ id: string }>,
  focus: GridFocus,
  key: string,
  colCount: number,
  modifiers: KeyModifiers = {},
): GridFocus | null {
  const current = rows.findIndex((row) => row.id === focus.rowId);
  const next = moveGridFocus(
    { row: Math.max(current, 0), col: focus.col },
    key,
    rows.length,
    colCount,
    modifiers,
  );
  if (!next) return null;
  // A focused row that is no longer displayed re-anchors on the first row
  // instead of stepping away from a position it no longer occupies.
  const row = rows[current < 0 ? 0 : next.row];
  return row ? { rowId: row.id, col: next.col } : null;
}
