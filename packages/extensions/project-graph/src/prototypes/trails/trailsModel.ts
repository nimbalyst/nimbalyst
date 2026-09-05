/**
 * Pure model helpers for the Evidence Trails prototype.
 *
 * The view answers "why does this record exist, and what does it affect?" by
 * walking the snapshot's *recorded* edges outward from one focused artifact.
 * Everything here is deliberately conservative:
 *
 *  - Relations keep the name the snapshot gave them. `part_of` is path
 *    containment and says so; it is never re-labelled into a semantic claim.
 *  - A missing relation is reported as unknown. Nothing infers failure,
 *    verification, or release from the absence of an edge.
 *  - Neighborhoods are bounded before they are rendered, and every bound
 *    reports the total it was taken from, so a truncated lane can never read
 *    as a complete one.
 */

import type { ProjectGraphEdge, ProjectGraphNode } from '../../types';
import type { PrototypeEvent, PrototypeModel, PrototypeRange } from '../contracts';

export type RelationBasisKind = 'explicit' | 'derived' | 'unknown';

export interface RelationDescriptor {
  /** The snapshot's own relation name, spaced for reading. Never a synonym. */
  label: string;
  /** What in the sources supports this connection. */
  basis: string;
  kind: RelationBasisKind;
  /**
   * Produced purely by where a file sits on disk. These dominate the graph and
   * carry the least meaning, so the view can collapse them on their own —
   * separately from the broader explicit/derived/unknown distinction.
   */
  pathDerived?: true;
}

/**
 * Basis text per relation. The four relations the live adapters actually emit
 * (`worked_on_in`, `edited_in`, `touches`, `part_of`, plus commit links) carry
 * the specific rule that produced them; the rest describe themselves honestly
 * rather than claiming a rule nobody wrote.
 */
const RELATIONS: Record<string, RelationDescriptor> = {
  worked_on_in: {
    label: 'worked on in',
    basis: 'An explicit tracker-to-session link, recorded on the tracker item or on the session.',
    kind: 'explicit',
  },
  edited_in: {
    label: 'edited in',
    basis: 'A file the session recorded editing.',
    kind: 'explicit',
  },
  touches: {
    label: 'touches',
    basis: 'A file the commit recorded changing.',
    kind: 'explicit',
  },
  references: {
    label: 'references',
    basis: 'The item links this commit.',
    kind: 'explicit',
  },
  fixes: {
    label: 'fixes',
    basis: 'The item links this commit and its type is defect-like. The "fixes" wording comes from the item type, not from the commit.',
    kind: 'derived',
  },
  closes: {
    label: 'closes',
    basis: 'A closing reference parsed out of the pull request.',
    kind: 'explicit',
  },
  contains: {
    label: 'contains',
    basis: 'Directory path containment.',
    kind: 'derived',
    pathDerived: true,
  },
  part_of: {
    label: 'part of',
    basis: 'The record’s file path rolls up to this directory. Where a file is filed, not what it is about.',
    kind: 'derived',
    pathDerived: true,
  },
  implements: { label: 'implements', basis: 'Recorded implementation link.', kind: 'explicit' },
  planned_by: { label: 'planned by', basis: 'Recorded link to a plan record.', kind: 'explicit' },
  designed_by: { label: 'designed by', basis: 'Recorded link to a design record.', kind: 'explicit' },
  documents: { label: 'documents', basis: 'Recorded documentation link.', kind: 'explicit' },
  depends_on: { label: 'depends on', basis: 'Recorded dependency.', kind: 'explicit' },
  blocked_by: { label: 'blocked by', basis: 'Recorded blocking relation.', kind: 'explicit' },
  requested_by: { label: 'requested by', basis: 'Recorded requester link.', kind: 'explicit' },
  reported_by: { label: 'reported by', basis: 'Recorded reporter link.', kind: 'explicit' },
  owned_by: { label: 'owned by', basis: 'Recorded owner link.', kind: 'explicit' },
  generated: { label: 'generated', basis: 'Recorded as produced by the linked record.', kind: 'explicit' },
  reviewed_in: { label: 'reviewed in', basis: 'Recorded review link.', kind: 'explicit' },
  related_to: {
    label: 'related to',
    basis: 'Recorded as related. The snapshot does not say what supports it.',
    kind: 'unknown',
  },
};

