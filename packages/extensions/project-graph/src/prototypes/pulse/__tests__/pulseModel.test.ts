// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type {
  PrototypeArea,
  PrototypeEvent,
  PrototypeMembership,
  PrototypeModel,
} from '../../contracts';
import type { ProjectGraphNode } from '../../../types';
import {
  buildPulseMatrix,
  classifyStatus,
  comparePeriods,
  heatLegend,
  heatStep,
  moveGridFocus,
  moveGridFocusById,
  openStateItems,
  pruneSelection,
  summarizeSelection,
  type PulseMatrix,
  type PulseSelection,
} from '../pulseModel';

/** Selects every displayed row across a column span, by row id. */
function selectAll(matrix: PulseMatrix, colStart: number, colEnd: number): PulseSelection {
  const rowIds = matrix.rows.map((row) => row.id);
  return {
    rowIds,
    anchorRowId: rowIds[0],
    headRowId: rowIds[rowIds.length - 1],
    anchorCol: colStart,
    headCol: colEnd,
  };
}

function selectRows(rowIds: string[], colStart: number, colEnd: number): PulseSelection {
  return {
    rowIds,
    anchorRowId: rowIds[0],
    headRowId: rowIds[rowIds.length - 1],
    anchorCol: colStart,
    headCol: colEnd,
  };
}

const DAY = (day: number, hour = 10) => new Date(2026, 8, day, hour, 0, 0, 0).getTime();
const RANGE = {
  startMs: new Date(2026, 8, 1, 0, 0, 0, 0).getTime(),
  endMs: new Date(2026, 8, 5, 23, 59, 59, 999).getTime(),
};

function node(id: string, extra: Partial<ProjectGraphNode> = {}): ProjectGraphNode {
  return {
    id,
    type: 'task',
    label: `Node ${id}`,
    category: 'delivery',
    source: 'tracker',
    visibility: 'local',
    ...extra,
  };
}

function event(
  id: string,
  nodeId: string,
  at: number,
  kind: PrototypeEvent['kind'] = 'commit',
): PrototypeEvent {
  return {
    id,
    nodeId,
    at,
    kind,
    label: `${kind} on ${nodeId}`,
    provenance: kind === 'last-activity' ? 'last-observed' : 'recorded',
  };
}

function makeModel(
  nodes: ProjectGraphNode[],
  areas: PrototypeArea[],
  events: PrototypeEvent[],
): PrototypeModel {
  const nodeById = new Map(nodes.map((entry) => [entry.id, entry]));
  const memberships = new Map<string, PrototypeMembership[]>();
  for (const area of areas) {
    for (const nodeId of area.nodeIds) {
      const list = memberships.get(nodeId) ?? [];
      list.push({ areaId: area.id, basis: area.basis });
      memberships.set(nodeId, list);
    }
  }
  return {
    snapshot: {
      generatedAt: DAY(6, 12),
      nodes,
      edges: [],
      stats: { nodeCount: nodes.length, edgeCount: 0, countsByType: {} },
    },
    nodeById,
    areas,
    memberships,
    events,
    coverage: ['sample coverage note'],
    source: 'sample',
  };
}

const AREAS: PrototypeArea[] = [
  { id: 'editor', label: 'Editor Experience', nodeIds: ['a', 'b', 'shared'], basis: 'tag:editor' },
  { id: 'collab', label: 'Collaboration', nodeIds: ['c', 'shared'], basis: 'tag:collab' },
  { id: 'quiet', label: 'Customer Learning', nodeIds: ['d'], basis: 'tag:crm' },
];

const NODES = [
  node('a', { status: 'in-progress' }),
  node('b', { status: 'done', closedAt: DAY(2) }),
  node('c', { status: 'open' }),
  node('d'),
  node('shared', { label: 'Permissions rework', status: 'in-review' }),
  node('orphan', { label: 'Unfiled note', type: 'doc' }),
];

