/**
 * EditorKey - Composite key for identifying editor instances
 *
 * With worktrees, the same file can be open in multiple places:
 * - Main editor area: "main:/path/to/file.md"
 * - Session A worktree: "session:session-abc:/path/to/file.md"
 * - Session B worktree: "session:session-xyz:/path/to/file.md"
 *
 * Each editor instance is independent - they may have different dirty states,
 * different content if one is edited but not saved, etc.
 *
 * Editor-level state (dirty, scroll, cursor) uses EditorKey.
 * File-level state (git status, existence) uses FilePath.
 */

/**
 * Composite key for editor instances.
 * Format: "main:{filePath}" or "session:{sessionId}:{filePath}"
 */
export type EditorKey = `main:${string}` | `session:${string}:${string}`;

/**
 * Context identifier for grouping editor instances.
 * - "main" for the primary editor area
 * - "session:{sessionId}" for worktree editors
 */
export type EditorContext = 'main' | `session:${string}`;

/**
 * Creates an EditorKey from a file path and optional session ID.
 *
 * @param filePath - The file path being edited
 * @param sessionId - Optional session ID for worktree editors
 * @returns The composite EditorKey
 *
 * @example
 * makeEditorKey('/path/file.md')           // "main:/path/file.md"
 * makeEditorKey('/path/file.md', 'abc123') // "session:abc123:/path/file.md"
 */
export function makeEditorKey(filePath: string, sessionId?: string): EditorKey {
  return sessionId
    ? `session:${sessionId}:${filePath}`
    : `main:${filePath}`;
}

/**
 * Creates an EditorContext from an optional session ID.
 *
 * @param sessionId - Optional session ID
 * @returns The EditorContext
 */
export function makeEditorContext(sessionId?: string): EditorContext {
  return sessionId ? `session:${sessionId}` : 'main';
}

/**
 * Parses an EditorKey into its components.
 *
 * @param key - The EditorKey to parse
 * @returns Object with context, sessionId (if present), and filePath
 *
 * @example
 * parseEditorKey('main:/path/file.md')
 * // { context: 'main', filePath: '/path/file.md' }
 *
 * parseEditorKey('session:abc123:/path/file.md')
 * // { context: 'session:abc123', sessionId: 'abc123', filePath: '/path/file.md' }
 */
export function parseEditorKey(key: EditorKey): {
  context: EditorContext;
  sessionId?: string;
  filePath: string;
} {
  if (key.startsWith('main:')) {
    return {
      context: 'main',
      filePath: key.slice(5), // Remove "main:" prefix
    };
  }

  // Format: session:{sessionId}:{filePath}
  const match = key.match(/^session:([^:]+):(.+)$/);
  if (!match) {
    throw new Error(`Invalid EditorKey format: ${key}`);
  }

  const [, sessionId, filePath] = match;
  return {
    context: `session:${sessionId}`,
    sessionId,
    filePath,
  };
}

/**
 * Gets the file path from an EditorKey without parsing the full structure.
 * Useful for quick file path extraction.
 *
 * @param key - The EditorKey
 * @returns The file path portion
 */
export function getFilePathFromKey(key: EditorKey): string {
  return parseEditorKey(key).filePath;
}

/**
 * Checks if an EditorKey belongs to a worktree (session) context.
 */
export function isWorktreeKey(key: EditorKey): boolean {
  return key.startsWith('session:');
}

/**
 * Checks if an EditorKey belongs to the main editor context.
 */
export function isMainKey(key: EditorKey): boolean {
  return key.startsWith('main:');
}

/**
 * Gets all EditorKeys for a given file path across all contexts.
 * Useful for notifying all editors when a file changes on disk.
 *
 * @param allKeys - All known EditorKeys
 * @param filePath - The file path to match
 * @returns EditorKeys that reference this file
 */
export function getKeysForFilePath(
  allKeys: EditorKey[],
  filePath: string
): EditorKey[] {
  return allKeys.filter((key) => {
    const parsed = parseEditorKey(key);
    return parsed.filePath === filePath;
  });
}
