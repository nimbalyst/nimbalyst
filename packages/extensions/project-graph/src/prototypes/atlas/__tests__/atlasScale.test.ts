import { describe, expect, it } from 'vitest';
import {
  areaActivityInRange,
  areaConnections,
  areaStandings,
  buildAreaIndex,
  layoutTerritories,
} from '../atlasModel';
import { area, edge, event, model, node } from './atlasFixture';

/**
 * The screenshot that motivated this view had ~3,055 records and ~3,802 edges.
 * The Atlas's whole claim is that it stays readable there, which means the work
 * per interaction must scale with the *selected* area and the map must never
 * render more than one tile per area.
 */
function bigModel(nodeCount = 3000, edgeCount = 4000, areaCount = 14) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => node(`n${i}`, { label: `Record ${i}` }));
  const edges = Array.from({ length: edgeCount }, (_, i) =>
    edge(`e${i}`, `n${i % nodeCount}`, `n${(i * 7 + 13) % nodeCount}`, 'references'),
  );
  const areas = Array.from({ length: areaCount }, (_, a) =>
    area(
      `area${a}`,
      `Area ${a}`,
      nodes.filter((_, i) => i % areaCount === a).map((n) => n.id),
    ),
  );
  // Cross-cutting records: every 250th node is also filed in Area 0.
  areas[0].nodeIds = [
    ...new Set([...areas[0].nodeIds, ...nodes.filter((_, i) => i % 250 === 0).map((n) => n.id)]),
  ];
  const events = nodes.slice(0, 1200).map((n, i) =>
    event(`ev${i}`, n.id, i % 2 === 0 ? 150 : 900, {
      provenance: i % 5 === 0 ? 'last-observed' : 'recorded',
      kind: i % 5 === 0 ? 'last-activity' : 'commit',
    }),
  );
  return model({ nodes, edges, areas, events });
}

describe('atlas at snapshot scale', () => {
  const m = bigModel();
  const index = buildAreaIndex(m);

  it('draws one tile per area, not one per record', () => {
    const layout = layoutTerritories(index.order, 1400);

    expect(index.order).toHaveLength(14);
    expect(layout.boxes).toHaveLength(14);
    expect(m.nodeById.size).toBe(3000);
  });

  it('keeps per-area connections to at most one entry per family per other area', () => {
    const { connections } = areaConnections(m, index, 'area0', { evidenceCap: 10 });

    const keys = connections.map((c) => `${c.family}:${c.otherAreaId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(connections.length).toBeLessThanOrEqual(index.order.length * 2);

    for (const connection of connections) {
      expect(connection.evidence.length).toBeLessThanOrEqual(10);
      expect(connection.evidence.length).toBeLessThanOrEqual(connection.count);
      expect(connection.count).toBeGreaterThan(0);
    }
    // The true total survives the cap, so the panel can say "10 of 44".
    expect(connections.some((c) => c.evidence.length < c.count)).toBe(true);
  });

  it('scopes the overlay to the range and never counts an event outside it', () => {
    const activity = areaActivityInRange(m, index, { startMs: 100, endMs: 200 });

    expect(activity.totalEvents).toBe(600);
    let summed = 0;
    for (const a of activity.byArea.values()) summed += a.events;
    // Cross-filed records are counted in each of their areas, so the per-area
    // sum legitimately exceeds the event total. This is why the footer says
    // area counts are not additive.
    expect(summed).toBeGreaterThanOrEqual(activity.totalEvents);
    for (const a of activity.byArea.values()) {
      expect(a.touched).toBeLessThanOrEqual(a.members);
      expect(a.share).toBeGreaterThanOrEqual(0);
      expect(a.share).toBeLessThanOrEqual(1);
    }
  });

  it('reports all-time standings independently of the selected range', () => {
    const standings = areaStandings(m, index);
    let total = 0;
    for (const s of standings.values()) total += s.resolved;

    expect(total).toBeGreaterThanOrEqual(3000);
    expect(standings.get('area0')!.resolved).toBe(index.nodeSetByArea.get('area0')!.size);
  });
});