describe('buildPulseMatrix', () => {
  it('counts distinct artifacts per bucket rather than raw events', () => {
    const model = makeModel(NODES, AREAS, [
      event('e1', 'a', DAY(2, 9)),
      event('e2', 'a', DAY(2, 17)),
      event('e3', 'b', DAY(2, 11)),
    ]);
    const matrix = buildPulseMatrix(model, RANGE, { sort: 'name' });
    const editor = matrix.rows.find((row) => row.id === 'editor')!;
    const cell = editor.cells[1];

    expect(cell.activeArtifacts).toBe(2);
    expect(cell.eventCount).toBe(3);
    expect(matrix.distinctArtifactsInRange).toBe(2);
    expect(matrix.eventsInRange).toBe(3);
  });

  it('keeps last-observed timestamps out of the active-artifact count', () => {
    const model = makeModel(NODES, AREAS, [
      event('e1', 'a', DAY(3), 'last-activity'),
      event('e2', 'b', DAY(3), 'status'),
    ]);
    const matrix = buildPulseMatrix(model, RANGE, { sort: 'name' });
    const cell = matrix.rows.find((row) => row.id === 'editor')!.cells[2];

    expect(cell.activeArtifacts).toBe(1);
    expect(cell.lastObservedOnly).toBe(1);
    expect(matrix.lastObservedOnlyArtifacts).toBe(1);
  });

  it('distinguishes a real gap from a bucket that predates every loaded record', () => {
    const model = makeModel(NODES, AREAS, [event('e1', 'a', DAY(4))]);
    const matrix = buildPulseMatrix(model, RANGE, { sort: 'name' });
    const cells = matrix.rows.find((row) => row.id === 'editor')!.cells;

    expect(cells[0].coverage).toBe('outside-loaded');
    expect(cells[3].coverage).toBe('observed');
    // After the earliest loaded event, an empty bucket is unmarked -- still no
    // loaded events, but without the global 'nothing was loaded this early' bound.
    expect(cells[4].coverage).toBe('gap');
  });

  it('counts a record shared by two areas in both rows and says so once in a selection', () => {
    const model = makeModel(NODES, AREAS, [event('e1', 'shared', DAY(2))]);
    const matrix = buildPulseMatrix(model, RANGE, { sort: 'name' });
    const editor = matrix.rows.find((row) => row.id === 'editor')!;
    const collab = matrix.rows.find((row) => row.id === 'collab')!;

    expect(editor.cells[1].activeArtifacts).toBe(1);
    expect(collab.cells[1].activeArtifacts).toBe(1);
    expect(matrix.distinctArtifactsInRange).toBe(1);

    const summary = summarizeSelection(matrix, selectAll(matrix, 0, 4), model.nodeById);
    expect(summary.eventCount).toBe(1);
    expect(summary.distinctArtifacts).toBe(1);
  });

  it('gives records with no area membership their own honest row', () => {
    const model = makeModel(NODES, AREAS, [event('e1', 'orphan', DAY(2))]);
    const matrix = buildPulseMatrix(model, RANGE, { sort: 'name' });
    const unassigned = matrix.rows.find((row) => row.kind === 'unassigned');

    expect(unassigned).toBeDefined();
    expect(unassigned!.cells[1].activeArtifacts).toBe(1);
  });

  it('keeps a quiet area visible with its out-of-range last-seen timestamp', () => {
    const model = makeModel(NODES, AREAS, [
      event('old', 'd', new Date(2026, 5, 1, 10).getTime()),
      event('e1', 'a', DAY(2)),
    ]);
    const matrix = buildPulseMatrix(model, RANGE, { sort: 'recent' });
    const quiet = matrix.rows.find((row) => row.id === 'quiet')!;

    expect(quiet.eventsInRange).toBe(0);
    expect(quiet.lastEventInRange).toBe(false);
    expect(quiet.lastEventAt).toBe(new Date(2026, 5, 1, 10).getTime());
    // Recency sort: active in the window, then last-seen long ago, then never
    // seen at all -- so scanning top-down is scanning by recency.
    expect(matrix.rows.map((row) => row.id)).toEqual(['editor', 'quiet', 'collab']);
  });

  it('drills a selected area into its own artifact rows', () => {
    const model = makeModel(NODES, AREAS, [
      event('e1', 'a', DAY(2)),
      event('e2', 'shared', DAY(3)),
      event('e3', 'c', DAY(3)),
    ]);
    const matrix = buildPulseMatrix(model, RANGE, { selectedAreaId: 'editor', sort: 'recent' });

    expect(matrix.scopeAreaLabel).toBe('Editor Experience');
    expect(matrix.rows.every((row) => row.kind === 'artifact')).toBe(true);
    expect(matrix.rows.map((row) => row.nodeId)).toContain('shared');
    // 'c' belongs to Collaboration only and must not leak into this scope.
    expect(matrix.rows.map((row) => row.nodeId)).not.toContain('c');
    expect(matrix.eventsInRange).toBe(2);
  });

  it('applies a view-only display name without touching the source area', () => {
    const model = makeModel(NODES, AREAS, [event('e1', 'a', DAY(2))]);
    const matrix = buildPulseMatrix(model, RANGE, {
      sort: 'name',
      areaLabelOverrides: { editor: 'Editing' },
    });

    expect(matrix.rows.find((row) => row.id === 'editor')!.label).toBe('Editing');
    expect(model.areas.find((area) => area.id === 'editor')!.label).toBe('Editor Experience');
  });

  it('bounds the rendered rows and reports the total', () => {
    const many: PrototypeArea[] = Array.from({ length: 6 }, (_, index) => ({
      id: `area${index}`,
      label: `Area ${index}`,
      nodeIds: ['a'],
      basis: 'tag:test',
    }));
    const model = makeModel(NODES, many, [event('e1', 'a', DAY(2))]);
    const matrix = buildPulseMatrix(model, RANGE, { maxRows: 2, sort: 'name' });

    expect(matrix.rows).toHaveLength(2);
    expect(matrix.rowsTotal).toBe(6);
  });

  it('sorts and counts the whole scope, not a pre-truncated slice of it', () => {
    // Far more members than the display cap, and almost all of them quiet: the
    // row universe must be enumerated in full before anything is cut.
    const members = Array.from({ length: 200 }, (_, index) =>
      node(`m${index}`, { label: `Item ${String(index).padStart(3, '0')}` }),
    );
    const areas: PrototypeArea[] = [
      { id: 'big', label: 'Big Area', nodeIds: members.map((entry) => entry.id), basis: 'tag:big' },
    ];
    const events = [
      event('e1', 'm150', DAY(2)),
      event('e2', 'm151', DAY(3)),
      event('e3', 'm152', DAY(4)),
    ];
    const model = makeModel(members, areas, events);

    const byName = buildPulseMatrix(model, RANGE, {
      selectedAreaId: 'big',
      sort: 'name',
      maxRows: 10,
    });
    expect(byName.rowsTotal).toBe(200);
    expect(byName.rows).toHaveLength(10);
    // Alphabetical order over all 200 -- not over whichever subset was
    // materialized first, which would have started at the active members.
    expect(byName.rows[0].label).toBe('Item 000');
    expect(byName.rows[9].label).toBe('Item 009');

    const byRecent = buildPulseMatrix(model, RANGE, {
      selectedAreaId: 'big',
      sort: 'recent',
      maxRows: 10,
    });
    expect(byRecent.rows.slice(0, 3).map((row) => row.nodeId)).toEqual(['m152', 'm151', 'm150']);
    expect(byRecent.rowsTotal).toBe(200);

    // A quiet historic window still reports the true scope size.
    const quietRange = {
      startMs: new Date(2024, 0, 1).getTime(),
      endMs: new Date(2024, 0, 31, 23, 59, 59, 999).getTime(),
    };
    const quiet = buildPulseMatrix(model, quietRange, {
      selectedAreaId: 'big',
      sort: 'volume',
      maxRows: 10,
    });
    expect(quiet.rowsTotal).toBe(200);
    expect(quiet.eventsInRange).toBe(0);
    expect(quiet.rows).toHaveLength(10);
  });
});

