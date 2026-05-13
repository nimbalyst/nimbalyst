/**
 * Transformer-only extension that publishes the Nimbalyst markdown table
 * transformer. Upstream `@lexical/table` owns the actual `TableNode` and
 * the React `TablePlugin` runtime; we only need a place to surface our
 * import/export transformer through the contributions store.
 */

import { defineExtension } from 'lexical';

import { TABLE_TRANSFORMER } from '../../plugins/TablePlugin/TableTransformer';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/table-markdown';

export const TableMarkdownExtension = defineExtension({
  name: NAME,
});

setExtensionContributions(NAME, {
  markdownTransformers: [TABLE_TRANSFORMER],
});