export function describeRelation(type: string): RelationDescriptor {
  const known = RELATIONS[type];
  if (known) return known;
  return {
    label: type.replace(/[_-]+/g, ' '),
    basis: 'Recorded in the snapshot without a stated basis.',
    kind: 'unknown',
  };
}

/**
 * `edited_in` and `touches` are recorded per file, but the adapters do not emit
 * a node per file: they aggregate a session's or a commit's file list onto a
 * synthesized directory node. The relation that reaches the directory is
 * therefore produced by the rollup rule, not asserted by any record, and the
 * fallback below says so. A far end that is a real file keeps the recorded
 * reading.
 */
const ROLLUP_RELATIONS = new Set(['edited_in', 'touches']);

export function isRollupRecord(node: ProjectGraphNode | null | undefined): boolean {
  return Boolean(node && (node.type === 'directory' || node.fields?.rollup === true));
}

const PROVENANCE_KIND: Record<'recorded' | 'derived' | 'unknown', RelationBasisKind> = {
  recorded: 'explicit',
  derived: 'derived',
  unknown: 'unknown',
};

/**
 * The descriptor for one connection, reading the edge's own provenance when the
 * adapter stated it and falling back to the relation table when it did not.
 *
 * The rollup fallback has to look at the edge's own *target*, not at whichever
 * end the reader happens to be standing on: `edited_in` and `touches` are
 * written session→directory and commit→directory, and the reading must not flip
 * when the neighborhood is built from the directory's side.
 */
export function describeConnection(
  edge: ProjectGraphEdge,
  nodeById?: Map<string, ProjectGraphNode>,
): RelationDescriptor {
  const table = describeRelation(edge.type);
  if (edge.provenance) {
    return {
      ...table,
      kind: PROVENANCE_KIND[edge.provenance.kind],
      basis: edge.provenance.basis,
      // A stated provenance overrides the table's reading, including whether
      // this is the file-path family the view collapses on its own.
      pathDerived: edge.provenance.kind === 'derived' ? table.pathDerived : undefined,
    };
  }
  if (ROLLUP_RELATIONS.has(edge.type) && isRollupRecord(nodeById?.get(edge.targetId))) {
    return {
      ...table,
      kind: 'derived',
      basis: `${table.basis} The link reaches this directory because the adapter rolled that file list up to it, not because a record names the directory.`,
    };
  }
  return table;
}

export type Direction = 'out' | 'in';

export interface AdjacencyEntry {
  edge: ProjectGraphEdge;
  neighborId: string;
  direction: Direction;
}

export interface TrailsIndex {
  adjacency: Map<string, AdjacencyEntry[]>;
  eventsByNode: Map<string, PrototypeEvent[]>;
}

/**
 * One pass over the snapshot. At the scale this prototype targets (3k+ nodes,
 * 3.8k+ edges) every per-focus question below is then a map lookup rather than
 * a scan, which is what keeps typing in the search box cheap.
 */
export function buildTrailsIndex(model: PrototypeModel): TrailsIndex {
  const adjacency = new Map<string, AdjacencyEntry[]>();
  const push = (id: string, entry: AdjacencyEntry) => {
    const list = adjacency.get(id);
    if (list) list.push(entry);
    else adjacency.set(id, [entry]);
  };
  for (const edge of model.snapshot.edges) {
    push(edge.sourceId, { edge, neighborId: edge.targetId, direction: 'out' });
    push(edge.targetId, { edge, neighborId: edge.sourceId, direction: 'in' });
  }

  const eventsByNode = new Map<string, PrototypeEvent[]>();
  for (const event of model.events) {
    const list = eventsByNode.get(event.nodeId);
    if (list) list.push(event);
    else eventsByNode.set(event.nodeId, [event]);
  }
  for (const list of eventsByNode.values()) list.sort((a, b) => b.at - a.at);

  return { adjacency, eventsByNode };
}

