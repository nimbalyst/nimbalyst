/**
 * Hashtag transformer for markdown import/export
 * Converts #word patterns to HashtagNode
 */

import { TextMatchTransformer } from '@lexical/markdown';
import { $createHashtagNode } from '@lexical/hashtag';

export const HASHTAG_TRANSFORMER: TextMatchTransformer = {
  dependencies: [],
  export: () => null, // HashtagNode exports itself as text via getTextContent()
  importRegExp: /#[a-zA-Z]\w*/,
  regExp: /#[a-zA-Z]\w*$/,
  replace: (textNode, match) => {
    const hashtagText = match[0]; // e.g., "#idea"
    const hashtagNode = $createHashtagNode(hashtagText);
    textNode.replace(hashtagNode);
  },
  trigger: '#',
  type: 'text-match',
};
