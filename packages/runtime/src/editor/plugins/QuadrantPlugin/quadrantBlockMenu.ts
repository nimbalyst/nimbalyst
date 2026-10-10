/** The 2x2's block-menu item: reset a dragged size. */

import { draggableBlockMenuRegistry } from '../DraggableBlockPlugin/DraggableBlockMenuRegistry';
import { parseQuadrantFence, setQuadrantFenceSize } from './quadrantFence';
import { $isQuadrantNode, QuadrantNode } from './QuadrantNodeCore';

draggableBlockMenuRegistry.registerMenuItem({
  id: 'quadrant:reset-size',
  label: 'Reset size',
  icon: 'fit_screen',
  nodeTypes: [QuadrantNode.getType()],
  order: 20,
  isVisible: (node) => {
    if (!$isQuadrantNode(node)) return false;
    const parsed = parseQuadrantFence(node.getSource());
    return parsed.width !== undefined || parsed.height !== undefined;
  },
  command: (editor, node) => editor.update(() => {
    const latest = node.getLatest();
    if ($isQuadrantNode(latest)) latest.setSource(setQuadrantFenceSize(latest.getSource(), { width: null, height: null }));
  }),
});
