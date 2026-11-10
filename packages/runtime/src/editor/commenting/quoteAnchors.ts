/**
 * Text-quote anchors that live only in thread data.
 *
 * A commenter (`editBody: false`) cannot write a MarkNode, because a MarkNode
 * is a change to the Lexical `root` and the server refuses any commenter update
 * that touches it. Their threads carry a `text-quote` anchor instead, and every
 * viewer finds the highlight at render time with the rule orphan re-anchoring
 * uses (`resolveThreadAnchorInIndex`, `findThreadQuoteOffset` in quoteMatch.ts):
 * the full selector, else the bare quote if it is unique. A quote found zero
 * times or more than once draws nothing and the thread is listed as
 * unanchored. Creating a thread stays strict (`resolveAnchorInIndex`).
 *
 * A legacy thread whose MarkNode was dropped by a markdown rebuild resolves the
 * same way, so it stays highlighted for viewers who cannot re-anchor it.
 */
import {
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  type LexicalEditor,
  type PointType,
} from 'lexical';

import {
  $buildCommentTextIndex,
  CollabCommentControllerError,
  collectMarkIds,
  getThreadQuoteSelector,
  resolveAnchorInIndex,
  resolveThreadAnchorInIndex,
  type CommentTextIndex,
  type ResolvedCommentAnchor,
} from './CollabCommentControllerRegistry';
import type { TextQuoteCommentAnchor, Thread } from './types';

/**
 * Context widths tried, in characters, when the selected text occurs more than
 * once. 128 characters stays under the 512-byte context bound even for
 * four-byte characters.
 */
const CONTEXT_WIDTHS = [0, 16, 32, 64, 128] as const;

export { getThreadQuoteSelector };

export interface QuoteHighlightResolution {
  /** Threads with no MarkNode whose quote occurs exactly once. */
  ranges: Map<string, ResolvedCommentAnchor>;
  /** Threads with no MarkNode and no unique quote match. */
  unanchored: Set<string>;
}

/**
 * Resolve the decoration highlight of every thread that has no MarkNode. Builds
 * the text index once for the whole pass.
 */
export function resolveQuoteHighlights(
  editor: LexicalEditor,
  threads: readonly Thread[],
  attached: ReadonlySet<string> = collectMarkIds(editor),
): QuoteHighlightResolution {
  const ranges = new Map<string, ResolvedCommentAnchor>();
  const unanchored = new Set<string>();
  editor.getEditorState().read(() => {
    let index: CommentTextIndex | null = null;
    for (const thread of threads) {
      if (attached.has(thread.id)) continue;
      const selector = getThreadQuoteSelector(thread);
      if (!selector) {
        unanchored.add(thread.id);
        continue;
      }
      index ??= $buildCommentTextIndex();
      try {
        ranges.set(thread.id, resolveThreadAnchorInIndex(index, selector));
      } catch {
        unanchored.add(thread.id);
      }
    }
  });
  return { ranges, unanchored };
}

/**
 * Offset in the index text of a selection point. An element point (a block
 * boundary, as triple-click produces) maps to the start of the first text at
 * or after it.
 */
function $pointToTextOffset(
  index: CommentTextIndex,
  point: PointType,
): number | null {
  if (point.type === 'text') {
    const segment = index.segments.find(
      (candidate) => candidate.node.getKey() === point.key,
    );
    if (!segment) return null;
    return segment.start + Math.min(point.offset, segment.end - segment.start);
  }
  const node = point.getNode();
  if (!$isElementNode(node)) return null;
  const child = node.getChildAtIndex(point.offset);
  for (const segment of index.segments) {
    const textNode = segment.node;
    const atOrAfter = child
      ? textNode.is(child) ||
        child.isParentOf(textNode) ||
        child.isBefore(textNode)
      : node.isBefore(textNode) && !node.isParentOf(textNode);
    if (atOrAfter) return segment.start;
  }
  return index.text.length;
}

/**
 * The anchor for `[start, end)` of the index text, with the least prefix and
 * suffix context that makes it unique. When even the widest context repeats
 * (two identical passages), the widest anchor is returned anyway: the thread
 * is kept and listed as unanchored rather than refused.
 */
export function quoteAnchorForRange(
  index: CommentTextIndex,
  start: number,
  end: number,
): TextQuoteCommentAnchor | null {
  const exact = index.text.slice(start, end);
  if (!exact.trim()) return null;
  let widest: TextQuoteCommentAnchor | null = null;
  for (const width of CONTEXT_WIDTHS) {
    const prefix = width ? index.text.slice(Math.max(0, start - width), start) : '';
    const suffix = width ? index.text.slice(end, end + width) : '';
    const anchor: TextQuoteCommentAnchor = {
      kind: 'text-quote',
      exact,
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
    };
    try {
      resolveAnchorInIndex(index, anchor);
      return anchor;
    } catch (error) {
      if (
        error instanceof CollabCommentControllerError &&
        error.code === 'ANCHOR_AMBIGUOUS'
      ) {
        widest = anchor;
        continue;
      }
      // Over the size bounds, or not mappable: no anchor can be stored.
      return widest;
    }
  }
  return widest;
}

/**
 * The quote anchor for the current range selection, trimmed of surrounding
 * whitespace (a triple-click ends on the next block's boundary). Must run
 * inside a Lexical read or update. Null when nothing quotable is selected.
 */
export function $quoteAnchorFromSelection(): TextQuoteCommentAnchor | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || selection.isCollapsed()) return null;
  const index = $buildCommentTextIndex();
  const [first, last] = selection.isBackward()
    ? [selection.focus, selection.anchor]
    : [selection.anchor, selection.focus];
  let start = $pointToTextOffset(index, first);
  let end = $pointToTextOffset(index, last);
  if (start === null || end === null) return null;
  while (start < end && /\s/.test(index.text[start])) start += 1;
  while (end > start && /\s/.test(index.text[end - 1])) end -= 1;
  if (end <= start) return null;
  return quoteAnchorForRange(index, start, end);
}
