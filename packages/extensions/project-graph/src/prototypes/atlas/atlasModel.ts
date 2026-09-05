/**
 * Atlas projection helpers.
 *
 * Everything here is pure and deterministic. The two properties the Atlas
 * depends on:
 *
 *  - **Geography is stable.** Territory order is a function of area identity
 *    alone -- not the range, the selection, the member counts, or the display
 *    labels. Moving the date window, renaming a territory, or reloading a
 *    snapshot whose tag frequencies shifted all leave the map where it was.
 *  - **Relations keep their provenance.** An edge recorded in the snapshot and a
 *    pair of records that merely landed in two areas by the same tag rule are
 *    different families and are never summed into one weight.
 */

import type { ProjectGraphEdge, ProjectGraphNode } from '../../types';
import type {
  PrototypeArea,
  PrototypeEvent,
  PrototypeModel,
  PrototypeRange,
} from '../contracts';
import { eventsInRange } from '../contracts';

/** Areas the parent produces for records no tag rule claimed. */
const UNASSIGNED_ID = 'unassigned';

export function isUnassignedArea(area: PrototypeArea): boolean {
  return area.id === UNASSIGNED_ID || /^unassigned\b/i.test(area.label.trim());
}

/**
 * Resolves the persistent ordinal each area occupies on the map.
 *
 * `PrototypeArea.slot` is assigned once by the parent's area registry and
 * survives refreshes, so a territory keeps its ground when tag frequencies
 * shift, when a busier area is added, and when an area drops out and returns.
 * An area the registry has not numbered yet is appended after every declared
 * slot rather than inserted among them, and Unassigned goes last of those.
 *
 * The gaps are the point: a dropped area leaves a hole, and nothing is repacked
 * into it. Repacking is what makes the map move under the reader.
 */
export function resolveSlots(areas: PrototypeArea[]): Array<{ area: PrototypeArea; slot: number }> {
  const declared = (area: PrototypeArea): number | null =>
    typeof area.slot === 'number' && Number.isInteger(area.slot) && area.slot >= 0
      ? area.slot
      : null;

  const taken = new Set<number>();
  const assigned = new Map<string, number>();

  // A slot the registry has handed to two areas would draw one absolutely
  // positioned tile on top of the other and leave the lower one unclickable.
  // First claimant by id keeps it; the other is treated as unnumbered, which is
  // a visible move rather than a silent overlap.
  const collided: PrototypeArea[] = [];
  for (const area of [...areas].sort((a, b) => a.id.localeCompare(b.id))) {
    const slot = declared(area);
    if (slot === null) continue;
    if (taken.has(slot)) collided.push(area);
    else {
      taken.add(slot);
      assigned.set(area.id, slot);
    }
  }

  const unnumbered = [...areas.filter((area) => declared(area) === null), ...collided].sort(
    (a, b) => {
      const aLast = isUnassignedArea(a);
      const bLast = isUnassignedArea(b);
      if (aLast !== bLast) return aLast ? 1 : -1;
      return a.id.localeCompare(b.id);
    },
  );

  let next = 0;
  for (const area of unnumbered) {
    while (taken.has(next)) next += 1;
    taken.add(next);
    assigned.set(area.id, next);
  }

  return areas
    .map((area) => ({ area, slot: assigned.get(area.id)! }))
    .sort((a, b) => a.slot - b.slot);
}

export interface AreaIndex {
  /**
   * Display order, keyed on the persistent slot each area holds. Deliberately
   * not member count and not label: both change under a refresh or a rename,
   * and a map that rearranges itself when you rename a territory is not a map.
   * Names and counts are overlays on fixed ground.
   */
  order: PrototypeArea[];
  byId: Map<string, PrototypeArea>;
  areaIdsByNode: Map<string, string[]>;
  nodeSetByArea: Map<string, Set<string>>;
  unassigned: PrototypeArea | null;
  /**
   * Loaded records no area claims at all. Kept separate from Unassigned rather
   * than folded into it -- "no rule matched" and "not in the projection" are
   * different gaps.
   */
  unclaimedNodeCount: number;
}

