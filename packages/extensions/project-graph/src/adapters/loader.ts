import type { PanelHost } from '@nimbalyst/extension-sdk';
import type { ProjectGraphEdge, ProjectGraphNode, ProjectGraphSnapshot, GraphNodeTypeSchema } from '../types';
import { gitAdapter } from './gitAdapter';
import { planAdapter } from './planAdapter';
import { docAdapter } from './docAdapter';
import { githubAdapter } from './githubAdapter';
import { databaseAdapter } from './databaseAdapter';
import { applyDeterministicLayout, type LayoutClusterInfo } from './layout';
import { applyHybridLayout } from './forceLayout';
import { enrichGraph } from './enrich';
import { BUILTIN_NODE_TYPES } from '../schema';

export type GraphLayoutMode = 'inventory' | 'map';

export interface SnapshotDiagnostics {
  adapters: Array<{ id: string; label: string; status: 'ok' | 'unavailable' | 'error'; message?: string; nodes: number; edges: number }>;
  generatedAt: number;
}

export interface LoadedSnapshot {
  snapshot: ProjectGraphSnapshot;
  diagnostics: SnapshotDiagnostics;
  clusters: LayoutClusterInfo[];
}

/**
 * Run every adapter in parallel, dedupe nodes by id (first writer wins for the
 * node itself, but later edges still attach), apply the deterministic layout,
 * and return both a snapshot and diagnostics about which adapters ran.
 */
export async function loadProjectSnapshot(
  host: PanelHost,
  typeSchemas: GraphNodeTypeSchema[] = BUILTIN_NODE_TYPES,
  layoutMode: GraphLayoutMode = 'inventory',
): Promise<LoadedSnapshot> {
  const adapters = [planAdapter, docAdapter, gitAdapter, githubAdapter, databaseAdapter];
  const results = await Promise.all(adapters.map(async a => {
    const r = await a.run(host).catch(err => ({
      nodes: [],
      edges: [],
      status: 'error' as const,
      message: String(err),
    }));
    return { adapter: a, result: r };
  }));

  const nodeById = new Map<string, ProjectGraphNode>();
  const edges: ProjectGraphEdge[] = [];
  for (const { result } of results) {
    for (const node of result.nodes) {
      if (!nodeById.has(node.id)) nodeById.set(node.id, node);
    }
    for (const edge of result.edges) edges.push(edge);
  }

  // Derive cross-cutting structure no single adapter can see: module containment
  // and path-backed nodes -> their module. May add synthetic parent module nodes.
  enrichGraph(nodeById, edges, host.workspacePath);

  // Drop edges that point at nodes no adapter produced (defensive — keeps the
  // canvas from rendering dangling arrows when an adapter is unavailable).
  const filteredEdges = edges.filter(e => nodeById.has(e.sourceId) && nodeById.has(e.targetId));

  // Fill in createdAt for nodes that lack a native date (files, directories,
  // plans, docs) by taking the earliest createdAt among their dated neighbors.
  // Native dates (commits, sessions, trackers) are never overwritten. Two
  // passes lets a directory pick up a session's date that itself derived from
  // a commit in the first pass — though in practice every dated neighbor lands
  // in pass one.
  for (let pass = 0; pass < 2; pass++) {
    const earliest = new Map<string, number>();
    for (const e of filteredEdges) {
      const a = nodeById.get(e.sourceId);
      const b = nodeById.get(e.targetId);
      if (!a || !b) continue;
      if (a.createdAt != null && b.createdAt == null) {
        const cur = earliest.get(b.id);
        if (cur == null || a.createdAt < cur) earliest.set(b.id, a.createdAt);
      }
      if (b.createdAt != null && a.createdAt == null) {
        const cur = earliest.get(a.id);
        if (cur == null || b.createdAt < cur) earliest.set(a.id, b.createdAt);
      }
    }
    if (earliest.size === 0) break;
    for (const [id, t] of earliest) {
      const n = nodeById.get(id);
      if (n && n.createdAt == null) n.createdAt = t;
    }
  }

  const allNodes = Array.from(nodeById.values());
  const layout = layoutMode === 'map'
    ? applyHybridLayout(allNodes, filteredEdges, typeSchemas)
    : applyDeterministicLayout(allNodes, typeSchemas);

  const countsByType: Record<string, number> = {};
  for (const n of layout.nodes) countsByType[n.type] = (countsByType[n.type] ?? 0) + 1;

  const snapshot: ProjectGraphSnapshot = {
    generatedAt: Date.now(),
    nodes: layout.nodes,
    edges: filteredEdges,
    stats: {
      nodeCount: layout.nodes.length,
      edgeCount: filteredEdges.length,
      countsByType,
    },
  };

  const diagnostics: SnapshotDiagnostics = {
    generatedAt: snapshot.generatedAt,
    adapters: results.map(({ adapter, result }) => ({
      id: adapter.id,
      label: adapter.label,
      status: result.status,
      message: result.message,
      nodes: result.nodes.length,
      edges: result.edges.length,
    })),
  };

  return { snapshot, diagnostics, clusters: layout.clusters };
}