export function degreeOf(index: TrailsIndex, nodeId: string): number {
  return index.adjacency.get(nodeId)?.length ?? 0;
}

/**
 * Connections that came from an explicit link in a source, counting only ones
 * whose other end is actually in this snapshot. Path containment and
 * type-inferred relations are excluded: they are what every record has, so they
 * say nothing about whether a record is a useful place to start reading.
 */
export function explicitDegreeOf(model: PrototypeModel, index: TrailsIndex, nodeId: string): number {
  const entries = index.adjacency.get(nodeId);
  if (!entries) return 0;
  let count = 0;
  for (const entry of entries) {
    const neighbor = model.nodeById.get(entry.neighborId);
    if (!neighbor) continue;
    if (describeConnection(entry.edge, model.nodeById).kind === 'explicit') count += 1;
  }
  return count;
}

export function latestEvent(index: TrailsIndex, nodeId: string): PrototypeEvent | null {
  return index.eventsByNode.get(nodeId)?.[0] ?? null;
}

/** True when this record has at least one recorded event inside the window. */
export function hasEvidenceInRange(index: TrailsIndex, nodeId: string, range: PrototypeRange): boolean {
  const events = index.eventsByNode.get(nodeId);
  if (!events) return false;
  return events.some(e => e.at >= range.startMs && e.at <= range.endMs);
}

export interface NeighborRef {
  /** Edge id: unique per connection even when two records connect twice. */
  key: string;
  node: ProjectGraphNode;
  edge: ProjectGraphEdge;
  direction: Direction;
  descriptor: RelationDescriptor;
  inRange: boolean;
  latest: PrototypeEvent | null;
  degree: number;
}

export interface RelationLane {
  key: string;
  type: string;
  direction: Direction;
  descriptor: RelationDescriptor;
  /** Bounded slice; `total` is what it was taken from. */
  neighbors: NeighborRef[];
  total: number;
  inRangeCount: number;
}

/**
 * A connection whose far endpoint is not in this snapshot.
 *
 * These are kept and shown rather than dropped: `githubAdapter` emits a
 * `closes` edge to an issue the loader may never have fetched, and the id it
 * points at is the only handle a reader has on that record. Hiding the row
 * would turn "it is not in this view" into an apparent absence of evidence.
 *
 * Two different situations land here and this view cannot separate them: the
 * record may never have been indexed, or it may be indexed and filtered out by
 * the shell's type filter, which keeps edges incident to excluded types. The
 * copy names both rather than asserting one.
 */
export interface UnresolvedRef {
  /** Edge id: unique per connection. */
  key: string;
  /** The endpoint id this snapshot could not resolve. */
  missingId: string;
  /** The endpoint that is loaded — the focus of this neighborhood. */
  knownId: string;
  direction: Direction;
  descriptor: RelationDescriptor;
}

/** Bounds the carried rows on a focus with a pathological number of danglers. */
const UNRESOLVED_CAP = 50;

export interface Neighborhood {
  focus: ProjectGraphNode | null;
  lanes: RelationLane[];
  /** Relation lanes that exist but are not rendered (lane cap). */
  laneTotal: number;
  /** Every edge touching the focus, including ones we cannot render. */
  connectionTotal: number;
  connectionShown: number;
  inRangeTotal: number;
  /** Edges whose other endpoint is not in this snapshot. */
  unresolved: number;
  /** Those same edges, bounded, so each stays visible with the id it names. */
  unresolvedRefs: UnresolvedRef[];
  /** Connections withheld because path-derived lanes are collapsed. */
  hiddenPathDerived: number;
  /**
   * Census over every *resolved* connection, taken before the lane cap and the
   * path-containment toggle. Anything that makes a claim about what the sources
   * do or do not contain has to read these, not the rendered lanes: a lane the
   * view chose not to draw is still evidence that exists.
   */
  census: NeighborhoodCensus;
}

