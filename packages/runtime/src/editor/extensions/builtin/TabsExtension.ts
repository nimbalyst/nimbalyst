/**
 * Extension that owns the tabs block: `TabsNode` / `TabPanelNode`, the
 * `<div data-tabs>` transformer, the tab strip, the slash entry, and the
 * transforms that keep the tree well formed after a paste or a remote edit
 * (panels only inside a tabs block, never empty; no empty tabs block).
 */

import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  defineExtension,
} from 'lexical';
import { $insertNodeToNearestRoot, mergeRegister } from '@lexical/utils';

import {
  $createTabsWithPanels,
  $isTabPanelNode,
  $isTabsNode,
  TabPanelNode,
  TabsNode,
} from '../../plugins/TabsPlugin/TabsNodes';
import { INSERT_TABS_COMMAND } from '../../plugins/TabsPlugin/TabsCommands';
import { createTabsTransformer } from '../../plugins/TabsPlugin/TabsTransformer';
import { registerTabStrips } from '../../plugins/TabsPlugin/tabStrip';
import { getTabStripController, type TabActionId } from '../../plugins/TabsPlugin/tabMenu';
import { draggableBlockMenuRegistry } from '../../plugins/DraggableBlockPlugin/DraggableBlockMenuRegistry';
import { getEditorTransformers } from '../../markdown';
import { setExtensionContributions } from '../extensionContributionsStore';
import '../../plugins/TabsPlugin/Tabs.css';

const NAME = '@nimbalyst/editor/tabs';

export const TabsExtension = defineExtension({
  name: NAME,
  nodes: [TabsNode, TabPanelNode],
  register: (editor) =>
    mergeRegister(
      registerTabStrips(editor),
      editor.registerCommand(
        INSERT_TABS_COMMAND,
        () => {
          if (!$isRangeSelection($getSelection())) return false;
          const tabs = $createTabsWithPanels(['Tab 1', 'Tab 2']);
          $insertNodeToNearestRoot(tabs);
          // Leave somewhere to type below the block.
          if (!tabs.getNextSibling()) tabs.insertAfter($createParagraphNode());
          tabs.getPanels()[0]?.selectStart();
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      editor.registerNodeTransform(TabPanelNode, (panel) => {
        if (!$isTabsNode(panel.getParent())) {
          for (const child of panel.getChildren()) panel.insertBefore(child);
          panel.remove();
          return;
        }
        if (panel.isEmpty()) panel.append($createParagraphNode());
      }),
      editor.registerNodeTransform(TabsNode, (tabs) => {
        const children = tabs.getChildren();
        if (children.length === 0) {
          tabs.remove();
          return;
        }
        // Content pasted between panels moves into the panel before it.
        for (const child of children) {
          if ($isTabPanelNode(child)) continue;
          const previous = child.getPreviousSibling();
          if ($isTabPanelNode(previous)) previous.append(child);
          else tabs.insertBefore(child);
        }
      }),
    ),
});

export const TABS_TRANSFORMER = createTabsTransformer(getEditorTransformers);

// The block menu acts on the tab showing; a tab's own context menu covers the others.
const BLOCK_MENU_ACTIONS: Array<{ id: TabActionId; label: string; icon: string }> = [
  { id: 'add', label: 'Add tab', icon: 'add' },
  { id: 'rename', label: 'Rename current tab', icon: 'edit' },
  { id: 'delete', label: 'Delete current tab', icon: 'delete' },
];
BLOCK_MENU_ACTIONS.forEach(({ id, label, icon }, index) => {
  draggableBlockMenuRegistry.registerMenuItem({
    id: `tabs:${id}`,
    label,
    icon,
    nodeTypes: [TabsNode.getType()],
    order: index,
    command: (editor, node) => {
      const controller = getTabStripController(editor);
      const panelKey = controller?.showing(node.getKey());
      if (controller && panelKey) controller.run(node.getKey(), panelKey, id);
    },
  });
});

setExtensionContributions(NAME, {
  markdownTransformers: [TABS_TRANSFORMER],
  userCommands: [
    {
      title: 'Tabs',
      description: 'Named panels that show one at a time',
      icon: 'tab',
      keywords: ['tabs', 'tab', 'panels', 'sections', 'switch'],
      command: INSERT_TABS_COMMAND,
    },
  ],
});
