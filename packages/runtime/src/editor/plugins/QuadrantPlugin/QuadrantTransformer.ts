/**
 * Markdown import/export for the static 2x2 block: a ```2x2 fence whose body
 * the node keeps verbatim.
 */

import type { MultilineElementTransformer } from '@lexical/markdown';

import { createFencedBlockTransformer } from '../fencedBlock/fencedBlockTransformer';
import { $createQuadrantNode, $isQuadrantNode, QUADRANT_FENCE_LANGUAGE, QuadrantNode } from './QuadrantNodeCore';

export const QUADRANT_TRANSFORMER: MultilineElementTransformer = createFencedBlockTransformer({
  language: QUADRANT_FENCE_LANGUAGE,
  node: QuadrantNode,
  isNode: $isQuadrantNode,
  getSource: (node) => node.getSource(),
  create: (source) => $createQuadrantNode({ source }),
});
