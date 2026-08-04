import type { ProjectGraphEdge, ProjectGraphNode } from '../types';
import { dirLabel, dirNodeId, moduleForPath, moduleParentId } from './paths';

/**
 * Edge enrichment: the per-adapter passes only know about their own slice of the
 * graph, so cross-cutting structure (which module a plan documents, how a
 * package's split areas nest) is added here, once, over the merged node set.
 *
 * Two kinds of structure are derived:
 *   1. Module containment — a split package area (`packages/electron/main`)
 *      becomes a child of its package (`packages/electron`), synthesizing the
 *      package node if no file landed directly in it. This turns the flat module
 *      list into a navigable tree and gives a layout real hub structure.
 *   2. `part_of` — any node carrying a file path (plans, docs, path-backed
 *      tracker items) is linked to the module that path rolls up to, so the
 *      file-derived "knowledge" nodes stop floating free of the code.
 *
 * Inline tracker items with no path and no links (most bugs/decisions, and all
 * content items like blogs/videos) genuinely have nothing to attach to and stay
 * isolated — that's a data fact, not a layout bug.
 */

function synthModuleNode(moduleId: string): ProjectGraphNode {
  return {
    id: dirNodeId(moduleId),
    type: 'directory',
    label: dirLabel(moduleId),
    sublabel: moduleId,
    category: 'knowledge',
    source: 'file',
    visibility: 'workspace-shared',
    fields: { path: moduleId, rollup: true, synthetic: true },
  };
}

/** The file path a node represents, if any (commits store a hash, not a path). */
function pathForNode(node: ProjectGraphNode): string | null {
  if (node.type === 'directory' || node.type === 'commit') return null;
  const p = node.fields?.path;
  if (typeof p === 'string' && (p.includes('/') || p.includes('.'))) return p;
  const dp = node.fields?.documentPath;
  if (typeof dp === 'string' && dp.trim()) return dp;
  return null;
}

export function enrichGraph(
  nodeById: Map<string, ProjectGraphNode>,
  edges: ProjectGraphEdge[],
  workspacePath: string,
): void {
  const edgeIds = new Set(edges.map(e => e.id));
  const addEdge = (id: string, type: ProjectGraphEdge['type'], sourceId: string, targetId: string) => {
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, type, sourceId, targetId });
  };

  // 1. Module containment (synthesize package parents as needed).
  for (const node of [...nodeById.values()]) {
    if (node.type !== 'directory') continue;
    const moduleId = typeof node.fields?.path === 'string' ? node.fields.path : null;
    if (!moduleId) continue;
    const parent = moduleParentId(moduleId);
    if (!parent) continue;
    const parentId = dirNodeId(parent);
    if (!nodeById.has(parentId)) nodeById.set(parentId, synthModuleNode(parent));
    addEdge(`${parentId}=>contains=>${node.id}`, 'contains', parentId, node.id);
  }

  // 2. path-backed node -> module (`part_of`).
  for (const node of nodeById.values()) {
    const path = pathForNode(node);
    if (!path) continue;
    const moduleId = moduleForPath(path, workspacePath);
    if (!moduleId) continue;
    const moduleNodeId = dirNodeId(moduleId);
    if (moduleNodeId === node.id || !nodeById.has(moduleNodeId)) continue;
    addEdge(`${node.id}=>part_of=>${moduleNodeId}`, 'part_of', node.id, moduleNodeId);
  }
}
