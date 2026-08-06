import type { ProjectGraphEdge, ProjectGraphNode, ProjectGraphSnapshot } from '../types';

/**
 * Sample graph used as a placeholder until the real source adapters
 * (tracker, session, file/doc, git, external) are wired up through the
 * extension SDK's host APIs.
 *
 * The shape and field names match the canonical model so the canvas, sidebar,
 * inspector, and views all render against the real production model.
 */
const N = (
  id: string,
  type: ProjectGraphNode['type'],
  label: string,
  rest: Partial<ProjectGraphNode> = {},
): ProjectGraphNode => ({
  id,
  type,
  label,
  category: rest.category ?? 'strategy',
  source: rest.source ?? 'system',
  visibility: rest.visibility ?? 'workspace-shared',
  ...rest,
});

const E = (id: string, type: ProjectGraphEdge['type'], sourceId: string, targetId: string, label?: string): ProjectGraphEdge => ({
  id,
  type,
  sourceId,
  targetId,
  label,
});

const nodes: ProjectGraphNode[] = [
  // Strategy
  N('obj-1', 'objective', 'Q3 Adoption', { category: 'strategy', progress: 67, x: 200, y: 140, cluster: 'strategy' }),
  N('init-1', 'initiative', 'Extension System', { category: 'strategy', progress: 52, x: 330, y: 260, cluster: 'strategy' }),
  N('proj-1', 'project', 'Nimbalyst', { category: 'strategy', x: 480, y: 360, cluster: 'strategy' }),

  N('plan-1', 'plan', 'Whole Project Graph', { category: 'strategy', status: 'draft', source: 'file', x: 180, y: 380 }),
  N('arch-1', 'architecture-doc', 'Sync Architecture', { category: 'knowledge', sublabel: '4 ADRs', source: 'file', x: 280, y: 540 }),

  // Modules (delivery hub)
  N('mod-services', 'module', 'services', {
    category: 'strategy',
    progress: 62,
    sublabel: 'Module · 14 features · health 62%',
    x: 640,
    y: 420,
    cluster: 'services',
    counts: { feature: 14, bug: 8, 'ai-session': 23, 'markdown-doc': 9, task: 17 },
    fields: { path: 'packages/electron/services', owner: '@greghinkle' },
  }),
  N('mod-renderer', 'module', 'renderer', { category: 'strategy', progress: 92, x: 720, y: 545 }),
  N('mod-extensions', 'module', 'extensions', { category: 'strategy', progress: 78, x: 940, y: 280 }),

  // Features
  N('feat-graph', 'feature', 'Project graph', { category: 'strategy', status: 'in-progress', x: 870, y: 470 }),
  N('feat-tracker-sync', 'feature', 'Tracker sync v3', { category: 'strategy', status: 'shipped', x: 840, y: 585 }),
  N('feat-marketplace', 'feature', 'Marketplace install', { category: 'strategy', status: 'in-review', x: 1000, y: 420 }),

  // Tasks / bugs
  N('task-cluster', 'task', '+ 5 tasks', { category: 'delivery', x: 990, y: 490, sublabel: 'Task cluster' }),

  N('bug-1', 'bug', 'P0 sync stall', { category: 'delivery', severity: 'critical', x: 440, y: 640, cluster: 'bug-cluster' }),
  N('bug-2', 'bug', 'document flicker', { category: 'delivery', severity: 'high', x: 490, y: 670, cluster: 'bug-cluster' }),
  N('bug-3', 'bug', 'tracker import retries', { category: 'delivery', severity: 'high', x: 540, y: 660, cluster: 'bug-cluster' }),
  N('bug-4', 'bug', 'panel scroll regression', { category: 'delivery', severity: 'medium', x: 540, y: 690, cluster: 'bug-cluster' }),
  N('bug-5', 'bug', 'reconnect loop', { category: 'delivery', severity: 'medium', x: 580, y: 670, cluster: 'bug-cluster' }),

  // AI sessions
  N('sess-7a3', 'ai-session', 'session 7a3', { category: 'delivery', source: 'session', x: 190, y: 650 }),
  N('sess-2c1', 'ai-session', 'sess 2c1', { category: 'delivery', source: 'session', x: 120, y: 690 }),

  // Files
  N('file-pg', 'file', 'ProjectGraph.tsx', { category: 'knowledge', source: 'file', x: 70, y: 740 }),
  N('file-svc', 'file', 'Service.ts', { category: 'knowledge', source: 'file', x: 130, y: 770 }),

  // Commits
  N('commit-1', 'commit', 'c', { category: 'delivery', source: 'git', x: 370, y: 580 }),
  N('commit-2', 'commit', 'c', { category: 'delivery', source: 'git', x: 345, y: 605 }),

  // PR / issue
  N('pr-312', 'github-pr', '#312', { category: 'delivery', source: 'external', x: 570, y: 520 }),
  N('issue-1', 'github-issue', 'i', { category: 'delivery', source: 'external', x: 610, y: 450 }),

  // Customers
  N('cust-1', 'customer', 'Acme', { category: 'people', source: 'external', x: 1090, y: 580 }),
  N('cust-2', 'customer', 'Beta Co', { category: 'people', source: 'external', x: 1100, y: 620 }),
  N('cust-3', 'customer', 'Gamma', { category: 'people', source: 'external', x: 1060, y: 640 }),

  // Collaborators
  N('coll-1', 'collaborator', 'Greg', { category: 'people', source: 'external', x: 1090, y: 200 }),
  N('coll-2', 'collaborator', 'Jess', { category: 'people', source: 'external', x: 1110, y: 230 }),
];

