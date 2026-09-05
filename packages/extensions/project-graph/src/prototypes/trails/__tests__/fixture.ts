/**
 * Shared fixture for the Trails prototype tests.
 *
 * Mirrors the relation vocabulary the live adapters actually emit — a tracker
 * item linked to a session and a commit, a session that edited a directory, a
 * plan attached to a directory only by path, a dangling `closes` edge, and one
 * record with no recorded connection at all.
 */

import type { ProjectGraphEdge, ProjectGraphNode } from '../../../types';
import type { PrototypeModel, PrototypeRange } from '../../contracts';

const DAY = 86_400_000;
export const NOW = Date.UTC(2026, 8, 4);
export const RANGE: PrototypeRange = { startMs: NOW - 6 * DAY, endMs: NOW };

const nodes: ProjectGraphNode[] = [
  {
    id: 'tracker:bug1',
    type: 'bug',
    label: 'NIM-1 tracker body lost on reload',
    category: 'delivery',
    source: 'tracker',
    visibility: 'workspace-shared',
    status: 'in-review',
    createdAt: NOW - 300 * DAY,
  },
  {
    id: 'session:s1',
    type: 'session',
    label: 'Body cache repair session',
    category: 'delivery',
    source: 'session',
    visibility: 'local',
    createdAt: NOW - 4 * DAY,
  },
  {
    id: 'session:s2',
    type: 'session',
    label: 'Older triage session',
    category: 'delivery',
    source: 'session',
    visibility: 'local',
    createdAt: NOW - 90 * DAY,
  },
  {
    id: 'commit:c1',
    type: 'commit',
    label: 'fix: persist tracker body',
    category: 'delivery',
    source: 'git',
    visibility: 'workspace-shared',
    createdAt: NOW - 3 * DAY,
  },
  {
    id: 'dir:packages/electron',
    type: 'directory',
    label: 'electron',
    sublabel: 'packages/electron',
    category: 'knowledge',
    source: 'file',
    visibility: 'workspace-shared',
  },
  {
    id: 'plan:tracker-body',
    type: 'plan',
    label: 'Tracker body sync plan',
    sublabel: 'packages/electron/plans/body.md',
    category: 'knowledge',
    source: 'file',
    visibility: 'workspace-shared',
    createdAt: NOW - 200 * DAY,
  },
  {
    id: 'tracker:lonely',
    type: 'decision',
    label: 'Use one write coordinator',
    category: 'knowledge',
    source: 'tracker',
    visibility: 'workspace-shared',
    createdAt: NOW - 30 * DAY,
  },
];

const edges: ProjectGraphEdge[] = [
  { id: 'e-bug-session1', type: 'worked_on_in', sourceId: 'tracker:bug1', targetId: 'session:s1' },
  { id: 'e-bug-session2', type: 'worked_on_in', sourceId: 'tracker:bug1', targetId: 'session:s2' },
  { id: 'e-bug-commit', type: 'fixes', sourceId: 'tracker:bug1', targetId: 'commit:c1' },
  { id: 'e-bug-plan', type: 'part_of', sourceId: 'tracker:bug1', targetId: 'dir:packages/electron' },
  // Dangling on purpose: githubAdapter emits closes edges to issues the
  // snapshot may never have loaded.
  { id: 'e-bug-issue', type: 'closes', sourceId: 'tracker:bug1', targetId: 'issue:999' },
  { id: 'e-session-dir', type: 'edited_in', sourceId: 'session:s1', targetId: 'dir:packages/electron', strength: 12 },
  { id: 'e-commit-dir', type: 'touches', sourceId: 'commit:c1', targetId: 'dir:packages/electron' },
  { id: 'e-plan-dir', type: 'part_of', sourceId: 'plan:tracker-body', targetId: 'dir:packages/electron' },
];

/**
 * A hub the size of a real directory node: one record every other record hangs
 * off. This is the shape that makes the original graph unreadable, so the view
 * has to stay bounded on it.
 */
export function makeLargeModel(count = 3000): PrototypeModel {
  const hub: ProjectGraphNode = {
    id: 'dir:hub',
    type: 'directory',
    label: 'packages',
    category: 'knowledge',
    source: 'file',
    visibility: 'workspace-shared',
  };
  const largeNodes: ProjectGraphNode[] = [hub];
  const largeEdges: ProjectGraphEdge[] = [];
  for (let i = 0; i < count; i += 1) {
    largeNodes.push({
      id: `session:${i}`,
      type: 'session',
      label: `Session ${i}`,
      category: 'delivery',
      source: 'session',
      visibility: 'local',
      createdAt: NOW - i * 3_600_000,
    });
    largeEdges.push({ id: `e${i}`, type: 'edited_in', sourceId: `session:${i}`, targetId: hub.id, strength: i % 7 });
  }
  return {
    snapshot: {
      generatedAt: NOW,
      nodes: largeNodes,
      edges: largeEdges,
      stats: { nodeCount: largeNodes.length, edgeCount: largeEdges.length, countsByType: {} },
    },
    nodeById: new Map(largeNodes.map(n => [n.id, n])),
    areas: [],
    memberships: new Map(),
    events: [],
    coverage: [],
    source: 'live',
  };
}

export interface FixtureOptions {
  /** Appended to the base edges; the base arrays are never mutated. */
  extraEdges?: ProjectGraphEdge[];
  extraNodes?: ProjectGraphNode[];
}

export function makeModel(
  overrides: Partial<PrototypeModel> = {},
  fixture: FixtureOptions = {},
): PrototypeModel {
  const allNodes = [...nodes, ...(fixture.extraNodes ?? [])];
  const allEdges = [...edges, ...(fixture.extraEdges ?? [])];
  const model: PrototypeModel = {
    snapshot: {
      generatedAt: NOW,
      nodes: allNodes,
      edges: allEdges,
      stats: { nodeCount: allNodes.length, edgeCount: allEdges.length, countsByType: {} },
    },
    nodeById: new Map(allNodes.map(n => [n.id, n])),
    areas: [
      {
        id: 'area:delivery',
        label: 'Delivery',
        nodeIds: ['tracker:bug1', 'session:s1', 'session:s2', 'commit:c1'],
        basis: 'tag rule: delivery',
      },
      { id: 'area:knowledge', label: 'Knowledge', nodeIds: ['plan:tracker-body'], basis: 'tag rule: knowledge' },
    ],
    memberships: new Map([
      ['tracker:bug1', [{ areaId: 'area:delivery', basis: 'tag "delivery" on the item' }]],
      ['plan:tracker-body', [{ areaId: 'area:knowledge', basis: 'plan frontmatter tag' }]],
    ]),
    events: [
      { id: 'ev1', nodeId: 'session:s1', at: NOW - 2 * DAY, kind: 'last-activity', label: 'Session activity', provenance: 'last-observed' },
      { id: 'ev2', nodeId: 'commit:c1', at: NOW - 3 * DAY, kind: 'commit', label: 'Commit authored', provenance: 'recorded' },
      { id: 'ev3', nodeId: 'session:s2', at: NOW - 90 * DAY, kind: 'created', label: 'Session created', provenance: 'recorded' },
      { id: 'ev4', nodeId: 'plan:tracker-body', at: NOW - 200 * DAY, kind: 'created', label: 'Plan created', provenance: 'recorded' },
    ],
    coverage: ['Commits limited to the most recent 500.'],
    source: 'live',
    ...overrides,
  };
  return model;
}
