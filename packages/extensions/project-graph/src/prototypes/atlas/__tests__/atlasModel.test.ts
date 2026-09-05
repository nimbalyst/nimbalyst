import { describe, expect, it } from 'vitest';
import {
  areaActivityInRange,
  areaConnections,
  areaStandings,
  buildAreaIndex,
  columnsForWidth,
  connectorPath,
  formatRelationSummary,
  layoutTerritories,
  moveTerritoryFocus,
} from '../atlasModel';
import { area, edge, event, model, node } from './atlasFixture';

describe('atlas area index', () => {
  it('orders territories by area identity with Unassigned last, and counts records no area claims', () => {
    const m = model({
      nodes: [node('n1'), node('n2'), node('n3'), node('n4'), node('n5'), node('orphan')],
      areas: [
        area('unassigned', 'Unassigned', ['n5'], 'no tag rule matched'),
        area('tag:zeta', 'Zeta', ['n3', 'n4']),
        area('tag:alpha', 'Alpha', ['n1', 'n2']),
        area('tag:big', 'Big', ['n1', 'n2', 'n3']),
      ],
    });

    const index = buildAreaIndex(m);

    // By id, not by size and not by the order the projection emitted them.
    expect(index.order.map((a) => a.id)).toEqual(['tag:alpha', 'tag:big', 'tag:zeta', 'unassigned']);
    expect(index.unassigned?.id).toBe('unassigned');
    expect(index.unclaimedNodeCount).toBe(1);
    expect(index.areaIdsByNode.get('n1')).toEqual(expect.arrayContaining(['tag:alpha', 'tag:big']));
  });

  it('holds geography fixed when a rename, a count change, or a reshuffled projection arrives', () => {
    const nodes = [node('n1'), node('n2'), node('n3'), node('n4')];
    const before = buildAreaIndex(
      model({
        nodes,
        areas: [
          area('tag:alpha', 'Alpha', ['n1']),
          area('tag:beta', 'Beta', ['n2', 'n3', 'n4']),
          area('unassigned', 'Unassigned', []),
        ],
      }),
    );

    // A refresh that renames Alpha to something alphabetically last, grows it
    // past Beta, and emits the areas in a different order.
    const after = buildAreaIndex(
      model({
        nodes,
        areas: [
          area('unassigned', 'Unassigned', []),
          area('tag:beta', 'Beta', ['n4']),
          area('tag:alpha', 'Zebra Territory', ['n1', 'n2', 'n3']),
        ],
      }),
    );

    expect(after.order.map((a) => a.id)).toEqual(before.order.map((a) => a.id));
    // The overlay moved even though the ground did not.
    expect(after.order[0].label).toBe('Zebra Territory');
    expect(after.order[0].nodeIds).toHaveLength(3);
  });

  it('reports records with no recorded close and the records it could not resolve', () => {
    const m = model({
      nodes: [node('a'), node('b', { closedAt: 99 }), node('c', { type: 'bug' })],
      areas: [area('one', 'One', ['a', 'b', 'c', 'ghost'])],
    });

    const standing = areaStandings(m, buildAreaIndex(m)).get('one')!;

    expect(standing.total).toBe(4);
    expect(standing.resolved).toBe(3);
    expect(standing.open).toBe(2);
    expect(standing.topTypes).toEqual([
      { type: 'task', count: 2 },
      { type: 'bug', count: 1 },
    ]);
  });
});

