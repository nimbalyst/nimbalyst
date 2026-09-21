import { distance, intersects, type Arrangement, type Point } from './geometry';
export function segments(points: Point[]) {
  return points.slice(1).map((b, i) => [points[i], b] as const);
}
export function segmentConflict(a: Point, b: Point, c: Point, d: Point) {
  const horizontal = a.y === b.y,
    otherHorizontal = c.y === d.y;
  if (horizontal === otherHorizontal) {
    if (horizontal ? a.y !== c.y : a.x !== c.x)
      return { crossing: 0, overlap: 0 };
    const axis = horizontal ? 'x' : 'y';
    return {
      crossing: 0,
      overlap: Math.max(
        0,
        Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) -
          Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]))
      ),
    };
  }
  const [h1, h2, v1, v2] = horizontal ? [a, b, c, d] : [c, d, a, b];
  return {
    overlap: 0,
    crossing: Number(
      v1.x > Math.min(h1.x, h2.x) &&
        v1.x < Math.max(h1.x, h2.x) &&
        h1.y > Math.min(v1.y, v2.y) &&
        h1.y < Math.max(v1.y, v2.y)
    ),
  };
}
export function measureArrangement(
  { nodes, routes }: Arrangement,
  viewport: { width: number; height: number }
) {
  let overlaps = 0,
    obstacleHits = 0,
    crossings = 0,
    sharedLength = 0,
    length = 0,
    bends = 0;
  nodes.forEach((a, i) =>
    nodes.slice(i + 1).forEach((b) => {
      if (
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y
      )
        overlaps++;
    })
  );
  const lines = routes.map((r) => segments(r.points));
  routes.forEach((r, i) => {
    bends += Math.max(0, r.points.length - 2);
    for (const [a, b] of lines[i]) {
      length += distance(a, b);
      obstacleHits += nodes.filter(
        (n) =>
          n.id !== r.source.nodeId &&
          n.id !== r.target.nodeId &&
          intersects(a, b, n, 0)
      ).length;
      for (let j = i + 1; j < routes.length; j++)
        for (const [c, d] of lines[j]) {
          const conflict = segmentConflict(a, b, c, d);
          crossings += conflict.crossing;
          sharedLength += conflict.overlap;
        }
    }
  });
  const points = [
    ...nodes.flatMap((n) => [
      { x: n.x, y: n.y },
      { x: n.x + n.width, y: n.y + n.height },
    ]),
    ...routes.flatMap((r) => r.points),
  ];
  const width = points.length
    ? Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x))
    : 0;
  const height = points.length
    ? Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y))
    : 0;
  const fitZoom = Math.min(
    1,
    viewport.width / (width + 100),
    viewport.height / (height + 100)
  );
  return {
    overlaps,
    obstacleHits,
    crossings,
    sharedLength,
    length,
    bends,
    width,
    height,
    fitZoom,
  };
}