describe('summarizeSelection', () => {
  it('builds a counted heading and artifact-grouped episodes ordered by recency', () => {
    const model = makeModel(NODES, AREAS, [
      event('e1', 'a', DAY(2), 'commit'),
      event('e2', 'a', DAY(2, 15), 'commit'),
      event('e3', 'b', DAY(4), 'status'),
    ]);
    const matrix = buildPulseMatrix(model, RANGE, { sort: 'name' });
    const summary = summarizeSelection(matrix, selectRows(['editor'], 0, 4), model.nodeById);

    expect(summary.heading).toBe('2 artifacts · 2 commits · 1 status change');
    expect(summary.episodes.map((episode) => episode.nodeId)).toEqual(['b', 'a']);
    expect(summary.episodes[1].events).toHaveLength(2);
    expect(summary.events[0].id).toBe('e3');
    expect(summary.recordedCount).toBe(3);
  });

  it('reports an empty selection as a gap instead of inventing an outcome', () => {
    const model = makeModel(NODES, AREAS, [event('e1', 'a', DAY(2))]);
    const matrix = buildPulseMatrix(model, RANGE, { sort: 'name' });
    const summary = summarizeSelection(matrix, selectRows(['editor'], 4, 4), model.nodeById);

    expect(summary.heading).toBe('No loaded events in this selection');
    expect(summary.episodes).toHaveLength(0);
  });

  it('flags a selection that touches a clipped bucket or unloaded history', () => {
    const model = makeModel(NODES, AREAS, [event('e1', 'a', DAY(3))]);
    const partialRange = {
      startMs: new Date(2026, 8, 1, 14, 0, 0, 0).getTime(),
      endMs: new Date(2026, 8, 5, 23, 59, 59, 999).getTime(),
    };
    const matrix = buildPulseMatrix(model, partialRange, { sort: 'name' });
    const summary = summarizeSelection(matrix, selectRows(['editor'], 0, 1), model.nodeById);

    expect(summary.includesPartialBucket).toBe(true);
    expect(summary.includesOutsideLoaded).toBe(true);
  });
});