describe('atlas activity overlay', () => {
  it('splits recorded from last-observed, counts distinct records, and drops out-of-range events', () => {
    const m = model({
      nodes: [node('n1'), node('n2'), node('loose')],
      areas: [area('a', 'A', ['n1', 'n2']), area('b', 'B', ['n2'])],
      events: [
        event('e1', 'n1', 100),
        event('e2', 'n1', 120),
        event('e3', 'n2', 150, { kind: 'last-activity', provenance: 'last-observed' }),
        event('e4', 'n1', 500),
        event('e5', 'loose', 130),
      ],
    });

    const activity = areaActivityInRange(m, buildAreaIndex(m), { startMs: 50, endMs: 200 });
    const a = activity.byArea.get('a')!;
    const b = activity.byArea.get('b')!;

    expect(a.events).toBe(3);
    expect(a.recorded).toBe(2);
    expect(a.lastObserved).toBe(1);
    expect(a.touched).toBe(2);
    // A record filed in two areas is counted in both -- area totals are not additive.
    expect(b.events).toBe(1);
    expect(b.touched).toBe(1);
    expect(activity.unmappedEvents).toBe(1);
    expect(activity.totalEvents).toBe(4);
  });

  it('scales the overlay on each area\'s own membership, not on the busiest area', () => {
    // `huge` carries almost every event; under a cross-area maximum it would
    // flatten `small` to nothing even though all of `small` was active.
    const nodes = [node('s1'), ...Array.from({ length: 100 }, (_, i) => node(`h${i}`))];
    const m = model({
      nodes,
      areas: [
        area('small', 'Small', ['s1']),
        area('huge', 'Huge', nodes.slice(1).map((n) => n.id)),
      ],
      events: [
        event('e0', 's1', 100, { provenance: 'last-observed', kind: 'last-activity' }),
        ...Array.from({ length: 25 }, (_, i) => event(`h${i}`, `h${i}`, 100)),
      ],
    });

    const activity = areaActivityInRange(m, buildAreaIndex(m), { startMs: 0, endMs: 200 });
    const small = activity.byArea.get('small')!;
    const huge = activity.byArea.get('huge')!;

    expect(small).toMatchObject({ members: 1, touched: 1, share: 1, events: 1 });
    expect(huge).toMatchObject({ members: 100, touched: 25, share: 0.25 });
    // The smaller area reads as fully active even though it emitted 1 of 26 events.
    expect(small.share).toBeGreaterThan(huge.share);

    // The bar's inner split is records, not events: s1 is seen only via a
    // last-observed marker, so none of its share is recorded activity.
    expect(small).toMatchObject({ touchedRecorded: 0, touchedObservedOnly: 1 });
    expect(huge).toMatchObject({ touchedRecorded: 25, touchedObservedOnly: 0 });
  });

  it('reports zero rather than a fabricated figure when nothing happened in range', () => {
    const m = model({
      nodes: [node('n1')],
      areas: [area('a', 'A', ['n1'])],
      events: [event('e1', 'n1', 10)],
    });

    const activity = areaActivityInRange(m, buildAreaIndex(m), { startMs: 1000, endMs: 2000 });

    expect(activity.byArea.get('a')).toMatchObject({ events: 0, touched: 0, recorded: 0, share: 0 });
  });
});

