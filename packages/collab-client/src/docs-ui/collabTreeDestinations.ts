/**
 * The sidebar page tree as rows for a destination picker: same nodes, nesting,
 * names and icons as the tree, so a location is found the way it is in the
 * sidebar. Type collections hold only their own items, so they are shown (the
 * structure has to match) but cannot be picked.
 */
import type { CollabDocumentTypeDescriptor } from '@nimbalyst/collab-client/core';
import { pageDisplayName, type CollabTreeNode, type SharedParentKind } from '@nimbalyst/collab-client/docs';
import { resolveSharedDocumentTypePresentation } from './documentPresentation';

export interface CollabTreeDestination {
  /** The tree row id (`document:`, `item:`, `type:`, `folder:`). */
  key: string;
  /** What a create writes as the parent. */
  parentId: string | null;
  parentKind: SharedParentKind;
  name: string;
  depth: number;
  icon: string;
  /** Icon while expanded, for rows drawn as folders. */
  expandedIcon?: string;
  /** Faint trailing label: a typed page's type, a type's item count. */
  hint?: string;
  selectable: boolean;
  /** Row keys above this one, outermost first. */
  ancestorKeys: string[];
  hasChildren: boolean;
}

export function buildCollabTreeDestinations(
  tree: CollabTreeNode[],
  descriptors: readonly CollabDocumentTypeDescriptor[],
): CollabTreeDestination[] {
  const rows: CollabTreeDestination[] = [];
  const walk = (nodes: CollabTreeNode[], ancestorKeys: string[]) => {
    for (const node of nodes) {
      const children = 'children' in node ? node.children ?? [] : [];
      const base = { key: node.id, depth: ancestorKeys.length, ancestorKeys, hasChildren: children.length > 0 };
      if (node.type === 'document') {
        // Matches the sidebar: a page holding pages that was never written reads as a folder.
        const asFolder = base.hasChildren && node.document.hasContent === false;
        rows.push({
          ...base,
          parentId: node.document.documentId,
          parentKind: 'page',
          name: pageDisplayName(node.name, node.document.documentType),
          icon: asFolder ? 'folder' : resolveSharedDocumentTypePresentation(node.document, descriptors).icon,
          ...(asFolder ? { expandedIcon: 'folder_open' } : {}),
          selectable: node.document.decryptFailed !== true,
        });
      } else if (node.type === 'item') {
        rows.push({
          ...base,
          parentId: node.itemId,
          parentKind: 'item',
          name: node.name,
          icon: 'description',
          ...(node.typeLabel ? { hint: node.typeLabel } : {}),
          selectable: true,
        });
      } else if (node.type === 'type') {
        rows.push({
          ...base,
          parentId: null,
          parentKind: 'page',
          name: node.name,
          icon: 'table',
          ...(node.count > 0 ? { hint: String(node.count) } : {}),
          selectable: false,
        });
      } else {
        rows.push({
          ...base,
          parentId: node.folderId ?? null,
          parentKind: 'page',
          name: node.name,
          icon: 'folder',
          expandedIcon: 'folder_open',
          selectable: !!node.folderId,
        });
      }
      walk(children, [...ancestorKeys, node.id]);
    }
  };
  walk(tree, []);
  return rows;
}
