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

export const TrackerReferenceTransformer: TextMatchTransformer = {
  dependencies: [TrackerReferenceNode],
  export: (node) => {
    if (!$isTrackerReferenceNode(node)) {
      return null;
    }
    const key = node.getReferenceKey();
    return `[${key}](${TRACKER_REFERENCE_URN_SCHEME}${key})`;
  },
  // Match markdown links whose href uses the nimbalyst:// scheme. The label
  // (group 1) is display-only; the reference key (group 2) is the URN path.
  importRegExp: /(?<!!)\[([^\]]+)\]\(nimbalyst:\/\/([^)\s]+)\)/,
  regExp: /(?<!!)\[([^\]]+)\]\(nimbalyst:\/\/([^)\s]+)\)$/,
  replace: (textNode, match) => {
    const [, , referenceKey] = match;
    textNode.replace($createTrackerReferenceNode(referenceKey));
  },
  trigger: ')',
  type: 'text-match',
};
