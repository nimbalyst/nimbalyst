/**
 * Markdown normalizer for preprocessing markdown before parsing.
 * Handles indent normalization and other compatibility fixes.
 */

import {
  ORDERED_LIST_REGEX,
  UNORDERED_LIST_REGEX,
  CHECK_LIST_REGEX,
} from './ListTransformers';

/**
 * Configuration for markdown normalization
 */
export interface NormalizerConfig {
  // Target indent size for normalization (default: auto-detect)
  targetIndentSize?: number;
  // Whether to normalize list indents (default: true)
  normalizeListIndents?: boolean;
  // Whether to preserve code blocks unchanged (default: true)
  preserveCodeBlocks?: boolean;
}

/**
 * Detects the most common indent size used in a markdown document
 * @param markdown The markdown string to analyze
 * @returns The detected indent size (2, 3, or 4) or null if no lists found
 */
export function detectMarkdownIndentSize(markdown: string): number | null {
  const lines = markdown.split('\n');
  const indentSizes: Map<number, number> = new Map();

  // Track what indent sizes are actually used
  let lastIndentLevel = 0;
  let inCodeBlock = false;

  for (const line of lines) {
    // Skip code blocks
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Check if this is a list item
    const isListItem =
      ORDERED_LIST_REGEX.test(line) ||
      UNORDERED_LIST_REGEX.test(line) ||
      CHECK_LIST_REGEX.test(line);

    if (isListItem) {
      const leadingSpaces = line.match(/^(\s*)/)?.[1] || '';
      const spaceCount = leadingSpaces.replace(/\t/g, '    ').length; // Convert tabs to 4 spaces

      if (spaceCount > 0) {
        // Try to determine the indent size by looking at the difference from the previous level
        if (lastIndentLevel === 0) {
          // First indent - this is our indent size
          const count = indentSizes.get(spaceCount) || 0;
          indentSizes.set(spaceCount, count + 1);
        } else if (spaceCount > lastIndentLevel) {
          // Increased indent - the difference might be our indent size
          const diff = spaceCount - lastIndentLevel;
          if (diff >= 2 && diff <= 4) {
            const count = indentSizes.get(diff) || 0;
            indentSizes.set(diff, count + 1);
          }
        } else if (spaceCount < lastIndentLevel) {
          // Decreased indent - the difference might be our indent size
          const diff = lastIndentLevel - spaceCount;
          if (diff >= 2 && diff <= 4) {
            const count = indentSizes.get(diff) || 0;
            indentSizes.set(diff, count + 1);
          }
        }

        lastIndentLevel = spaceCount;
      } else {
        lastIndentLevel = 0;
      }
    }
  }

  // Find the most common indent size
  let mostCommon: number | null = null;
  let maxCount = 0;

  // Prefer 2, 3, or 4 space indents (in that order for ties)
  for (const size of [2, 3, 4]) {
    const count = indentSizes.get(size) || 0;
    if (count > maxCount) {
      maxCount = count;
      mostCommon = size;
    }
  }

  return mostCommon;
}

/**
 * Normalizes list indentation in markdown to a consistent size
 * @param markdown The markdown string to normalize
 * @param config Normalization configuration
 * @returns The normalized markdown string
 */
export function normalizeMarkdownLists(
  markdown: string,
  config: NormalizerConfig = {}
): string {
  const {
    targetIndentSize,
    normalizeListIndents = true,
    preserveCodeBlocks = true,
  } = config;

  if (!normalizeListIndents) {
    return markdown;
  }

  // Detect the indent size if not specified
  const detectedSize = detectMarkdownIndentSize(markdown);

  // Default target to 2 for consistent handling
  const targetSize = targetIndentSize || 2;

  // If no lists found, return as-is
  if (!detectedSize) {
    return markdown;
  }

  // If already using target size, return as-is
  if (detectedSize === targetSize) {
    return markdown;
  }

  const lines = markdown.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Handle code blocks
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock && preserveCodeBlocks) {
      result.push(line);
      continue;
    }

    // Check if this is a list item
    const listMatch =
      line.match(ORDERED_LIST_REGEX) ||
      line.match(UNORDERED_LIST_REGEX) ||
      line.match(CHECK_LIST_REGEX);

    if (listMatch) {
      const leadingWhitespace = listMatch[1];
      const restOfLine = line.substring(leadingWhitespace.length);

      // Convert tabs to spaces first
      const spacesOnly = leadingWhitespace.replace(/\t/g, ' '.repeat(detectedSize));
      const spaceCount = spacesOnly.length;

      // Calculate the indent level based on detected size
      const indentLevel = Math.round(spaceCount / detectedSize);

      // Create new indentation with target size
      const newIndent = ' '.repeat(indentLevel * targetSize);

      result.push(newIndent + restOfLine);
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * Full markdown normalization pipeline
 * @param markdown The markdown string to normalize
 * @param config Normalization configuration
 * @returns The normalized markdown string
 */
export function normalizeMarkdown(
  markdown: string,
  config: NormalizerConfig = {}
): string {
  // Apply list normalization
  let normalized = normalizeMarkdownLists(markdown, config);

  // Future: Add other normalizations here
  // - Normalize heading styles
  // - Fix table alignment
  // - Standardize link formats
  // etc.

  return normalized;
}