export interface NeighborhoodCensus {
  resolved: number;
  explicit: number;
  /** Derived by a stated rule — path containment or item type. */
  derived: number;
  pathDerived: number;
  unknownBasis: number;
  /** Relations that record a review of this work (outcome not evaluated here). */
  review: number;
  commit: number;
  session: number;
}

export interface NeighborhoodOptions {
  /** Per-lane render cap, keyed by lane key. */
  perLane: (laneKey: string) => number;
  laneLimit: number;
  includePathDerived: boolean;
}

function compareNeighbors(a: NeighborRef, b: NeighborRef): number {
  if (a.inRange !== b.inRange) return a.inRange ? -1 : 1;
  const aAt = a.latest?.at ?? -Infinity;
  const bAt = b.latest?.at ?? -Infinity;
  if (aAt !== bAt) return bAt - aAt;
  const aStrength = a.edge.strength ?? 0;
  const bStrength = b.edge.strength ?? 0;
  if (aStrength !== bStrength) return bStrength - aStrength;
  return a.node.label.localeCompare(b.node.label);
}

const KIND_RANK: Record<RelationBasisKind, number> = { explicit: 0, unknown: 1, derived: 2 };

/** Relations that record that work was reviewed. Their outcome is not read. */
const REVIEW_RELATIONS = new Set(['reviewed_in']);

function emptyCensus(): NeighborhoodCensus {
  return { resolved: 0, explicit: 0, derived: 0, pathDerived: 0, unknownBasis: 0, review: 0, commit: 0, session: 0 };
}

