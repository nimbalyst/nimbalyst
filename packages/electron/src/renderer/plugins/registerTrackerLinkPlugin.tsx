/**
 * Register the runtime's tracker-reference node + markdown transformer as a
 * renderer-contributed Lexical extension.
 *
 * Unlike the document-link plugin, there is no editor component to register for
 * V1: the chip resolves its live data from the runtime tracker store and
 * handles its own click (hover-card + navigate). The `#` typeahead picker is a
 * planned V2 follow-up.
 */

import { defineExtension } from 'lexical';
import {
  setExtensionContributions,
  setExtensionLexicalExtension,
} from '@nimbalyst/runtime';
import {
  TrackerReferenceNode,
  TrackerReferenceTransformer,
} from '@nimbalyst/runtime/plugins/TrackerLinkPlugin';

const SOURCE = 'tracker-link';

export function registerTrackerLinkPlugin(): void {
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
