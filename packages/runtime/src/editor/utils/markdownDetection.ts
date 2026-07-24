/**
 * Markdown detection utilities for paste operations.
 * Analyzes plain text content to determine if it's likely markdown.
 */

/**
 * Configuration for markdown detection
 */
export interface MarkdownDetectionConfig {
  minContentLength?: number;
  minConfidenceScore?: number;
}

/**
 * Default configuration for markdown detection
 */
const DEFAULT_CONFIG: Required<MarkdownDetectionConfig> = {
  minContentLength: 10,
  minConfidenceScore: 15,
};

/**
 * Pattern definitions for markdown detection
 */
const MARKDOWN_PATTERNS = {
  // Strong indicators (high confidence)
  heading: /^#{1,6}\s+.+/m,
  codeBlock: /^```[\w-]*$/m,
  unorderedList: /^[-*+]\s+.+/m,
  orderedList: /^\d+\.\s+.+/m,
  blockquote: /^>\s+.+/m,
  horizontalRule: /^(?:---+|___+|\*\*\*+)\s*$/m,
  table: /^\|.+\|$/m,
  taskList: /^[-*+]\s+\[[ xX]\]\s+.+/m,

  // Medium indicators
  bold: /\*\*[^*]+\*\*|__[^_]+__/,
  italic: /\*[^*]+\*|_[^_]+_/,
  inlineCode: /`[^`]+`/,
  link: /\[.+?\]\(.+?\)/,

  // Weak indicators
  strikethrough: /~~[^~]+~~/,
  highlight: /==[^=]+==/,
};

/**
 * Calculate confidence score for markdown content
 */
function calculateConfidenceScore(text: string): number {
  const lines = text.split('\n');
  const totalLines = lines.length;
  let score = 0;

  // Track different pattern types found
  const patternsFound = new Set<string>();

  // Check for strong block-level indicators (per line)
  let markdownLines = 0;
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    if (MARKDOWN_PATTERNS.heading.test(line)) {
      markdownLines++;
      patternsFound.add('heading');
      score += 15;
    } else if (MARKDOWN_PATTERNS.codeBlock.test(line)) {
      patternsFound.add('codeBlock');
      score += 20;
    } else if (MARKDOWN_PATTERNS.unorderedList.test(line)) {
      markdownLines++;
      patternsFound.add('list');
      score += 10;
    } else if (MARKDOWN_PATTERNS.orderedList.test(line)) {
      markdownLines++;
      patternsFound.add('list');
      score += 10;
    } else if (MARKDOWN_PATTERNS.blockquote.test(line)) {
      markdownLines++;
      patternsFound.add('blockquote');
      score += 12;
    } else if (MARKDOWN_PATTERNS.horizontalRule.test(line)) {
      patternsFound.add('horizontalRule');
      score += 15;
    } else if (MARKDOWN_PATTERNS.table.test(line)) {
      markdownLines++;
      patternsFound.add('table');
      score += 15;
    } else if (MARKDOWN_PATTERNS.taskList.test(line)) {
      markdownLines++;
      patternsFound.add('taskList');
      score += 12;
    }
  }

  // Check for inline patterns (in full text)
  if (MARKDOWN_PATTERNS.bold.test(text)) {
    patternsFound.add('bold');
    score += 8;
  }
  if (MARKDOWN_PATTERNS.italic.test(text)) {
    patternsFound.add('italic');
    score += 5;
  }
  if (MARKDOWN_PATTERNS.inlineCode.test(text)) {
    patternsFound.add('inlineCode');
    score += 8;
  }
  if (MARKDOWN_PATTERNS.link.test(text)) {
    patternsFound.add('link');
    score += 10;
  }
  if (MARKDOWN_PATTERNS.strikethrough.test(text)) {
    patternsFound.add('strikethrough');
    score += 5;
  }
  if (MARKDOWN_PATTERNS.highlight.test(text)) {
    patternsFound.add('highlight');
    score += 5;
  }

  // Boost score for multiple different pattern types
  if (patternsFound.size >= 3) {
    score += 15;
  } else if (patternsFound.size === 2) {
    score += 8;
  }

  // Calculate percentage of lines with markdown
  if (totalLines > 0) {
    const markdownPercentage = (markdownLines / totalLines) * 100;
    if (markdownPercentage > 50) {
      score += 20;
    } else if (markdownPercentage > 25) {
      score += 10;
    }
  }

  // Check for frontmatter (very strong indicator)
  if (text.trimStart().startsWith('---\n')) {
    const secondDivider = text.indexOf('\n---\n', 4);
    if (secondDivider > 0) {
      patternsFound.add('frontmatter');
      score += 30;
    }
  }

  return Math.min(score, 100);
}

/**
 * Detect if text content is likely markdown
 */
export function isLikelyMarkdown(
  text: string,
  config: MarkdownDetectionConfig = {}
): boolean {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Too short to be meaningful markdown
  if (text.length < mergedConfig.minContentLength) {
    return false;
  }

  // Calculate confidence score
  const score = calculateConfidenceScore(text);

  // Return true if score meets threshold
  return score >= mergedConfig.minConfidenceScore;
}

/**
 * Get detailed markdown detection result with score
 */
export function detectMarkdown(
  text: string,
  config: MarkdownDetectionConfig = {}
): { isMarkdown: boolean; score: number } {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  if (text.length < mergedConfig.minContentLength) {
    return { isMarkdown: false, score: 0 };
  }

  const score = calculateConfidenceScore(text);
  const isMarkdown = score >= mergedConfig.minConfidenceScore;

  return { isMarkdown, score };
}
