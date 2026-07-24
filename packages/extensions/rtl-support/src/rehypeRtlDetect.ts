/**
 * rehypeRtlDetect — a custom rehype plugin that adds a text direction
 * (dir) attribute to hAST blocks based on their content.
 *
 * Unlike tag-based direction plugins, this one analyzes the text of each
 * block to detect the appropriate direction.
 *
 * How it works:
 *  - Walks the hAST tree (HTML AST from react-markdown)
 *  - For text blocks (p, li, h1-h6, blockquote, td, th) extracts the text
 *  - Detects direction with detectDirection()
 *  - Sets the dir attribute on the node
 *  - Protects code blocks (pre/code) — always LTR
 *
 * Nimbalyst's MarkdownRenderer forwards these hAST properties to its styled
 * DOM elements, so direction can be added without replacing host renderers.
 */

import { visit } from 'unist-util-visit';
import type { Element, ElementContent, Root, Text } from 'hast';
import { detectDirection, detectInlineRuns } from './detection';

/** Text block tags that should receive a direction */
const TEXT_BLOCK_TAGS = new Set([
  'p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'table', 'td', 'th', 'dd', 'dt', 'figcaption',
]);

/** Leaf-oriented blocks whose inline text can safely be isolated once. */
const INLINE_TEXT_TAGS = new Set([
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'td', 'th', 'dd', 'dt', 'figcaption',
]);

/** Tags whose content should always stay LTR */
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
  /** RTL detection threshold (0..1) */
  threshold?: number;
  /** Whether to detect per-block or per-message */
  perBlock?: boolean;
  /** Mode: auto = detect, rtl/ltr = force */
  mode?: 'auto' | 'rtl' | 'ltr';
  /** Whether mixed-direction text runs should be wrapped in isolated spans */
  inlineDetect?: boolean;
}

type Dir = 'rtl' | 'ltr';

function directionClasses(tagName: string, dir: Dir): string[] {
  if (tagName === 'table') return ['nim-rtl-table', `nim-rtl-${dir}`];
  if (tagName === 'td' || tagName === 'th') return ['nim-rtl-cell', `nim-rtl-${dir}`];
  if (TEXT_BLOCK_TAGS.has(tagName)) return ['nim-rtl-block', `nim-rtl-${dir}`];
  return [];
}

function setDirection(node: Element, dir: Dir): void {
  const properties: Element['properties'] = { ...(node.properties || {}), dir };
  const existing = properties.className;
  const classNames = Array.isArray(existing)
    ? existing.map(String)
    : typeof existing === 'string'
      ? existing.split(/\s+/).filter(Boolean)
      : [];

  for (const className of directionClasses(node.tagName, dir)) {
    if (!classNames.includes(className)) classNames.push(className);
  }
  if (classNames.length > 0) properties.className = classNames;
  node.properties = properties;
}

function wrapInlineText(node: Element): void {
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child.type === 'element') {
      if (!PROTECTED_TAGS.has(child.tagName)) wrapInlineText(child);
      continue;
    }
    if (child.type !== 'text') continue;

    const runs = detectInlineRuns(child.value);
    if (runs.length === 0 || !child.value.trim()) continue;

    const spans: Element[] = runs.map((run) => ({
      type: 'element',
      tagName: 'span',
      properties: {
        dir: run.direction,
        style: 'unicode-bidi: isolate',
      },
      children: [{ type: 'text', value: run.text }],
    }));
    node.children.splice(index, 1, ...spans);
    index += spans.length - 1;
  }
}

function isolateInlineText(node: Element): void {
  if (detectInlineRuns(extractText(node.children)).length <= 1) return;
  wrapInlineText(node);
}

function setDirOnTree(tree: Root, dir: Dir): void {
  visit(tree, 'element', (node: Element) => {
    if (PROTECTED_TAGS.has(node.tagName)) {
      setDirection(node, 'ltr');
      return;
    }
    setDirection(node, dir);
  });
}

/**
 * rehype plugin for automatic text direction detection.
 *
 * @example
 * ```ts
 * import { rehypeRtlDetect } from './rehypeRtlDetect';
 *
 * setTranscriptMarkdownContributions('my-ext', {
 *   rehypePlugins: [[rehypeRtlDetect, { threshold: 0.3 }]],
 * });
 * ```
 */
export function rehypeRtlDetect(options: RehypeRtlDetectOptions = {}) {
  const {
    threshold = 0.3,
    perBlock = true,
    mode = 'auto',
    inlineDetect = false,
  } = options;

  return (tree: Root): void => {
    // Forced mode — set direction on the whole tree
    if (mode === 'rtl' || mode === 'ltr') {
      setDirOnTree(tree, mode);
      if (inlineDetect) {
        visit(tree, 'element', (node: Element) => {
          if (INLINE_TEXT_TAGS.has(node.tagName)) isolateInlineText(node);
        });
      }
      return;
    }

    // Auto mode
    if (!perBlock) {
      // Per-message: direction of the whole transcript based on full content
      const fullText = extractText(tree.children as ElementContent[]);
      const dir = detectDirection(fullText, threshold);
      setDirOnTree(tree, dir);
      if (inlineDetect) {
        visit(tree, 'element', (node: Element) => {
          if (INLINE_TEXT_TAGS.has(node.tagName)) isolateInlineText(node);
        });
      }
      return;
    }

    // Per-block: analyze each text block independently
    visit(tree, 'element', (node: Element) => {
      if (PROTECTED_TAGS.has(node.tagName)) {
        // Code block — LTR and isolated
        setDirection(node, 'ltr');
        return;
      }
      if (!TEXT_BLOCK_TAGS.has(node.tagName)) return;

      const text = extractText(node.children as ElementContent[]);
      if (!text.trim()) return;

      const dir = detectDirection(text, threshold);
      setDirection(node, dir);
      if (inlineDetect && INLINE_TEXT_TAGS.has(node.tagName)) isolateInlineText(node);
    });
  };
}

export default rehypeRtlDetect;
