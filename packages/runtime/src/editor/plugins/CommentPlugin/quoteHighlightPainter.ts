/**
 * Draws the highlights of quote-anchored threads (no MarkNode) with the CSS
 * Custom Highlight API. A decoration, not a node: nothing is written to the
 * editor state or the shared Y.Doc, so a commenter can see and click their own
 * thread's highlight. Styled by `::highlight(nim-comment-quote*)` in
 * CommentPlugin.css.
 *
 * `CSS.highlights` is one registry per document shared by every mounted editor,
 * so each painter adds and removes only its own ranges on the shared
 * `Highlight` objects instead of replacing them.
 */
import { getDOMTextNode, type LexicalEditor } from 'lexical';

import type { ResolvedCommentAnchor } from '../../commenting/CollabCommentControllerRegistry';

export const QUOTE_HIGHLIGHT = 'nim-comment-quote';
export const QUOTE_HIGHLIGHT_SELECTED = 'nim-comment-quote-selected';
export const QUOTE_HIGHLIGHT_RESOLVED = 'nim-comment-quote-resolved';

export type QuoteHighlightName =
  | typeof QUOTE_HIGHLIGHT
  | typeof QUOTE_HIGHLIGHT_SELECTED
  | typeof QUOTE_HIGHLIGHT_RESOLVED;

function highlightRegistry(): HighlightRegistry | null {
  if (
    typeof CSS === 'undefined' ||
    !('highlights' in CSS) ||
    typeof Highlight !== 'function'
  ) {
    return null;
  }
  return CSS.highlights;
}

/** A DOM Range over a resolved anchor, or null when its text is not rendered. */
export function createQuoteDomRange(
  editor: Pick<LexicalEditor, 'getElementByKey'>,
  anchor: ResolvedCommentAnchor,
): Range | null {
  const startText = getDOMTextNode(editor.getElementByKey(anchor.start.key));
  const endText = getDOMTextNode(editor.getElementByKey(anchor.end.key));
  if (!startText || !endText) return null;
  const range = startText.ownerDocument.createRange();
  range.setStart(startText, Math.min(anchor.start.offset, startText.length));
  range.setEnd(endText, Math.min(anchor.end.offset, endText.length));
  return range;
}

export class QuoteHighlightPainter {
  private painted: Array<{ name: QuoteHighlightName; range: Range }> = [];

  paint(entries: ReadonlyArray<{ name: QuoteHighlightName; range: Range }>) {
    this.clear();
    const registry = highlightRegistry();
    if (!registry) return;
    for (const entry of entries) {
      let highlight = registry.get(entry.name);
      if (!highlight) {
        highlight = new Highlight();
        registry.set(entry.name, highlight);
      }
      highlight.add(entry.range);
      this.painted.push(entry);
    }
  }

  clear() {
    const registry = highlightRegistry();
    if (registry) {
      for (const { name, range } of this.painted) {
        registry.get(name)?.delete(range);
      }
    }
    this.painted = [];
  }
}

/** The thread whose highlight contains the point, if any. */
export function hitTestQuoteRanges(
  ranges: ReadonlyMap<string, Range>,
  clientX: number,
  clientY: number,
): string | null {
  for (const [threadId, range] of ranges) {
    if (typeof range.getClientRects !== 'function') continue;
    for (const rect of Array.from(range.getClientRects())) {
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return threadId;
      }
    }
  }
  return null;
}
