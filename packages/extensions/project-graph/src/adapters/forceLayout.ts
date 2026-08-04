import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import type { GraphNodeTypeSchema, ProjectGraphEdge, ProjectGraphNode } from '../types';
import { applyDeterministicLayout, type LayoutClusterInfo, type LayoutResult } from './layout';

/**
 * Hybrid "Map" layout.
 *
 * The project graph is sparse and lopsided: a connected core (modules, the
 * commits and sessions that touched them, the docs/plans that belong to them)
 * plus a large tail of nodes with no edges at all (inline bugs/decisions,
 * chat-only sessions, content items). A single force layout would fling the
 * unconnected tail into a meaningless halo, and a single grid hides the real
 * structure of the core. So we do both:
 *
 *   - the CONNECTED subgraph gets a ForceAtlas2 layout (seeded deterministically
 *     from the grid so positions are stable across reloads — no random jitter),
 *     which pulls each module's commits/sessions/docs into a readable cluster;
 *   - the ISOLATED nodes are parked in tidy per-type grids in a panel beneath the
 *     map, so they stay scannable without polluting the force field.
 */

const FA2_ITERATIONS = 320;
const ISOLATED_GAP_Y = 320;

export function applyHybridLayout(
  nodes: ProjectGraphNode[],
  edges: ProjectGraphEdge[],
  typeSchemas: GraphNodeTypeSchema[] = [],
): LayoutResult {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.sourceId, (degree.get(e.sourceId) ?? 0) + 1);
    degree.set(e.targetId, (degree.get(e.targetId) ?? 0) + 1);
  }
  const connected = nodes.filter(n => degree.has(n.id));
  const isolated = nodes.filter(n => !degree.has(n.id));

  // Nothing connected -> fall back to the plain grid over everything.
  if (connected.length < 2) {
    return applyDeterministicLayout(nodes, typeSchemas);
  }

  // Seed positions from the deterministic grid so FA2 starts spread out and
  // converges to the same result every load (FA2 is deterministic given a fixed
  // seed + iteration count; it only randomizes when started from a single point).
  const seed = applyDeterministicLayout(connected, typeSchemas);
  const seedPos = new Map(seed.nodes.map(n => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));

  const g = new Graph({ type: 'undirected' });
  for (const n of connected) {
    const p = seedPos.get(n.id)!;
    // Size by degree so hubs (a heavily-touched module) repel harder and their
    // satellites fan out instead of stacking.
    const size = 3 + Math.sqrt(degree.get(n.id) ?? 1) * 2;
    g.addNode(n.id, { x: p.x, y: p.y, size });
  }
  for (const e of edges) {
    if (!g.hasNode(e.sourceId) || !g.hasNode(e.targetId)) continue;
    if (e.sourceId === e.targetId) continue;
    if (!g.hasEdge(e.sourceId, e.targetId)) g.addEdge(e.sourceId, e.targetId, { weight: e.strength ?? 1 });
  }

  const settings = forceAtlas2.inferSettings(g);
  forceAtlas2.assign(g, {
    iterations: FA2_ITERATIONS,
    settings: { ...settings, adjustSizes: true, gravity: 1.2, scalingRatio: 12, barnesHutOptimize: true },
  });

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const positioned: ProjectGraphNode[] = connected.map(n => {
    const x = g.getNodeAttribute(n.id, 'x') as number;
    const y = g.getNodeAttribute(n.id, 'y') as number;
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    return { ...n, x, y, cluster: undefined };
  });
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }

  const clusters: LayoutClusterInfo[] = [];

  // Park isolated nodes in per-type grids beneath the map.
  if (isolated.length > 0) {
    const iso = applyDeterministicLayout(isolated, typeSchemas);
    const offsetX = minX - iso.bounds.minX;
    const offsetY = maxY + ISOLATED_GAP_Y - iso.bounds.minY;
    for (const n of iso.nodes) {
      const x = (n.x ?? 0) + offsetX;
      const y = (n.y ?? 0) + offsetY;
      positioned.push({ ...n, x, y });
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    for (const c of iso.clusters) {
      clusters.push({ ...c, x: c.x + offsetX, y: c.y + offsetY, headerY: c.headerY + offsetY });
    }
  }

  return { nodes: positioned, clusters, bounds: { minX, minY, maxX, maxY } };
}
