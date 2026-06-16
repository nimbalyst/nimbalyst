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
 * Note: In Nimbalyst's MarkdownRenderer, hast properties.dir is ignored
 * because custom React components are used. This plugin is kept as a
 * fallback for standard react-markdown renderers; the component overrides
 * in RtlTranscriptHost.tsx are what actually apply dir to the DOM.
 */

import { visit } from 'unist-util-visit';
import type { Element, ElementContent, Root, Text } from 'hast';
import { detectDirection } from './detection';

/** Text block tags that should receive a direction */
const TEXT_BLOCK_TAGS = new Set([
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'td', 'th', 'dd', 'dt', 'figcaption',
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
  } = options;

  return (tree: Root): void => {
    // Forced mode — set direction on the whole tree
    if (mode === 'rtl' || mode === 'ltr') {
      setDirOnTree(tree, mode);
      return;
    }

    // Auto mode
    if (!perBlock) {
      // Per-message: direction of the whole transcript based on full content
      const fullText = extractText(tree.children as ElementContent[]);
      const dir = detectDirection(fullText, threshold);
      setDirOnTree(tree, dir);
      return;
    }

    // Per-block: analyze each text block independently
    visit(tree, 'element', (node: Element) => {
      if (PROTECTED_TAGS.has(node.tagName)) {
        // Code block — LTR and isolated
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
