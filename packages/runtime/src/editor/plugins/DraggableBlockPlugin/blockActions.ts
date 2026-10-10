/**
 * Lets a block's React component take actions from the block menu. Some menu
 * items act on the node directly (change a chart's type); others need the
 * component's own state (open the chart's source editor, check an excerpt
 * against the file). A component registers the actions it can take right now
 * with `useBlockActions`; a menu item made with `blockActionMenuItem` shows
 * only while its block offers that action, and runs it there.
 *
 * React-free so extension files can register menu items without loading React.
 */

import type { LexicalEditor, NodeKey } from 'lexical';

import { draggableBlockMenuRegistry, type DraggableBlockMenuItem } from './DraggableBlockMenuRegistry';

export interface BlockActionTarget {
  /** The actions the block can take now. */
  available(): readonly string[];
  run(action: string): void;
}

const targets = new WeakMap<LexicalEditor, Map<NodeKey, BlockActionTarget>>();

export function registerBlockActions(editor: LexicalEditor, nodeKey: NodeKey, target: BlockActionTarget): () => void {
  let byKey = targets.get(editor);
  if (!byKey) {
    byKey = new Map();
    targets.set(editor, byKey);
  }
  byKey.set(nodeKey, target);
  return () => {
    if (byKey.get(nodeKey) === target) byKey.delete(nodeKey);
  };
}

export function blockOffers(editor: LexicalEditor | undefined, nodeKey: NodeKey, action: string): boolean {
  return !!editor && !!targets.get(editor)?.get(nodeKey)?.available().includes(action);
}

export function runBlockAction(editor: LexicalEditor, nodeKey: NodeKey, action: string): void {
  targets.get(editor)?.get(nodeKey)?.run(action);
}

/** A block-menu item that runs `action` on a block whose component offers it. */
export function registerBlockActionMenuItem(item: Omit<DraggableBlockMenuItem, 'command' | 'isVisible'> & { action: string }): () => void {
  const { action, ...rest } = item;
  return draggableBlockMenuRegistry.registerMenuItem({
    ...rest,
    isVisible: (node, editor) => blockOffers(editor, node.getKey(), action),
    command: (editor, node) => runBlockAction(editor, node.getKey(), action),
  });
}
