import {
  absolutePort,
  CLEARANCE,
  distance,
  intersects,
  labelPosition,
  outward,
  simplify,
  type Geometry,
  type Point,
  type Route,
} from './geometry';
import { segmentConflict, segments } from './metrics';

/** A* over obstacle boundary coordinates; the direction is part of each search state. */
export function routeConnections({ nodes, connections }: Geometry): Route[] {
  const routes: Route[] = [];
  for (const connection of connections) {
    const source = absolutePort(connection.source, nodes),
      target = absolutePort(connection.target, nodes);
    const start = outward(source),
      end = outward(target);
    const xs = new Set([start.x, end.x]),
      ys = new Set([start.y, end.y]);
    for (const n of nodes) {
      xs.add(n.x - CLEARANCE);
      xs.add(n.x + n.width + CLEARANCE);
      ys.add(n.y - CLEARANCE);
      ys.add(n.y + n.height + CLEARANCE);
    }
    // Extra lanes let unrelated edges avoid coincident runs on obstacle boundaries.
    for (const r of routes)
      for (const p of r.points) {
        xs.add(p.x - 8);
        xs.add(p.x + 8);
        ys.add(p.y - 8);
        ys.add(p.y + 8);
      }
    const x = [...xs].sort((a, b) => a - b),
      y = [...ys].sort((a, b) => a - b);
    if (x.length * y.length > 200000)
      throw new Error(
        'This diagram is too dense to route. Try auto-layout or Compact view.'
      );
    const nx = x.length;
    const index = (p: Point) => y.indexOf(p.y) * nx + x.indexOf(p.x);
    const point = (i: number): Point => ({
      x: x[i % nx],
      y: y[Math.floor(i / nx)],
    });
    const startIndex = index(start),
      endIndex = index(end);
    const blocked = (a: Point, b: Point) =>
      nodes.some((n) => intersects(a, b, n));
    if (
      nodes.some(
        (n) => n.id !== source.nodeId && intersects(source, start, n, 0)
      ) ||
      nodes.some((n) => n.id !== target.nodeId && intersects(end, target, n, 0))
    )
      throw new Error(
        'Overlapping cards prevent relationship routing. Run Auto-layout or move the cards apart.'
      );
    const costs = new Map<number, number>(),
      parents = new Map<number, number>();
    const heap: { state: number; cost: number; score: number }[] = [];
    const push = (item: (typeof heap)[number]) => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p].score <= item.score) break;
        heap[i] = heap[p];
        i = p;
      }
      heap[i] = item;
    };
    const pop = () => {
      const top = heap[0],
        last = heap.pop()!;
      if (heap.length) {
        let i = 0;
        while (i * 2 + 1 < heap.length) {
          let c = i * 2 + 1;
          if (c + 1 < heap.length && heap[c + 1].score < heap[c].score) c++;
          if (last.score <= heap[c].score) break;
          heap[i] = heap[c];
          i = c;
        }
        heap[i] = last;
      }
      return top;
    };
    const initial =
      startIndex * 2 +
      Number(source.side === 'top' || source.side === 'bottom');
    costs.set(initial, 0);
    push({ state: initial, cost: 0, score: distance(start, end) });
    let found: number | undefined;
    const occupied = routes.flatMap((r) => segments(r.points));
    while (heap.length) {
      const current = pop();
      if (current.cost !== costs.get(current.state)) continue;
      const cell = Math.floor(current.state / 2),
        axis = current.state % 2;
      if (cell === endIndex) {
        found = current.state;
        break;
      }
      const a = point(cell),
        xi = cell % nx,
        yi = Math.floor(cell / nx);
      const neighbors = [
        ...(xi > 0 ? [cell - 1] : []),
        ...(xi + 1 < nx ? [cell + 1] : []),
        ...(yi > 0 ? [cell - nx] : []),
        ...(yi + 1 < y.length ? [cell + nx] : []),
      ];
      for (const next of neighbors) {
        const b = point(next);
        if (blocked(a, b)) continue;
        const nextAxis = Number(a.x === b.x),
          state = next * 2 + nextAxis;
        let cost = current.cost + distance(a, b) + (axis !== nextAxis ? 24 : 0);
        for (const [c, d] of occupied) {
          const conflict = segmentConflict(a, b, c, d);
          cost += conflict.crossing * 80 + conflict.overlap * 2;
        }
        if (cost >= (costs.get(state) ?? Infinity)) continue;
        costs.set(state, cost);
        parents.set(state, current.state);
        push({ state, cost, score: cost + distance(b, end) });
      }
    }
    if (found === undefined)
      throw new Error(
        'Overlapping cards prevent relationship routing. Run Auto-layout or move the cards apart.'
      );
    const middle: Point[] = [];
    for (
      let state: number | undefined = found;
      state !== undefined;
      state = parents.get(state)
    )
      middle.push(point(Math.floor(state / 2)));
    const points = simplify([source, ...middle.reverse(), target]);
    routes.push({
      ...connection,
      points,
      labelPosition: labelPosition(points),
    });
  }
  return routes;
}
