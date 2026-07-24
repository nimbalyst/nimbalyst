/**
 * Emoji transformer for markdown import/export
 */

import { TextMatchTransformer } from '@lexical/markdown';
import { $createTextNode } from 'lexical';
import emojiList from '../../utils/emoji-list';

export const EMOJI_TRANSFORMER: TextMatchTransformer = {
  dependencies: [],
  export: () => null,
  importRegExp: /:([a-z0-9_]+):/,
  regExp: /:([a-z0-9_]+):$/,
  replace: (textNode, [, name]) => {
    const emoji = emojiList.find((e) => e.aliases.includes(name))?.emoji;
    if (emoji) {
      textNode.replace($createTextNode(emoji));
    }
  },
  trigger: ':',
  type: 'text-match',
};