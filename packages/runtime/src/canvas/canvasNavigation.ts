import type { CanvasDocument } from './CanvasDocument';
import { canvasCardLabel } from './canvasFlowMapping';

export interface CanvasNavigationItem {
  nodeId: string;
  parentId: string | null;
  label: string;
}

/** Explicit order/containment, independent of geometry, selection and flow edges. */
export function readCanvasNavigation(
  document: CanvasDocument
): CanvasNavigationItem[] {
  const raw = document['x-nimbalyst']?.navigation;
  if (!Array.isArray(raw)) return [];
  const nodes = new Map((document.nodes ?? []).map((node) => [node.id, node]));
  const seen = new Set<string>();
  const items: CanvasNavigationItem[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const { nodeId, parentId } = value as Record<string, unknown>;
    if (typeof nodeId !== 'string' || seen.has(nodeId)) continue;
    const node = nodes.get(nodeId);
    if (!node) continue;
    seen.add(nodeId);
    items.push({
      nodeId,
      parentId: typeof parentId === 'string' ? parentId : null,
      label: canvasCardLabel(node) || nodeId,
    });
  }
  const byId = new Map(items.map((item) => [item.nodeId, item]));
  // A removed parent promotes its surviving children. Break malformed cycles
  // rather than trapping a reader in an endless breadcrumb or Up operation.
  for (const item of items) {
    const ancestors = new Set([item.nodeId]);
    let parent = item.parentId;
    while (parent !== null) {
      if (ancestors.has(parent) || !byId.has(parent)) {
        item.parentId = null;
        break;
      }
      ancestors.add(parent);
      parent = byId.get(parent)!.parentId;
    }
  }
  return items;
}
