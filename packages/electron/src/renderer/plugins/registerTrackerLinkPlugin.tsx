/**
 * Register the runtime's tracker-reference node, markdown transformer, and
 * renderer-only chip implementation as a Lexical extension.
 */

import { defineExtension } from 'lexical';
import {
  setExtensionContributions,
  setExtensionLexicalExtension,
} from '@nimbalyst/runtime';
import {
  setTrackerReferenceNodeRenderer,
  TrackerReferenceChip,
  TrackerReferenceNode,
  TrackerReferenceTransformer,
} from '@nimbalyst/runtime/plugins/TrackerLinkPlugin';

const SOURCE = 'tracker-link';

export function registerTrackerLinkPlugin(): void {
  setTrackerReferenceNodeRenderer(TrackerReferenceChip);
  setExtensionLexicalExtension(
    SOURCE,
    defineExtension({
      name: '@nimbalyst/tracker-link',
      nodes: [TrackerReferenceNode],
    }),
  );
  setExtensionContributions(SOURCE, {
    markdownTransformers: [TrackerReferenceTransformer],
  });
}
