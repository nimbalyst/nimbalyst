/** The button block's menu item: open its source editor (run by `ActionButtonBlock`). */

import { registerBlockActionMenuItem } from '../DraggableBlockPlugin/blockActions';
import { ActionButtonNode } from './ActionButtonNodeCore';

registerBlockActionMenuItem({ id: 'action-button:edit', label: 'Edit button', icon: 'edit', nodeTypes: [ActionButtonNode.getType()], order: 0, action: 'edit' });
