/**
 * Keyboard handler for the flat virtualized file tree.
 *
 * Handles arrow navigation, expand/collapse, open/preview,
 * rename, delete, select-all, type-ahead find, and home/end/page navigation.
 */

import type { FlatTreeNode } from '../store';

export interface TreeActions {
  setFocused: (index: number | null) => void;
  expand: (path: string) => void;
  collapse: (path: string) => void;
  toggleExpand: (path: string) => void;
  openFile: (path: string) => void;
  startRename: (path: string) => void;
  deleteItems: (paths: string[]) => void;
  selectAll: () => void;
  clearSelection: () => void;
  extendSelection: (toIndex: number) => void;
  typeAhead: (char: string) => void;
  /** Number of rows visible in the viewport, for PageUp/PageDown */
  viewportRowCount: number;
}

/**
 * Get the paths that should be acted on (selected items, or just the focused item).
 */
function getSelectedOrFocused(
  nodes: FlatTreeNode[],
  focusedIndex: number,
  selectedPaths: Set<string>
): string[] {
  const focusedNode = nodes[focusedIndex];
  if (!focusedNode) return [];

  if (selectedPaths.size > 0 && selectedPaths.has(focusedNode.path)) {
    return Array.from(selectedPaths);
  }
  return [focusedNode.path];
}

export function handleTreeKeyDown(
  e: React.KeyboardEvent,
  nodes: FlatTreeNode[],
  focusedIndex: number | null,
  selectedPaths: Set<string>,
  actions: TreeActions
): void {
  if (nodes.length === 0) return;

  // First keypress focuses the first item if nothing is focused
  if (focusedIndex == null) {
    actions.setFocused(0);
    e.preventDefault();
    return;
  }

  const node = nodes[focusedIndex];
  if (!node) return;

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      {
        const next = Math.min(focusedIndex + 1, nodes.length - 1);
        if (e.shiftKey) actions.extendSelection(next);
        actions.setFocused(next);
      }
      break;

    case 'ArrowUp':
      e.preventDefault();
      {
        const prev = Math.max(focusedIndex - 1, 0);
        if (e.shiftKey) actions.extendSelection(prev);
        actions.setFocused(prev);
      }
      break;

    case 'ArrowRight':
      e.preventDefault();
      if (node.type === 'directory') {
        if (!node.isExpanded) {
          actions.expand(node.path);
        } else if (focusedIndex + 1 < nodes.length) {
          // Move to first child
          actions.setFocused(focusedIndex + 1);
        }
      }
      break;

    case 'ArrowLeft':
      e.preventDefault();
      if (node.type === 'directory' && node.isExpanded) {
        actions.collapse(node.path);
      } else if (node.parentPath) {
        // Jump to parent directory
        const parentIdx = nodes.findIndex(n => n.path === node.parentPath);
        if (parentIdx >= 0) actions.setFocused(parentIdx);
      }
      break;

    case 'Enter':
      e.preventDefault();
      if (node.type === 'directory') {
        actions.toggleExpand(node.path);
      } else {
        actions.openFile(node.path);
      }
      break;

    case ' ':
      e.preventDefault();
      // Space opens file (preview behavior can be added later)
      if (node.type === 'file') {
        actions.openFile(node.path);
      }
      break;

    case 'F2':
      e.preventDefault();
      actions.startRename(node.path);
      break;

    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      actions.deleteItems(getSelectedOrFocused(nodes, focusedIndex, selectedPaths));
      break;

    case 'Home':
      e.preventDefault();
      actions.setFocused(0);
      break;

    case 'End':
      e.preventDefault();
      actions.setFocused(nodes.length - 1);
      break;

    case 'PageUp':
      e.preventDefault();
      actions.setFocused(Math.max(focusedIndex - actions.viewportRowCount, 0));
      break;

    case 'PageDown':
      e.preventDefault();
      actions.setFocused(Math.min(focusedIndex + actions.viewportRowCount, nodes.length - 1));
      break;

    case 'Escape':
      e.preventDefault();
      actions.clearSelection();
      actions.setFocused(null);
      break;

    case 'a':
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        actions.selectAll();
      } else {
        actions.typeAhead(e.key);
      }
      break;

    default:
      // Type-ahead find: printable single characters
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        actions.typeAhead(e.key);
      }
      break;
  }
}
