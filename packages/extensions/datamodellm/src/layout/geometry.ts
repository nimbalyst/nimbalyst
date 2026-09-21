import type { Entity, EntityViewMode, Relationship } from '../types';

export interface Point {
  x: number;
  y: number;
}
export type Side = 'left' | 'right' | 'top' | 'bottom';
export type Direction = 'automatic' | 'horizontal' | 'vertical';
export interface Size {
  width: number;
  height: number;
  fields: Record<string, number>;
}
export interface LayoutNode extends Point, Size {
  id: string;
  name: string;
}
export interface Port extends Point {
  nodeId: string;
  side: Side;
  id: string;
}
export interface Connection {
  id: string;
  source: Port;
  target: Port;
  label?: string;
}
export interface Route extends Connection {
  points: Point[];
  labelPosition: Point;
}
export interface Geometry {
  nodes: LayoutNode[];
  connections: Connection[];
}
export interface Arrangement {
  nodes: LayoutNode[];
  routes: Route[];
}
export const CLEARANCE = 16;
export const STUB = 30;
const sides: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};
export const outward = (p: Port, distance = STUB): Point => ({
  x: p.x + sides[p.side].x * distance,
  y: p.y + sides[p.side].y * distance,
});
export const distance = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const absolutePort = (p: Port, nodes: LayoutNode[]): Port => {
  const node = nodes.find((n) => n.id === p.nodeId)!;
  return { ...p, x: node.x + p.x, y: node.y + p.y };
};

/** Strict interiors permit segments along the inflated obstacle boundary. */
export function intersects(
  a: Point,
  b: Point,
  r: LayoutNode,
  padding = CLEARANCE
): boolean {
  const left = r.x - padding,
    right = r.x + r.width + padding;
  const top = r.y - padding,
    bottom = r.y + r.height + padding;
  if (a.x === b.x)
    return (
      a.x > left &&
      a.x < right &&
      Math.max(a.y, b.y) > top &&
      Math.min(a.y, b.y) < bottom
    );
  if (a.y === b.y)
    return (
      a.y > top &&
      a.y < bottom &&
      Math.max(a.x, b.x) > left &&
      Math.min(a.x, b.x) < right
    );
  return true;
}

export function simplify(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const raw of points) {
    const p = {
      x: Math.round(raw.x * 1e6) / 1e6,
      y: Math.round(raw.y * 1e6) / 1e6,
    };
    if (result.length && distance(result[result.length - 1], p) < 0.01)
      continue;
    while (result.length > 1) {
      const a = result[result.length - 2],
        b = result[result.length - 1];
      if (
        (a.x === b.x && b.x === p.x && (b.y - a.y) * (p.y - b.y) >= 0) ||
        (a.y === b.y && b.y === p.y && (b.x - a.x) * (p.x - b.x) >= 0)
      )
        result.pop();
      else break;
    }
    result.push(p);
  }
  return result;
}
export function labelPosition(points: Point[]): Point {
  let longest = -1,
    center = points[0];
  for (let i = 1; i < points.length; i++) {
    const length = distance(points[i - 1], points[i]);
    if (length > longest) {
      longest = length;
      center = {
        x: (points[i - 1].x + points[i].x) / 2,
        y: (points[i - 1].y + points[i].y) / 2,
      };
    }
  }
  return center;
}

/** Stable semantic ordering survives parser-generated runtime IDs. Ports are node-relative. */
export function buildGeometry(
  entities: Entity[],
  relationships: Relationship[],
  sizes: Map<string, Size>,
  mode: EntityViewMode,
  direction?: Exclude<Direction, 'automatic'>
): Geometry {
  const nodes = [...entities]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const size = sizes.get(e.id);
      if (!size || size.width <= 0 || size.height <= 0)
        throw new Error(
          'Open the diagram and wait for its cards to finish measuring.'
        );
      return { id: e.id, name: e.name, ...e.position, ...size };
    });
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const key = (r: Relationship) =>
    [
      r.sourceEntityName,
      r.sourceFieldName,
      r.targetEntityName,
      r.targetFieldName,
      r.name,
      r.type,
    ].join(':');
  const sorted = [...relationships].sort((a, b) =>
    key(a).localeCompare(key(b))
  );
  const connections: Connection[] = sorted.map((r, index) => {
    const source = byName.get(r.sourceEntityName),
      target = byName.get(r.targetEntityName);
    if (!source || !target)
      throw new Error('A relationship refers to a missing entity.');
    const fieldPorts =
      mode !== 'compact' &&
      r.sourceFieldName &&
      r.targetFieldName &&
      source.fields[r.sourceFieldName] !== undefined &&
      target.fields[r.targetFieldName] !== undefined;
    const dx = target.x + target.width / 2 - source.x - source.width / 2;
    const dy = target.y + target.height / 2 - source.y - source.height / 2;
    const vertical =
      !fieldPorts &&
      (direction ? direction === 'vertical' : Math.abs(dy) > Math.abs(dx));
    const forward = direction !== undefined || (vertical ? dy >= 0 : dx >= 0);
    const sourceSide: Side = vertical
      ? forward
        ? 'bottom'
        : 'top'
      : forward
      ? 'right'
      : 'left';
    const targetSide: Side = vertical
      ? forward
        ? 'top'
        : 'bottom'
      : forward
      ? 'left'
      : 'right';
    const port = (
      node: LayoutNode,
      side: Side,
      field: string | undefined,
      role: string
    ): Port => ({
      id: `${index}-${role}`,
      nodeId: node.id,
      side,
      x: side === 'right' ? node.width : side === 'left' ? 0 : node.width / 2,
      y:
        side === 'bottom'
          ? node.height
          : side === 'top'
          ? 0
          : fieldPorts && field
          ? node.fields[field]
          : node.height / 2,
    });
    return {
      id: r.id,
      source: port(source, sourceSide, r.sourceFieldName, 'source'),
      target: port(target, targetSide, r.targetFieldName, 'target'),
      label: r.name,
    };
  });
  // Separate entity-level attachments. Field endpoints remain centered on the exact row.
  for (const node of nodes)
    for (const side of Object.keys(sides) as Side[]) {
      const ports = connections
        .flatMap((c) => [c.source, c.target])
        .filter((p) => p.nodeId === node.id && p.side === side);
      const free = ports.filter((p) => {
        const c = connections.find((c) => c.source === p || c.target === p)!;
        const r = relationships.find((r) => r.id === c.id)!;
        const a = byName.get(r.sourceEntityName)!,
          b = byName.get(r.targetEntityName)!;
        return !(
          mode !== 'compact' &&
          r.sourceFieldName &&
          r.targetFieldName &&
          a.fields[r.sourceFieldName] !== undefined &&
          b.fields[r.targetFieldName] !== undefined
        );
      });
      free.forEach((p, i) => {
        if (side === 'top' || side === 'bottom')
          p.x = (node.width * (i + 1)) / (free.length + 1);
        else p.y = (node.height * (i + 1)) / (free.length + 1);
      });
    }
  // Network-simplex placement quantizes port coordinates to pixels. Quantize its
  // inputs too, so self-loop bend points and endpoints use the same coordinates.
  for (const connection of connections)
    for (const port of [connection.source, connection.target]) {
      port.x = Math.round(port.x);
      port.y = Math.round(port.y);
    }
  return { nodes, connections };
}