describe('atlas connections', () => {
  const m = model({
    nodes: [
      node('a1', { label: 'Access rules' }),
      node('a2', { label: 'Session queue' }),
      node('b1', { label: 'Release check' }),
      node('c1', { label: 'Shared doc' }),
    ],
    edges: [
      // `worked_on_in` is a link a source record carries; `part_of` is
      // synthesized from a file path and `fixes` is a verb inferred from the
      // item being a defect. All three arrive as plain snapshot edges.
      edge('e1', 'a1', 'b1', 'worked_on_in'),
      edge('e2', 'a2', 'b1', 'references'),
      edge('e3', 'b1', 'a1', 'part_of', 'blocked on rollout'),
      edge('e5', 'a2', 'b1', 'fixes'),
      edge('e6', 'a1', 'b1', 'implements'),
      edge('e4', 'a1', 'a2', 'related_to'),
    ],
    // c1 is filed in both A and C -- co-membership, not an edge.
    areas: [area('a', 'A', ['a1', 'a2', 'c1']), area('b', 'B', ['b1']), area('c', 'C', ['c1'])],
  });

  it('never files a derived edge under the recorded family', () => {
    const { connections, internalEdges } = areaConnections(m, buildAreaIndex(m), 'a');

    expect(internalEdges).toEqual({ total: 1, byFamily: { 'unclassified-link': 1 } });

    const recorded = connections.find((c) => c.family === 'recorded-link' && c.otherAreaId === 'b')!;
    expect(recorded.relationCounts.map((r) => r.relation)).toEqual(['references', 'worked_on_in']);
    expect(recorded.count).toBe(2);
    expect(recorded.explanation).toBe('2 links recorded in source records between A and B.');

    // `part_of` is path-synthesized and `fixes` is a verb inferred from the
    // item type. Neither may sit under a header that says "recorded".
    const derived = connections.find((c) => c.family === 'derived-link' && c.otherAreaId === 'b')!;
    expect(derived.relationCounts.map((r) => r.relation)).toEqual(['fixes', 'part_of']);
    expect(derived.count).toBe(2);
    expect(derived.explanation).toMatch(/none is asserted by a record/);

    // `implements` is emitted by no adapter we classified, so it is neither.
    const unclassified = connections.find((c) => c.family === 'unclassified-link')!;
    expect(unclassified.relationCounts.map((r) => r.relation)).toEqual(['implements']);
    expect(unclassified.explanation).toMatch(/does not classify how they were produced/);

    // Three provenances between the same two areas, three separate counts.
    expect(connections.filter((c) => c.otherAreaId === 'b').map((c) => c.family).sort()).toEqual([
      'derived-link',
      'recorded-link',
      'unclassified-link',
    ]);
  });

  it('carries a derivation note for every relation that is not a plain recorded link', () => {
    const { connections } = areaConnections(m, buildAreaIndex(m), 'a');

    const noteFor = (relation: string) =>
      connections.flatMap((c) => c.relationCounts).find((r) => r.relation === relation)?.note;

    expect(noteFor('worked_on_in')).toBeUndefined();
    expect(noteFor('part_of')).toMatch(/Synthesized from a file path/);
    expect(noteFor('fixes')).toMatch(/inferred from the item being a bug or incident/);
    expect(noteFor('references')).toMatch(/adapter's default verb/);
    expect(noteFor('implements')).toMatch(/does not classify how it was produced/);
  });

  it('keeps shared membership separate and points evidence at the record in the other area', () => {
    const { connections } = areaConnections(m, buildAreaIndex(m), 'a');
    const recorded = connections.find((c) => c.family === 'recorded-link')!;

    expect(recorded.evidence.map((e) => e.nodeId)).toEqual(['b1', 'b1']);
    expect(recorded.evidence[0].label).toBe('Access rules → Release check');
    expect(recorded.evidence[0].detail).toBe(
      'Snapshot worked_on_in edge · link recorded in a source record',
    );

    const derived = connections.find((c) => c.family === 'derived-link')!;
    expect(derived.evidence[0].detail).toContain('part_of (blocked on rollout)');
    expect(derived.evidence[0].detail).toContain('Synthesized from a file path');

    const shared = connections.find((c) => c.family === 'shared-membership')!;
    expect(shared.otherAreaId).toBe('c');
    expect(shared.count).toBe(1);
    expect(shared.explanation).toMatch(/Co-membership is not a dependency/);
    expect(shared.evidence[0]).toMatchObject({ nodeId: 'c1', label: 'Shared doc' });
    expect(shared.evidence[0].detail).toContain('Filed in both areas');
    // No entry rolls a link and a membership into one weight.
    expect(connections.filter((c) => c.otherAreaId === 'c')).toHaveLength(1);
  });

  it('caps carried evidence while still reporting the true total', () => {
    const { connections } = areaConnections(m, buildAreaIndex(m), 'a', { evidenceCap: 1 });
    const recorded = connections.find((c) => c.family === 'recorded-link')!;

    expect(recorded.count).toBe(2);
    expect(recorded.evidence).toHaveLength(1);
  });

  it('returns nothing for an unknown area instead of scanning every edge pair', () => {
    expect(areaConnections(m, buildAreaIndex(m), 'nope')).toEqual({
      connections: [],
      internalEdges: { total: 0, byFamily: {} },
    });
  });
});

describe('atlas geography', () => {
  const areas = [area('a', 'A', ['1']), area('b', 'B', ['2']), area('c', 'C', ['3']), area('d', 'D', ['4']), area('e', 'E', ['5'])];

  it('reflows columns with container width without ever reordering territories', () => {
    expect(columnsForWidth(400)).toBe(1);
    expect(columnsForWidth(700)).toBe(2);
    expect(columnsForWidth(900)).toBe(3);
    expect(columnsForWidth(1400)).toBe(4);

    const wide = layoutTerritories(areas, 1400);
    const narrow = layoutTerritories(areas, 600);

    expect(wide.boxes.map((b) => b.areaId)).toEqual(narrow.boxes.map((b) => b.areaId));
    expect(wide.columns).toBe(4);
    expect(narrow.columns).toBe(2);
    expect(narrow.height).toBeGreaterThan(wide.height);
    // Same inputs, same coordinates -- the map does not drift between renders.
    expect(layoutTerritories(areas, 1400)).toEqual(wide);
  });

  it('anchors connectors on the territory borders rather than their centres', () => {
    const [from, to] = layoutTerritories([areas[0], areas[1]], 1400).boxes;
    const path = connectorPath(from, to);

    const [startX, startY, , , endX] = path.d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    expect(startX).toBeCloseTo(from.x + from.w, 0);
    expect(startY).toBeCloseTo(from.y + from.h / 2, 0);
    expect(endX).toBeCloseTo(to.x, 0);
    // The arc bows off the straight line so it clears the tiles it spans.
    expect(path.midY).not.toBeCloseTo(from.y + from.h / 2, 1);
  });
});

describe('relation summaries', () => {
  it('lists the top relations and states how many it withheld', () => {
    const counts = [
      { relation: 'implements', count: 5 },
      { relation: 'references', count: 3 },
      { relation: 'fixes', count: 2 },
      { relation: 'touches', count: 1 },
    ];

    expect(formatRelationSummary(counts)).toBe('implements ×5, references ×3, fixes ×2 +1 more');
    expect(formatRelationSummary([])).toBe('');
  });
});

describe('persistent territory slots', () => {
  const slotted = (id: string, label: string, slot: number) => ({ ...area(id, label, [id]), slot });

  it('holds a territory at its slot when the registry gains a busier area', () => {
    const before = model({
      nodes: [node('collab'), node('editor')],
      areas: [slotted('collab', 'Collaboration', 0), slotted('editor', 'Editor', 1)],
    });
    // A tag that shot to the top of the frequency list is still appended at the
    // next free slot. Frequency decides membership, never position.
    const after = model({
      nodes: [node('collab'), node('editor'), node('sync')],
      areas: [
        slotted('sync', 'Sync', 2),
        slotted('collab', 'Collaboration', 0),
        slotted('editor', 'Editor', 1),
      ],
    });

    expect(buildAreaIndex(before).order.map((a) => a.id)).toEqual(['collab', 'editor']);
    expect(buildAreaIndex(after).order.map((a) => a.id)).toEqual(['collab', 'editor', 'sync']);
  });

  it('leaves a hole where a dropped area used to sit and puts it back on return', () => {
    const full = [slotted('a', 'A', 0), slotted('b', 'B', 1), slotted('c', 'C', 2)];
    const withoutB = [slotted('a', 'A', 0), slotted('c', 'C', 2)];

    const whole = layoutTerritories(buildAreaIndex(model({ nodes: [], areas: full })).order, 1400);
    const gapped = layoutTerritories(
      buildAreaIndex(model({ nodes: [], areas: withoutB })).order,
      1400,
    );

    const at = (layout: { boxes: Array<{ areaId: string; x: number; y: number }> }, id: string) =>
      layout.boxes.find((b) => b.areaId === id)!;

    // C must not slide left into B's vacated cell.
    expect(at(gapped, 'c').x).toBe(at(whole, 'c').x);
    expect(at(gapped, 'c').y).toBe(at(whole, 'c').y);
    expect(gapped.boxes.some((b) => b.areaId === 'b')).toBe(false);

    const returned = layoutTerritories(buildAreaIndex(model({ nodes: [], areas: full })).order, 1400);
    expect(at(returned, 'b')).toEqual(at(whole, 'b'));
  });

  it('keeps a renamed area on its own ground', () => {
    const renamed = [slotted('a', 'A', 0), { ...slotted('b', 'B', 1), label: 'Zzz renamed' }];
    const index = buildAreaIndex(model({ nodes: [], areas: renamed }));

    expect(index.order.map((a) => a.id)).toEqual(['a', 'b']);
    expect(layoutTerritories(index.order, 1400).boxes.find((b) => b.areaId === 'b')!.col).toBe(1);
  });

  it('falls back to identity order for a model that carries no slots yet', () => {
    const index = buildAreaIndex(
      model({ nodes: [], areas: [area('zeta', 'Zeta', []), area('alpha', 'Alpha', [])] }),
    );
    expect(index.order.map((a) => a.id)).toEqual(['alpha', 'zeta']);
  });

  it('leaves Unassigned where the registry put it rather than pinning it last', () => {
    // Unassigned owns a persisted slot like any other area. Once the user has
    // added an area after it, forcing it to the end would move ground the
    // registry already fixed.
    const index = buildAreaIndex(
      model({
        nodes: [],
        areas: [
          slotted('later', 'Later', 2),
          { ...area('unassigned', 'Unassigned', [], 'no rule matched'), slot: 1 },
          slotted('first', 'First', 0),
        ],
      }),
    );

    expect(index.order.map((a) => a.id)).toEqual(['first', 'unassigned', 'later']);
    expect(index.unassigned?.id).toBe('unassigned');
  });

  it('never stacks two territories on one slot if the registry collides', () => {
    // Absolute positioning means a duplicated slot draws one tile on top of
    // another and makes the lower one unclickable. Moving the later area to the
    // next free slot is a visible, deterministic outcome instead of a silent one.
    const index = buildAreaIndex(
      model({
        nodes: [],
        areas: [slotted('beta', 'Beta', 1), slotted('alpha', 'Alpha', 1), slotted('gamma', 'Gamma', 0)],
      }),
    );
    const boxes = layoutTerritories(index.order, 1400).boxes;
    const cells = boxes.map((b) => `${b.row}:${b.col}`);

    expect(new Set(cells).size).toBe(cells.length);
    expect(boxes.find((b) => b.areaId === 'alpha')!.col).toBe(1);
    expect(boxes.find((b) => b.areaId === 'beta')!.col).toBe(2);
  });

  it('keeps a registered area with no members on its own ground', () => {
    // An area whose rule currently matches nothing is retained by the registry.
    // It holds its slot so the areas after it do not shift when it refills.
    const areas = [slotted('a', 'A', 0), { ...area('empty', 'Empty', []), slot: 1 }, slotted('c', 'C', 2)];
    const index = buildAreaIndex(model({ nodes: [node('a'), node('c')], areas }));

    expect(index.order.map((a) => a.id)).toEqual(['a', 'empty', 'c']);
    const boxes = layoutTerritories(index.order, 1400).boxes;
    expect(boxes.find((b) => b.areaId === 'empty')!.col).toBe(1);
    expect(boxes.find((b) => b.areaId === 'c')!.col).toBe(2);
  });
});

describe('territory keyboard navigation over a sparse map', () => {
  // Slots 0, 1 and 3 on a four-column map: one hole at slot 2, and slot 4 sits
  // directly below slot 0 on the next row.
  const boxes = [
    { areaId: 'a', col: 0, row: 0, x: 0, y: 0, w: 100, h: 152 },
    { areaId: 'b', col: 1, row: 0, x: 110, y: 0, w: 100, h: 152 },
    { areaId: 'd', col: 3, row: 0, x: 330, y: 0, w: 100, h: 152 },
    { areaId: 'e', col: 0, row: 1, x: 0, y: 166, w: 100, h: 152 },
  ];

  it('steps over a hole instead of landing on empty ground', () => {
    expect(moveTerritoryFocus(boxes, 'b', 'ArrowRight')).toBe('d');
    expect(moveTerritoryFocus(boxes, 'd', 'ArrowLeft')).toBe('b');
  });

  it('moves down the column the reader is actually in', () => {
    // Index arithmetic (position + columnCount) would have walked off the end
    // here, because the visual grid has a gap the dense order does not.
    expect(moveTerritoryFocus(boxes, 'a', 'ArrowDown')).toBe('e');
    expect(moveTerritoryFocus(boxes, 'e', 'ArrowUp')).toBe('a');
    // Nothing below `b` in its own column: focus stays put.
    expect(moveTerritoryFocus(boxes, 'b', 'ArrowDown')).toBeNull();
  });

  it('jumps to the first and last occupied territory', () => {
    expect(moveTerritoryFocus(boxes, 'd', 'Home')).toBe('a');
    expect(moveTerritoryFocus(boxes, 'a', 'End')).toBe('e');
    expect(moveTerritoryFocus(boxes, 'a', 'Tab')).toBeNull();
  });
});

describe('bridge detection is independent of how an edge was written', () => {
  // `n1` is filed in both A and B, `n2` only in A. Whether the snapshot wrote
  // this edge n1→n2 or n2→n1 must not change whether A bridges to B.
  const build = (sourceId: string, targetId: string) =>
    model({
      nodes: [node('n1'), node('n2')],
      edges: [edge('e1', sourceId, targetId, 'worked_on_in')],
      areas: [area('a', 'A', ['n1', 'n2']), area('b', 'B', ['n1'])],
    });

  it('reports the same bridge in either edge direction', () => {
    const forward = areaConnections(build('n1', 'n2'), buildAreaIndex(build('n1', 'n2')), 'a');
    const reverse = areaConnections(build('n2', 'n1'), buildAreaIndex(build('n2', 'n1')), 'a');

    const summary = (result: ReturnType<typeof areaConnections>) =>
      result.connections
        .filter((c) => c.family !== 'shared-membership')
        .map((c) => `${c.family}:${c.otherAreaId}:${c.count}`);

    expect(summary(forward)).toEqual(['recorded-link:b:1']);
    expect(summary(reverse)).toEqual(summary(forward));
    expect(reverse.internalEdges.total).toBe(forward.internalEdges.total);
  });

  it('still reads the relation in the direction the snapshot recorded it', () => {
    const forward = areaConnections(build('n1', 'n2'), buildAreaIndex(build('n1', 'n2')), 'a');
    const reverse = areaConnections(build('n2', 'n1'), buildAreaIndex(build('n2', 'n1')), 'a');

    const label = (result: ReturnType<typeof areaConnections>) =>
      result.connections.find((c) => c.family === 'recorded-link')!.evidence[0].label;

    expect(label(forward)).toBe('n1 → n2');
    expect(label(reverse)).toBe('n2 → n1');
  });
});

describe('internal edges carry their own provenance', () => {
  const m = model({
    nodes: [node('n1'), node('n2'), node('n3')],
    edges: [
      edge('e1', 'n1', 'n2', 'worked_on_in'),
      edge('e2', 'n2', 'n3', 'part_of'),
      edge('e3', 'n1', 'n3', 'implements'),
    ],
    areas: [area('a', 'A', ['n1', 'n2', 'n3'])],
  });

  it('does not report a path-synthesized edge as a recorded one', () => {
    const { internalEdges } = areaConnections(m, buildAreaIndex(m), 'a');

    expect(internalEdges.total).toBe(3);
    expect(internalEdges.byFamily).toEqual({
      'recorded-link': 1,
      'derived-link': 1,
      'unclassified-link': 1,
    });
  });
});

describe('connectors for a pair joined by more than one family', () => {
  const boxes = [
    { areaId: 'a', col: 0, row: 0, x: 0, y: 0, w: 200, h: 152 },
    { areaId: 'b', col: 1, row: 0, x: 240, y: 0, w: 200, h: 152 },
  ];

  it('gives each family its own route and its own control point', () => {
    const first = connectorPath(boxes[0], boxes[1], { index: 0, count: 2 });
    const second = connectorPath(boxes[0], boxes[1], { index: 1, count: 2 });

    expect(first.d).not.toBe(second.d);
    // The clickable control sits on its own line, so neither can cover the other.
    expect(Math.hypot(first.midX - second.midX, first.midY - second.midY)).toBeGreaterThan(16);
  });

  it('leaves a lone connection on the centre route', () => {
    expect(connectorPath(boxes[0], boxes[1], { index: 0, count: 1 })).toEqual(
      connectorPath(boxes[0], boxes[1]),
    );
  });
});
