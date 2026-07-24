/**
 * OpenCode File Snapshot Plugin
 *
 * Hooks into OpenCode's tool execution lifecycle to capture
 * before/after file content snapshots. This data flows through
 * SSE events to the OpenCodeSDKProtocol, enabling Nimbalyst's
 * red/green diff and local history system.
 *
 * Note: The exact OpenCode plugin API is not yet finalized.
 * This module defines a clean adapter interface that matches
 * the data shapes OpenCodeSDKProtocol.parseSSEEvent already
 * consumes. A thin adapter layer will be needed once the
 * real plugin API is documented.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// --- Types ---

/** Snapshot of a single file's content */
export interface FileSnapshot {
  /** File content (null for new/deleted files) */
  content: string | null;
  /** Set when file couldn't be read */
  error?: string;
  /** True for binary files (content will be null) */
  isBinary?: boolean;
  /** True if content was truncated due to size limits */
  truncated?: boolean;
}

/** Map of file paths to their snapshots */
export type FileSnapshotMap = Record<string, FileSnapshot>;

/** Context provided to plugin hooks by OpenCode */
export interface ToolExecuteContext {
  /** Tool invocation ID (unique per execution) */
  id: string;
  /** Tool name (e.g., 'file_edit', 'file_write', 'patch') */
  toolName: string;
  /** Tool input arguments */
  input: Record<string, unknown>;
  /** Attach additional properties to the SSE event */
  setProperty: (key: string, value: unknown) => void;
}

/** Plugin hooks interface matching OpenCode's plugin system */
export interface OpenCodePluginHooks {
  'tool.execute.before'?: (context: ToolExecuteContext) => Promise<void> | void;
  'tool.execute.after'?: (context: ToolExecuteContext) => Promise<void> | void;
}

/** Plugin configuration */
export interface FileSnapshotPluginConfig {
  /** Maximum file size in bytes before truncation (default: 1MB) */
  maxFileSize?: number;
  /** Working directory for resolving relative paths */
  workspacePath?: string;
}

// --- Constants ---

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024; // 1MB

/** Tool names that write/edit files */
const FILE_WRITE_TOOLS = new Set([
  'file_write', 'file_edit', 'file_create',
  'write_file', 'edit_file', 'create_file',
  'patch', 'patch_file', 'apply_diff',
  'Write', 'Edit', 'NotebookEdit',
]);

/** Fields that may contain the target file path */
const FILE_PATH_FIELDS = ['path', 'file_path', 'filePath', 'file', 'filename'];

// --- Plugin Implementation ---

/**
 * Create the file snapshot plugin.
 *
 * Returns an object with hooks that can be registered with
 * OpenCode's plugin system.
 */
export function createFileSnapshotPlugin(config: FileSnapshotPluginConfig = {}): {
  hooks: OpenCodePluginHooks;
} {
  const maxFileSize = config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const workspacePath = config.workspacePath ?? process.cwd();

  // Map of tool invocation ID -> before-snapshots
  const pendingSnapshots = new Map<string, FileSnapshotMap>();

  /**
   * Extract file path from tool arguments.
   */
  function extractFilePath(input: Record<string, unknown>): string | null {
    for (const field of FILE_PATH_FIELDS) {
      const value = input[field];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return null;
  }

  /**
   * Resolve a potentially relative path against the workspace.
   */
  function resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.resolve(workspacePath, filePath);
  }

  /**
   * Read file content with size limits and binary detection.
   */
  async function captureSnapshot(filePath: string): Promise<FileSnapshot> {
    const resolvedPath = resolvePath(filePath);

    try {
      const stat = await fs.stat(resolvedPath);

      if (stat.size > maxFileSize) {
        const buffer = Buffer.alloc(maxFileSize);
        const fd = await fs.open(resolvedPath, 'r');
        try {
          await fd.read(buffer, 0, maxFileSize, 0);
        } finally {
          await fd.close();
        }

        // Check for binary content in the first 8KB
        const checkSize = Math.min(8192, maxFileSize);
        if (isBinaryBuffer(buffer.subarray(0, checkSize))) {
          return { content: null, isBinary: true };
        }

        return {
          content: buffer.toString('utf-8'),
          truncated: true,
        };
      }

      const buffer = await fs.readFile(resolvedPath);

      // Check for binary content
      const checkSize = Math.min(8192, buffer.length);
      if (isBinaryBuffer(buffer.subarray(0, checkSize))) {
        return { content: null, isBinary: true };
      }

      return { content: buffer.toString('utf-8') };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        // File doesn't exist (new file)
        return { content: null };
      }
      return {
        content: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    hooks: {
      /**
       * Before tool execution: capture file content before writes.
       */
      'tool.execute.before': async (context: ToolExecuteContext) => {
        if (!FILE_WRITE_TOOLS.has(context.toolName)) {
          return;
        }

        const filePath = extractFilePath(context.input);
        if (!filePath) {
          return;
        }

        const snapshot = await captureSnapshot(filePath);
        const snapshots: FileSnapshotMap = { [filePath]: snapshot };
        pendingSnapshots.set(context.id, snapshots);

        context.setProperty('fileSnapshots', snapshots);
      },

      /**
       * After tool execution: capture file content after writes,
       * merge with before-snapshot.
       */
      'tool.execute.after': async (context: ToolExecuteContext) => {
        if (!FILE_WRITE_TOOLS.has(context.toolName)) {
          return;
        }

        const filePath = extractFilePath(context.input);
        if (!filePath) {
          return;
        }

        const afterSnapshot = await captureSnapshot(filePath);
        const beforeSnapshots = pendingSnapshots.get(context.id);
        pendingSnapshots.delete(context.id);

        const snapshots: FileSnapshotMap = {
          [filePath]: afterSnapshot,
        };

        // Include before-content in metadata if available
        if (beforeSnapshots?.[filePath]) {
          context.setProperty('beforeContent', beforeSnapshots[filePath].content);
        }
        context.setProperty('afterContent', afterSnapshot.content);
        context.setProperty('fileSnapshots', snapshots);
      },
    },
  };
}

// --- Utilities ---

/**
 * Detect binary content by checking for null bytes in the buffer.
 */
function isBinaryBuffer(buffer: Buffer | Uint8Array): boolean {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Type guard for Node.js errors with `code` property.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
