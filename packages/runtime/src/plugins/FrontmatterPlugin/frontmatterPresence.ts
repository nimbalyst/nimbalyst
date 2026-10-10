/**
 * Which frontmatter the generic Properties editor claims, and the status a
 * page shows above its text. A tracker document's frontmatter belongs to the
 * tracker header instead.
 */

import { detectTrackerFromFrontmatter } from '../TrackerPlugin/documentHeader/frontmatterUtils';
import { extractFrontmatterWithError, parseFields } from './fieldUtils';

function isMarkdownPath(filePath: string): boolean {
  // Other file types (e.g. .astro) may use --- delimiters for non-YAML purposes.
  const lowerPath = filePath.toLowerCase();
  return !lowerPath || lowerPath.endsWith('.md') || lowerPath.endsWith('.mdx');
}

/**
 * Whether the generic Properties editor shows this document's frontmatter
 * (or its parse error).
 */
export function shouldRenderGenericFrontmatter(content: string, filePath: string): boolean {
  if (!isMarkdownPath(filePath)) return false;

  const result = extractFrontmatterWithError(content);
  if (!result.hasFrontmatter) return false;
  // Invalid frontmatter shows its parse error.
  if (!result.success) return true;
  if (!result.data) return false;

  // Stand down only when the tracker header will actually claim the document.
  //
  // This used to test a hardcoded list of status keys for truthiness, which
  // diverged from `detectTrackerFromFrontmatter`: it abdicated on any truthy
  // value while every tracker branch requires the key to hold an *object*. A
  // scalar `planStatus: draft` was therefore claimed by nobody (nimbalyst#1357).
  // Asking the detector directly keeps the two in step by construction
  // (nimbalyst#67).
  if (detectTrackerFromFrontmatter(content) !== null) return false;

  return parseFields(result.data).length > 0;
}

/** A status that means the page is in its normal state, so nothing is shown. */
const SETTLED_STATUSES = new Set(['current']);

export type FrontmatterStatusBadge =
  | { kind: 'status'; status: string }
  | { kind: 'invalid' };

/**
 * What a page shows above its text: its `status` when it is not the settled
 * one, or that its frontmatter does not parse. Null shows nothing.
 */
export function frontmatterStatusBadge(content: string, filePath: string): FrontmatterStatusBadge | null {
  if (!shouldRenderGenericFrontmatter(content, filePath)) return null;
  const result = extractFrontmatterWithError(content);
  if (!result.success) return { kind: 'invalid' };
  const status = result.data?.status;
  if (typeof status !== 'string') return null;
  const trimmed = status.trim();
  return trimmed && !SETTLED_STATUSES.has(trimmed.toLowerCase()) ? { kind: 'status', status: trimmed } : null;
}
