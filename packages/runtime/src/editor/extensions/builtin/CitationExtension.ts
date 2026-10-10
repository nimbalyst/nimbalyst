/**
 * Headless extension that owns `CitationNode` and its markdown transformer.
 * The chip, its popover and the Sources line are React and mount from
 * `CitationNode.tsx` / `Editor.tsx`.
 */

import { defineExtension } from 'lexical';

import { CitationNode } from '../../plugins/CitationPlugin/CitationNode';
import { CITATION_TRANSFORMER } from '../../plugins/CitationPlugin/CitationTransformer';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/citation';

export const CitationExtension = defineExtension({
  name: NAME,
  nodes: [CitationNode],
});

setExtensionContributions(NAME, {
  markdownTransformers: [CITATION_TRANSFORMER],
});
