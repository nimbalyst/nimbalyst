/**
 * Core markdown transformers that are always included.
 * These handle basic markdown syntax that doesn't require plugins.
 */

import type { Transformer } from '@lexical/markdown';

import {
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  CHECK_LIST,
  CODE,
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  HIGHLIGHT,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
  LINK,
} from './MarkdownTransformers';

import { HR_TRANSFORMER } from './HorizontalRuleTransformer';
import { PAGE_BREAK_TRANSFORMER } from '../plugins/PageBreakPlugin';
import { HASHTAG_TRANSFORMER } from './HashtagTransformer';

// Element transformers
const ELEMENT_TRANSFORMERS: Array<Transformer> = [
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
];

// Multiline element transformers
const MULTILINE_ELEMENT_TRANSFORMERS: Array<Transformer> = [
  CODE,
];

// Text format transformers - order matters
const TEXT_FORMAT_TRANSFORMERS: Array<Transformer> = [
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  HIGHLIGHT,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
];

// Text match transformers
const TEXT_MATCH_TRANSFORMERS: Array<Transformer> = [
  LINK,
  HASHTAG_TRANSFORMER,
];

/**
 * Core transformers that are always available in the editor.
 * These don't require any plugins to be loaded.
 */
export const CORE_TRANSFORMERS: Array<Transformer> = [
  // Core element transformers
  HR_TRANSFORMER, // Horizontal rules are core markdown
  PAGE_BREAK_TRANSFORMER, // Page breaks for print/export

  // All markdown transformers from our local implementation
  CHECK_LIST,
  ...ELEMENT_TRANSFORMERS,
  ...MULTILINE_ELEMENT_TRANSFORMERS,
  ...TEXT_FORMAT_TRANSFORMERS,
  ...TEXT_MATCH_TRANSFORMERS,
];