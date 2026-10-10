/**
 * Where everything on the type map goes. Pure and synchronous:
 *
 * 1. Relationships collapse to one line per pair of types (`buildPairs`).
 * 2. Each zone is laid out on a grid around its hub (`placeZone`): the most
 *    connected type takes the middle cell, and every next type takes the free
 *    cell nearest what it links to, avoiding cells a line would cross.
 * 3. Rows and columns are sized from their boxes, each box reserving the height
 *    it grows to when zoomed in, so an expanded box never covers a neighbour.
 * 4. Zones are packed into rows for the canvas's aspect ratio (`zoneRows`).
 * 5. Lines are curves between the nearest sides, bent around any box in their
 *    way; pills go where they collide with no box, reserved area or other pill.
 */
import type { TypeMapRelationship, TypeMapType, TypeMapZone } from '../ontologyLabelMap';

export const NODE_W = 176;
export const NODE_H = 52;
export const PILL_H = 20;
/** Properties a type box lists when zoomed in; the inspector has the rest. */
export const DETAIL_ROWS = 6;
export const DETAIL_ROW_H = 17;
const GAP_X = 104;
const GAP_Y = 50;
const ZONE_PAD_TOP = 40;
const ZONE_PAD = 20;
const ZONE_GAP = 28;
const MARGIN = 16;

export type PairStyle = 'used' | 'unused' | 'off-label' | 'violation';

export interface MapPair {
  id: string;
  /** Source and target of the line: the busiest relationship's direction. */
  from: string;
  to: string;
  relationships: TypeMapRelationship[];
  statements: number;
  style: PairStyle;
  /** Some relationship runs the other way too: arrowheads at both ends. */
  both: boolean;
}

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface PositionedZone extends Rect { id: string; name: string }
export interface PositionedPair { id: string; path: string }
export interface PositionedPill extends Rect { relationshipId: string; pairId: string }

export interface MapLayout {
  width: number;
  height: number;
  /** Compact boxes, as drawn at fit. */
  nodes: Map<string, Rect>;
  /** The space each box grows into when zoomed in; nothing else is placed there. */
  reserved: Map<string, Rect>;
  zones: PositionedZone[];
  pairs: PositionedPair[];
  pills: PositionedPill[];
}

export interface MapLayoutInput {
  types: readonly TypeMapType[];
  zones: readonly TypeMapZone[];
  pairs: readonly MapPair[];
  /** Width over height of the canvas the map is fitted to. */
  aspect?: number;
}

const STYLE: Record<TypeMapRelationship['status'], PairStyle> = {
  'declared-used': 'used',
  'declared-unused': 'unused',
  'off-label': 'off-label',
  'range-violation': 'violation',
};

/** Relationships that get a pill at fit: declared and used, and range violations. */
export function isMajor(relationship: TypeMapRelationship): boolean {
  return relationship.status === 'declared-used' || relationship.status === 'range-violation';
}

export function buildPairs(relationships: readonly TypeMapRelationship[]): MapPair[] {
  const byPair = new Map<string, TypeMapRelationship[]>();
  for (const relationship of relationships) {
    const key = relationship.from === relationship.to ? `${relationship.from}~self` : [relationship.from, relationship.to].sort().join('~');
    byPair.set(key, [...(byPair.get(key) ?? []), relationship]);
  }
  return [...byPair].map(([id, list]) => {
    const sorted = [...list].sort((a, b) => b.statements - a.statements || Number(isMajor(b)) - Number(isMajor(a)) || a.id.localeCompare(b.id));
    const lead = sorted[0]!;
    const styles = new Set(sorted.map((relationship) => STYLE[relationship.status]));
    return {
      id,
      from: lead.from,
      to: lead.to,
      relationships: sorted,
      statements: sorted.reduce((sum, relationship) => sum + relationship.statements, 0),
      style: styles.size === 1 ? [...styles][0]! : STYLE[lead.status],
      both: lead.from !== lead.to && sorted.some((relationship) => relationship.from === lead.to),
    };
  });
}

