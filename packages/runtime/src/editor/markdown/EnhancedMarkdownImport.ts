/**
 * Enhanced markdown import with frontmatter support.
 * This module extends Lexical's markdown import capabilities to:
 * - Parse and store frontmatter metadata in the root node
 * - Handle markdown with or without frontmatter seamlessly
 * - Preserve frontmatter data during editor operations
 */

import { $convertFromMarkdownString, Transformer } from '@lexical/markdown';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTabNode,
  ElementNode,
  type LexicalNode,
} from 'lexical';

import {
  $setFrontmatter,
  $getFrontmatter,
  parseFrontmatter,
  type FrontmatterData
} from './FrontmatterUtils';

import {
  normalizeMarkdown,
  type NormalizerConfig
} from './MarkdownNormalizer';

/**
 * Options for enhanced markdown import.
 */
export interface EnhancedImportOptions {
  preserveNewLines?: boolean;
  extractFrontmatter?: boolean;
  normalize?: boolean | NormalizerConfig;
}

/**
 * Result of enhanced markdown import.
 */
export interface EnhancedImportResult {
  frontmatter: FrontmatterData | null;
  originalContent?: string;
}

/**
 * Convert markdown string to Lexical nodes with frontmatter support.
 * This function will:
 * 1. Extract frontmatter from the markdown if present
 * 2. Store frontmatter in the root node's internal state
 * 3. Import the content (without frontmatter) into Lexical
 *
 * @param markdown - The markdown string to import (may include frontmatter)
 * @param transformers - Array of transformers for markdown conversion
 * @param node - Optional node to append content to (default: root)
 * @param preserveNewLines - Whether to preserve newlines (default: true)
 * @param extractFrontmatter - Whether to extract frontmatter (default: true)
 * @returns Result containing extracted frontmatter data
 */
export function $convertFromEnhancedMarkdownString(
  markdown: string,
  transformers?: Array<Transformer>,
  node?: ElementNode,
  preserveNewLines: boolean = true,
  extractFrontmatter: boolean = true,
  normalize: boolean | NormalizerConfig = true
): EnhancedImportResult {
  // Normalize CRLF line endings to LF before any processing.
  // Files with Windows line endings cause regex failures in Lexical's
  // multiline transformers (e.g. mermaid, code blocks) because `$` in
  // regexes doesn't match before `\r`.
  const normalizedMarkdown = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let content = normalizedMarkdown;
  let frontmatter: FrontmatterData | null = null;
  let originalContent: string | undefined;

  // Extract and store frontmatter if requested
  if (extractFrontmatter) {
    const parsed = parseFrontmatter(normalizedMarkdown);
    content = parsed.content;
    frontmatter = parsed.data;
    originalContent = parsed.orig;

    // Store frontmatter in the root node
    if (frontmatter) {
      $setFrontmatter(frontmatter);
    }
  }

  // Normalize the markdown if requested
  if (normalize) {
    const normalizerConfig = typeof normalize === 'boolean'
      ? { targetIndentSize: 2 } // Normalize to 2-space indents - our standard!
      : normalize;
    content = normalizeMarkdown(content, normalizerConfig);
  }

  // Import via upstream Lexical's $convertFromMarkdownString. Our 2-space
  // list house style is handled by the MarkdownNormalizer pre-pass above and
  // by ListTransformers' export side; the importer itself accepts any
  // indent size that matches a list-item regex.
  //
  // The export side encodes literal `*`/`_` adjacent to emphasis runs as
  // HTML numeric character references, so upstream's CommonMark emphasis
  // scanner (which classifies `\` as non-punctuation) re-imports our exports
  // without losing emphasis spans. See exportTextFormat in
  // EnhancedMarkdownExport for the rationale.
  $convertFromMarkdownString(content, transformers || [], node, preserveNewLines);

  // Upstream splits literal tab characters in text nodes into TabNodes
  // (registered automatically by core Lexical). Our DiffPlugin's tree matcher
  // doesn't know how to align text+tab+text+tab+text spans against the same
  // logical paragraph, which corrupts diffs that contain tab whitespace. The
  // forked import path used to leave tabs as plain characters inside their
  // surrounding TextNodes, so collapse upstream's TabNodes back to text here
  // to preserve that behavior until the diff system grows TabNode awareness.
  $collapseTabNodes(node ?? $getRoot());

  return {
    frontmatter,
    originalContent,
  };
}

function $collapseTabNodes(root: ElementNode): void {
  const visit = (node: LexicalNode): void => {
    if ($isTabNode(node)) {
      node.replace($createTextNode('\t'));
      return;
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        visit(child);
      }
    }
  };
  visit(root);
}

/**
 * Helper function to update frontmatter in the current editor state.
 * This can be called after the initial import to modify frontmatter data.
 *
 * @param data - The frontmatter data to set (null to clear)
 */
export function $updateFrontmatter(data: FrontmatterData | null): void {
  $setFrontmatter(data);
}

/**
 * Helper function to merge new frontmatter data with existing data.
 * Useful for incrementally updating metadata without overwriting everything.
 *
 * @param newData - The new frontmatter data to merge
 */
export function $mergeFrontmatter(newData: FrontmatterData): void {
  const existing = $getFrontmatter();
  const merged = {
    ...existing,
    ...newData,
  };
  $setFrontmatter(merged);
}

// Re-export getFrontmatter for convenience
export { $getFrontmatter } from './FrontmatterUtils';

/**
 * Convert markdown to Lexical nodes and return both the nodes and frontmatter.
 * This is useful for processing markdown without immediately updating the editor.
 *
 * @param markdown - The markdown string to process
 * @param transformers - Array of transformers for markdown conversion
 * @returns Parsed content and frontmatter data
 */
export function parseEnhancedMarkdown(
  markdown: string,
  transformers?: Array<Transformer>
): {
  content: string;
  frontmatter: FrontmatterData | null;
  transformers: Array<Transformer>;
} {
  const parsed = parseFrontmatter(markdown);

  return {
    content: parsed.content,
    frontmatter: parsed.data,
    transformers: transformers || [],
  };
}
