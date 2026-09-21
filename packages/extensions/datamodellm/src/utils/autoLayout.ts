import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Entity, EntityViewMode, Relationship } from '../types';
import {
  buildGeometry,
  labelPosition,
  simplify,
  type Arrangement,
  type Direction,
  type Size,
} from '../layout/geometry';
import { measureArrangement } from '../layout/metrics';
const elk = new ELK();
const elkSide = { left: 'WEST', right: 'EAST', top: 'NORTH', bottom: 'SOUTH' };

export async function autoLayoutEntitiesAsync(
  entities: Entity[],
  relationships: Relationship[],
  viewMode: EntityViewMode,
  sizes: Map<string, Size>,
  direction: Direction,
  viewport: { width: number; height: number }
): Promise<Arrangement> {
  const candidates: Arrangement[] = [];
  for (const orientation of direction === 'automatic'
    ? (['horizontal', 'vertical'] as const)
    : [direction]) {
    for (const layering of ['NETWORK_SIMPLEX', 'COFFMAN_GRAHAM']) {
      const geometry = buildGeometry(
        entities,
        relationships,
        sizes,
        viewMode,
        orientation
      );
      const graph: ElkNode = {
        id: 'root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': orientation === 'horizontal' ? 'RIGHT' : 'DOWN',
          'elk.edgeRouting': 'ORTHOGONAL',
          'elk.randomSeed': '1',
          'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
          'elk.layered.layering.strategy': layering,
          'elk.layered.layering.coffmanGraham.layerBound': '3',
          'elk.spacing.nodeNode': '80',
          'elk.layered.spacing.nodeNodeBetweenLayers': '100',
          'elk.layered.spacing.edgeNodeBetweenLayers': '30',
          'elk.spacing.edgeNode': '30',
          'elk.spacing.nodeSelfLoop': '40',
          'elk.spacing.edgeEdge': '16',
          'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
          'elk.padding': '[top=50,left=50,bottom=50,right=50]',
          'elk.layered.mergeEdges': 'false',
        },
        children: geometry.nodes.map((n) => ({
          id: n.id,
          width: n.width,
          height: n.height,
          layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
          ports: geometry.connections
            .flatMap((c) => [c.source, c.target])
            .filter((p) => p.nodeId === n.id)
            .map((p) => ({
              id: p.id,
              x: p.x,
              y: p.y,
              width: 0,
              height: 0,
              layoutOptions: { 'elk.port.side': elkSide[p.side] },
            })),
        })),
        edges: geometry.connections.map((c) => ({
          id: c.id,
          sources: [c.source.id],
          targets: [c.target.id],
          ...(c.label
            ? { labels: [{ text: c.label, width: 120, height: 24 }] }
            : {}),
        })),
      };
      const result = await elk.layout(graph);
      const nodes = geometry.nodes.map((n) => {
        const positioned = result.children?.find((c) => c.id === n.id);
        if (positioned?.x === undefined || positioned.y === undefined)
          throw new Error('Layout did not return entity positions.');
        return { ...n, x: positioned.x, y: positioned.y };
      });
      const routes = geometry.connections.map((c) => {
        const edge = result.edges?.find((e) => e.id === c.id),
          section = edge?.sections?.[0];
        if (!section || edge?.sections?.length !== 1)
          throw new Error(
            'Layout did not return a complete relationship route.'
          );
        const points = simplify([
          section.startPoint,
          ...(section.bendPoints ?? []),
          section.endPoint,
        ]);
        const label = edge.labels?.[0];
        return {
          ...c,
          points,
          labelPosition:
            label?.x !== undefined && label.y !== undefined
              ? { x: label.x + 60, y: label.y + 12 }
              : labelPosition(points),
        };
      });
      const candidate = { nodes, routes };
      const metrics = measureArrangement(candidate, viewport);
      if (!metrics.overlaps && !metrics.obstacleHits)
        candidates.push(candidate);
    }
  }
  if (!candidates.length)
    throw new Error(
      'Could not find a layout without overlapping cards or relationships.'
    );
  const scored = candidates.map((candidate) => ({
    candidate,
    metrics: measureArrangement(candidate, viewport),
  }));
  const leastShared = Math.min(...scored.map((s) => s.metrics.sharedLength));
  const distinct = scored.filter((s) => s.metrics.sharedLength === leastShared);
  const leastCrossings = Math.min(...distinct.map((s) => s.metrics.crossings));
  // A single extra crossing must not halve the reading scale. Allow at most two
  // extra crossings, then prefer the arrangement that fits at the largest scale.
  return distinct
    .filter((s) => s.metrics.crossings <= leastCrossings + 2)
    .sort(
      (a, b) =>
        b.metrics.fitZoom - a.metrics.fitZoom ||
        a.metrics.crossings - b.metrics.crossings ||
        a.metrics.length - b.metrics.length ||
        a.metrics.bends - b.metrics.bends
    )[0].candidate;
}
