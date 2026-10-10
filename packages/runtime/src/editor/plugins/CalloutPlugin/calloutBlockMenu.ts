/**
 * The callout's block-menu items: change the type (the current one is not
 * offered) and edit the title (the same input a header click opens).
 */

import { draggableBlockMenuRegistry } from '../DraggableBlockPlugin/DraggableBlockMenuRegistry';
import { $isCalloutNode, CALLOUT_LABELS, CALLOUT_TYPES, CalloutNode, startCalloutTitleEdit } from './CalloutNode';

const NODE_TYPES = [CalloutNode.getType()];
const ICONS = { note: 'info', tip: 'lightbulb', important: 'priority_high', warning: 'warning', caution: 'report' } as const;

CALLOUT_TYPES.forEach((type, index) => {
  draggableBlockMenuRegistry.registerMenuItem({
    id: `callout:type:${type}`,
    label: `Change to ${CALLOUT_LABELS[type].toLowerCase()}`,
    icon: ICONS[type],
    nodeTypes: NODE_TYPES,
    order: index,
    isVisible: (node, editor) => $isCalloutNode(node) && node.getCalloutType() !== type && !!editor?.isEditable(),
    command: (editor, node) => editor.update(() => {
      const latest = node.getLatest();
      if ($isCalloutNode(latest)) latest.setCalloutType(type);
    }),
  });
});

draggableBlockMenuRegistry.registerMenuItem({
  id: 'callout:title',
  label: 'Edit title',
  icon: 'title',
  nodeTypes: NODE_TYPES,
  order: 10,
  isVisible: (_node, editor) => !!editor?.isEditable(),
  command: (editor, node) => startCalloutTitleEdit(editor, node.getKey()),
});
