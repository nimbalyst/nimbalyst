export interface CanvasGeometryNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  locked?: boolean;
}
export interface CanvasGeometryPatch {
  id: string;
  x: number;
  y: number;
}
export type CanvasAlignment =
  | "left"
  | "center-x"
  | "right"
  | "top"
  | "center-y"
  | "bottom";

function patches(
  nodes: readonly CanvasGeometryNode[],
  position: (
    node: CanvasGeometryNode,
    index: number
  ) => { x: number; y: number }
): CanvasGeometryPatch[] {
  return nodes.flatMap((node, index) => {
    const next = position(node, index);
    const x = Math.round(next.x),
      y = Math.round(next.y);
    return x === node.x && y === node.y ? [] : [{ id: node.id, x, y }];
  });
}
export function alignNodes(
  nodes: readonly CanvasGeometryNode[],
  edge: CanvasAlignment
): CanvasGeometryPatch[] {
  const movable = nodes.filter((node) => !node.locked);
  if (movable.length < 2) return [];
  // Locked cards are outside the arrangement, so their bounds cannot pull movable cards away.
  const left = Math.min(...movable.map((n) => n.x)),
    top = Math.min(...movable.map((n) => n.y));
  const right = Math.max(...movable.map((n) => n.x + n.width)),
    bottom = Math.max(...movable.map((n) => n.y + n.height));
  return patches(movable, (node) => ({
    x:
      edge === "left"
        ? left
        : edge === "right"
        ? right - node.width
        : edge === "center-x"
        ? (left + right - node.width) / 2
        : node.x,
    y:
      edge === "top"
        ? top
        : edge === "bottom"
        ? bottom - node.height
        : edge === "center-y"
        ? (top + bottom - node.height) / 2
        : node.y,
  }));
}
export function distributeNodes(
  nodes: readonly CanvasGeometryNode[],
  axis: "x" | "y"
): CanvasGeometryPatch[] {
  const movable = nodes
    .filter((node) => !node.locked)
    .sort((a, b) => a[axis] - b[axis]);
  if (movable.length < 3) return [];
  const size = axis === "x" ? "width" : "height";
  const start = movable[0][axis];
  const end = Math.max(...movable.map((node) => node[axis] + node[size]));
  const gap =
    (end - start - movable.reduce((sum, node) => sum + node[size], 0)) /
    (movable.length - 1);
  let cursor = start;
  return patches(movable, (node) => {
    const position = { x: node.x, y: node.y, [axis]: cursor };
    cursor += node[size] + gap;
    return position;
  });
}
export function tidyNodes(
  nodes: readonly CanvasGeometryNode[],
  gutter = 28
): CanvasGeometryPatch[] {
  const movable = nodes.filter((node) => !node.locked).sort((a, b) => a.y - b.y || a.x - b.x);
  if (movable.length < 2) return [];
  const columns = Math.ceil(Math.sqrt(movable.length));
  const left = Math.min(...movable.map((n) => n.x)),
    top = Math.min(...movable.map((n) => n.y));
  const width = Math.max(...movable.map((n) => n.width)) + gutter,
    height = Math.max(...movable.map((n) => n.height)) + gutter;
  return patches(movable, (_node, index) => ({
    x: left + (index % columns) * width,
    y: top + Math.floor(index / columns) * height,
  }));
}
export function nudgeNodes(
  nodes: readonly CanvasGeometryNode[],
  dx: number,
  dy: number
): CanvasGeometryPatch[] {
  return patches(
    nodes.filter((node) => !node.locked),
    (node) => ({ x: node.x + dx, y: node.y + dy })
  );
}
