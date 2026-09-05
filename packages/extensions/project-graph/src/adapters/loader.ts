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
  /**
   * Every relation the adapters recorded, INCLUDING ones whose endpoint is not
   * in `snapshot.nodes` because it fell outside this bounded snapshot.
   *
   * `snapshot.edges` stays filtered: the canvas cannot draw an arrow to a node
   * it does not have. But dropping the relation entirely made "the sources
   * recorded no link" indistinguishable from "the other end was not loaded",
   * which is the false-absence claim the September 5 review flagged. Consumers
   * that describe absence must read this, not `snapshot.edges`.
   */
  rawEdges: ProjectGraphEdge[];
  /** Ids within {@link rawEdges} whose source or target is not loaded. */
  unresolvedEdgeIds: string[];
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

  // Filtering happens at the LAYOUT boundary only: the canvas cannot draw an
  // arrow to a node it does not have. The unfiltered set is returned alongside
  // so callers can distinguish an unloaded endpoint from a missing relation.
  const resolved = (e: ProjectGraphEdge) => nodeById.has(e.sourceId) && nodeById.has(e.targetId);
  const filteredEdges = edges.filter(resolved);
  const unresolvedEdgeIds = edges.filter(e => !resolved(e)).map(e => e.id);

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

  return { snapshot, diagnostics, clusters: layout.clusters, rawEdges: edges, unresolvedEdgeIds };
}
