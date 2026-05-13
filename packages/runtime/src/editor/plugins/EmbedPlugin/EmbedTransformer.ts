/**
 * Markdown transformer for `EmbeddedFileNode`.
 *
 * Import: handled by a Lexical node transform on `LinkNode` in
 * `EmbedExtension` -- it upgrades paragraph-isolated links whose target is
 * an embeddable file extension into `EmbeddedFileNode`s. We don't import
 * via a TextMatchTransformer because the auto-upgrade rule is paragraph-
 * scoped, which the text-match shape can't express.
 *
 * Export: an `ElementTransformer` that writes the node back as a plain
 * CommonMark link, putting any attributes into the link title. We use the
 * element-transformer shape (not text-match) because the node is a top-
 * level decorator -- each embed lives on its own block, not inline.
 */

import type { ElementTransformer } from '@lexical/markdown';

import {
  $isEmbeddedFileNode,
  EmbeddedFileNode,
} from './EmbeddedFileNode';
import { serializeEmbedAttrs } from './embedAttrs';

export const EMBED_TRANSFORMER: ElementTransformer = {
  dependencies: [EmbeddedFileNode],
  type: 'element',
  // Import is handled via a Lexical node transform on `LinkNode`, not the
  // markdown tokenizer. This regex intentionally never matches (the
  // negative lookahead at the start makes it impossible to advance).
  regExp: /^(?!)/,
  replace: () => {
    // No-op: see comment above.
  },
  export: (node) => {
    if (!$isEmbeddedFileNode(node)) return null;
    const src = node.getSrc();
    const label = node.getLabel();
    const title = serializeEmbedAttrs(node.getAttrs());
    const displayLabel = label || src;
    return title
      ? `[${displayLabel}](${src} "${title}")`
      : `[${displayLabel}](${src})`;
  },
};
