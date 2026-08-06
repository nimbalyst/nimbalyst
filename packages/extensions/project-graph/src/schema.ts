import type { CategoryGroup, GraphNodeTypeSchema, GraphViewDefinition } from './types';

/**
 * Catch-all category for user-defined tracker types that have no curated
 * built-in category. Keeps custom types (blog, video, idea, ...) grouped and
 * toggleable in the sidebar instead of vanishing into an unrendered category.
 */
export const TRACKER_CATEGORY = 'tracker';

/**
 * Built-in node type schemas. Custom tracker types should be appended to this
 * list when the tracker adapter is wired up.
 */
export const BUILTIN_NODE_TYPES: GraphNodeTypeSchema[] = [
  // Strategy
  { type: 'objective', label: 'Objective', category: 'strategy', colorToken: '--pg-c-objective', shape: 'pill', childTypes: ['initiative', 'project'], quickActions: ['open', 'add-feature'] },
  { type: 'initiative', label: 'Initiative', category: 'strategy', colorToken: '--pg-c-initiative', shape: 'pill', childTypes: ['project', 'feature', 'plan'], quickActions: ['open'] },
  { type: 'project', label: 'Project', category: 'strategy', colorToken: '--pg-c-project', shape: 'pill', childTypes: ['module', 'plan'], quickActions: ['open'] },
  { type: 'module', label: 'Module', category: 'strategy', colorToken: '--pg-c-module', shape: 'card', childTypes: ['feature', 'bug', 'task', 'markdown-doc'], quickActions: ['launch-session', 'add-bug', 'add-feature'] },
  { type: 'feature', label: 'Feature', category: 'strategy', colorToken: '--pg-c-feature', shape: 'card', childTypes: ['task', 'bug', 'plan'], quickActions: ['launch-session', 'add-task', 'add-bug'] },
  { type: 'plan', label: 'Plan', category: 'strategy', colorToken: '--pg-c-plan', shape: 'card', quickActions: ['open'] },
  { type: 'decision', label: 'Decision', category: 'strategy', colorToken: '--pg-c-decision', shape: 'card', quickActions: ['open'] },
  { type: 'architecture-doc', label: 'Architecture doc', category: 'strategy', colorToken: '--pg-c-architecture', shape: 'card', quickActions: ['open'] },

  // Delivery
  { type: 'task', label: 'Task', category: 'delivery', colorToken: '--pg-c-task', shape: 'pill', quickActions: ['open', 'reveal-in-tracker'] },
  { type: 'bug', label: 'Bug', category: 'delivery', colorToken: '--pg-c-bug', shape: 'dot', quickActions: ['launch-fix-session', 'reveal-in-tracker'] },
  { type: 'incident', label: 'Incident', category: 'delivery', colorToken: '--pg-c-incident', shape: 'dot', quickActions: ['open', 'launch-fix-session'] },
  { type: 'github-issue', label: 'GitHub issue', category: 'delivery', colorToken: '--pg-c-github-issue', shape: 'dot', quickActions: ['open'] },
  { type: 'github-pr', label: 'GitHub PR', category: 'delivery', colorToken: '--pg-c-github-pr', shape: 'pill', quickActions: ['open'] },
  { type: 'ai-session', label: 'AI session', category: 'delivery', colorToken: '--pg-c-session', shape: 'pill', quickActions: ['open-session'] },
  { type: 'commit', label: 'Commit', category: 'delivery', colorToken: '--pg-c-commit', shape: 'dot' },

  // Knowledge
  { type: 'markdown-doc', label: 'Markdown doc', category: 'knowledge', colorToken: '--pg-c-doc', shape: 'card', quickActions: ['open-file'] },
  { type: 'directory', label: 'Directory', category: 'knowledge', colorToken: '--pg-c-file', shape: 'pill', quickActions: ['open-file'] },
  { type: 'file', label: 'File', category: 'knowledge', colorToken: '--pg-c-file', shape: 'pill', quickActions: ['open-file'] },

  // People
  { type: 'collaborator', label: 'Collaborator', category: 'people', colorToken: '--pg-c-collaborator', shape: 'dot' },
  { type: 'customer', label: 'Customer', category: 'people', colorToken: '--pg-c-customer', shape: 'dot' },
];

export function getTypeSchema(types: GraphNodeTypeSchema[], type: string): GraphNodeTypeSchema | undefined {
  return types.find(t => t.type === type);
}

export function groupTypesByCategory(
  types: GraphNodeTypeSchema[],
  extraCategories: Array<{ id: string; label: string }> = [],
): CategoryGroup[] {
  const builtinCategories: Array<{ id: CategoryGroup['id']; label: string }> = [
    { id: 'strategy', label: 'Strategy' },
    { id: 'delivery', label: 'Delivery' },
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'people', label: 'People' },
    { id: TRACKER_CATEGORY, label: 'Trackers' },
    { id: 'external', label: 'External' },
  ];
  const categories = [
    ...builtinCategories,
    ...extraCategories.map(c => ({ id: c.id as CategoryGroup['id'], label: c.label })),
  ];
  return categories
    .map(c => ({
      id: c.id,
      label: c.label,
      types: types.filter(t => t.category === (c.id as string)),
    }))
    .filter(group => group.types.length > 0);
}

/**
 * Built-in saved views.
 */
export const BUILTIN_VIEWS: GraphViewDefinition[] = [
  {
    id: 'everything',
    name: 'Everything',
    description: 'Every node type the adapters loaded',
    builtin: true,
    // includedTypes left undefined → all types are shown
  },
  {
    id: 'pm-big-picture',
    name: 'PM Big Picture',
    description: 'Objectives, initiatives, projects, modules, features',
    builtin: true,
    includedTypes: ['objective', 'initiative', 'project', 'module', 'feature', 'plan', 'customer'],
    rollupMode: 'progress',
    emphasizeCategories: ['strategy'],
  },
  {
    id: 'architecture',
    name: 'Architecture',
    description: 'Modules, architecture docs, decisions, key plans',
    builtin: true,
    includedTypes: ['project', 'module', 'feature', 'architecture-doc', 'decision', 'plan', 'markdown-doc'],
    emphasizeCategories: ['strategy', 'knowledge'],
  },
  {
    id: 'quality',
    name: 'Quality',
    description: 'Bugs, incidents, modules, sessions, files',
    builtin: true,
    includedTypes: ['module', 'bug', 'incident', 'ai-session', 'commit', 'file', 'github-issue'],
    rollupMode: 'quality',
    emphasizeCategories: ['delivery'],
  },
  {
    id: 'delivery',
    name: 'Delivery',
    description: 'Plans, tasks, bugs, sessions, commits, PRs',
    builtin: true,
    includedTypes: ['plan', 'feature', 'task', 'bug', 'ai-session', 'commit', 'github-pr'],
    rollupMode: 'delivery',
    emphasizeCategories: ['delivery', 'strategy'],
  },
  {
    id: 'customer-impact',
    name: 'Customer Impact',
    description: 'Customers, requested features, modules they touch',
    builtin: true,
    includedTypes: ['customer', 'feature', 'module', 'plan', 'bug'],
    emphasizeCategories: ['people', 'strategy'],
  },
  {
    id: 'recent-execution',
    name: 'Recent Execution',
    description: 'Recent sessions, commits, edited files, closed bugs',
    builtin: true,
    includedTypes: ['ai-session', 'commit', 'file', 'bug', 'github-pr', 'feature'],
    emphasizeCategories: ['delivery'],
  },
];
