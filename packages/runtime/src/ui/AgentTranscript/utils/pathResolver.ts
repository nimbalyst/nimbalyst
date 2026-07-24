/**
 * Utilities for resolving and formatting file paths in the agent transcript
 */

/**
 * Tools that have file paths that should be clickable (actual files, not directories)
 */
const FILE_PATH_TOOLS = new Set([
  'read',
  'edit',
  'write',
  'notebookedit',
  'lsp',
]);

/**
 * Tools where 'path' argument is a directory, not a file
 */
const DIRECTORY_PATH_TOOLS = new Set([
  'glob',
  'grep',
]);

/**
 * Normalize a tool name by stripping MCP prefixes and converting to lowercase
 * Handles patterns like: mcp__nimbalyst__glob -> glob, Glob -> glob
 */
function normalizeToolName(toolName: string): string {
  let name = toolName.toLowerCase();
  // Strip mcp__*__ prefix (e.g., mcp__nimbalyst__glob -> glob)
  const mcpMatch = name.match(/^mcp__[^_]+__(.+)$/);
  if (mcpMatch) {
    name = mcpMatch[1];
  }
  return name;
}

/**
 * Extract file path from tool arguments (only for tools that reference actual files)
 * @param toolName - Name of the tool
 * @param args - Tool arguments object
 * @returns File path if found and tool references files, undefined otherwise
 */
export function extractFilePathFromArgs(toolName: string, args: any): string | undefined {
  if (!args || typeof args !== 'object') {
    return undefined;
  }

  const normalizedToolName = normalizeToolName(toolName);

  // For tools that use 'path' as a directory (Glob, Grep), don't return it as clickable
  if (DIRECTORY_PATH_TOOLS.has(normalizedToolName)) {
    return undefined;
  }

  // For known file tools, check their specific path properties
  if (FILE_PATH_TOOLS.has(normalizedToolName)) {
    const filePath = args.file_path || args.filePath || args.notebook_path || args.path;
    if (typeof filePath === 'string') {
      return filePath;
    }
  }

  // For unknown tools, only use unambiguous file path properties (not 'path')
  const filePath = args.file_path || args.filePath || args.notebook_path;
  if (typeof filePath === 'string') {
    return filePath;
  }

  return undefined;
}

/**
 * Convert an absolute path to a project-relative path
 * @param absolutePath - Full system path
 * @param workspacePath - Workspace root path (optional)
 * @returns Project-relative path, or original path if not within workspace
 */