describe('openStateItems', () => {
  it('counts only recognized non-terminal states as open work', () => {
    const model = makeModel(NODES, AREAS, [event('e1', 'a', DAY(2))]);
    const matrix = buildPulseMatrix(model, RANGE, { sort: 'name' });
    const census = openStateItems(model, matrix, 10);

    // 'b' is closed, 'd' has no status, 'orphan' is in no area in view.
    expect(census.open.map((item) => item.node.id)).toEqual(['a', 'c', 'shared']);
    expect(census.openTotal).toBe(3);
    expect(census.closedTotal).toBe(1);
    expect(census.statuslessTotal).toBe(1);
    expect(census.scopeSize).toBe(5);
    // Most recently touched first; only 'a' has an event at all.
    expect(census.open[0].node.id).toBe('a');
  });

  it('treats a terminal status as settled even without a closedAt timestamp', () => {
    const sessions = [
      node('s1', { type: 'session', status: 'completed' }),
      node('s2', { type: 'session', status: 'Done' }),
      node('s3', { type: 'session', status: 'in_progress' }),
    ];
    const areas: PrototypeArea[] = [
      { id: 'sessions', label: 'Sessions', nodeIds: ['s1', 's2', 's3'], basis: 'tag:session' },
    ];
    const model = makeModel(sessions, areas, []);
    const matrix = buildPulseMatrix(model, RANGE, { sort: 'name' });
    const census = openStateItems(model, matrix, 10);

    expect(census.open.map((item) => item.node.id)).toEqual(['s3']);
    expect(census.closedTotal).toBe(2);
    expect(census.unrecognizedTotal).toBe(0);
  });

  it('holds an unrecognized custom status apart instead of asserting it is unresolved', () => {
    const custom = [
      node('c1', { status: 'spike' }),
      node('c2', { status: 'approved' }),
      node('c3', { status: 'open' }),
    ];
    const areas: PrototypeArea[] = [
      { id: 'custom', label: 'Custom', nodeIds: ['c1', 'c2', 'c3'], basis: 'tag:custom' },
    ];
    const model = makeModel(custom, areas, []);
    const census = openStateItems(model, buildPulseMatrix(model, RANGE, { sort: 'name' }), 10);

    expect(census.openTotal).toBe(1);
    expect(census.unrecognizedTotal).toBe(2);
    expect(census.unrecognizedStatuses).toEqual(['approved', 'spike']);
    expect(census.open.map((item) => item.node.id)).not.toContain('c1');
  });

  it('bounds the list and still reports the true total', () => {
    const model = makeModel(NODES, AREAS, []);
    const matrix = buildPulseMatrix(model, RANGE, { sort: 'name' });
    const census = openStateItems(model, matrix, 1);

    expect(census.open).toHaveLength(1);
    expect(census.openTotal).toBe(3);
  });

  it('counts the whole area universe even when rows are truncated for display', () => {
    const model = makeModel(NODES, AREAS, [event('e1', 'a', DAY(2))]);
    const capped = buildPulseMatrix(model, RANGE, { sort: 'name', maxRows: 1 });

    expect(capped.rows).toHaveLength(1);
    expect(openStateItems(model, capped, 10).openTotal).toBe(3);
  });
});

describe('classifyStatus', () => {
  it('normalizes separators and case, and refuses to guess at unknown states', () => {
    expect(classifyStatus('In Progress')).toBe('open');
    expect(classifyStatus('in_progress')).toBe('open');
    expect(classifyStatus('COMPLETED')).toBe('terminal');
    expect(classifyStatus('wont fix')).toBe('terminal');
    expect(classifyStatus('needs triage from ops')).toBe('unrecognized');
    expect(classifyStatus('')).toBeNull();
    expect(classifyStatus(undefined)).toBeNull();
  });
});