export function buildNeighborhood(
  model: PrototypeModel,
  index: TrailsIndex,
  focusId: string | null,
  range: PrototypeRange,
  options: NeighborhoodOptions,
): Neighborhood {
  const empty: Neighborhood = {
    focus: null,
    lanes: [],
    laneTotal: 0,
    connectionTotal: 0,
    connectionShown: 0,
    inRangeTotal: 0,
    unresolved: 0,
    unresolvedRefs: [],
    hiddenPathDerived: 0,
    census: emptyCensus(),
  };
  if (!focusId) return empty;
  const focus = model.nodeById.get(focusId) ?? null;
  if (!focus) return empty;

  const entries = index.adjacency.get(focusId) ?? [];
  const grouped = new Map<string, NeighborRef[]>();
  const census = emptyCensus();
  const unresolvedRefs: UnresolvedRef[] = [];
  let unresolved = 0;
  let inRangeTotal = 0;

  for (const entry of entries) {
    const node = model.nodeById.get(entry.neighborId);
    if (!node) {
      // githubAdapter can emit a `closes` edge to an issue the snapshot never
      // loaded. Drawing an empty card is dishonest, but so is dropping the row:
      // the id is kept and listed as unresolved.
      unresolved += 1;
      if (unresolvedRefs.length < UNRESOLVED_CAP) {
        unresolvedRefs.push({
          key: entry.edge.id,
          missingId: entry.neighborId,
          knownId: focusId,
          direction: entry.direction,
          descriptor: describeConnection(entry.edge, model.nodeById),
        });
      }
      continue;
    }
    const ref: NeighborRef = {
      key: entry.edge.id,
      node,
      edge: entry.edge,
      direction: entry.direction,
      descriptor: describeConnection(entry.edge, model.nodeById),
      inRange: hasEvidenceInRange(index, node.id, range),
      latest: latestEvent(index, node.id),
      degree: degreeOf(index, node.id),
    };
    if (ref.inRange) inRangeTotal += 1;

    census.resolved += 1;
    if (ref.descriptor.kind === 'explicit') census.explicit += 1;
    else if (ref.descriptor.kind === 'derived') census.derived += 1;
    else census.unknownBasis += 1;
    if (ref.descriptor.pathDerived) census.pathDerived += 1;
    if (REVIEW_RELATIONS.has(entry.edge.type)) census.review += 1;
    if (node.type === 'commit') census.commit += 1;
    if (node.source === 'session') census.session += 1;

    const laneKey = `${entry.edge.type}:${entry.direction}`;
    const list = grouped.get(laneKey);
    if (list) list.push(ref);
    else grouped.set(laneKey, [ref]);
  }

  let hiddenPathDerived = 0;
  const allLanes: RelationLane[] = [];
  for (const [key, refs] of grouped) {
    const descriptor = refs[0]!.descriptor;
    if (!options.includePathDerived && descriptor.pathDerived) {
      hiddenPathDerived += refs.length;
      continue;
    }
    refs.sort(compareNeighbors);
    allLanes.push({
      key,
      type: refs[0]!.edge.type,
      direction: refs[0]!.direction,
      descriptor,
      neighbors: refs.slice(0, Math.max(1, options.perLane(key))),
      total: refs.length,
      inRangeCount: refs.reduce((n, r) => n + (r.inRange ? 1 : 0), 0),
    });
  }

  allLanes.sort((a, b) => {
    const rank = KIND_RANK[a.descriptor.kind] - KIND_RANK[b.descriptor.kind];
    if (rank !== 0) return rank;
    if (a.total !== b.total) return b.total - a.total;
    return a.descriptor.label.localeCompare(b.descriptor.label);
  });

  const lanes = allLanes.slice(0, Math.max(1, options.laneLimit));
  return {
    focus,
    lanes,
    laneTotal: allLanes.length,
    connectionTotal: entries.length,
    connectionShown: lanes.reduce((n, lane) => n + lane.neighbors.length, 0),
    inRangeTotal,
    unresolved,
    unresolvedRefs,
    hiddenPathDerived,
    census,
  };
}

export interface SecondHop {
  items: NeighborRef[];
  total: number;
}

/**
 * The second hop out of one first-hop neighbor. The focus is excluded — the way
 * back is the trail you are standing on, not a discovery.
 */
export function buildSecondHop(
  model: PrototypeModel,
  index: TrailsIndex,
  neighborId: string,
  focusId: string,
  range: PrototypeRange,
  limit: number,
): SecondHop {
  const entries = index.adjacency.get(neighborId) ?? [];
  const refs: NeighborRef[] = [];
  for (const entry of entries) {
    if (entry.neighborId === focusId) continue;
    const node = model.nodeById.get(entry.neighborId);
    if (!node) continue;
    refs.push({
      key: entry.edge.id,
      node,
      edge: entry.edge,
      direction: entry.direction,
      descriptor: describeConnection(entry.edge, model.nodeById),
      inRange: hasEvidenceInRange(index, node.id, range),
      latest: latestEvent(index, node.id),
      degree: degreeOf(index, node.id),
    });
  }
  refs.sort(compareNeighbors);
  return { items: refs.slice(0, Math.max(0, limit)), total: refs.length };
}

export interface StartingArtifacts {
  items: ProjectGraphNode[];
  /** Matches within the current scope, before the display bound. */
  total: number;
  /** Records the scope itself excluded, so the bound is not read as the whole. */
  scopeTotal: number;
}

export interface StartingArtifactsOptions {
  query: string;
  areaNodeIds: Set<string> | null;
  limit: number;
  range: PrototypeRange;
}

/**
 * A directory or synthesized package rollup. These accumulate an `edited_in` or
 * `touches` edge from every session and commit in the project, so ranking on
 * connection count alone hands the entire list to them — and a directory is
 * where a trail arrives, not the question someone starts from.
 */
