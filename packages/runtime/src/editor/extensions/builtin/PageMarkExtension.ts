/**
 * Headless extension that owns `PageMarkNode` and its markdown transformer.
 * Marking, editing and removing go through `PageMarkPlugin/pageMarkActions.ts`,
 * loaded on use; the editor popover is `PageMarkEditorPlugin.tsx`.
 */

import { defineExtension } from 'lexical';

import { PageMarkNode } from '../../plugins/PageMarkPlugin/PageMarkNode';
import { PAGE_MARK_TRANSFORMER } from '../../plugins/PageMarkPlugin/PageMarkTransformer';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/page-mark';

export const PageMarkExtension = defineExtension({
  name: NAME,
  nodes: [PageMarkNode],
});

setExtensionContributions(NAME, {
  markdownTransformers: [PAGE_MARK_TRANSFORMER],
});