/**
 * Stroke width. Only declared-and-used lines and range violations grow with
 * their statements; off-label and unused lines stay hairlines whatever their count.
 */
export function pairStrokeWidth(pair: Pick<MapPair, 'statements' | 'style'>): number {
  if (pair.style === 'unused') return 1.1;
  if (pair.style === 'off-label') return 1.3;
  return pair.statements ? 1.3 + Math.log2(pair.statements + 1) * 0.9 : 1.2;
}

export function pillWidth(relationship: Pick<TypeMapRelationship, 'verb' | 'statements'>): number {
  return Math.round(18 + relationship.verb.length * 6.3 + (relationship.statements ? 10 + String(relationship.statements).length * 7 : 0));
}

/** Property rows a type box lists when zoomed in: none for a type with no pages, whose coverage is empty. */
export function detailRows(type: Pick<TypeMapType, 'properties' | 'count'>): number {
  if (!type.count) return 0;
  return Math.min(type.properties.length, DETAIL_ROWS) + (type.properties.length > DETAIL_ROWS ? 1 : 0);
}

/** A type box's height when zoomed in far enough to list its properties. */
export function expandedHeight(type: Pick<TypeMapType, 'properties' | 'count'>): number {
  const rows = detailRows(type);
  return rows ? NODE_H + 8 + rows * DETAIL_ROW_H : NODE_H;
}

// ---------------------------------------------------------------------------
// Placement inside a zone
// ---------------------------------------------------------------------------

type Cell = [col: number, row: number];

/** How strongly two types pull together: declared relationships count, then usage. */
function pairWeight(pair: MapPair): number {
  const declared = pair.relationships.some((relationship) => relationship.status === 'declared-used' || relationship.status === 'declared-unused');
  return (declared ? 2 : 1) + Math.log2(1 + pair.statements);
}

/** Does the straight segment between two cell centres pass through `cell`'s box? */
function crosses(a: Cell, b: Cell, cell: Cell): boolean {
  for (let i = 1; i < 12; i++) {
    const t = i / 12;
    const col = a[0] + (b[0] - a[0]) * t;
    const row = a[1] + (b[1] - a[1]) * t;
    if (Math.abs(col - cell[0]) < 0.38 && Math.abs(row - cell[1]) < 0.36) return true;
  }
  return false;
}

/**
 * Grid cells for a zone's types, hub in the middle. Deterministic: the same
 * vocabulary always draws the same map.
 */
