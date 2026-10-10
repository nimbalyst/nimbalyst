import { $getNearestNodeFromDOMNode, type LexicalEditor } from 'lexical';
import { $isLinkNode } from '@lexical/link';
import { $findMatchingParent } from '@lexical/utils';

/**
 * The href of a tapped link as written in the markdown.
 *
 * Lexical renders a link without a scheme with `https://` in front of it, so
 * `[Product](Product.md)` gets `href="https://Product.md"`, and native would
 * open a page link in the browser. The node keeps the authored URL; read that.
 */
export function authoredLinkHref(editor: LexicalEditor | null, anchor: Element): string {
  const rendered = anchor.getAttribute('href') ?? '';
  if (!editor) return rendered;
  return editor.read(() => {
    const node = $getNearestNodeFromDOMNode(anchor);
    const link = node && ($isLinkNode(node) ? node : $findMatchingParent(node, $isLinkNode));
    return $isLinkNode(link) ? link.getURL() : rendered;
  });
}