describe('grid helpers', () => {
  it('moves and clamps focus, and ignores keys the application owns', () => {
    expect(moveGridFocus({ row: 1, col: 1 }, 'ArrowRight', 3, 3)).toEqual({ row: 1, col: 2 });
    expect(moveGridFocus({ row: 0, col: 0 }, 'ArrowUp', 3, 3)).toEqual({ row: 0, col: 0 });
    expect(moveGridFocus({ row: 2, col: 2 }, 'ArrowDown', 3, 3)).toEqual({ row: 2, col: 2 });
    expect(moveGridFocus({ row: 1, col: 1 }, 'End', 3, 4)).toEqual({ row: 1, col: 3 });
    expect(moveGridFocus({ row: 1, col: 1 }, 'PageUp', 3, 4)).toEqual({ row: 0, col: 1 });
    expect(moveGridFocus({ row: 0, col: 0 }, 'k', 3, 3)).toBeNull();
    expect(moveGridFocus({ row: 0, col: 0 }, 'ArrowRight', 0, 0)).toBeNull();
  });

  it('ramps heat only above zero and saturates at the matrix maximum', () => {
    expect(heatStep(0, 8)).toBe(0);
    expect(heatStep(2, 8)).toBe(1);
    expect(heatStep(4, 8)).toBe(2);
    expect(heatStep(8, 8)).toBe(4);
    expect(heatStep(1, 1)).toBe(4);
  });

  it('prints a legend that agrees with heatStep for every reachable value', () => {
    // Small maxima cannot reach every step; the legend must list only the
    // steps that some value actually maps to, with its true range.
    expect(heatLegend(1)).toEqual([{ step: 4, label: '1' }]);
    expect(heatLegend(2)).toEqual([
      { step: 2, label: '1' },
      { step: 4, label: '2' },
    ]);
    expect(heatLegend(3)).toEqual([
      { step: 2, label: '1' },
      { step: 3, label: '2' },
      { step: 4, label: '3' },
    ]);
    expect(heatLegend(5)).toEqual([
      { step: 1, label: '1' },
      { step: 2, label: '2' },
      { step: 3, label: '3' },
      { step: 4, label: '4–5' },
    ]);
    expect(heatLegend(0)).toEqual([]);
  });

  it('never advertises a swatch no value maps to, at any maximum', () => {
    for (let maxValue = 1; maxValue <= 40; maxValue += 1) {
      const entries = heatLegend(maxValue);
      const advertised = entries.map((entry) => entry.step);
      const reachable = new Set<number>();
      for (let value = 1; value <= maxValue; value += 1) reachable.add(heatStep(value, maxValue));
      expect(advertised).toEqual([...reachable].sort((a, b) => a - b));

      // Every value falls inside exactly one printed range, under its own step.
      for (let value = 1; value <= maxValue; value += 1) {
        const step = heatStep(value, maxValue);
        const entry = entries.find((candidate) => candidate.step === step)!;
        const [from, to] = entry.label.includes('–')
          ? entry.label.split('–').map(Number)
          : [Number(entry.label), Number(entry.label)];
        expect(value).toBeGreaterThanOrEqual(from);
        expect(value).toBeLessThanOrEqual(to);
      }
    }
  });
});

describe('selection identity across re-sorting', () => {
  // Editor is alphabetically last but most recently active, so 'name' and
  // 'recent' put Collaboration at different row indices.
  const model = makeModel(NODES, AREAS, [
    event('e1', 'a', DAY(5)),
    event('e2', 'c', DAY(2)),
  ]);

  it('keeps naming the same artifacts when the row order changes', () => {
    const byName = buildPulseMatrix(model, RANGE, { sort: 'name' });
    const selection = selectRows(['collab'], 0, 4);
    const before = summarizeSelection(byName, selection, model.nodeById);

    // 'recent' puts Collaboration in a different row index than 'name' did.
    const byRecent = buildPulseMatrix(model, RANGE, { sort: 'recent' });
    expect(byRecent.rows.findIndex((row) => row.id === 'collab')).not.toBe(
      byName.rows.findIndex((row) => row.id === 'collab'),
    );

    const after = summarizeSelection(byRecent, selection, model.nodeById);
    expect(after.events.map((entry) => entry.id)).toEqual(before.events.map((entry) => entry.id));
    expect(after.rowLabels).toEqual(['Collaboration']);
    expect(after.rowsOutOfView).toBe(0);
  });

  it('reports selected rows that fall below the display cap rather than dropping them', () => {
    const capped = buildPulseMatrix(model, RANGE, { sort: 'name', maxRows: 1 });
    const summary = summarizeSelection(capped, selectRows(['editor', 'collab'], 0, 4), model.nodeById);

    expect(summary.rowsSelected).toBe(2);
    expect(summary.rowsOutOfView).toBe(1);
    expect(summary.rowLabels).toEqual(['Collaboration']);
  });
});