export function placeZone(typeIds: readonly string[], pairs: readonly MapPair[], counts: ReadonlyMap<string, number>, looseColumns?: number): Map<string, Cell> {
  const ids = [...typeIds];
  const inside = new Set(ids);
  const links = pairs.filter((pair) => pair.from !== pair.to && inside.has(pair.from) && inside.has(pair.to));
  const weight = new Map<string, Map<string, number>>();
  for (const pair of links) {
    const w = pairWeight(pair);
    for (const [a, b] of [[pair.from, pair.to], [pair.to, pair.from]] as const) {
      if (!weight.has(a)) weight.set(a, new Map());
      weight.get(a)!.set(b, (weight.get(a)!.get(b) ?? 0) + w);
    }
  }
  const degree = (id: string) => [...(weight.get(id)?.values() ?? [])].reduce((sum, w) => sum + w, 0);
  const cells = new Map<string, Cell>();
  const taken = new Set<string>();
  const key = (cell: Cell) => `${cell[0]},${cell[1]}`;
  const byStrength = (a: string, b: string) => degree(b) - degree(a) || (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b);

  // Types with no line in the zone go in a tidy grid after the linked ones.
  const linked = ids.filter((id) => weight.has(id));
  const loose = ids.filter((id) => !weight.has(id)).sort(byStrength);
  while (cells.size < linked.length) {
    const left = linked.filter((id) => !cells.has(id));
    // Next: the type most strongly tied to what is placed; else the strongest left.
    const pull = (id: string) => [...(weight.get(id) ?? [])].reduce((sum, [other, w]) => sum + (cells.has(other) ? w : 0), 0);
    const next = [...left].sort((a, b) => pull(b) - pull(a) || byStrength(a, b))[0]!;
    if (!cells.size) {
      cells.set(next, [0, 0]);
      taken.add('0,0');
      continue;
    }
    const placed = [...cells.values()];
    const [minC, maxC] = [Math.min(...placed.map((c) => c[0])), Math.max(...placed.map((c) => c[0]))];
    const [minR, maxR] = [Math.min(...placed.map((c) => c[1])), Math.max(...placed.map((c) => c[1]))];
    const centre: Cell = [(minC + maxC) / 2, (minR + maxR) / 2];
    const neighbours = [...(weight.get(next) ?? [])].filter(([other]) => cells.has(other)).map(([other, w]) => [cells.get(other)!, w] as const);
    const existing = links.filter((pair) => cells.has(pair.from) && cells.has(pair.to)).map((pair) => [cells.get(pair.from)!, cells.get(pair.to)!] as const);
    let best: { cell: Cell; cost: number } | null = null;
    for (let row = minR - 1; row <= maxR + 1; row++) {
      for (let col = minC - 1; col <= maxC + 1; col++) {
        const cell: Cell = [col, row];
        if (taken.has(key(cell))) continue;
        let cost = 0;
        for (const [at, w] of neighbours) {
          cost += w * (Math.abs(col - at[0]) * 1.15 + Math.abs(row - at[1]));
          for (const other of placed) if (other !== at && crosses(cell, at, other)) cost += 6 * w;
        }
        for (const [a, b] of existing) if (crosses(a, b, cell)) cost += 8;
        // Stay compact, and grow sideways before growing down (the canvas is wide).
        cost += 0.9 * (Math.abs(col - centre[0]) * 0.8 + Math.abs(row - centre[1]) * 1.2);
        const width = Math.max(maxC, col) - Math.min(minC, col) + 1;
        const height = Math.max(maxR, row) - Math.min(minR, row) + 1;
        if (width > 4 || height > 4) cost += 3 * (Math.max(width, height) - 4);
        if (!best || cost < best.cost - 1e-9) best = { cell, cost };
      }
    }
    cells.set(next, best!.cell);
    taken.add(key(best!.cell));
  }
  if (loose.length) {
    const placed = [...cells.values()];
    const minC = placed.length ? Math.min(...placed.map((c) => c[0])) : 0;
    const perRow = looseColumns ?? Math.max(placed.length ? Math.max(...placed.map((c) => c[0])) - minC + 1 : 0, Math.ceil(Math.sqrt(loose.length * 1.6)));
    let row = placed.length ? Math.max(...placed.map((c) => c[1])) + 1 : 0;
    // Fill free cells on the linked types' last row first, then new rows below.
    const lastRow = row - 1;
    const queue = [...loose];
    if (placed.length) {
      for (let col = minC; col < minC + perRow && queue.length; col++) {
        if (!taken.has(key([col, lastRow])) && !placed.some((c) => c[1] === lastRow && Math.abs(c[0] - col) === 0)) {
          const id = queue.shift()!;
          cells.set(id, [col, lastRow]);
          taken.add(key([col, lastRow]));
        }
      }
    }
    for (let i = 0; queue.length; i++, row += i % perRow === 0 ? 1 : 0) {
      const col = minC + (i % perRow);
      const id = queue.shift()!;
      cells.set(id, [col, row]);
      taken.add(key([col, row]));
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Zones: boxes, then packing
// ---------------------------------------------------------------------------

interface ZoneBox {
  id: string;
  name: string;
  w: number;
  h: number;
  /** Relative to the zone's top-left. */
  nodes: Map<string, Rect>;
}

function zoneBox(zone: TypeMapZone, ids: readonly string[], pairs: readonly MapPair[], byId: ReadonlyMap<string, TypeMapType>, looseColumns?: number): ZoneBox {
  const counts = new Map(ids.map((id) => [id, byId.get(id)?.count ?? 0]));
  const cells = placeZone(ids, pairs, counts, looseColumns);
  const cols = [...new Set([...cells.values()].map((cell) => cell[0]))].sort((a, b) => a - b);
  const rows = [...new Set([...cells.values()].map((cell) => cell[1]))].sort((a, b) => a - b);
  // A column only as wide as it needs to be, a row as tall as its tallest reserved box.
  const rowHeight = new Map(rows.map((row) => [row, Math.max(...ids.filter((id) => cells.get(id)![1] === row).map((id) => expandedHeight(byId.get(id)!)))]));
  const colX = new Map<number, number>();
  cols.forEach((col, i) => colX.set(col, ZONE_PAD + i * (NODE_W + GAP_X)));
  const rowY = new Map<number, number>();
  let y = ZONE_PAD_TOP;
  for (const row of rows) {
    rowY.set(row, y);
    y += rowHeight.get(row)! + GAP_Y;
  }
  const nodes = new Map<string, Rect>();
  for (const [id, [col, row]] of cells) nodes.set(id, { x: colX.get(col)!, y: rowY.get(row)!, w: NODE_W, h: NODE_H });
  const w = Math.max(ZONE_PAD * 2 + cols.length * (NODE_W + GAP_X) - GAP_X, zone.name.length * 8.4 + 40);
  return { id: zone.id, name: zone.name, w, h: y - GAP_Y + ZONE_PAD, nodes };
}

/**
 * Zone ids by row, in order, for the arrangement that fits the canvas's
 * aspect ratio at the largest zoom. Every split into rows is tried (zones
 * are few), then the fewest rows among equals.
 */
export function zoneRows(sizes: ReadonlyArray<{ id: string; w: number; h: number }>, aspect = 1.5): string[][] {
  return bestRows(sizes, aspect).rows;
}

function bestRows(sizes: ReadonlyArray<{ id: string; w: number; h: number }>, aspect: number): { rows: string[][]; scale: number } {
  const n = sizes.length;
  if (!n) return { rows: [], scale: 1 };
  let best: { rows: string[][]; scale: number } | null = null;
  const splits = n <= 10 ? 1 << (n - 1) : 1;
  for (let mask = 0; mask < splits; mask++) {
    const rows: Array<Array<{ id: string; w: number; h: number }>> = [[sizes[0]!]];
    for (let i = 1; i < n; i++) {
      if (mask & (1 << (i - 1))) rows.push([sizes[i]!]);
      else rows[rows.length - 1]!.push(sizes[i]!);
    }
    const width = Math.max(...rows.map((row) => row.reduce((sum, size) => sum + size.w, 0) + (row.length - 1) * ZONE_GAP));
    const height = rows.reduce((sum, row) => sum + Math.max(...row.map((size) => size.h)), 0) + (rows.length - 1) * ZONE_GAP;
    const scale = Math.min(aspect / width, 1 / height);
    if (!best || scale > best.scale * 1.0001 || (Math.abs(scale - best.scale) <= best.scale * 1e-4 && rows.length < best.rows.length)) {
      best = { rows: rows.map((row) => row.map((size) => size.id)), scale };
    }
  }
  return best!;
}

// ---------------------------------------------------------------------------
// Lines and pills
// ---------------------------------------------------------------------------

type Curve = [Point, Point, Point, Point];

function at(curve: Curve, t: number): Point {
  const u = 1 - t;
  const [a, b, c, d] = curve;
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
  };
}

const inside = (p: Point, r: Rect, pad: number) => p.x > r.x - pad && p.x < r.x + r.w + pad && p.y > r.y - pad && p.y < r.y + r.h + pad;
const overlapArea = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

type Side = 'left' | 'right' | 'top' | 'bottom';

/** Which sides a line leaves and enters by: sideways unless the boxes stack. */
function sidesFor(a: Rect, b: Rect): [Side, Side] {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  if (Math.abs(dx) > a.w * 0.75) return dx > 0 ? ['right', 'left'] : ['left', 'right'];
  return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

function anchor(box: Rect, side: Side, offset: number): Point {
  switch (side) {
    case 'left': return { x: box.x, y: box.y + box.h / 2 + offset };
    case 'right': return { x: box.x + box.w, y: box.y + box.h / 2 + offset };
    case 'top': return { x: box.x + box.w / 2 + offset, y: box.y };
    case 'bottom': return { x: box.x + box.w / 2 + offset, y: box.y + box.h };
  }
}

function curveFor(start: Point, startSide: Side, end: Point, endSide: Side, bend: number): Curve {
  const horizontal = startSide === 'left' || startSide === 'right';
  const reach = horizontal ? Math.max(40, Math.abs(end.x - start.x) / 2) : Math.max(30, Math.abs(end.y - start.y) / 2);
  const out = (side: Side, p: Point): Point => {
    switch (side) {
      case 'left': return { x: p.x - reach, y: p.y + bend };
      case 'right': return { x: p.x + reach, y: p.y + bend };
      case 'top': return { x: p.x + bend, y: p.y - reach };
      case 'bottom': return { x: p.x + bend, y: p.y + reach };
    }
  };
  return [start, out(startSide, start), out(endSide, end), end];
}

const curvePath = ([a, b, c, d]: Curve) => `M${a.x},${a.y} C${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`;

/** A self-link: a small loop off whichever of the box's top, right or left side no line uses. */
function loopCurve(box: Rect, side: Side): Curve {
  const right = box.x + box.w;
  switch (side) {
    case 'right': return [{ x: right, y: box.y + 12 }, { x: right + 50, y: box.y - 4 }, { x: right + 50, y: box.y + box.h + 4 }, { x: right - 1, y: box.y + box.h - 12 }];
    case 'left': return [{ x: box.x, y: box.y + 12 }, { x: box.x - 50, y: box.y - 4 }, { x: box.x - 50, y: box.y + box.h + 4 }, { x: box.x + 1, y: box.y + box.h - 12 }];
    default: return [{ x: right - 62, y: box.y }, { x: right - 72, y: box.y - 38 }, { x: right - 8, y: box.y - 38 }, { x: right - 18, y: box.y - 1 }];
  }
}

function routeLines(pairs: readonly MapPair[], nodes: ReadonlyMap<string, Rect>, reserved: ReadonlyMap<string, Rect>): Map<string, Curve> {
  // Spread lines that share a side of a box so they do not meet in one point.
  const plan = pairs.filter((pair) => pair.from !== pair.to && nodes.has(pair.from) && nodes.has(pair.to)).map((pair) => {
    const a = nodes.get(pair.from)!;
    const b = nodes.get(pair.to)!;
    const [startSide, endSide] = sidesFor(a, b);
    return { pair, a, b, startSide, endSide };
  });
  const bySide = new Map<string, Array<{ id: string; other: Point }>>();
  for (const { pair, a, b, startSide, endSide } of plan) {
    for (const [id, side, other] of [[pair.from, startSide, b], [pair.to, endSide, a]] as const) {
      const list = bySide.get(`${id}:${side}`) ?? [];
      list.push({ id: pair.id, other: { x: other.x + other.w / 2, y: other.y + other.h / 2 } });
      bySide.set(`${id}:${side}`, list);
    }
  }
  const offsetOf = (typeId: string, side: Side, pairId: string) => {
    const list = bySide.get(`${typeId}:${side}`) ?? [];
    if (list.length < 2) return 0;
    const vertical = side === 'left' || side === 'right';
    const sorted = [...list].sort((p, q) => (vertical ? p.other.y - q.other.y : p.other.x - q.other.x));
    const span = vertical ? NODE_H * 0.5 : NODE_W * 0.5;
    const i = sorted.findIndex((entry) => entry.id === pairId);
    return -span / 2 + (span * i) / (sorted.length - 1);
  };
  const out = new Map<string, Curve>();
  const obstacles = [...reserved.entries()];
  for (const { pair, a, b, startSide, endSide } of plan) {
    const start = anchor(a, startSide, offsetOf(pair.from, startSide, pair.id));
    const end = anchor(b, endSide, offsetOf(pair.to, endSide, pair.id));
    const blocked = (curve: Curve) => obstacles.some(([id, box]) => id !== pair.from && id !== pair.to && [...Array(24).keys()].some((i) => inside(at(curve, (i + 0.5) / 24), box, 8)));
    let chosen = curveFor(start, startSide, end, endSide, 0);
    for (const bend of [60, -60, 120, -120, 180, -180, 260, -260]) {
      if (!blocked(chosen)) break;
      chosen = curveFor(start, startSide, end, endSide, bend);
    }
    if (blocked(chosen)) chosen = curveFor(start, startSide, end, endSide, 0);
    out.set(pair.id, chosen);
  }
  for (const pair of pairs) {
    const box = nodes.get(pair.from);
    if (pair.from !== pair.to || !box) continue;
    const side = (['top', 'right', 'left'] as const).find((candidate) => !bySide.has(`${pair.from}:${candidate}`)) ?? 'top';
    out.set(pair.id, loopCurve(box, side));
  }
  return out;
}

/** Where a pill may go, best first: along its line, or around a self-link's loop. */
function pillCandidates(curve: Curve, w: number, self: boolean, i: number, box: Rect | undefined, reservedBottom: number): Rect[] {
  if (self && box) {
    const right = box.x + box.w;
    const stack = i * (PILL_H + 4);
    const top = Math.min(...curve.map((point) => point.y));
    return [
      { x: right - w / 2 - 40, y: top - PILL_H - 2 - stack, w, h: PILL_H },
      { x: right - w - 80, y: box.y - PILL_H - 10 - stack, w, h: PILL_H },
      { x: right + 56, y: box.y + box.h / 2 - PILL_H / 2 + stack, w, h: PILL_H },
      { x: box.x - w - 56, y: box.y + box.h / 2 - PILL_H / 2 + stack, w, h: PILL_H },
      { x: right - w + 10, y: reservedBottom + 8 + stack, w, h: PILL_H },
    ];
  }
  const out: Rect[] = [];
  for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]) {
    const p = at(curve, t);
    for (const shift of [0, 24, -24, 48, -48, 72, -72]) out.push({ x: p.x - w / 2, y: p.y - PILL_H / 2 + shift, w, h: PILL_H });
  }
  return out;
}

function placePills(pairs: readonly MapPair[], curves: ReadonlyMap<string, Curve>, nodes: ReadonlyMap<string, Rect>, reserved: ReadonlyMap<string, Rect>, obstacles: readonly Rect[]): PositionedPill[] {
  const pills: PositionedPill[] = [];
  const order = pairs.flatMap((pair) => pair.relationships.map((relationship, i) => ({ pair, relationship, i })))
    .sort((a, b) => Number(isMajor(b.relationship)) - Number(isMajor(a.relationship)) || b.relationship.statements - a.relationship.statements || a.relationship.id.localeCompare(b.relationship.id));
  for (const { pair, relationship, i } of order) {
    const curve = curves.get(pair.id);
    if (!curve) continue;
    const box = nodes.get(pair.from);
    const reservedBox = reserved.get(pair.from);
    const candidates = pillCandidates(curve, pillWidth(relationship), pair.from === pair.to, i, box, reservedBox ? reservedBox.y + reservedBox.h : 0);
    let best: { rect: Rect; clash: number } | null = null;
    for (const rect of candidates) {
      const clash = obstacles.reduce((sum, obstacle) => sum + overlapArea(rect, { x: obstacle.x - 4, y: obstacle.y - 4, w: obstacle.w + 8, h: obstacle.h + 8 }), 0)
        + pills.reduce((sum, pill) => sum + overlapArea(rect, { x: pill.x - 4, y: pill.y - 3, w: pill.w + 8, h: pill.h + 6 }), 0);
      if (!best || clash < best.clash) best = { rect, clash };
      if (clash === 0) break;
    }
    pills.push({ ...best!.rect, relationshipId: relationship.id, pairId: pair.id });
  }
  return pills;
}

// ---------------------------------------------------------------------------
// The whole map
// ---------------------------------------------------------------------------

export function layoutTypeMap(input: MapLayoutInput): MapLayout {
  const byId = new Map(input.types.map((type) => [type.id, type]));
  const aspect = input.aspect ?? 1.5;
  // A zone whose types have no lines between them can be any number of columns wide;
  // try each and keep the combination that fits the canvas largest.
  const variants = input.zones
    .map((zone) => ({ zone, ids: zone.typeIds.filter((id) => byId.has(id)) }))
    .filter(({ ids }) => ids.length > 0)
    .map(({ zone, ids }) => {
      const unlinked = !input.pairs.some((pair) => pair.from !== pair.to && ids.includes(pair.from) && ids.includes(pair.to));
      const columns = unlinked ? [...Array(Math.min(ids.length, 4)).keys()].map((i) => i + 1) : [undefined];
      return columns.map((looseColumns) => zoneBox(zone, ids, input.pairs, byId, looseColumns));
    });
  let boxes: ZoneBox[] = variants.map((options) => options[0]!);
  let rows = bestRows(boxes, aspect);
  const combos = variants.reduce((product, options) => product * options.length, 1);
  if (combos > 1 && combos <= 256) {
    for (let index = 0; index < combos; index++) {
      let rest = index;
      const pick = variants.map((options) => {
        const choice = options[rest % options.length]!;
        rest = Math.floor(rest / options.length);
        return choice;
      });
      const candidate = bestRows(pick, aspect);
      if (candidate.scale > rows.scale * 1.0001) {
        boxes = pick;
        rows = candidate;
      }
    }
  }
  const byZone = new Map(boxes.map((box) => [box.id, box]));
  const nodes = new Map<string, Rect>();
  const reserved = new Map<string, Rect>();
  const zones: PositionedZone[] = [];
  let y = MARGIN;
  let width = 0;
  for (const row of rows.rows) {
    let x = MARGIN;
    const height = Math.max(...row.map((id) => byZone.get(id)!.h));
    for (const id of row) {
      const box = byZone.get(id)!;
      zones.push({ id, name: box.name, x, y, w: box.w, h: box.h });
      for (const [typeId, rect] of box.nodes) {
        nodes.set(typeId, { ...rect, x: rect.x + x, y: rect.y + y });
        reserved.set(typeId, { x: rect.x + x, y: rect.y + y, w: rect.w, h: expandedHeight(byId.get(typeId)!) });
      }
      x += box.w + ZONE_GAP;
    }
    width = Math.max(width, x - ZONE_GAP + MARGIN);
    y += height + ZONE_GAP;
  }
  const visible = input.pairs.filter((pair) => nodes.has(pair.from) && nodes.has(pair.to));
  const curves = routeLines(visible, nodes, reserved);
  const titles = zones.map((zone) => ({ x: zone.x, y: zone.y, w: Math.min(zone.w, zone.name.length * 8.4 + 30), h: ZONE_PAD_TOP - 8 }));
  const pills = placePills(visible, curves, nodes, reserved, [...reserved.values(), ...titles]);
  return {
    width,
    height: y - ZONE_GAP + MARGIN,
    nodes,
    reserved,
    zones,
    pairs: visible.map((pair) => ({ id: pair.id, path: curvePath(curves.get(pair.id)!) })),
    pills,
  };
}