export function buildAreaIndex(model: PrototypeModel): AreaIndex {
  const byId = new Map<string, PrototypeArea>();
  const areaIdsByNode = new Map<string, string[]>();
  const nodeSetByArea = new Map<string, Set<string>>();

  for (const area of model.areas) {
    byId.set(area.id, area);
    const set = new Set(area.nodeIds);
    nodeSetByArea.set(area.id, set);
    for (const nodeId of set) {
      const existing = areaIdsByNode.get(nodeId);
      if (existing) existing.push(area.id);
      else areaIdsByNode.set(nodeId, [area.id]);
    }
  }

  const unassigned = model.areas.find(isUnassignedArea) ?? null;
  const order = resolveSlots(model.areas).map((entry) => entry.area);

  let unclaimedNodeCount = 0;
  for (const nodeId of model.nodeById.keys()) {
    if (!areaIdsByNode.has(nodeId)) unclaimedNodeCount += 1;
  }

  return { order, byId, areaIdsByNode, nodeSetByArea, unassigned, unclaimedNodeCount };
}

/** All-time facts about an area. Never scoped to the selected window. */
export interface AreaStanding {
  areaId: string;
  /** As declared by the projection. */
  total: number;
  /** How many of those ids resolve to a loaded record. */
  resolved: number;
  /** Records with no recorded close (`closedAt` undefined), per the model contract. */
  open: number;
  topTypes: Array<{ type: string; count: number }>;
}