describe('archive is not closure', () => {
  const census = (nodes: ProjectGraphNode[]) => {
    const areas: PrototypeArea[] = [
      { id: 'one', label: 'One', nodeIds: nodes.map((n) => n.id), basis: 'tag:one' },
    ];
    const m = makeModel(nodes, areas, []);
    return openStateItems(m, buildPulseMatrix(m, RANGE, { sort: 'name' }));
  };

  it('does not read an archived record as a finished one', () => {
    // Archiving is a filing decision. A record can be archived while the work
    // it describes is still open, so the two are counted on separate axes.
    const result = census([
      node('arch', { status: 'in-progress', fields: { archived: true } }),
      node('live', { status: 'in-progress' }),
    ]);

    expect(result.closedTotal).toBe(0);
    expect(result.archivedTotal).toBe(1);
    expect(result.archived.map((i) => i.node.id)).toEqual(['arch']);
    expect(result.open.map((i) => i.node.id)).toEqual(['live']);
    expect(classifyStatus('archived')).not.toBe('terminal');
  });

  it('counts an archived record that is also terminal on both axes without double-closing', () => {
    const result = census([node('both', { status: 'done', fields: { archived: true } })]);

    expect(result.closedTotal).toBe(1);
    expect(result.archivedTotal).toBe(1);
    expect(result.openTotal).toBe(0);
  });

  it('keeps a record whose status is still in review out of the closed count', () => {
    // The adapters have conflated "archived" and "completed" with closure; an
    // explicit non-terminal status is the stronger signal and wins.
    const result = census([node('rev', { status: 'in-review', closedAt: DAY(2) })]);

    expect(result.openTotal).toBe(1);
    expect(result.closedTotal).toBe(0);
    expect(result.closureConflicts).toBe(1);
  });
});

describe('unrecognized status labels', () => {
  it('bounds a status string that is really a paragraph of prose', () => {
    // Live data: a tracker item carried a whole stopped-work note, and a code
    // comment, in its status field. Printing four of those verbatim turned the
    // disclosure line into an unreadable wall.
    const prose =
      'STOPPED 2026-07-27 - supplied evidence yields 64 targets but the approved decision says 63; ' +
      'no executable allowlist or purge tool exists. Not executed.';
    const nodes = [node('a', { status: prose }), node('b', { status: 'weird-state' })];
    const areas: PrototypeArea[] = [
      { id: 'one', label: 'One', nodeIds: ['a', 'b'], basis: 'tag:one' },
    ];
    const m = makeModel(nodes, areas, []);

    const census = openStateItems(m, buildPulseMatrix(m, RANGE, { sort: 'name' }));

    expect(census.unrecognizedTotal).toBe(2);
    const longest = Math.max(...census.unrecognizedStatuses.map((s) => s.length));
    expect(longest).toBeLessThanOrEqual(32);
    // Still identifiable: the head of the value survives, marked as clipped.
    expect(census.unrecognizedStatuses.some((s) => s.startsWith('STOPPED 2026-07-27'))).toBe(true);
    expect(census.unrecognizedStatuses.some((s) => s.endsWith('…'))).toBe(true);
    expect(census.unrecognizedStatuses).toContain('weird-state');
  });

  it('shows at most three examples while the totals stay true', () => {
    const nodes = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((status, i) =>
      node(`n${i}`, { status: `custom-${status}` }),
    );
    const areas: PrototypeArea[] = [
      { id: 'one', label: 'One', nodeIds: nodes.map((n) => n.id), basis: 'tag:one' },
    ];
    const m = makeModel(nodes, areas, []);

    const census = openStateItems(m, buildPulseMatrix(m, RANGE, { sort: 'name' }));

    expect(census.unrecognizedStatuses).toHaveLength(3);
    // The counts are of records and of distinct values, and neither is clipped.
    expect(census.unrecognizedTotal).toBe(5);
    expect(census.unrecognizedStatusTotal).toBe(5);
  });
});

describe('pruning a selection against a refreshed model', () => {
  const model = makeModel(NODES, AREAS, [event('e1', 'a', DAY(2)), event('e2', 'c', DAY(3))]);

  it('keeps a selected row that is merely below the display cap', () => {
    // `rowsOutOfView` exists to report exactly this case. Pruning against the
    // displayed rows instead of the model would delete the row and with it the
    // disclosure that its events are not counted.
    const capped = buildPulseMatrix(model, RANGE, { sort: 'name', maxRows: 1 });
    const selection = selectRows(['editor', 'collab'], 0, 4);

    expect(pruneSelection(model, capped, selection)).toBe(selection);
    expect(summarizeSelection(capped, selection, model.nodeById).rowsOutOfView).toBe(1);
  });

  it('drops a row the model no longer has and re-anchors on a survivor', () => {
    const matrix = buildPulseMatrix(model, RANGE, { sort: 'name' });
    const pruned = pruneSelection(model, matrix, selectRows(['gone', 'collab'], 0, 4));

    expect(pruned).not.toBeNull();
    expect(pruned!.rowIds).toEqual(['collab']);
    expect(pruned!.anchorRowId).toBe('collab');
    expect(pruned!.headRowId).toBe('collab');
    expect(pruned!.anchorCol).toBe(0);
    expect(pruned!.headCol).toBe(4);
  });

  it('clears the selection only when nothing in it survives', () => {
    const matrix = buildPulseMatrix(model, RANGE, { sort: 'name' });

    expect(pruneSelection(model, matrix, selectRows(['gone', 'also-gone'], 0, 2))).toBeNull();
  });

  it('validates artifact rows against the scope when one area is selected', () => {
    const scoped = buildPulseMatrix(model, RANGE, { selectedAreaId: 'editor', sort: 'name' });

    expect(pruneSelection(model, scoped, selectRows(['a', 'c'], 0, 2))!.rowIds).toEqual(['a']);
    expect(pruneSelection(model, scoped, selectRows(['a', 'b'], 0, 2))!.rowIds).toEqual(['a', 'b']);
  });
});

