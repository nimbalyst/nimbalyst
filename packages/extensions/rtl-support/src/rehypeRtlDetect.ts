/**
 * rehypeRtlDetect — یه rehype plugin سفارشی که جهت متن (dir) رو
 * بر اساس محتوا به بلاک‌های hAST اضافه می‌کنه.
 *
 * نکته: در برخی renderer‌ها (مثل MarkdownRenderer Nimbalyst) properties hAST
 * به DOM نمی‌رسه چون component سفارشی استفاده می‌شه. برای اون موارد،
 * component override در RtlTranscriptHost.tsx مسئول اعمال dir هست.
 * این rehype plugin برای renderer‌های استاندارد react-markdown نگه‌داری می‌شه.
 */

import { visit } from 'unist-util-visit';
import type { Element, ElementContent, Root, Text } from 'hast';
import { detectDirection } from './detection';

const TEXT_BLOCK_TAGS = new Set([
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'td', 'th', 'dd', 'dt', 'figcaption',
]);

const PROTECTED_TAGS = new Set([
  'pre', 'code', 'kbd', 'samp', 'var', 'tt',
]);

function extractText(node: ElementContent | ElementContent[] | undefined): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((c) => extractText(c)).join('');
  if (node.type === 'text') return (node as Text).value;
  if (node.type === 'element') {
    if (PROTECTED_TAGS.has(node.tagName)) return '';
    return extractText(node.children as ElementContent[]);
  }
  return '';
}

export interface RehypeRtlDetectOptions {
  threshold?: number;
  perBlock?: boolean;
  mode?: 'auto' | 'rtl' | 'ltr';
}

type Dir = 'rtl' | 'ltr';

function setDirOnTree(tree: Root, dir: Dir): void {
  visit(tree, 'element', (node: Element) => {
    if (PROTECTED_TAGS.has(node.tagName)) {
      node.properties = { ...(node.properties || {}), dir: 'ltr' };
      return;
    }
    node.properties = { ...(node.properties || {}), dir };
  });
}

export function rehypeRtlDetect(options: RehypeRtlDetectOptions = {}) {
  const {
    threshold = 0.3,
    perBlock = true,
    mode = 'auto',
  } = options;

  return (tree: Root): void => {
    if (mode === 'rtl' || mode === 'ltr') {
      setDirOnTree(tree, mode);
      return;
    }

    if (!perBlock) {
      const fullText = extractText(tree.children as ElementContent[]);
      const dir = detectDirection(fullText, threshold);
      setDirOnTree(tree, dir);
      return;
    }

    visit(tree, 'element', (node: Element) => {
      if (PROTECTED_TAGS.has(node.tagName)) {
        node.properties = { ...(node.properties || {}), dir: 'ltr' };
        return;
      }
      if (!TEXT_BLOCK_TAGS.has(node.tagName)) return;

      const text = extractText(node.children as ElementContent[]);
      if (!text.trim()) return;

      const dir = detectDirection(text, threshold);
      node.properties = { ...(node.properties || {}), dir };
    });
  };
}

export default rehypeRtlDetect;
