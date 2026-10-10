import { describe, expect, it } from 'vitest';
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';
import { $createLinkNode, LinkNode } from '@lexical/link';
import { authoredLinkHref } from '../linkHref';

function renderLinks(urls: string[]) {
  const editor = createEditor({ nodes: [LinkNode], onError: (error) => { throw error; } });
  const root = document.createElement('div');
  editor.setRootElement(root);
  editor.update(() => {
    const paragraph = $createParagraphNode();
    for (const url of urls) paragraph.append($createLinkNode(url).append($createTextNode(url)));
    $getRoot().append(paragraph);
  }, { discrete: true });
  return { editor, anchors: [...root.querySelectorAll('a')] };
}

describe('authoredLinkHref', () => {
  it('returns the written href, not the https:// one Lexical renders for a page link', () => {
    const { editor, anchors } = renderLinks(['Product.md', 'Product/MVP%20scope.md', 'https://example.com']);
    expect(anchors[0].getAttribute('href')).toBe('https://Product.md');
    expect(anchors.map((anchor) => authoredLinkHref(editor, anchor))).toEqual(['Product.md', 'Product/MVP%20scope.md', 'https://example.com']);
    // A tap usually lands on the text inside the anchor.
    expect(authoredLinkHref(editor, anchors[0].firstElementChild!)).toBe('Product.md');
  });
});