describe('grid focus survives a re-sort', () => {
  const rows = (ids: string[]) => ids.map((id) => ({ id }) as { id: string });

  it('moves relative to the focused row id, not the index it used to hold', () => {
    const before = rows(['alpha', 'beta', 'gamma']);
    const after = rows(['gamma', 'alpha', 'beta']);

    expect(moveGridFocusById(before, { rowId: 'alpha', col: 1 }, 'ArrowDown', 4)).toEqual({
      rowId: 'beta',
      col: 1,
    });
    // Same focused row, reordered grid: down is now the row below it *there*.
    expect(moveGridFocusById(after, { rowId: 'alpha', col: 1 }, 'ArrowDown', 4)).toEqual({
      rowId: 'beta',
      col: 1,
    });
    expect(moveGridFocusById(after, { rowId: 'gamma', col: 1 }, 'ArrowDown', 4)).toEqual({
      rowId: 'alpha',
      col: 1,
    });
  });

  it('lands on the first row when the focused row left the display', () => {
    expect(moveGridFocusById(rows(['a', 'b']), { rowId: 'gone', col: 0 }, 'ArrowDown', 3)).toEqual({
      rowId: 'a',
      col: 0,
    });
  });

  it('leaves a modifier chord to the application', () => {
    expect(moveGridFocus({ row: 0, col: 0 }, 'ArrowDown', 3, 3, { metaKey: true })).toBeNull();
    expect(moveGridFocus({ row: 0, col: 0 }, 'ArrowDown', 3, 3, { ctrlKey: true })).toBeNull();
    expect(moveGridFocus({ row: 0, col: 0 }, 'ArrowDown', 3, 3, { altKey: true })).toBeNull();
    expect(moveGridFocus({ row: 0, col: 0 }, 'ArrowDown', 3, 3, { shiftKey: true })).toEqual({
      row: 1,
      col: 0,
    });
    expect(
      moveGridFocusById(rows(['a', 'b']), { rowId: 'a', col: 0 }, 'ArrowDown', 3, { metaKey: true }),
    ).toBeNull();
  });
});

