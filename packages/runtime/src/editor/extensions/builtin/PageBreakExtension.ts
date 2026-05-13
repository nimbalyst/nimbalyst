/**
 * Headless extension that owns `PageBreakNode`, the markdown transformer,
 * and the `INSERT_PAGE_BREAK` handler. Replaces the React `PageBreakPlugin`
 * (which returned null) and the legacy `PluginPackage` registration.
 */

import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  defineExtension,
} from 'lexical';
import { $insertNodeToNearestRoot } from '@lexical/utils';

import {
  $createPageBreakNode,
  PageBreakNode,
} from '../../plugins/PageBreakPlugin/PageBreakNode';
import { PAGE_BREAK_TRANSFORMER } from '../../plugins/PageBreakPlugin/PageBreakTransformer';
import { INSERT_PAGE_BREAK } from '../../plugins/PageBreakPlugin/PageBreakCommands';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/page-break';

export const PageBreakExtension = defineExtension({
  name: NAME,
  nodes: [PageBreakNode],
  register: (editor) =>
    editor.registerCommand(
      INSERT_PAGE_BREAK,
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;
        if (selection.focus.getNode() !== null) {
          $insertNodeToNearestRoot($createPageBreakNode());
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});

setExtensionContributions(NAME, {
  markdownTransformers: [PAGE_BREAK_TRANSFORMER],
});