export function areaStandings(model: PrototypeModel, index: AreaIndex): Map<string, AreaStanding> {
  const out = new Map<string, AreaStanding>();
  for (const area of index.order) {
    const byType = new Map<string, number>();
    let resolved = 0;
    let open = 0;
    for (const nodeId of index.nodeSetByArea.get(area.id) ?? []) {
      const node = model.nodeById.get(nodeId);
      if (!node) continue;
      resolved += 1;
      if (node.closedAt === undefined) open += 1;
      byType.set(node.type, (byType.get(node.type) ?? 0) + 1);
    }
    const topTypes = [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
      .slice(0, 3);
    out.set(area.id, { areaId: area.id, total: area.nodeIds.length, resolved, open, topTypes });
  }
  return out;
}

export interface AreaActivity {
  areaId: string;
  events: number;
  /** Events the source actually recorded at that time. */
  recorded: number;
  /** Last-observed markers: one observation, never an interval. */
  lastObserved: number;
  /** Distinct records touched -- the honest unit, since one record can emit many events. */
  touched: number;
  /** Of those, records carrying at least one recorded event. */
  touchedRecorded: number;
  /** Records whose only in-range evidence is a last-seen timestamp. */
  touchedObservedOnly: number;
  /** Loaded records in the area: the denominator for `share`. */
  members: number;
  /**
   * `touched / members`. The overlay scales on this rather than on a
   * cross-area event maximum: one huge area (Unassigned carries 1,568 of the
   * project's 2,227 in-range events) flattens every other bar to a sliver and
   * hides exactly the change the map exists to show.
   */
  share: number;
  byKind: Array<{ kind: PrototypeEvent['kind']; count: number }>;
}

export interface RangeActivity {
  byArea: Map<string, AreaActivity>;
  totalEvents: number;
  /** In-range events whose record belongs to no area; reported, not silently dropped. */
  unmappedEvents: number;
}

export function areaActivityInRange(
  model: PrototypeModel,
  index: AreaIndex,
  range: PrototypeRange,
): RangeActivity {
  const touchedByArea = new Map<string, Set<string>>();
  const recordedTouchedByArea = new Map<string, Set<string>>();
  const kindsByArea = new Map<string, Map<PrototypeEvent['kind'], number>>();
  const byArea = new Map<string, AreaActivity>();

  for (const area of index.order) {
    let members = 0;
    for (const nodeId of index.nodeSetByArea.get(area.id) ?? []) {
      if (model.nodeById.has(nodeId)) members += 1;
    }
    byArea.set(area.id, {
      areaId: area.id,
      events: 0,
      recorded: 0,
      lastObserved: 0,
      touched: 0,
      touchedRecorded: 0,
      touchedObservedOnly: 0,
      members,
      share: 0,
      byKind: [],
    });
    touchedByArea.set(area.id, new Set());
    recordedTouchedByArea.set(area.id, new Set());
    kindsByArea.set(area.id, new Map());
  }

  const inRange = eventsInRange(model, range);
  let unmappedEvents = 0;

  for (const event of inRange) {
    const areaIds = index.areaIdsByNode.get(event.nodeId);
    if (!areaIds || areaIds.length === 0) {
      unmappedEvents += 1;
      continue;
    }
    // A record filed in two areas counts in both; the footer states that area
    // totals are not additive for exactly this reason.
    for (const areaId of areaIds) {
      const activity = byArea.get(areaId);
      if (!activity) continue;
      activity.events += 1;
      if (event.provenance === 'last-observed') activity.lastObserved += 1;
      else {
        activity.recorded += 1;
        recordedTouchedByArea.get(areaId)!.add(event.nodeId);
      }
      touchedByArea.get(areaId)!.add(event.nodeId);
      const kinds = kindsByArea.get(areaId)!;
      kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
    }
  }

  for (const activity of byArea.values()) {
    activity.touched = touchedByArea.get(activity.areaId)!.size;
    activity.touchedRecorded = recordedTouchedByArea.get(activity.areaId)!.size;
    activity.touchedObservedOnly = activity.touched - activity.touchedRecorded;
    activity.share = activity.members > 0 ? activity.touched / activity.members : 0;
    activity.byKind = [...kindsByArea.get(activity.areaId)!.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  }

  return { byArea, totalEvents: inRange.length, unmappedEvents };
}

export type ConnectionFamily =
  | 'recorded-link'
  | 'derived-link'
  | 'unclassified-link'
  | 'shared-membership';

/** Families produced by a snapshot edge; shared membership is not an edge. */
export type LinkFamily = Exclude<ConnectionFamily, 'shared-membership'>;

export const CONNECTION_FAMILY_LABEL: Record<ConnectionFamily, string> = {
  'recorded-link': 'Recorded links',
  'derived-link': 'Derived links',
  'unclassified-link': 'Unclassified links',
  'shared-membership': 'Shared membership',
};

export const CONNECTION_FAMILY_SHORT: Record<ConnectionFamily, string> = {
  'recorded-link': 'recorded links',
  'derived-link': 'derived links',
  'unclassified-link': 'unclassified links',
  'shared-membership': 'shared records',
};

const FAMILY_RANK: Record<ConnectionFamily, number> = {
  'recorded-link': 0,
  'derived-link': 1,
  'unclassified-link': 2,
  'shared-membership': 3,
};

export interface RelationOrigin {
  family: LinkFamily;
  /** Stated wherever the relation is not simply a link a source record carries. */
  note?: string;
}

/**
 * Provenance per edge type, read off the adapters that actually emit them
 * rather than assumed from the verb. A snapshot edge is NOT automatically an
 * explicit relation: `enrich.ts` synthesizes `contains`/`part_of` from file
 * paths, and `databaseAdapter` relabels a recorded commit link as `fixes` when
 * the item's tracker type is bug or incident. Anything not listed here is
 * reported as unclassified -- never silently promoted to recorded.
 */
const RELATION_ORIGIN: Record<string, RelationOrigin> = {
  worked_on_in: { family: 'recorded-link' },
  references: {
    family: 'recorded-link',
    note: 'The commit link is recorded on the item; "references" is the adapter\'s default verb for non-defect items.',
  },
  closes: {
    family: 'recorded-link',
    note: 'Parsed from a closing reference written in the commit or pull-request text.',
  },
  // The file edits and file changes are recorded, but no record names the
  // directory: the adapters roll a file list up onto a synthesized node, so the
  // relation that lands on that node is produced by the rollup rule.
  edited_in: {
    family: 'derived-link',
    note: 'Recorded session file edits, rolled up by path onto a synthesized directory node that no record names.',
  },
  touches: {
    family: 'derived-link',
    note: 'Recorded commit file changes, rolled up by path onto a synthesized directory node that no record names.',
  },
  fixes: {
    family: 'derived-link',
    note: 'The commit link is recorded; the "fixes" verb is inferred from the item being a bug or incident.',
  },
  contains: {
    family: 'derived-link',
    note: 'Synthesized from file paths by the enrichment pass; no record asserts it.',
  },
  part_of: {
    family: 'derived-link',
    note: 'Synthesized from a file path; being filed under a directory is not a statement about that directory.',
  },
};

export function relationOrigin(type: string): RelationOrigin {
  return (
    RELATION_ORIGIN[type] ?? {
      family: 'unclassified-link',
      note: 'Carried from the snapshot; this prototype does not classify how it was produced.',
    }
  );
}

const PROVENANCE_FAMILY: Record<'recorded' | 'derived' | 'unknown', LinkFamily> = {
  recorded: 'recorded-link',
  derived: 'derived-link',
  unknown: 'unclassified-link',
};

/**
 * Provenance for one edge. An adapter that stated its own provenance is the
 * authority; the table above is the fallback for the ones that did not.
 */
export function connectionOrigin(edge: ProjectGraphEdge): RelationOrigin {
  if (edge.provenance) {
    return { family: PROVENANCE_FAMILY[edge.provenance.kind], note: edge.provenance.basis };
  }
  return relationOrigin(edge.type);
}

export interface ConnectionEvidence {
  id: string;
  /** The record this row selects and opens -- always the one in the other area. */
  nodeId: string;
  label: string;
  /** States the relation and what supports it. Never a bare "related". */
  detail: string;
}

export interface AreaConnection {
  id: string;
  family: ConnectionFamily;
  otherAreaId: string;
  otherAreaLabel: string;
  /** True total, independent of how much evidence is carried. */
  count: number;
  relationCounts: Array<{ relation: string; count: number; note?: string }>;
  explanation: string;
  evidence: ConnectionEvidence[];
}

export interface InternalEdgeCensus {
  /** Snapshot edges with both endpoints inside this area. Context, not a bridge. */
  total: number;
  /**
   * Split by provenance, because "edges stay inside this area" reads as a
   * statement about recorded work — and a path-synthesized edge between two
   * records that happen to be filed together is not that.
   */
  byFamily: Partial<Record<LinkFamily, number>>;
}

export interface AreaConnectionResult {
  connections: AreaConnection[];
  internalEdges: InternalEdgeCensus;
}

const DEFAULT_EVIDENCE_CAP = 200;

function nodeLabel(model: PrototypeModel, id: string): string {
  return model.nodeById.get(id)?.label ?? id;
}

function membershipBasis(model: PrototypeModel, nodeId: string, areaId: string): string | null {
  const memberships = model.memberships.get(nodeId);
  return memberships?.find((m) => m.areaId === areaId)?.basis ?? null;
}

/**
 * Bridges from one area outward. Only ever computed for the selected area --
 * an all-pairs pass over every edge is the hairball this view exists to avoid.
 */
export function areaConnections(
  model: PrototypeModel,
  index: AreaIndex,
  areaId: string,
  options: { evidenceCap?: number } = {},
): AreaConnectionResult {
  const cap = options.evidenceCap ?? DEFAULT_EVIDENCE_CAP;
  const home = index.nodeSetByArea.get(areaId);
  const homeArea = index.byId.get(areaId);
  const internalEdges: InternalEdgeCensus = { total: 0, byFamily: {} };
  if (!home || !homeArea) return { connections: [], internalEdges };

  interface Bucket {
    family: ConnectionFamily;
    otherAreaId: string;
    count: number;
    relations: Map<string, number>;
    evidence: ConnectionEvidence[];
  }
  // Keyed by family *and* area, so a pair of areas joined by both a recorded
  // link and a path-derived one produces two entries with two provenances --
  // never one entry asserting the stronger of the two.
  const links = new Map<string, Bucket>();

  const bucketFor = (map: Map<string, Bucket>, family: ConnectionFamily, otherId: string) => {
    const key = `${family}|${otherId}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { family, otherAreaId: otherId, count: 0, relations: new Map(), evidence: [] };
      map.set(key, bucket);
    }
    return bucket;
  };

  const areasOf = (nodeId: string) => index.areaIdsByNode.get(nodeId) ?? [];

  for (const edge of model.snapshot.edges) {
    const sourceHome = home.has(edge.sourceId);
    const targetHome = home.has(edge.targetId);
    if (!sourceHome && !targetHome) continue;

    // Both ends are considered, so which way round the adapter happened to
    // write the edge cannot decide whether this area bridges to another one.
    // Reading only the "far" end of an edge whose *source* is filed in two
    // areas silently made an A→B bridge appear or vanish on direction alone.
    const outside = new Set<string>();
    if (sourceHome) for (const id of areasOf(edge.targetId)) if (id !== areaId) outside.add(id);
    if (targetHome) for (const id of areasOf(edge.sourceId)) if (id !== areaId) outside.add(id);

    const origin = connectionOrigin(edge);
    if (outside.size === 0) {
      // Both endpoints live only in this area (or the far end is unfiled).
      if (sourceHome && targetHome) {
        internalEdges.total += 1;
        internalEdges.byFamily[origin.family] =
          (internalEdges.byFamily[origin.family] ?? 0) + 1;
      }
      continue;
    }

    for (const otherId of outside) {
      // The evidence row points at the record that is in the *other* area. When
      // both endpoints qualify, the one outside this area is the discovery.
      const inOther = (nodeId: string) => areasOf(nodeId).includes(otherId);
      const candidates = [edge.sourceId, edge.targetId].filter(inOther);
      const farId =
        candidates.find((nodeId) => !home.has(nodeId)) ??
        [...candidates].sort()[0] ??
        edge.targetId;

      const bucket = bucketFor(links, origin.family, otherId);
      bucket.count += 1;
      bucket.relations.set(edge.type, (bucket.relations.get(edge.type) ?? 0) + 1);
      if (bucket.evidence.length < cap) {
        const relation = edge.label ? `${edge.type} (${edge.label})` : edge.type;
        bucket.evidence.push({
          id: `${edge.id}:${otherId}`,
          nodeId: farId,
          // Bucketing is direction-blind; the explanation is not. The arrow is
          // the direction the snapshot actually recorded.
          label: `${nodeLabel(model, edge.sourceId)} → ${nodeLabel(model, edge.targetId)}`,
          detail: `Snapshot ${relation} edge · ${origin.note ?? 'link recorded in a source record'}`,
        });
      }
    }
  }

  const shared = new Map<string, Bucket>();
  for (const nodeId of home) {
    const areaIds = index.areaIdsByNode.get(nodeId) ?? [];
    for (const otherId of areaIds) {
      if (otherId === areaId) continue;
      const bucket = bucketFor(shared, 'shared-membership', otherId);
      bucket.count += 1;
      if (bucket.evidence.length < cap) {
        const here = membershipBasis(model, nodeId, areaId);
        const there = membershipBasis(model, nodeId, otherId);
        const basis =
          here && there
            ? `${here} / ${there}`
            : (here ?? there ?? 'membership basis not recorded');
        bucket.evidence.push({
          id: `shared:${nodeId}:${otherId}`,
          nodeId,
          label: nodeLabel(model, nodeId),
          detail: `Filed in both areas · ${basis}`,
        });
      }
    }
  }

  const connections: AreaConnection[] = [];
  const explain = (family: ConnectionFamily, n: number, otherLabel: string): string => {
    const links = `${n} ${n === 1 ? 'link' : 'links'}`;
    switch (family) {
      case 'recorded-link':
        return `${links} recorded in source records between ${homeArea.label} and ${otherLabel}.`;
      case 'derived-link':
        return `${links} the loader derived between ${homeArea.label} and ${otherLabel}. Each relation states how it was derived; none is asserted by a record.`;
      case 'unclassified-link':
        return `${links} carried from the snapshot between ${homeArea.label} and ${otherLabel}. This prototype does not classify how they were produced.`;
      case 'shared-membership':
        return `${n} ${n === 1 ? 'record is' : 'records are'} filed in both areas by a membership rule. Co-membership is not a dependency.`;
    }
  };

  for (const bucket of [...links.values(), ...shared.values()]) {
    const other = index.byId.get(bucket.otherAreaId);
    if (!other) continue;
    const relationCounts = [...bucket.relations.entries()]
      .map(([relation, count]) => ({ relation, count, note: relationOrigin(relation).note }))
      .sort((a, b) => b.count - a.count || a.relation.localeCompare(b.relation));
    connections.push({
      id: `${bucket.family}:${bucket.otherAreaId}`,
      family: bucket.family,
      otherAreaId: bucket.otherAreaId,
      otherAreaLabel: other.label,
      count: bucket.count,
      relationCounts,
      explanation: explain(bucket.family, bucket.count, other.label),
      evidence: bucket.evidence,
    });
  }

  connections.sort(
    (a, b) =>
      b.count - a.count ||
      FAMILY_RANK[a.family] - FAMILY_RANK[b.family] ||
      a.otherAreaLabel.localeCompare(b.otherAreaLabel),
  );

  return { connections, internalEdges };
}

export function formatRelationSummary(
  relationCounts: Array<{ relation: string; count: number }>,
  limit = 3,
): string {
  if (relationCounts.length === 0) return '';
  const shown = relationCounts.slice(0, limit).map((r) => `${r.relation} ×${r.count}`);
  const rest = relationCounts.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

export interface TerritoryBox {
  areaId: string;
  col: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasLayout {
  width: number;
  height: number;
  columns: number;
  boxes: TerritoryBox[];
}

export const TERRITORY_HEIGHT = 152;
const TERRITORY_GAP = 14;
const MAP_PADDING = 16;

export function columnsForWidth(width: number): number {
  if (width < 520) return 1;
  if (width < 780) return 2;
  if (width < 1120) return 3;
  return 4;
}

/**
 * Grid placement over the persistent slots. The only input that can move a
 * territory is its own slot; width changes the column count and nothing else.
 * A slot with no area left in it stays empty — the cells after it do not shift
 * up to close the gap.
 */
export function layoutTerritories(order: PrototypeArea[], width: number): AtlasLayout {
  const usable = Math.max(width, 260);
  const slots = resolveSlots(order);
  const maxSlot = slots.reduce((max, entry) => Math.max(max, entry.slot), -1);
  const columns = Math.min(columnsForWidth(usable), Math.max(maxSlot + 1, 1));
  const inner = usable - MAP_PADDING * 2 - TERRITORY_GAP * (columns - 1);
  const tileWidth = Math.max(inner / columns, 120);
  const rows = Math.max(Math.ceil((maxSlot + 1) / columns), 1);

  const boxes = slots.map(({ area, slot }) => {
    const col = slot % columns;
    const row = Math.floor(slot / columns);
    return {
      areaId: area.id,
      col,
      row,
      x: MAP_PADDING + col * (tileWidth + TERRITORY_GAP),
      y: MAP_PADDING + row * (TERRITORY_HEIGHT + TERRITORY_GAP),
      w: tileWidth,
      h: TERRITORY_HEIGHT,
    };
  });

  return {
    width: usable,
    height: MAP_PADDING * 2 + rows * TERRITORY_HEIGHT + (rows - 1) * TERRITORY_GAP,
    columns,
    boxes,
  };
}

/**
 * The territory an arrow key moves to, resolved against the drawn geometry.
 *
 * Stepping by position in the area order was correct only while the map was
 * densely packed. Persistent slots mean a hidden or emptied rule leaves a hole,
 * so `position + columns` now lands on ground no territory occupies — or walks
 * off the end of a short last row. Reading the boxes moves the reader to what
 * they can actually see. Returns null for keys this view does not own, which is
 * how application chords stay unswallowed.
 */
export function moveTerritoryFocus(
  boxes: TerritoryBox[],
  areaId: string,
  key: string,
): string | null {
  const current = boxes.find((box) => box.areaId === areaId);
  if (!current || boxes.length === 0) return null;
  const reading = [...boxes].sort((a, b) => a.row - b.row || a.col - b.col);

  if (key === 'Home') return reading[0].areaId;
  if (key === 'End') return reading[reading.length - 1].areaId;

  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const at = reading.findIndex((box) => box.areaId === areaId);
    const next = reading[key === 'ArrowRight' ? at + 1 : at - 1];
    return next ? next.areaId : null;
  }

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    // Nearest occupied cell in the same column, so a hole is stepped over
    // rather than stepped onto.
    const down = key === 'ArrowDown';
    const candidates = boxes
      .filter((box) => box.col === current.col && (down ? box.row > current.row : box.row < current.row))
      .sort((a, b) => (down ? a.row - b.row : b.row - a.row));
    return candidates[0]?.areaId ?? null;
  }

  return null;
}

function borderPoint(box: TerritoryBox, towardX: number, towardY: number) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = towardX - cx;
  const dy = towardY - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : box.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : box.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

export interface Connector {
  d: string;
  midX: number;
  midY: number;
}

/**
 * Where one connection sits inside the bundle of connections between the same
 * pair of territories. Two families joined the same pair used to produce the
 * identical arc and the identical midpoint, which stacked their controls and
 * left the lower one unclickable.
 */
export interface ConnectorOffset {
  index: number;
  count: number;
}

/** Bow separation between the routes of one bundle, in px. */
const BUNDLE_SPREAD = 44;

/** A quadratic arc anchored on both territory borders, bowed clear of the tiles. */
export function connectorPath(
  from: TerritoryBox,
  to: TerritoryBox,
  offset: ConnectorOffset = { index: 0, count: 1 },
): Connector {
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const a = borderPoint(from, tc.x, tc.y);
  const b = borderPoint(to, fc.x, fc.y);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Each route in a bundle keeps its own bow, spread symmetrically about the
  // centre line so a lone connection is unchanged.
  const rank = offset.index - (Math.max(offset.count, 1) - 1) / 2;
  const bow = Math.min(len * 0.16, 46) + rank * BUNDLE_SPREAD;
  const cx = (a.x + b.x) / 2 + (-dy / len) * bow;
  const cy = (a.y + b.y) / 2 + (dx / len) * bow;
  return {
    d: `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
    midX: 0.25 * a.x + 0.5 * cx + 0.25 * b.x,
    midY: 0.25 * a.y + 0.5 * cy + 0.25 * b.y,
  };
}

export function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
}

export function describeNode(node: ProjectGraphNode): string {
  const bits = [node.type, node.source];
  if (node.status) bits.push(node.status);
  return bits.join(' · ');
}
