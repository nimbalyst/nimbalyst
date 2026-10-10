/** The table of contents' block-menu items: how deep a heading it lists. */

import { draggableBlockMenuRegistry } from '../DraggableBlockPlugin/DraggableBlockMenuRegistry';
import { $isTocNode, parseTocDepth, setTocDepth, TocNode } from './TocNodeCore';

const LABELS = ['List level 1 headings only', 'List headings to level 2', 'List headings to level 3'];

LABELS.forEach((label, index) => {
  const depth = index + 1;
  draggableBlockMenuRegistry.registerMenuItem({
    id: `toc:depth:${depth}`,
    label,
    icon: 'format_list_numbered',
    nodeTypes: [TocNode.getType()],
    order: index,
    isVisible: (node, editor) => $isTocNode(node) && parseTocDepth(node.getSource()) !== depth && !!editor?.isEditable(),
    command: (editor, node) => editor.update(() => {
      const latest = node.getLatest();
      if ($isTocNode(latest)) latest.setSource(setTocDepth(latest.getSource(), depth));
    }),
  });
});
