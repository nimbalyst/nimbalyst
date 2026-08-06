/**
 * Project Graph domain model.
 *
 * The graph is one canonical model with typed nodes and edges. Different
 * "views" are filtered projections over the same graph -- not separate graphs.
 */

/**
 * Built-in node categories. Project config may introduce additional
 * categories at runtime; treat this as the well-known set, not the closed set.
 */
export type BuiltinNodeCategory =
  | 'strategy'
  | 'delivery'
  | 'knowledge'
  | 'people'
  | 'external'
  | 'system';

export type NodeCategory = BuiltinNodeCategory | (string & {});

export type NodeSource =
  | 'tracker'
  | 'session'
  | 'file'
  | 'git'
  | 'external'
  | 'system';

export type NodeVisibility = 'local' | 'workspace-shared' | 'team-shared' | 'imported';

export type NodeShape = 'pill' | 'card' | 'hex' | 'dot' | 'stack';

/**
 * A schema entry describes one node type: its label, color, where it sits in
 * the category sidebar, what shape it draws as, and which child types and
 * quick actions it exposes when selected.
 */
export interface GraphNodeTypeSchema {
  type: string;
  label: string;
  category: NodeCategory;
  colorToken: string;
  shape: NodeShape;
  childTypes?: string[];
  quickActions?: NodeQuickAction[];
}

export type NodeQuickAction =
  | 'open'
  | 'reveal-in-tracker'
  | 'open-file'
  | 'open-session'
  | 'launch-session'
  | 'launch-fix-session'
  | 'add-bug'
  | 'add-task'
  | 'add-feature'
  | 'link-existing';

export interface ProjectGraphNode {
  id: string;
  type: string;
  label: string;
  sublabel?: string;
  category: NodeCategory;
  source: NodeSource;
  visibility: NodeVisibility;
  status?: string;
  priority?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  progress?: number;
  /**
   * Tags / labels carried by the item (tracker `data.tags`/`data.labels`, plan
   * frontmatter `tags`). Drives the timeline's group-by-tag lanes. Undefined or
   * empty for untagged items.
   */
  tags?: string[];
  badges?: Array<{ key: string; value: string | number }>;
  counts?: Record<string, number>;
  /** Optional default x/y layout coordinates (in canvas units). */
  x?: number;
  y?: number;
  /** Optional cluster id used by the layout / halos. */
  cluster?: string;
  /**
   * Epoch ms when this node "appeared" in the project. Drives the timeline
   * animation: nodes are hidden until the playhead reaches `createdAt`. May be
   * undefined for nodes without a clear birth date (planAdapter, docAdapter);
   * the loader will fill in a derived value where possible.
   */
  createdAt?: number;
  /**
   * Epoch ms when this node entered a terminal state (bug closed, session
   * completed). After this timestamp the canvas desaturates the node but keeps
   * it visible so the topology stays stable. Undefined = still active.
   */
  closedAt?: number;
  /** Arbitrary metadata for the inspector. */
  fields?: Record<string, unknown>;
}

export type EdgeType =
  | 'contains'
  | 'implements'
  | 'planned_by'
  | 'designed_by'
  | 'documents'
  | 'depends_on'
  | 'blocked_by'
  | 'related_to'
  | 'requested_by'
  | 'reported_by'
  | 'owned_by'
  | 'worked_on_in'
  | 'edited_in'
  | 'touches'
  | 'fixes'
  | 'closes'
  | 'references'
  | 'generated'
  | 'reviewed_in'
  | 'part_of';

export interface ProjectGraphEdge {
  id: string;
  type: EdgeType;
  sourceId: string;
  targetId: string;
  strength?: number;
  label?: string;
}

export interface ProjectGraphSnapshot {
  generatedAt: number;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    countsByType: Record<string, number>;
  };
}

/**
 * A view is a filter + framing over the canonical graph.
 */
export interface GraphViewDefinition {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  includedTypes?: string[];
  hiddenStatuses?: string[];
  rollupMode?: 'none' | 'progress' | 'quality' | 'delivery';
  edgeTypes?: EdgeType[];
  emphasizeCategories?: NodeCategory[];
}

export interface CategoryGroup {
  id: NodeCategory;
  label: string;
  types: GraphNodeTypeSchema[];
}
