/**
 * The page's headings, in document order, with the same GitHub-style anchor
 * ids `HeadingAnchorExtension` puts on the rendered elements (a repeated slug
 * gets `-1`, `-2`, ...), so a TOC entry's `#slug` matches its heading.
 */

import { $isHeadingNode } from '@lexical/rich-text';
import { $getRoot, $isElementNode, $isParagraphNode, type LexicalNode } from 'lexical';

import { slugify } from '../../utils/headingSlug';

export interface TocHeading {
  key: string;
  text: string;
  level: number;
  slug: string;
}

function $collectHeadingNodes(node: LexicalNode, out: LexicalNode[]): void {
  if ($isHeadingNode(node)) {
    out.push(node);
    return;
  }
  // Paragraphs never hold headings; everything else (columns, callouts,
  // collapsibles, table cells) might.
  if ($isElementNode(node) && !$isParagraphNode(node)) {
    for (const child of node.getChildren()) $collectHeadingNodes(child, out);
  }
}

export function $getTocHeadings(maxDepth: number): TocHeading[] {
  const nodes: LexicalNode[] = [];
  $collectHeadingNodes($getRoot(), nodes);

  const taken = new Map<string, number>();
  const headings: TocHeading[] = [];
  for (const node of nodes) {
    if (!$isHeadingNode(node)) continue;
    const text = node.getTextContent();
    const base = slugify(text);
    let slug = base;
    if (base) {
      const count = taken.get(base);
      if (count !== undefined) {
        slug = `${base}-${count + 1}`;
        taken.set(base, count + 1);
      } else {
        taken.set(base, 0);
      }
    }
    const level = Number(node.getTag().slice(1));
    if (level <= maxDepth && text.trim()) {
      headings.push({ key: node.getKey(), text, level, slug });
    }
  }
  return headings;
}
