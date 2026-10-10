/**
 * Headless extension that owns the static 2x2 block: `QuadrantNode`, its
 * ```2x2 fence transformer, and the slash entry that inserts one. The
 * query-backed 2x2 is a placed view (`mode=2x2` on a placed-view link, see `placedViewUrl.ts`),
 * drawn by the same chart.
 */

import {
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  defineExtension,
} from 'lexical';

import { $createQuadrantNode, QuadrantNode } from '../../plugins/QuadrantPlugin/QuadrantNode';
import { QUADRANT_TRANSFORMER } from '../../plugins/QuadrantPlugin/QuadrantTransformer';
import { INSERT_QUADRANT_COMMAND } from '../../plugins/QuadrantPlugin/QuadrantCommands';
import '../../plugins/QuadrantPlugin/quadrantBlockMenu';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/quadrant';

export const QuadrantExtension = defineExtension({
  name: NAME,
  nodes: [QuadrantNode],
  register: (editor) =>
    editor.registerCommand(
      INSERT_QUADRANT_COMMAND,
      (payload) => {
        if (!$isRangeSelection($getSelection())) return false;
        $insertNodes([$createQuadrantNode(payload)]);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});

setExtensionContributions(NAME, {
  markdownTransformers: [QUADRANT_TRANSFORMER],
  userCommands: [
    {
      title: '2x2 chart',
      description: 'A 2x2 of points you type in, with labeled quadrants',
      icon: 'grid_view',
      keywords: ['2x2', 'quadrant', 'matrix', 'chart', 'landscape', 'positioning'],
      command: INSERT_QUADRANT_COMMAND,
    },
  ],
});