export function isContainerRecord(node: ProjectGraphNode): boolean {
  return node.type === 'directory' || node.fields?.rollup === true;
}

/**
 * Ranks candidate starting points. With no query the rule, in order, is:
 * evidence inside the current range, then named artifacts ahead of directory
 * rollups, then explicitly linked connections, then total connections, then the
 * most recent event. That is the whole rule — it is not a relevance model, and
 * the UI states it. A query bypasses the tiers entirely and matches on name, so
 * directories and unlinked records stay reachable by typing.
 */
export function findStartingArtifacts(
  model: PrototypeModel,
  index: TrailsIndex,
  options: StartingArtifactsOptions,
): StartingArtifacts {
  const query = options.query.trim().toLowerCase();
  const scoped = options.areaNodeIds;
  const matches: Array<{
    node: ProjectGraphNode;
    rank: number;
    recency: number;
    degree: number;
    explicit: number;
    inRange: boolean;
    container: boolean;
  }> = [];
  let scopeTotal = 0;

  for (const node of model.snapshot.nodes) {
    if (scoped && !scoped.has(node.id)) continue;
    scopeTotal += 1;
    let rank = 0;
    if (query) {
      const label = node.label.toLowerCase();
      const sub = node.sublabel?.toLowerCase() ?? '';
      if (label.startsWith(query)) rank = 0;
      else if (label.includes(query)) rank = 1;
      else if (sub.includes(query)) rank = 2;
      else if (node.id.toLowerCase().includes(query)) rank = 3;
      else continue;
    }
    matches.push({
      node,
      rank,
      recency: latestEvent(index, node.id)?.at ?? node.createdAt ?? -Infinity,
      degree: degreeOf(index, node.id),
      explicit: explicitDegreeOf(model, index, node.id),
      inRange: hasEvidenceInRange(index, node.id, options.range),
      container: isContainerRecord(node),
    });
  }

  matches.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (query) {
      if (a.recency !== b.recency) return b.recency - a.recency;
      return a.node.label.localeCompare(b.node.label);
    }
    if (a.inRange !== b.inRange) return a.inRange ? -1 : 1;
    if (a.container !== b.container) return a.container ? 1 : -1;
    if (a.explicit !== b.explicit) return b.explicit - a.explicit;
    if (a.degree !== b.degree) return b.degree - a.degree;
    if (a.recency !== b.recency) return b.recency - a.recency;
    return a.node.label.localeCompare(b.node.label);
  });

  return {
    items: matches.slice(0, Math.max(0, options.limit)).map(m => m.node),
    total: matches.length,
    scopeTotal,
  };
}

/**
 * What this trail does *not* establish.
 *
 * Every line is scoped to something actually counted: the census covers all
 * resolved connections, so these hold whether or not a lane was capped or the
 * path-containment toggle is on. Nothing here asserts a negative outcome, and
 * nothing claims an absence the view did not measure.
 */
