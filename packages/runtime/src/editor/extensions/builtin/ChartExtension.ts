/**
 * Headless extension that owns the chart block: `ChartNode`, its ```chart
 * fence transformer, and the slash entry that inserts one. The query-backed
 * chart is a placed view (`mode=chart` on a placed-view link), drawn by the
 * same renderer.
 */

import {
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  defineExtension,
} from 'lexical';

import { $createChartNode, ChartNode } from '../../plugins/ChartPlugin/ChartNode';
import { CHART_TRANSFORMER } from '../../plugins/ChartPlugin/ChartTransformer';
import { INSERT_CHART_COMMAND } from '../../plugins/ChartPlugin/ChartCommands';
import '../../plugins/ChartPlugin/chartBlockMenu';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/chart';

export const ChartExtension = defineExtension({
  name: NAME,
  nodes: [ChartNode],
  register: (editor) =>
    editor.registerCommand(
      INSERT_CHART_COMMAND,
      (payload) => {
        if (!$isRangeSelection($getSelection())) return false;
        $insertNodes([$createChartNode(payload)]);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});

setExtensionContributions(NAME, {
  markdownTransformers: [CHART_TRANSFORMER],
  userCommands: [
    {
      title: 'Chart',
      description: 'A bar, line, area, pie or scatter chart from data you type in',
      icon: 'bar_chart',
      keywords: ['chart', 'graph', 'plot', 'bar', 'line', 'pie', 'scatter', 'area', 'vega'],
      command: INSERT_CHART_COMMAND,
    },
  ],
});
