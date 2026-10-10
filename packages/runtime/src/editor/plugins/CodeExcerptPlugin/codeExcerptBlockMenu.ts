/**
 * The code excerpt's block-menu items: the header's update, open and recheck
 * actions (run by `CodeExcerptBlock`, shown only when the header shows them),
 * and reset a dragged size.
 */

import { draggableBlockMenuRegistry } from '../DraggableBlockPlugin/DraggableBlockMenuRegistry';
import { registerBlockActionMenuItem } from '../DraggableBlockPlugin/blockActions';
import { $isCodeExcerptNode, CodeExcerptNode } from './CodeExcerptNodeCore';
import { excerptHasSize } from './excerptFence';

const NODE_TYPES = [CodeExcerptNode.getType()];

registerBlockActionMenuItem({ id: 'excerpt:update', label: 'Update to current file', icon: 'sync', nodeTypes: NODE_TYPES, order: 0, action: 'update' });
registerBlockActionMenuItem({ id: 'excerpt:open-file', label: 'Open file', icon: 'open_in_new', nodeTypes: NODE_TYPES, order: 1, action: 'open-file' });
registerBlockActionMenuItem({ id: 'excerpt:recheck', label: 'Check against file again', icon: 'refresh', nodeTypes: NODE_TYPES, order: 2, action: 'recheck' });

draggableBlockMenuRegistry.registerMenuItem({
  id: 'excerpt:reset-size',
  label: 'Reset size',
  icon: 'fit_screen',
  nodeTypes: NODE_TYPES,
  order: 20,
  isVisible: (node) => $isCodeExcerptNode(node) && excerptHasSize(node.getSource()),
  // The rewrite parses YAML, which loads on use so the web console's eager bundle stays small.
  command: (editor, node) => void import('./excerptSource').then(({ setExcerptSize }) => editor.update(() => {
    const latest = node.getLatest();
    if ($isCodeExcerptNode(latest)) latest.setSource(setExcerptSize(latest.getSource(), { width: null, height: null }));
  })),
});