export function describeGaps(model: PrototypeModel, neighborhood: Neighborhood): string[] {
  const focus = neighborhood.focus;
  if (!focus) return [];
  const { census } = neighborhood;
  const gaps: string[] = [];

  if (neighborhood.connectionTotal === 0) {
    // Every adapter here is capped, and a record that would carry the link may
    // simply not have been loaded. The claim is about this snapshot only — it
    // is never that the sources recorded nothing.
    gaps.push(
      'No connection to this artifact is present in the loaded snapshot. Each source is bounded, so a link may exist in a record that was not loaded; this is not evidence that the work stands alone.',
    );
  }

  if (focus.type === 'commit' || census.commit > 0) {
    gaps.push(
      'A commit is implementation evidence. Whether this shipped, or behaves correctly, is not recorded in this snapshot.',
    );
  }

  if (focus.type === 'commit' || focus.source === 'session' || census.commit > 0 || census.session > 0) {
    gaps.push(
      'This view does not assess verification — it reads recorded links and never evaluates an outcome. Verification status here is unknown, not failed.',
    );
  }
  if (census.review > 0) {
    gaps.push(
      `${census.review} recorded review link${census.review === 1 ? ' is' : 's are'} on this trail. This view lists ${census.review === 1 ? 'it' : 'them'} without reading ${census.review === 1 ? 'its' : 'their'} result.`,
    );
  }

  // Both claims below are counted over every resolved connection, not over the
  // lanes that happened to be drawn.
  if (census.resolved > 0 && census.pathDerived === census.resolved) {
    gaps.push(
      `All ${census.resolved} recorded connection${census.resolved === 1 ? '' : 's'} here come from file-path containment — where these records are filed, not what they are about.`,
    );
  } else if (census.resolved > 0 && census.derived === census.resolved) {
    // Gated on `derived`, not on `explicit === 0`: a relation with an unstated
    // basis (`related_to`) is not derived by any rule we can name, and saying it
    // came from a path or an item type would invent one. Unknown stays unknown.
    gaps.push(
      `None of the ${census.resolved} recorded connection${census.resolved === 1 ? '' : 's'} here is an explicit source link; each was derived by a stated rule, from a file path or from the item's type.`,
    );
  }

  if (neighborhood.unresolved > 0) {
    const n = neighborhood.unresolved;
    gaps.push(
      // The shell retains edges incident to record types it filtered out, so a
      // missing endpoint is either unindexed or merely out of view. This view
      // cannot tell those apart and does not guess.
      `${n} connection${n === 1 ? ' points' : 's point'} at records that are not in this view — either not indexed, or of a type filtered out here. ${n === 1 ? 'It is' : 'They are'} listed with the id ${n === 1 ? 'it names' : 'they name'}.`,
    );
  }

  if (model.source === 'live') {
    gaps.push('This snapshot runs no memory adapter, so memory evidence is missing rather than empty.');
  }

  return gaps;
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function formatDay(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms)) return 'unknown';
  return DAY_FORMAT.format(new Date(ms));
}

export function formatRange(range: PrototypeRange): string {
  return `${formatDay(range.startMs)} – ${formatDay(range.endMs)}`;
}

/**
 * The creation event the sources actually recorded, if there is one.
 *
 * `node.createdAt` cannot be used for this. The loader fills undated nodes from
 * their earliest dated neighbor, so on a file-backed record that field is a
 * useful ordering approximation and *not* an observed creation date. Only a
 * `created` event carrying `recorded` provenance says when something was made.
 */
export function recordedCreation(index: TrailsIndex, nodeId: string): PrototypeEvent | null {
  const events = index.eventsByNode.get(nodeId);
  if (!events) return null;
  // Sorted newest-first; the earliest recorded creation is the one that counts.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind === 'created' && event.provenance === 'recorded') return event;
  }
  return null;
}

/** Caption for a record's creation. Never prints an inferred date as observed. */
export function describeCreation(index: TrailsIndex, nodeId: string): string {
  const created = recordedCreation(index, nodeId);
  return created ? `Created ${formatDay(created.at)}` : 'Creation date not recorded';
}

/** "recorded" vs "last observed" — a single observation is never an interval. */
export function describeEvent(event: PrototypeEvent | null): string {
  if (!event) return 'No dated event recorded';
  const qualifier = event.provenance === 'last-observed' ? 'last observed' : 'recorded';
  return `${event.label} · ${qualifier} ${formatDay(event.at)}`;
}

export function formatCount(shown: number, total: number, noun: string): string {
  const suffix = /(?:s|x|z|ch|sh)$/.test(noun) ? 'es' : 's';
  const plural = total === 1 ? noun : `${noun}${suffix}`;
  if (shown >= total) return `${total} ${plural}`;
  return `${shown} of ${total} ${plural}`;
}
