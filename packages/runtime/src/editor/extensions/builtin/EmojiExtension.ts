/**
 * Transformer-only extension that publishes the emoji-shortcode markdown
 * transformer. `EmojiNode` is already listed in `EditorNodes.ts` and the
 * emoji picker is a separate React plugin -- this extension exists solely
 * so the emoji transformer no longer needs to ride through the deleted
 * `pluginRegistry`.
 */

import { defineExtension } from 'lexical';

import { EMOJI_TRANSFORMER } from '../../plugins/EmojisPlugin/EmojiTransformer';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/emoji-markdown';

export const EmojiMarkdownExtension = defineExtension({
  name: NAME,
});

setExtensionContributions(NAME, {
  markdownTransformers: [EMOJI_TRANSFORMER],
});
