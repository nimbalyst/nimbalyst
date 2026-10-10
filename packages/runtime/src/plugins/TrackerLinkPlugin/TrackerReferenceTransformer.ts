/**
 * Markdown transformer for tracker references.
 *
 * Exports `TrackerReferenceNode` as a portable markdown link and imports two
 * link forms back into a `TrackerReferenceNode`: a console item link
 * (`https://console.nimbalyst.com/org/<org>/project/<p>/page/item/NIM-123`,
 * or `/app/item/<key>` for a local item), which new references are written
 * as, and `[NIM-123](nimbalyst://NIM-123)`, which older bodies keep until the
 * reference is replaced. The node keeps the link it was read with, so either
 * form round-trips byte for byte. The reference key comes from the link and
 * the chip shows the item. Either form keeps its written label
 * (`[the sync engine](...)`), which is the sentence the Links section shows,
 * so saving never changes a link's text.
 * The title attribute holds space-separated `k=v` tokens: `view=` (omitted for
 * the default chip) then `rel=<predicateId>` (omitted for a plain link), e.g.
 * `[NIM-1](nimbalyst://NIM-1 "view=card rel=built-on")`. Import accepts either
 * order and drops unknown tokens; unsupported views normalize to the chip.
 *
 * Scheme-gated so it never collides with `DocumentReferenceTransformer`, whose
 * regex explicitly excludes links containing `://`.
 */

import type { TextMatchTransformer } from '@lexical/markdown';
import { $createTextNode } from 'lexical';
import { $createLinkNode } from '@lexical/link';

import {
  $createTrackerReferenceNode,
  $isTrackerReferenceNode,
  TrackerReferenceNode,
  TRACKER_REFERENCE_URN_SCHEME,
  normalizeTrackerReferenceRelation,
  normalizeTrackerReferenceView,
} from './TrackerReferenceNodeCore';
import {
  TRACKER_REFERENCE_CONSOLE_HREF_PATTERN,
  TRACKER_REFERENCE_KEY_PATTERN,
  trackerReferenceKeyFromHref,
} from './trackerReferenceHref';
import { isTranscludeTitle } from '../../editor/plugins/TransclusionPlugin/transclusionLink';

const TRACKER_REFERENCE_IMPORT_REGEXP = new RegExp(
  String.raw`(?<!!)\[([^\]]+)\]\((nimbalyst:\/\/(${TRACKER_REFERENCE_KEY_PATTERN})|${TRACKER_REFERENCE_CONSOLE_HREF_PATTERN})(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^()]*)\)))?\s*\)`,
);
function titleToken(title: string | undefined, name: string): string | undefined {
  return title?.match(new RegExp(String.raw`(?:^|\s)${name}=([^\s]+)(?:\s|$)`))?.[1];
}

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
    const view = node.getView();
    const relation = node.getRelation();
    const tokens = [
      ...(view === 'chip' ? [] : [`view=${view}`]),
      ...(relation ? [`rel=${relation}`] : []),
    ];
    const title = tokens.length ? ` "${tokens.join(' ')}"` : '';
    return `[${node.getLabel() ?? key}](${node.getHref() ?? `${TRACKER_REFERENCE_URN_SCHEME}${key}`}${title})`;
  },
  // Match only tracker issue keys and local tracker URNs. Other nimbalyst://
  // namespaces (including action links) must remain ordinary links.
  importRegExp: TRACKER_REFERENCE_IMPORT_REGEXP,
  regExp: TRACKER_REFERENCE_REGEXP,
  replace: (textNode, match) => {
    const [, writtenLabel, href, urnKey, doubleQuotedTitle, singleQuotedTitle, parenthesizedTitle] = match;
    // The console pattern only finds candidates; the parser decides.
    const referenceKey = urnKey ?? trackerReferenceKeyFromHref(href);
    if (!referenceKey) return undefined;
    const title = doubleQuotedTitle ?? singleQuotedTitle ?? parenthesizedTitle;
    // A typed page's console link asking for a transclusion stays a link, title
    // and all, for the TransclusionExtension to upgrade.
    if (!urnKey && isTranscludeTitle(title)) {
      const link = $createLinkNode(href, { title });
      const text = $createTextNode(writtenLabel);
      text.setFormat(textNode.getFormat());
      link.append(text);
      textNode.replace(link);
      return text;
    }
    const view = normalizeTrackerReferenceView(titleToken(title, 'view'));
    const relation = normalizeTrackerReferenceRelation(titleToken(title, 'rel'));
    // null keeps the `nimbalyst://KEY` form; a console link is kept as written.
    // The label is stored only when it is not the key.
    const label = writtenLabel !== referenceKey ? writtenLabel : null;
    textNode.replace($createTrackerReferenceNode(referenceKey, view, relation, urnKey ? null : href, label));
    return undefined;
  },
  trigger: ')',
  type: 'text-match',
};
