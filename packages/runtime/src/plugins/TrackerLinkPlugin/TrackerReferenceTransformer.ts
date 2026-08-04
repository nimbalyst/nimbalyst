/**
 * Markdown transformer for tracker references.
 *
 * Exports `TrackerReferenceNode` as a portable markdown link
 * `[NIM-123](nimbalyst://NIM-123)` and imports any `nimbalyst://<key>` link
 * back into a `TrackerReferenceNode`. The label is display-only; the canonical
 * reference key is the URN path after `nimbalyst://`.
 *
 * Scheme-gated so it never collides with `DocumentReferenceTransformer`, whose
 * regex explicitly excludes links containing `://`.
 */

import type { TextMatchTransformer } from '@lexical/markdown';

import {
  $createTrackerReferenceNode,
  $isTrackerReferenceNode,
  TrackerReferenceNode,
  TRACKER_REFERENCE_URN_SCHEME,
} from './TrackerReferenceNode';
import { TRACKER_REFERENCE_KEY_PATTERN } from './trackerReferenceHref';

const TRACKER_REFERENCE_IMPORT_REGEXP = new RegExp(
  `(?<!!)\\[([^\\]]+)\\]\\(nimbalyst:\\/\\/(${TRACKER_REFERENCE_KEY_PATTERN})\\)`,
);
const TRACKER_REFERENCE_REGEXP = new RegExp(
  `${TRACKER_REFERENCE_IMPORT_REGEXP.source}$`,
);

export const TrackerReferenceTransformer: TextMatchTransformer = {
  dependencies: [TrackerReferenceNode],
  export: (node) => {
    if (!$isTrackerReferenceNode(node)) {
      return null;
    }
    const key = node.getReferenceKey();
    return `[${key}](${TRACKER_REFERENCE_URN_SCHEME}${key})`;
  },
  // Match only tracker issue keys and local tracker URNs. Other nimbalyst://
  // namespaces (including action links) must remain ordinary links.
  importRegExp: TRACKER_REFERENCE_IMPORT_REGEXP,
  regExp: TRACKER_REFERENCE_REGEXP,
  replace: (textNode, match) => {
    const [, , referenceKey] = match;
    textNode.replace($createTrackerReferenceNode(referenceKey));
  },
  trigger: ')',
  type: 'text-match',
};