export function toProjectRelative(absolutePath: string, workspacePath?: string): string {
  if (!workspacePath || !absolutePath) {
    return absolutePath;
  }

  // Normalize paths for comparison (handle trailing slashes)
  const normalizedWorkspace = workspacePath.replace(/\/$/, '');
  const normalizedAbsolute = absolutePath.replace(/\/$/, '');

  // Check if the path starts with the workspace path
  if (normalizedAbsolute.startsWith(normalizedWorkspace)) {
    // Remove workspace path and leading slash
    const relativePath = normalizedAbsolute.slice(normalizedWorkspace.length).replace(/^\//, '');
    return relativePath || '.';
  }

  // Path is outside workspace, return as-is
  return absolutePath;
}

/**
 * Intelligently shorten a path for display while preserving the filename
 * @param path - Path to shorten
 * @param maxLength - Maximum display length (default: 60)
 * @returns Shortened path with filename always preserved
 */
export function shortenPath(path: string, maxLength: number = 60): string {
  if (path.length <= maxLength) {
    return path;
  }

  // Extract filename and directory
  const lastSlashIndex = path.lastIndexOf('/');
  if (lastSlashIndex === -1) {
    // No directory separator, just truncate
    return path.length > maxLength ? path.slice(0, maxLength - 3) + '...' : path;
  }

  const filename = path.slice(lastSlashIndex + 1);
  const directory = path.slice(0, lastSlashIndex);

  // If filename alone is too long, show it anyway (it's the most important part)
  if (filename.length >= maxLength - 10) {
    return '.../' + filename;
  }

  // Calculate how much space we have for the directory
  const remainingLength = maxLength - filename.length - 4; // -4 for ".../" separator

  if (remainingLength <= 0) {
    return '.../' + filename;
  }

  // Try to preserve the start of the directory path
  if (directory.length <= remainingLength) {
    return path; // Fits without truncation
  }

  // Truncate directory from the middle
  const dirParts = directory.split('/');
  if (dirParts.length === 1) {
    // Single directory, truncate it
    return directory.slice(0, remainingLength) + '.../' + filename;
  }

  // Keep first and last directory components if possible
  const firstDir = dirParts[0];
  const lastDir = dirParts[dirParts.length - 1];
  const combined = firstDir + '/.../' + lastDir + '/' + filename;

  if (combined.length <= maxLength) {
    return combined;
  }

  // Fall back to just showing end of path
  return '.../' + lastDir + '/' + filename;
}

/**
 * Extract arguments from a tool call for display
 * Handles special cases for common tools (Read, Edit, Bash, etc.)
 */
export function formatToolArguments(
  toolName: string,
  args: any,
  workspacePath?: string
): string {
  if (!args || typeof args !== 'object') {
    return '';
  }

  switch (toolName.toLowerCase()) {
    case 'read': {
      const filePath = args.file_path || args.path || args.filePath;
      if (filePath) {
        const relativePath = toProjectRelative(filePath, workspacePath);
        const parts = [shortenPath(relativePath, 50)];

        // Add line range if present
        if (args.offset !== undefined && args.limit !== undefined) {
          const start = args.offset;
          const end = args.offset + args.limit;
          parts.push(`lines ${start}-${end}`);
        } else if (args.offset !== undefined) {
          parts.push(`from line ${args.offset}`);
        } else if (args.limit !== undefined) {
          parts.push(`first ${args.limit} lines`);
        }

        return parts.join(', ');
      }
      break;
    }

    case 'edit':
    case 'write': {
      const filePath = args.file_path || args.path || args.filePath;
      if (filePath) {
        const relativePath = toProjectRelative(filePath, workspacePath);
        return shortenPath(relativePath, 50);
      }
      break;
    }

    case 'glob': {
      const pattern = args.pattern;
      const path = args.path;
      if (pattern) {
        return pattern;
      }
      if (path) {
        const relativePath = toProjectRelative(path, workspacePath);
        return shortenPath(relativePath, 50);
      }
      break;
    }

    case 'grep': {
      const pattern = args.pattern;
      const path = args.path;
      const parts: string[] = [];

      if (pattern) {
        parts.push(`"${pattern.length > 30 ? pattern.slice(0, 30) + '...' : pattern}"`);
      }
      if (path) {
        const relativePath = toProjectRelative(path, workspacePath);
        parts.push(`in ${shortenPath(relativePath, 40)}`);
      }

      return parts.join(' ');
    }

    case 'bash': {
      const command = args.command;
      if (command) {
        return command.length > 50 ? command.slice(0, 50) + '...' : command;
      }
      break;
    }

    default:
      // Generic handling for other tools
      const keys = Object.keys(args);
      if (keys.length === 0) return '';

      // Try to find file path in common property names
      const filePath = args.file_path || args.path || args.filePath || args.file;
      if (filePath && typeof filePath === 'string') {
        const relativePath = toProjectRelative(filePath, workspacePath);
        return shortenPath(relativePath, 50);
      }

      // Fall back to showing first few args
      return keys
        .slice(0, 2)
        .map(k => {
          const val = args[k];
          if (typeof val === 'string') {
            return val.length > 20 ? val.substring(0, 20) + '...' : val;
          }
          return JSON.stringify(val);
        })
        .join(', ');
  }

  return '';
}
