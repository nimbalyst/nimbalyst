/**
 * Shared utility for extracting file paths from AI tool arguments.
 *
 * Both ToolExecutor (pre-write bypass registration) and SessionFileTracker
 * (post-write tracking) need to pull a file path from heterogeneous tool
 * argument shapes. This centralises the field list so new tool conventions
 * only need to be added in one place.
 */

/** All argument field names that may contain a file path, checked in priority order. */
const FILE_PATH_FIELDS = [
  'file_path',
  'filePath',
  'path',
  'targetFilePath',
  'notebook_path',
  'notebookPath',
  'file_name',
  'old_file_path',
] as const;

/**
 * Extract the first file path found in tool arguments.
 *
 * @param args - The tool call arguments object. May be null/undefined.
 * @returns The first string-valued file path field, or null if none found.
 */
export function extractFilePath(args: Record<string, unknown> | null | undefined): string | null {
  if (!args) return null;

  for (const field of FILE_PATH_FIELDS) {
    const value = args[field];
    if (value && typeof value === 'string') {
      return value;
    }
  }

  return null;
}
