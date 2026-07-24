/**
 * File mention parser for extracting file references from messages
 * Supports markdown link format: @[filename](path)
 */

export interface FileMentionMatch {
  fullMatch: string;
  fileName: string;
  filePath: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Regular expression to match file mentions in format: @[filename](path)
 * Captures:
 * - Group 1: filename (inside square brackets)
 * - Group 2: file path (inside parentheses)
 */
const FILE_MENTION_REGEX = /@\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Extract all file mentions from a message
 * @param message - The message text to parse
 * @returns Array of file mention matches
 */
export function extractFileMentions(message: string): FileMentionMatch[] {
  const matches: FileMentionMatch[] = [];
  const regex = new RegExp(FILE_MENTION_REGEX);

  let match: RegExpExecArray | null;
  while ((match = regex.exec(message)) !== null) {
    matches.push({
      fullMatch: match[0],
      fileName: match[1],
      filePath: match[2],
      startIndex: match.index,
      endIndex: match.index + match[0].length
    });
  }

  return matches;
}

/**
 * Check if a message contains any file mentions
 * @param message - The message text to check
 * @returns True if the message contains file mentions
 */
export function hasFileMentions(message: string): boolean {
  return FILE_MENTION_REGEX.test(message);
}

/**
 * Remove file mention markdown from a message, leaving just the filename
 * Example: "Check @[file.ts](path/to/file.ts)" -> "Check @file.ts"
 * @param message - The message text to clean
 * @returns Message with simplified file references
 */
export function simplifyFileMentions(message: string): string {
  return message.replace(FILE_MENTION_REGEX, '@$1');
}

/**
 * Get unique file paths from a message
 * @param message - The message text to parse
 * @returns Array of unique file paths
 */
export function getUniqueFilePaths(message: string): string[] {
  const mentions = extractFileMentions(message);
  const paths = mentions.map(m => m.filePath);
  return Array.from(new Set(paths));
}
