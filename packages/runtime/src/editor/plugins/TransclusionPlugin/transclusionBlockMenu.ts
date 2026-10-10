/**
 * The transclusion's block-menu items: open the source page (run by
 * `TransclusionBlock`, which has the host), show as a plain link, and reset a
 * dragged size.
 */

import { parseEmbedAttrs } from '../EmbedPlugin/embedAttrs';
import { setTitleAttr } from '../EmbedPlugin/embedTitle';
import { draggableBlockMenuRegistry } from '../DraggableBlockPlugin/DraggableBlockMenuRegistry';
import { registerBlockActionMenuItem } from '../DraggableBlockPlugin/blockActions';
import { $downgradeTransclusionToLink, $isTransclusionNode, TransclusionNode } from './TransclusionNodeCore';

const NODE_TYPES = [TransclusionNode.getType()];

registerBlockActionMenuItem({ id: 'transclusion:open', label: 'Open source page', icon: 'open_in_new', nodeTypes: NODE_TYPES, order: 0, action: 'open' });

draggableBlockMenuRegistry.registerMenuItem({
  id: 'transclusion:unlink',
  label: 'Show as link',
  icon: 'link',
  nodeTypes: NODE_TYPES,
  order: 1,
  isVisible: (_node, editor) => !!editor?.isEditable(),
  command: (editor, node) => editor.update(() => {
    const latest = node.getLatest();
    if ($isTransclusionNode(latest)) $downgradeTransclusionToLink(latest);
  }),
});

draggableBlockMenuRegistry.registerMenuItem({
  id: 'transclusion:reset-size',
  label: 'Reset size',
  icon: 'fit_screen',
  nodeTypes: NODE_TYPES,
  order: 20,
  isVisible: (node) => {
    if (!$isTransclusionNode(node)) return false;
    const attrs = parseEmbedAttrs(node.getTitle());
    return attrs.width !== undefined || attrs.height !== undefined;
  },
  command: (editor, node) => editor.update(() => {
    const latest = node.getLatest();
    if ($isTransclusionNode(latest)) latest.setTitle(setTitleAttr(setTitleAttr(latest.getTitle(), 'width', null), 'height', null));
  }),
});