describe('comparison against the preceding period', () => {
  const PREVIOUS = {
    startMs: new Date(2026, 7, 27, 0, 0, 0, 0).getTime(),
    endMs: new Date(2026, 7, 31, 23, 59, 59, 999).getTime(),
  };
  const build = (events: PrototypeEvent[], coverage?: PrototypeModel['periodCoverage']) => {
    const m = makeModel(NODES, AREAS, events);
    return { ...m, periodCoverage: coverage };
  };

  it('counts the same scope in both windows and states the delta', () => {
    const m = build([
      event('c1', 'a', DAY(2)),
      event('c2', 'b', DAY(3)),
      event('p1', 'a', new Date(2026, 7, 29, 10).getTime()),
    ]);

    const result = comparePeriods(m, RANGE, PREVIOUS, {});

    expect(result.current).toMatchObject({ events: 2, artifacts: 2 });
    expect(result.previous).toMatchObject({ events: 1, artifacts: 1 });
    expect(result.deltaEvents).toBe(1);
    expect(result.deltaArtifacts).toBe(1);
    // No periodCoverage at all: the counts are comparable as observed records,
    // but nothing here supports a claim about complete history.
    expect(result.deltaBasis).toBe('observed');
    expect(result.comparable).toBe(false);
  });

  it('scopes the comparison to the selected area on both sides', () => {
    const m = build([
      event('c1', 'c', DAY(2)),
      event('c2', 'a', DAY(2)),
      event('p1', 'a', new Date(2026, 7, 29, 10).getTime()),
    ]);

    const result = comparePeriods(m, RANGE, PREVIOUS, { selectedAreaId: 'collab' });

    expect(result.current).toMatchObject({ events: 1, artifacts: 1 });
    expect(result.previous).toMatchObject({ events: 0, artifacts: 0 });
  });

  it('refuses a delta when the previous window is outside what the sources loaded', () => {
    const m = build([event('c1', 'a', DAY(2))], {
      startMs: RANGE.startMs,
      endMs: RANGE.endMs,
      complete: true,
      reason: 'Sessions load 90 days of history.',
    });

    const result = comparePeriods(m, RANGE, PREVIOUS, {});

    expect(result.comparable).toBe(false);
    expect(result.deltaEvents).toBeNull();
    expect(result.previousCoverage).toBe('unloaded');
    // The earliest loaded event is not a coverage statement and must not be
    // used as one: an empty previous window here is unknown, not quiet.
    expect(result.note).toMatch(/not.*loaded|outside/i);
    expect(result.note).not.toMatch(/no (work|activity)/i);
  });

  it('makes no comprehensive claim when the current period is outside the loaded bounds', () => {
    // The previous window being covered says nothing about the current one.
    // Gating on it alone published an authoritative delta over a current period
    // the sources never retrieved.
    const m = build([event('c1', 'a', DAY(2)), event('p1', 'a', new Date(2026, 7, 29, 10).getTime())], {
      startMs: PREVIOUS.startMs,
      endMs: PREVIOUS.endMs,
      complete: true,
    });

    const result = comparePeriods(m, RANGE, PREVIOUS, {});

    expect(result.previousCoverage).toBe('covered');
    expect(result.currentCoverage).toBe('unloaded');
    expect(result.comparable).toBe(false);
    expect(result.deltaBasis).toBeNull();
    expect(result.deltaEvents).toBeNull();
    // Counts are still reported: they are what was loaded, which is a fact.
    expect(result.current).toMatchObject({ events: 1 });
    expect(result.previous).toMatchObject({ events: 1 });
  });

  it('drops to an observed comparison when the current period only partly fits', () => {
    const m = build([event('c1', 'a', DAY(2)), event('p1', 'a', new Date(2026, 7, 29, 10).getTime())], {
      startMs: PREVIOUS.startMs,
      endMs: new Date(2026, 8, 3, 12).getTime(),
      complete: true,
    });

    const result = comparePeriods(m, RANGE, PREVIOUS, {});

    expect(result.currentCoverage).toBe('partial');
    expect(result.comparable).toBe(false);
    expect(result.deltaBasis).toBe('observed');
    expect(result.deltaEvents).toBe(0);
    // The note has to withhold the claim explicitly, not merely omit it.
    expect(result.note).toMatch(/loaded rather than everything that happened/i);
    expect(result.note).not.toMatch(/(?<!rather than )everything that happened/i);
  });

  it('treats unestablished retrieval bounds as unknown, not as an unloaded period', () => {
    // The shell passes startMs 0 / complete false when some source cannot state
    // its bounds. Reading that as "the previous period was never loaded" would
    // turn one source's silence into a claim about every source.
    const m = build([event('c1', 'a', DAY(2)), event('p1', 'a', new Date(2026, 7, 29, 10).getTime())], {
      startMs: 0,
      endMs: DAY(6, 12),
      complete: false,
      reason: 'Some sources do not report how far back they retrieved.',
    });

    const result = comparePeriods(m, RANGE, PREVIOUS, {});

    expect(result.previousCoverage).toBe('unknown');
    expect(result.currentCoverage).toBe('unknown');
    expect(result.previous).toMatchObject({ events: 1 });
    expect(result.deltaBasis).toBe('observed');
    expect(result.deltaEvents).toBe(0);
    expect(result.comparable).toBe(false);
    expect(result.note).toContain('Some sources do not report how far back they retrieved.');
    expect(result.note).not.toMatch(/outside what the sources loaded/i);
  });

  it('refuses a delta when the comparison window is not the same length', () => {
    const m = build([event('c1', 'a', DAY(2))]);
    const shorter = { startMs: PREVIOUS.startMs, endMs: PREVIOUS.endMs - 86_400_000 };

    const result = comparePeriods(m, RANGE, shorter, {});

    expect(result.comparable).toBe(false);
    expect(result.equalDuration).toBe(false);
    expect(result.deltaEvents).toBeNull();
  });

  it('reports an empty covered previous period as an absence of records, not of work', () => {
    const m = build([event('c1', 'a', DAY(2))], {
      startMs: PREVIOUS.startMs,
      endMs: RANGE.endMs,
      complete: true,
    });

    const result = comparePeriods(m, RANGE, PREVIOUS, {});

    expect(result.comparable).toBe(true);
    expect(result.previous).toMatchObject({ events: 0, artifacts: 0 });
    expect(result.deltaEvents).toBe(1);
    expect(result.note).toMatch(/no loaded events/i);
    expect(result.note).not.toMatch(/nothing happened|inactiv/i);
  });
});
