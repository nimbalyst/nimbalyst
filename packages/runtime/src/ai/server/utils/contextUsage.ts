import type { TokenUsageCategory } from '../types';

export interface ParsedContextUsage {
  totalTokens: number;
  contextWindow: number;
  categories?: TokenUsageCategory[];
}

const TOKEN_LINE_REGEX = /\*\*Tokens:\*\*\s+([\d.,]+)([kKmM]?)\s*\/\s*([\d.,]+)([kKmM]?)\s*\((\d+)%\)/i;

/**
 * Extract the actual markdown content from the stored message.
 * The database stores raw SDK chunks as JSON like:
 * {"type":"user","message":{"content":"<local-command-stdout>## Context Usage..."}}
 *
 * This function extracts the markdown from that structure.
 */
function extractMarkdownFromStoredContent(content: string): string {
  let markdown = content;

  // Check if content is a JSON object (starts with { and contains "type")
  if (content.trim().startsWith('{') && content.includes('"type"')) {
    try {
      const parsed = JSON.parse(content);
      // Extract from user message structure
      if (parsed.type === 'user' && typeof parsed.message?.content === 'string') {
        markdown = parsed.message.content;
      }
    } catch {
      // Not valid JSON, use content as-is
    }
  }

  // Strip <local-command-stdout> tags if present
  const match = markdown.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (match && match[1]) {
    markdown = match[1].trim();
  }

  return markdown;
}

/**
 * Parse the markdown emitted by the `/context` command to extract token usage information.
 * Returns undefined if the expected token line cannot be parsed.
 *
 * Handles two formats:
 * 1. Raw JSON from database: {"type":"user","message":{"content":"<local-command-stdout>..."}}
 * 2. Extracted markdown: "## Context Usage\n**Tokens:** 32.9k / 200.0k (16%)\n..."
 */
export function parseContextUsageMessage(content?: string): ParsedContextUsage | undefined {
  if (!content) {
    return undefined;
  }

  // Extract markdown from JSON/XML wrapper if needed
  const markdown = extractMarkdownFromStoredContent(content);

  const tokenMatch = markdown.match(TOKEN_LINE_REGEX);
  if (!tokenMatch) {
    return undefined;
  }

  const totalTokens = convertToTokens(tokenMatch[1], tokenMatch[2]);
  const contextWindow = convertToTokens(tokenMatch[3], tokenMatch[4]);
  const categories = extractCategories(markdown);

  return {
    totalTokens,
    contextWindow,
    categories: categories.length > 0 ? categories : undefined
  };
}

function extractCategories(content: string): TokenUsageCategory[] {
  // Try both old and new format headers
  let categoriesStart = content.indexOf('### Estimated usage by category');
  if (categoriesStart === -1) {
    categoriesStart = content.indexOf('### Categories');
    if (categoriesStart === -1) {
      return [];
    }
  }

  const section = content.slice(categoriesStart);
  const rowRegex = /\|\s*([^|]+?)\s*\|\s*([\d.,]+)([kKmM]?)\s*\|\s*([\d.,]+)%\s*\|/g;
  const categories: TokenUsageCategory[] = [];
  let match: RegExpExecArray | null;

  while ((match = rowRegex.exec(section)) !== null) {
    const name = match[1].trim();
    const tokens = convertToTokens(match[2], match[3]);
    const percentage = Number.parseFloat(match[4]);

    // Skip header rows
    if (name === 'Category' || name === '---' || !name || Number.isNaN(tokens) || Number.isNaN(percentage)) {
      continue;
    }

    categories.push({
      name,
      tokens,
      percentage
    });
  }

  return categories;
}

function convertToTokens(value: string, suffix?: string): number {
  const normalized = value.replace(/,/g, '').trim();
  const numericValue = Number.parseFloat(normalized);
  if (Number.isNaN(numericValue)) {
    return 0;
  }

  const multiplier = suffix?.toLowerCase() === 'm'
    ? 1_000_000
    : suffix?.toLowerCase() === 'k'
      ? 1_000
      : 1;

  return Math.round(numericValue * multiplier);
}
