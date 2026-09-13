/**
 * File operation tools that use the FileSystemService abstraction
 */

import type { ToolContext, ToolDefinition } from './definitions';
import {
  getFileSystemService,
  getFileSystemServiceFor,
  getFileSystemServiceForPath,
} from '../../core/FileSystemService';

/**
 * Resolve the FileSystemService for the workspace this tool call belongs
 * to, in decreasing order of confidence:
 *
 * 1. An absolute `path` argument, which names the root that owns the file.
 *    In a multi-root workspace this is the only signal that distinguishes an
 *    attached folder from the primary root — `ctx.workspacePath` is the
 *    primary root for every session in the workspace, and its service does
 *    not contain the attached folder's files.
 * 2. The dispatcher's explicit `workspacePath`.
 * 3. The legacy global, only when the call site genuinely has no workspace
 *    context (the renderer-side chat providers). It points at whichever
 *    workspace is visible, which is why it is last.
 */
function resolveFileSystemServiceForCall(ctx?: ToolContext, argPath?: unknown) {
  if (typeof argPath === 'string') {
    const owning = getFileSystemServiceForPath(argPath);
    if (owning) return owning;
  }
  if (ctx?.workspacePath) {
    const scoped = getFileSystemServiceFor(ctx.workspacePath);
    if (scoped) return scoped;
  }
  return getFileSystemService();
}

/**
 * The service that should run this call, and the path expressed the way that
 * service accepts it.
 *
 * Every `FileSystemService` sandboxes to its own root and REJECTS absolute
 * paths -- so resolving the right service for `/attached/repo/src/a.ts` and
 * then handing it that same absolute string fails validation and the tool call
 * dies. Relativize against the service's own root once the service is known.
 * Paths outside that root are passed through unchanged so the sandbox, not this
 * helper, is what refuses them.
 */
function resolveCallTarget(ctx: ToolContext | undefined, argPath: unknown) {
  const service = resolveFileSystemServiceForCall(ctx, argPath);
  if (!service || typeof argPath !== 'string' || !argPath) {
    return { service, path: typeof argPath === 'string' ? argPath : undefined };
  }

  const root = service.getWorkspacePath()?.replace(/[\\/]+$/, '');
  if (!root) return { service, path: argPath };

  const normalizedArg = argPath.replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/');
  if (normalizedArg === normalizedRoot) return { service, path: undefined };
  if (normalizedArg.startsWith(`${normalizedRoot}/`)) {
    return { service, path: normalizedArg.slice(normalizedRoot.length + 1) };
  }
  return { service, path: argPath };
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
        description: 'Optional path to search. Relative paths resolve against the primary workspace root; use an absolute path to search inside a folder attached to this workspace. Defaults to the entire primary root.'
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
    const { service: fileSystemService, path: scopedPath } = resolveCallTarget(ctx, args.path);
    if (!fileSystemService) {
      return {
        success: false,
        error: 'File system service not available'
      };
    }

    return fileSystemService.searchFiles(args.query, {
      path: scopedPath,
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
        description: 'Path to list. Relative paths resolve against the primary workspace root; use an absolute path to list a folder attached to this workspace. Defaults to the primary root.'
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
    const { service: fileSystemService, path: scopedPath } = resolveCallTarget(ctx, args.path);
    if (!fileSystemService) {
      return {
        success: false,
        error: 'File system service not available'
      };
    }

    return fileSystemService.listFiles({
      path: scopedPath,
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
        description: 'Path to the file. Relative paths resolve against the primary workspace root; use an absolute path to read a file in a folder attached to this workspace.'
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
    const { service: fileSystemService, path: scopedPath } = resolveCallTarget(ctx, args.path);
    if (!fileSystemService) {
      return {
        success: false,
        error: 'File system service not available'
      };
    }

    return fileSystemService.readFile(scopedPath ?? args.path, {
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