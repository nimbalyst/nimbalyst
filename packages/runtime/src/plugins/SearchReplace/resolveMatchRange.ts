/**
 * Build a DOM Range covering `length` characters starting at `offset` within the text
 * content of `element`.
 *
 * The DOM element Lexical renders for a TextNode is not always `<span>text</span>` with a
 * single text child: inline code renders as `<code><span class="nim-text-code">text</span></code>`,
 * so the match text lives in a descendant, not `element.firstChild`. Walking descendant text
 * nodes also lets a match span several of them.
 */
export function resolveMatchRange(element: HTMLElement, offset: number, length: number): Range | null {
  if (offset < 0 || length <= 0) return null;

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const end = offset + length;

  let consumed = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  let node = walker.nextNode() as Text | null;
  while (node) {
    const nodeEnd = consumed + node.length;

    if (startNode === null && offset < nodeEnd) {
      startNode = node;
      startOffset = offset - consumed;
    }

    if (startNode !== null && end <= nodeEnd) {
      endNode = node;
      endOffset = end - consumed;
      break;
    }

    // Clamp to the last text node if the match runs past the element's text.
    endNode = node;
    endOffset = node.length;
    consumed = nodeEnd;
    node = walker.nextNode() as Text | null;
  }

  if (!startNode || !endNode) return null;

  const range = document.createRange();
  try {
    range.setStart(startNode, Math.min(startOffset, startNode.length));
    range.setEnd(endNode, Math.min(endOffset, endNode.length));
  } catch {
    return null;
  }

  return range.collapsed ? null : range;
}
