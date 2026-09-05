// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildNeighborhood,
  buildSecondHop,
  buildTrailsIndex,
  describeCreation,
  describeEvent,
  describeGaps,
  describeRelation,
  findStartingArtifacts,
  latestEvent,
  recordedCreation,
  type NeighborhoodOptions,
} from '../trailsModel';
import { makeModel, NOW, RANGE } from './fixture';

const OPTIONS: NeighborhoodOptions = { perLane: () => 5, laneLimit: 6, includePathDerived: true };

describe('trails neighborhood', () => {
  it('groups connections by relation name and direction, and counts endpoints it cannot resolve', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    const hood = buildNeighborhood(model, index, 'tracker:bug1', RANGE, OPTIONS);

    expect(hood.lanes.map(l => l.key)).toEqual(['worked_on_in:out', 'fixes:out', 'part_of:out']);
    // The `closes` edge points at an issue node the snapshot never loaded: it
    // stays in the total and never becomes a card.
    expect(hood.connectionTotal).toBe(5);
    expect(hood.unresolved).toBe(1);
    expect(hood.connectionShown).toBe(4);
    expect(hood.lanes.every(l => l.neighbors.every(n => n.node.id !== 'issue:999'))).toBe(true);

    const derived = hood.lanes.find(l => l.key === 'part_of:out');
    expect(derived?.descriptor.kind).toBe('derived');
    expect(derived?.descriptor.basis).toMatch(/filed, not what it is about/i);
  });

  it('credits both ends for a tracker-session link, which either side may record', () => {
    expect(describeRelation('worked_on_in')).toMatchObject({
      label: 'worked on in',
      kind: 'explicit',
      basis: 'An explicit tracker-to-session link, recorded on the tracker item or on the session.',
    });
  });

  it('reads an incoming relation from the other end without renaming it', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    const hood = buildNeighborhood(model, index, 'dir:packages/electron', RANGE, OPTIONS);
    const lane = hood.lanes.find(l => l.key === 'edited_in:in');

    expect(lane?.descriptor.label).toBe('edited in');
    expect(lane?.neighbors.map(n => n.node.id)).toEqual(['session:s1']);
    // Every lane on a directory is derived: two rollups plus path containment.
    expect(hood.lanes.map(l => l.descriptor.kind)).toEqual(['derived', 'derived', 'derived']);
  });

  it('bounds each lane while reporting the total it was taken from', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    const hood = buildNeighborhood(model, index, 'tracker:bug1', RANGE, { ...OPTIONS, perLane: () => 1 });
    const lane = hood.lanes.find(l => l.key === 'worked_on_in:out');

    expect(lane?.total).toBe(2);
    expect(lane?.neighbors).toHaveLength(1);
    // Recent evidence sorts first; the 90-day-old session is still counted.
    expect(lane?.neighbors[0]?.node.id).toBe('session:s1');
    expect(lane?.inRangeCount).toBe(1);
    expect(hood.connectionShown).toBe(3);
  });

  it('withholds path-containment lanes on request without touching other derived relations', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    const hood = buildNeighborhood(model, index, 'tracker:bug1', RANGE, { ...OPTIONS, includePathDerived: false });

    // `fixes` is derived from the item type, not from a path, so it stays.
    expect(hood.lanes.map(l => l.key)).toEqual(['worked_on_in:out', 'fixes:out']);
    expect(hood.hiddenPathDerived).toBe(1);
    expect(hood.connectionTotal).toBe(5);
  });

  it('returns an empty neighborhood for a record with no recorded connection', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    const hood = buildNeighborhood(model, index, 'tracker:lonely', RANGE, OPTIONS);

    expect(hood.focus?.id).toBe('tracker:lonely');
    expect(hood.connectionTotal).toBe(0);
    expect(hood.lanes).toEqual([]);
  });
});