const edges: ProjectGraphEdge[] = [
  E('e1', 'contains', 'obj-1', 'init-1'),
  E('e2', 'contains', 'init-1', 'proj-1'),
  E('e3', 'contains', 'proj-1', 'mod-services', 'contains'),
  E('e4', 'contains', 'proj-1', 'mod-renderer'),
  E('e5', 'contains', 'proj-1', 'mod-extensions'),
  E('e6', 'planned_by', 'init-1', 'plan-1'),
  E('e7', 'designed_by', 'mod-services', 'arch-1'),

  E('e8', 'contains', 'mod-services', 'feat-graph'),
  E('e9', 'contains', 'mod-services', 'feat-tracker-sync'),
  E('e10', 'contains', 'mod-extensions', 'feat-marketplace'),
  E('e11', 'implements', 'feat-graph', 'task-cluster'),

  E('e12', 'related_to', 'mod-services', 'bug-1', 'worked_on_in'),
  E('e13', 'related_to', 'mod-services', 'bug-2'),
  E('e14', 'worked_on_in', 'bug-1', 'sess-7a3'),
  E('e15', 'worked_on_in', 'bug-3', 'sess-2c1'),
  E('e16', 'edited_in', 'sess-7a3', 'file-pg'),
  E('e17', 'edited_in', 'sess-7a3', 'file-svc'),
  E('e18', 'generated', 'sess-7a3', 'commit-1'),
  E('e19', 'generated', 'sess-2c1', 'commit-2'),
  E('e20', 'closes', 'pr-312', 'issue-1'),
  E('e21', 'references', 'commit-1', 'pr-312'),

  E('e22', 'requested_by', 'cust-1', 'feat-graph'),
  E('e23', 'requested_by', 'cust-2', 'feat-marketplace'),

  E('e24', 'owned_by', 'mod-extensions', 'coll-1'),
];

export const SAMPLE_SNAPSHOT: ProjectGraphSnapshot = {
  generatedAt: Date.now(),
  nodes,
  edges,
  stats: {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    countsByType: nodes.reduce<Record<string, number>>((acc, n) => {
      acc[n.type] = (acc[n.type] ?? 0) + 1;
      return acc;
    }, {}),
  },
};
