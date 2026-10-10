/**
 * The columns block's menu items: add a column, remove the last one (its
 * content moves into the column before it, so nothing is lost), and make the
 * columns equal width.
 */

import { $createParagraphNode, type LexicalEditor, type LexicalNode } from 'lexical';

import { draggableBlockMenuRegistry } from '../DraggableBlockPlugin/DraggableBlockMenuRegistry';
import { $isLayoutContainerNode, LayoutContainerNode } from './LayoutContainerNode';
import { $createLayoutItemNode, $isLayoutItemNode } from './LayoutItemNode';

const NODE_TYPES = [LayoutContainerNode.getType()];
const MAX_COLUMNS = 6;

const tracks = (node: LayoutContainerNode) => node.getTemplateColumns().trim().split(/\s+/).filter(Boolean);

function update(editor: LexicalEditor, node: LexicalNode, fn: (container: LayoutContainerNode) => void): void {
  editor.update(() => {
    const latest = node.getLatest();
    if ($isLayoutContainerNode(latest)) fn(latest);
  });
}

draggableBlockMenuRegistry.registerMenuItem({
  id: 'columns:add',
  label: 'Add column',
  icon: 'add',
  nodeTypes: NODE_TYPES,
  order: 0,
  isVisible: (node, editor) => $isLayoutContainerNode(node) && tracks(node).length < MAX_COLUMNS && !!editor?.isEditable(),
  command: (editor, node) => update(editor, node, (container) => {
    container.append($createLayoutItemNode().append($createParagraphNode()));
    container.setTemplateColumns([...tracks(container), '1fr'].join(' '));
  }),
});

draggableBlockMenuRegistry.registerMenuItem({
  id: 'columns:remove-last',
  label: 'Remove last column',
  icon: 'remove',
  nodeTypes: NODE_TYPES,
  order: 1,
  isVisible: (node, editor) => $isLayoutContainerNode(node) && node.getChildrenSize() > 2 && !!editor?.isEditable(),
  command: (editor, node) => update(editor, node, (container) => {
    const last = container.getLastChild();
    const previous = last?.getPreviousSibling();
    if (!$isLayoutItemNode(last) || !$isLayoutItemNode(previous)) return;
    // Keep the removed column's content, unless it is a lone empty paragraph.
    const moved = last.getChildren().filter((child) => child.getTextContent().trim() !== '' || child.getType() !== 'paragraph');
    previous.append(...moved);
    last.remove();
    container.setTemplateColumns(tracks(container).slice(0, container.getChildrenSize()).join(' '));
  }),
});

draggableBlockMenuRegistry.registerMenuItem({
  id: 'columns:equal',
  label: 'Make columns equal width',
  icon: 'view_column',
  nodeTypes: NODE_TYPES,
  order: 2,
  isVisible: (node, editor) => $isLayoutContainerNode(node) && new Set(tracks(node)).size > 1 && !!editor?.isEditable(),
  command: (editor, node) => update(editor, node, (container) => {
    container.setTemplateColumns(Array(container.getChildrenSize()).fill('1fr').join(' '));
  }),
});