describe('second hop', () => {
  it('excludes the record the trail is standing on and reports the full count', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    const hop = buildSecondHop(model, index, 'session:s1', 'tracker:bug1', RANGE, 5);

    expect(hop.total).toBe(1);
    expect(hop.items.map(i => i.node.id)).toEqual(['dir:packages/electron']);
  });
});

describe('starting artifacts', () => {
  it('ranks in-range evidence then explicit links with no query, and reports scope size', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    const result = findStartingArtifacts(model, index, {
      query: '',
      areaNodeIds: null,
      limit: 3,
      range: RANGE,
    });

    // s1 and c1 have evidence in the window; the directory hub, which has the
    // most edges but the fewest explicit ones, does not lead.
    expect(result.items.map(i => i.id)).toEqual(['session:s1', 'commit:c1', 'tracker:bug1']);
    expect(result.total).toBe(7);
    expect(result.scopeTotal).toBe(7);
  });

  it('ranks directory rollups below named artifacts instead of letting hub degree win', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    const result = findStartingArtifacts(model, index, {
      query: '',
      areaNodeIds: null,
      limit: 20,
      range: RANGE,
    });

    const order = result.items.map(i => i.id);
    // The directory has more connections than anything else and no evidence in
    // range; it must not be the first thing offered as a starting question.
    expect(order[order.length - 1]).toBe('dir:packages/electron');
    expect(order.indexOf('plan:tracker-body')).toBeLessThan(order.indexOf('dir:packages/electron'));
    expect(order.indexOf('tracker:lonely')).toBeLessThan(order.indexOf('dir:packages/electron'));
    // Every record in scope is still offered.
    expect(order).toHaveLength(7);
  });

  it('treats a synthesized package rollup as a container even though its type is not directory', () => {
    const model = makeModel(
      {},
      {
        extraNodes: [
          {
            id: 'rollup:packages',
            type: 'module',
            label: 'packages rollup',
            category: 'knowledge',
            source: 'file',
            visibility: 'workspace-shared',
            fields: { rollup: true },
          },
        ],
      },
    );
    const index = buildTrailsIndex(model);

    const order = findStartingArtifacts(model, index, {
      query: '',
      areaNodeIds: null,
      limit: 20,
      range: RANGE,
    }).items.map(i => i.id);

    expect(order.indexOf('rollup:packages')).toBeGreaterThan(order.indexOf('tracker:lonely'));
  });

  it('ignores the ranking tiers once a query is typed, so a directory is still findable', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    const result = findStartingArtifacts(model, index, {
      query: 'electron',
      areaNodeIds: null,
      limit: 10,
      range: RANGE,
    });

    expect(result.items[0]?.id).toBe('dir:packages/electron');
  });

  it('prefers a label prefix match and keeps unlinked records reachable by name', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    const result = findStartingArtifacts(model, index, {
      query: 'use one',
      areaNodeIds: null,
      limit: 10,
      range: RANGE,
    });

    expect(result.items.map(i => i.id)).toEqual(['tracker:lonely']);
    expect(result.total).toBe(1);
  });

  it('honours the shared area scope without pretending the scope is everything', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    const result = findStartingArtifacts(model, index, {
      query: '',
      areaNodeIds: new Set(model.areas[0]!.nodeIds),
      limit: 10,
      range: RANGE,
    });

    expect(result.items.map(i => i.id)).not.toContain('plan:tracker-body');
    expect(result.scopeTotal).toBe(4);
  });
});

