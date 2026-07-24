/**
 * File operation tools that use the FileSystemService abstraction
 */

import type { ToolContext, ToolDefinition } from './index';
import { getFileSystemService, getFileSystemServiceFor } from '../../core/FileSystemService';

/**
 * Resolve the FileSystemService for the workspace this tool call belongs
 * to. Prefer the per-path registry when the dispatcher hands us an
 * explicit `workspacePath`; fall back to the legacy global only when
 * the call site genuinely has no workspace context. The fallback exists
 * to keep older single-project paths working — multi-project rail
 * dispatch always supplies the path.
 */
function resolveFileSystemServiceForCall(ctx?: ToolContext) {
  if (ctx?.workspacePath) {
    const scoped = getFileSystemServiceFor(ctx.workspacePath);
    if (scoped) return scoped;
  }
  return getFileSystemService();
}

/**
 * Create file search tool
 */
export const searchFilesTool: ToolDefinition = {
  name: 'searchFiles',
  description: 'Search for files containing specific text within the workspace',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Text to search for in files'
      },
      path: {
        type: 'string',
        description: 'Optional relative path within workspace to search (defaults to entire workspace)'
      },
      filePattern: {
        type: 'string',
        description: 'Optional glob pattern to filter files (e.g., "*.ts", "**/*.jsx")'
      },
      caseSensitive: {
        type: 'boolean',
        description: 'Whether the search should be case sensitive (default: false)'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 50)'
      }
    },
    required: ['query']
  },
  handler: async (args: any, ctx?: ToolContext) => {
    const fileSystemService = resolveFileSystemServiceForCall(ctx);
    if (!fileSystemService) {
      return {
        success: false,
        error: 'File system service not available'
      };
    }

    return fileSystemService.searchFiles(args.query, {
      path: args.path,
      filePattern: args.filePattern,
      caseSensitive: args.caseSensitive,
      maxResults: args.maxResults
    });
  },
  source: 'runtime'
};

/**
 * Create file listing tool
 */
export const listFilesTool: ToolDefinition = {
  name: 'listFiles',
  description: 'List files and directories in the workspace',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path within workspace to list (defaults to workspace root)'
      },
      pattern: {
        type: 'string',
        description: 'Optional glob pattern to filter results (e.g., "*.ts", "**/*.jsx")'
      },
      recursive: {
        type: 'boolean',
        description: 'Whether to list files recursively (default: false)'
      },
      includeHidden: {
        type: 'boolean',
        description: 'Whether to include hidden files (starting with .) (default: false)'
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum depth for recursive listing (default: 3)'
      }
    },
    required: []
  },
  handler: async (args: any, ctx?: ToolContext) => {
    const fileSystemService = resolveFileSystemServiceForCall(ctx);
    if (!fileSystemService) {
      return {
        success: false,
        error: 'File system service not available'
      };
    }

    return fileSystemService.listFiles({
      path: args.path,
      pattern: args.pattern,
      recursive: args.recursive,
      includeHidden: args.includeHidden,
      maxDepth: args.maxDepth
    });
  },
  source: 'runtime'
};

/**
 * Create file reading tool
 */
export const readFileTool: ToolDefinition = {
  name: 'readFile',
  description: 'Read the contents of a file in the workspace',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path to the file within the workspace'
      },
      encoding: {
        type: 'string',
        description: 'File encoding (default: "utf-8")',
        enum: ['utf-8', 'ascii', 'base64', 'hex', 'latin1']
      }
    },
    required: ['path']
  },
  handler: async (args: any, ctx?: ToolContext) => {
    const fileSystemService = resolveFileSystemServiceForCall(ctx);
    if (!fileSystemService) {
      return {
        success: false,
        error: 'File system service not available'
      };
    }

    return fileSystemService.readFile(args.path, {
      encoding: args.encoding
    });
  },
  source: 'runtime'
};

/**
 * Export all file tools
 */
export const FILE_TOOLS: ToolDefinition[] = [
  searchFilesTool,
  listFilesTool,
  readFileTool
];