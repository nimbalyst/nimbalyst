/**
 * Owns `MentionNode` (person and date chips) and their markdown. The `@`
 * typeahead that inserts them is the document-link menu's people and dates
 * groups (`DocumentLinkPlugin`), so there is one `@` menu, not two.
 */

import { defineExtension } from 'lexical';

import { MentionNode, MENTION_TRANSFORMERS } from '../../plugins/MentionPlugin/MentionNode';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/mention';

export const MentionExtension = defineExtension({
  name: NAME,
  nodes: [MentionNode],
});

setExtensionContributions(NAME, {
  markdownTransformers: MENTION_TRANSFORMERS,
});