describe('date provenance', () => {
  it('reports a creation date only when an event recorded one', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    expect(recordedCreation(index, 'plan:tracker-body')?.id).toBe('ev4');
    expect(describeCreation(index, 'plan:tracker-body')).toMatch(/^Created \w+ \d+, \d+$/);
  });

  it('will not print node.createdAt, which the loader may have inferred from a neighbor', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    // Both carry a `createdAt` on the node; neither has a recorded creation
    // event, so neither may claim one.
    expect(model.nodeById.get('session:s1')?.createdAt).toBeDefined();
    expect(recordedCreation(index, 'session:s1')).toBeNull();
    expect(describeCreation(index, 'session:s1')).toBe('Creation date not recorded');

    expect(model.nodeById.get('tracker:bug1')?.createdAt).toBeDefined();
    expect(describeCreation(index, 'tracker:bug1')).toBe('Creation date not recorded');
  });

  it('does not read a commit or last-observed event as a creation', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    // c1 has a `commit` event, s1 a `last-activity` one: activity, not birth.
    expect(describeCreation(index, 'commit:c1')).toBe('Creation date not recorded');
    expect(describeEvent(latestEvent(index, 'commit:c1'))).toMatch(/Commit authored · recorded/);
    expect(describeEvent(latestEvent(index, 'session:s1'))).toMatch(/Session activity · last observed/);
  });

  it('ignores an inferred creation event that is not marked as recorded', () => {
    const model = makeModel({
      events: [
        { id: 'inferred', nodeId: 'plan:tracker-body', at: NOW, kind: 'created', label: 'Derived from a neighbor', provenance: 'last-observed' },
      ],
    });
    const index = buildTrailsIndex(model);

    expect(describeCreation(index, 'plan:tracker-body')).toBe('Creation date not recorded');
  });
});

