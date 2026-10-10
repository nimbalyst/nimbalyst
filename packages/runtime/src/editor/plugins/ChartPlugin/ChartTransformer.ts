/**
 * Markdown import/export for the chart block: a ```chart fence whose body the
 * node keeps verbatim.
 */

import type { MultilineElementTransformer } from '@lexical/markdown';

import { createFencedBlockTransformer } from '../fencedBlock/fencedBlockTransformer';
import { $createChartNode, $isChartNode, CHART_FENCE_LANGUAGE, ChartNode } from './ChartNodeCore';

export const CHART_TRANSFORMER: MultilineElementTransformer = createFencedBlockTransformer({
  language: CHART_FENCE_LANGUAGE,
  node: ChartNode,
  isNode: $isChartNode,
  getSource: (node) => node.getSource(),
  create: (source) => $createChartNode({ source }),
});