describe('gaps', () => {
  it('says verification is unassessed rather than claiming no verification evidence exists', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);
    const hood = buildNeighborhood(model, index, 'tracker:bug1', RANGE, OPTIONS);

    const gaps = describeGaps(model, hood).join(' ');

    expect(gaps).toMatch(/does not assess verification/);
    expect(gaps).toMatch(/unknown, not failed/);
    // The old wording asserted an absence the view never measured.
    expect(gaps).not.toMatch(/No verification evidence is linked/);
    expect(gaps).toMatch(/Whether this shipped, or behaves correctly, is not recorded/);
    // The shell keeps edges incident to types it filtered out, so an endpoint
    // missing from this view may be unindexed OR merely out of view. Claiming
    // it was never loaded asserts the one of those the view cannot tell apart.
    expect(gaps).toMatch(/not in this view/i);
    expect(gaps).not.toMatch(/did not load|was not loaded|cannot be opened/i);
    expect(gaps).toMatch(/no memory adapter/);
  });

  it('acknowledges a recorded review link without reading its result', () => {
    const model = makeModel(
      {},
      { extraEdges: [{ id: 'e-review', type: 'reviewed_in', sourceId: 'tracker:bug1', targetId: 'session:s2' }] },
    );
    const index = buildTrailsIndex(model);
    const hood = buildNeighborhood(model, index, 'tracker:bug1', RANGE, OPTIONS);

    const gaps = describeGaps(model, hood).join(' ');

    expect(hood.census.review).toBe(1);
    expect(gaps).toMatch(/1 recorded review link is on this trail/);
    expect(gaps).toMatch(/without reading its result/);
    expect(gaps).toMatch(/does not assess verification/);
  });

  it('does not blame file paths when a derived relation came from the item type', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);
    // `fixes` is derived from the tracker type, `part_of` from a path: a claim
    // that everything here came from file paths would be wrong.
    const hood = buildNeighborhood(model, index, 'tracker:bug1', RANGE, OPTIONS);

    const gaps = describeGaps(model, hood).join(' ');

    expect(hood.census).toMatchObject({ resolved: 4, explicit: 2, derived: 2, pathDerived: 1 });
    expect(gaps).not.toMatch(/come from file-path containment/);
    expect(gaps).not.toMatch(/is an explicit source link/);
  });

  it('counts every resolved connection, so a capped lane cannot fake an absence', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    // Render one lane, one record: the census still sees all four connections.
    const hood = buildNeighborhood(model, index, 'tracker:bug1', RANGE, {
      perLane: () => 1,
      laneLimit: 1,
      includePathDerived: false,
    });

    expect(hood.connectionShown).toBe(1);
    expect(hood.census.resolved).toBe(4);
    expect(hood.census.explicit).toBe(2);
    expect(describeGaps(model, hood).join(' ')).not.toMatch(/None of the|come from file-path containment/);
  });

  it('states an all-path-derived neighborhood with the count it measured', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);
    const hood = buildNeighborhood(model, index, 'plan:tracker-body', RANGE, OPTIONS);

    const gaps = describeGaps(model, hood).join(' ');

    expect(gaps).toMatch(/All 1 recorded connection here come from file-path containment/);
    expect(gaps).toMatch(/where these records are filed, not what they are about/);
  });

  it('leaves an unstated-basis relation unknown instead of calling it derived', () => {
    const model = makeModel(
      {},
      {
        extraNodes: [
          {
            id: 'tracker:idea',
            type: 'idea',
            label: 'Try a continuity ledger',
            category: 'knowledge',
            source: 'tracker',
            visibility: 'workspace-shared',
          },
        ],
        extraEdges: [{ id: 'e-idea-rel', type: 'related_to', sourceId: 'tracker:idea', targetId: 'tracker:lonely' }],
      },
    );
    const index = buildTrailsIndex(model);
    const hood = buildNeighborhood(model, index, 'tracker:idea', RANGE, OPTIONS);

    expect(hood.census).toMatchObject({ resolved: 1, explicit: 0, derived: 0, unknownBasis: 1 });
    // `explicit === 0` used to be enough to claim a rule produced every link.
    expect(describeGaps(model, hood).join(' ')).not.toMatch(/derived by a stated rule/);
  });

  it('makes no derived claim when a neighborhood mixes a derived and an unknown relation', () => {
    const model = makeModel(
      {},
      {
        extraNodes: [
          {
            id: 'tracker:bug3',
            type: 'bug',
            label: 'NIM-3 third defect',
            category: 'delivery',
            source: 'tracker',
            visibility: 'workspace-shared',
          },
        ],
        extraEdges: [
          { id: 'e-bug3-commit', type: 'fixes', sourceId: 'tracker:bug3', targetId: 'commit:c1' },
          { id: 'e-bug3-rel', type: 'related_to', sourceId: 'tracker:bug3', targetId: 'tracker:lonely' },
        ],
      },
    );
    const index = buildTrailsIndex(model);
    const hood = buildNeighborhood(model, index, 'tracker:bug3', RANGE, OPTIONS);

    expect(hood.census).toMatchObject({ resolved: 2, explicit: 0, derived: 1, unknownBasis: 1 });
    expect(describeGaps(model, hood).join(' ')).not.toMatch(/derived by a stated rule/);
  });

  it('reports a derived-only neighborhood without calling it a path when it is not', () => {
    const model = makeModel(
      {},
      {
        extraNodes: [
          {
            id: 'tracker:bug2',
            type: 'bug',
            label: 'NIM-2 second defect',
            category: 'delivery',
            source: 'tracker',
            visibility: 'workspace-shared',
          },
        ],
        extraEdges: [{ id: 'e-bug2-commit', type: 'fixes', sourceId: 'tracker:bug2', targetId: 'commit:c1' }],
      },
    );
    const index = buildTrailsIndex(model);
    const hood = buildNeighborhood(model, index, 'tracker:bug2', RANGE, OPTIONS);

    const gaps = describeGaps(model, hood).join(' ');

    expect(gaps).toMatch(/None of the 1 recorded connection here is an explicit source link/);
    expect(gaps).toMatch(/from a file path or from the item's type/);
    expect(gaps).not.toMatch(/All 1 recorded connection/);
  });

  it('states an unlinked record as an absence in the loaded snapshot, not as isolation', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);
    const hood = buildNeighborhood(model, index, 'tracker:lonely', RANGE, OPTIONS);

    const gaps = describeGaps(model, hood);

    expect(gaps[0]).toMatch(/not present in the loaded snapshot|is present in the loaded snapshot/);
    expect(gaps[0]).toMatch(/not evidence that the work stands alone/);
  });

  it('drops the memory-adapter disclosure for sample records', () => {
    const model = makeModel({ source: 'sample' });
    const index = buildTrailsIndex(model);
    const hood = buildNeighborhood(model, index, 'tracker:bug1', RANGE, OPTIONS);

    expect(describeGaps(model, hood).join(' ')).not.toMatch(/memory adapter/);
  });
});

describe('connection provenance', () => {
  it('reads a directory rollup as derived rather than as a link a record carries', () => {
    // `edited_in` and `touches` never point at a file: the adapters aggregate a
    // session's or commit's file list onto a synthesized directory node, so the
    // relation is produced by the rollup rule, not asserted by any record.
    const model = makeModel();
    const index = buildTrailsIndex(model);

    const hood = buildNeighborhood(model, index, 'dir:packages/electron', RANGE, OPTIONS);

    expect(hood.lanes.find(l => l.key === 'edited_in:in')?.descriptor.kind).toBe('derived');
    expect(hood.lanes.find(l => l.key === 'touches:in')?.descriptor.kind).toBe('derived');
    expect(hood.census.explicit).toBe(0);
    expect(hood.census.derived).toBe(hood.census.resolved);
  });

  it('keeps an edited_in edge explicit when its far end is a real file, not a rollup', () => {
    const model = makeModel(
      {},
      {
        extraNodes: [
          {
            id: 'file:one.ts',
            type: 'file',
            label: 'one.ts',
            category: 'knowledge',
            source: 'file',
            visibility: 'local',
          },
        ],
        extraEdges: [
          { id: 'e-file-edit', type: 'edited_in', sourceId: 'file:one.ts', targetId: 'session:s2' },
        ],
      },
    );
    const index = buildTrailsIndex(model);

    const hood = buildNeighborhood(model, index, 'file:one.ts', RANGE, OPTIONS);

    expect(hood.lanes[0]?.descriptor.kind).toBe('explicit');
  });

  it('prefers the provenance the edge itself carries over the relation table', () => {
    const model = makeModel(
      {},
      {
        extraEdges: [
          {
            id: 'e-stated',
            type: 'worked_on_in',
            sourceId: 'tracker:lonely',
            targetId: 'session:s1',
            provenance: { kind: 'derived', basis: 'Matched by issue key in the session title.' },
          },
        ],
      },
    );
    const index = buildTrailsIndex(model);

    const hood = buildNeighborhood(model, index, 'tracker:lonely', RANGE, OPTIONS);

    expect(hood.lanes[0]?.descriptor).toMatchObject({
      label: 'worked on in',
      kind: 'derived',
      basis: 'Matched by issue key in the session title.',
    });
    expect(hood.census).toMatchObject({ resolved: 1, explicit: 0, derived: 1 });
  });
});

describe('unresolved endpoints', () => {
  it('keeps a dangling link reachable with the id it points at', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);

    const hood = buildNeighborhood(model, index, 'tracker:bug1', RANGE, OPTIONS);

    expect(hood.unresolved).toBe(1);
    expect(hood.unresolvedRefs).toEqual([
      expect.objectContaining({
        key: 'e-bug-issue',
        missingId: 'issue:999',
        knownId: 'tracker:bug1',
        direction: 'out',
      }),
    ]);
    expect(hood.unresolvedRefs[0]?.descriptor.label).toBe('closes');
  });

  it('never reports an absence of links the sources were never asked for', () => {
    const model = makeModel();
    const index = buildTrailsIndex(model);
    const hood = buildNeighborhood(model, index, 'tracker:lonely', RANGE, OPTIONS);

    const gaps = describeGaps(model, hood).join(' ');

    // The loader caps every source. "Nothing links this record" is a statement
    // about the snapshot in hand, never about what the sources hold.
    expect(gaps).toMatch(/loaded snapshot/i);
    expect(gaps).not.toMatch(/sources that would carry a link recorded none/i);
    expect(gaps).not.toMatch(/was recorded for this artifact/i);
  });
});
