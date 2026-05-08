/**
 * GitCommitConfirmationWidget
 *
 * Custom tool widget that renders when AI calls git_commit_proposal.
 * Shows the proposed commit with file selection and message editing.
 *
 * The widget has two modes:
 * 1. Interactive mode: When the tool is pending (no result yet), user can edit and confirm
 * 2. Display mode: When tool has completed, shows the result (committed/cancelled)
 *
 * The tool waits for user confirmation before returning to Claude, so:
 * - tool.result being undefined/null means the proposal is pending
 * - tool.result containing "committed" means user confirmed
 * - tool.result containing "cancelled" means user cancelled
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { MaterialSymbol } from '../../../icons/MaterialSymbol';
import type { CustomToolWidgetProps } from './index';
import { buildCodexToolLookupId } from '../../../../ai/server/toolLookupIds';
import { interactiveWidgetHostAtom } from '../../../../store/atoms/interactiveWidgetHost';
import { useDiffPeek } from '../../../git/useDiffPeek';

// ============================================================
// File Status Types
// ============================================================

type FileStatus = 'added' | 'modified' | 'deleted';

interface FileWithStatus {
  path: string;
  status: FileStatus;
}

type FileInput = string | FileWithStatus;

/**
 * Normalize file input to extract path and status
 */
function normalizeFileInput(file: FileInput): FileWithStatus {
  if (typeof file === 'string') {
    return { path: file, status: 'modified' }; // Default to modified for backward compatibility
  }
  return file;
}

/**
 * Extract just the path from a file input
 */
function getFilePath(file: FileInput): string {
  return typeof file === 'string' ? file : file.path;
}

// ============================================================
// Pending Proposals - Using Jotai atoms (DB-backed in Electron)
// ============================================================
// The widget reads pending proposal from sessionPendingGitCommitProposalAtom.
// In Electron, this atom is synced from the DB by SessionTranscript.
// In Capacitor, this atom is populated directly by the IPC handler.

// ============================================================
// Directory Tree Types and Helpers
// ============================================================

interface DirectoryNode {
  path: string;
  displayPath: string;
  files: string[];
  subdirectories: Map<string, DirectoryNode>;
  fileCount: number;
}

/**
 * Build a directory tree from a flat list of file paths.
 * Collapses single-child directories (e.g., packages/electron/src becomes one node).
 */
function buildDirectoryTree(filePaths: string[]): DirectoryNode {
  const root: DirectoryNode = {
    path: '',
    displayPath: '',
    files: [],
    subdirectories: new Map(),
    fileCount: 0
  };

  filePaths.forEach(filePath => {
    const parts = filePath.split('/');

    // If file is at root level (no directory)
    if (parts.length === 1) {
      root.files.push(filePath);
      root.fileCount++;
      return;
    }

    // Build directory tree
    let currentNode = root;
    const dirParts = parts.slice(0, -1);

    dirParts.forEach((part, index) => {
      const pathSoFar = dirParts.slice(0, index + 1).join('/');

      if (!currentNode.subdirectories.has(part)) {
        currentNode.subdirectories.set(part, {
          path: pathSoFar,
          displayPath: part,
          files: [],
          subdirectories: new Map(),
          fileCount: 0
        });
      }

      currentNode = currentNode.subdirectories.get(part)!;
    });

    currentNode.files.push(filePath);
    currentNode.fileCount++;
  });

  // Update file counts up the tree
  const updateCounts = (node: DirectoryNode): number => {
    let count = node.files.length;
    node.subdirectories.forEach(subdir => {
      count += updateCounts(subdir);
    });
    node.fileCount = count;
    return count;
  };
  updateCounts(root);

  return collapseDirectoryTree(root);
}

/**
 * Collapse single-child directory paths (e.g., packages/electron/src -> packages/electron/src)
 */
function collapseDirectoryTree(node: DirectoryNode): DirectoryNode {
  // First, recursively collapse all subdirectories
  node.subdirectories.forEach((subdir, key) => {
    node.subdirectories.set(key, collapseDirectoryTree(subdir));
  });

  // If this node has exactly one subdirectory and no files, collapse it
  if (node.subdirectories.size === 1 && node.files.length === 0) {
    const [, childNode] = Array.from(node.subdirectories.entries())[0];

    // Merge the paths
    const newDisplayPath = node.displayPath
      ? `${node.displayPath}/${childNode.displayPath}`
      : childNode.displayPath;

    return {
      ...childNode,
      displayPath: newDisplayPath
    };
  }

  return node;
}

/**
 * Get all folder paths in a tree (for expand all functionality)
 */
function getAllFolderPaths(node: DirectoryNode, paths: string[] = []): string[] {
  if (node.path) {
    paths.push(node.path);
  }
  node.subdirectories.forEach(subdir => {
    getAllFolderPaths(subdir, paths);
  });
  return paths;
}

interface StructuredCommitResult {
  action?: string;
  commitHash?: string;
  commitDate?: string;
  commitMessage?: string;
  error?: string;
  success?: boolean;
  status?: string;
}

/**
 * Extract plain text from different tool result shapes.
 * Supports:
 * - Claude/legacy: string or content-block arrays
 * - Codex: nested object wrapper { success, result, status, error }
 */
function extractToolResultText(value: unknown, seen: Set<object> = new Set()): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractToolResultText(item, seen))
      .filter(Boolean)
      .join('\n');
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  if (seen.has(value)) {
    return '';
  }
  seen.add(value);

  const record = value as Record<string, unknown>;

  if (typeof record.text === 'string' && record.text.trim()) {
    return record.text;
  }

  if (record.content !== undefined) {
    const contentText = extractToolResultText(record.content, seen);
    if (contentText) {
      return contentText;
    }
  }

  if (record.result !== undefined) {
    const resultText = extractToolResultText(record.result, seen);
    if (resultText) {
      return resultText;
    }
  }

  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message;
  }

  if (typeof record.output === 'string' && record.output.trim()) {
    return record.output;
  }

  if (typeof record.error === 'string' && record.error.trim()) {
    return `Error: ${record.error}`;
  }

  return '';
}

/**
 * Walk a result object and extract structured commit fields when present.
 */
function extractStructuredCommitResult(value: unknown, seen: Set<object> = new Set()): StructuredCommitResult | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const result: StructuredCommitResult = {};
  let hasAnyField = false;

  if (typeof record.action === 'string') {
    result.action = record.action;
    hasAnyField = true;
  }
  if (typeof record.commitHash === 'string') {
    result.commitHash = record.commitHash;
    hasAnyField = true;
  }
  if (typeof record.commitDate === 'string') {
    result.commitDate = record.commitDate;
    hasAnyField = true;
  }
  if (typeof record.commitMessage === 'string') {
    result.commitMessage = record.commitMessage;
    hasAnyField = true;
  }
  if (typeof record.error === 'string') {
    result.error = record.error;
    hasAnyField = true;
  }
  if (typeof record.success === 'boolean') {
    result.success = record.success;
    hasAnyField = true;
  }
  if (typeof record.status === 'string') {
    result.status = record.status;
    hasAnyField = true;
  }

  const nestedCandidates = [record.result, record.content];
  for (const candidate of nestedCandidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const nested = extractStructuredCommitResult(candidate, seen);
    if (!nested) {
      continue;
    }

    result.action = result.action ?? nested.action;
    result.commitHash = result.commitHash ?? nested.commitHash;
    result.commitDate = result.commitDate ?? nested.commitDate;
    result.commitMessage = result.commitMessage ?? nested.commitMessage;
    result.error = result.error ?? nested.error;
    result.success = result.success ?? nested.success;
    result.status = result.status ?? nested.status;
    hasAnyField = true;
  }

  return hasAnyField ? result : null;
}

function isToolResultCompleted(rawToolResult: unknown, toolResultText: string, structured: StructuredCommitResult | null): boolean {
  if (rawToolResult === undefined || rawToolResult === null) {
    return false;
  }

  if (typeof rawToolResult === 'string') {
    return rawToolResult.trim().length > 0;
  }

  if (Array.isArray(rawToolResult)) {
    return toolResultText.trim().length > 0;
  }

  if (structured) {
    if (structured.action) return true;
    if (structured.success !== undefined) return true;
    if (structured.error) return true;
    if (structured.status) {
      const normalized = structured.status.toLowerCase();
      if (normalized === 'completed' || normalized === 'failed' || normalized === 'cancelled' || normalized === 'canceled') {
        return true;
      }
    }
  }

  const record = rawToolResult as Record<string, unknown>;
  if (record.result !== undefined && record.result !== null) {
    return true;
  }

  return toolResultText.trim().length > 0;
}

// ============================================================
// Widget Component
// ============================================================

export const GitCommitConfirmationWidget: React.FC<CustomToolWidgetProps> = ({
  message,
  workspacePath,
  sessionId,
}) => {
  const posthog = usePostHog();

  // Get host from atom (set by SessionTranscript or SessionDetailScreen)
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));

  // Extract data from tool call
  const toolCall = message.toolCall;
  if (!toolCall) {
    return null;
  }

  // Get data from arguments (the tool input)
  const args = toolCall.arguments as any;
  if (!args) {
    return null;
  }

  // Parse files - can be strings or objects with path and status
  // The model sometimes sends filesToStage as a JSON-encoded string instead of an array
  // Memoize to prevent infinite loop - args.filesToStage reference is stable
  const rawFiles: FileInput[] = useMemo(
    () => {
      let files = args.filesToStage;
      if (typeof files === 'string') {
        console.warn('[GitCommitWidget] filesToStage received as string instead of array, parsing JSON:', files.substring(0, 200));
        try { files = JSON.parse(files); } catch (e) {
          console.error('[GitCommitWidget] Failed to parse filesToStage string as JSON:', e);
          return [];
        }
      }
      if (!Array.isArray(files)) {
        console.error('[GitCommitWidget] filesToStage is not an array after parsing, got:', typeof files, files);
        return [];
      }
      return files;
    },
    [args.filesToStage]
  );
  const filesWithStatus: FileWithStatus[] = useMemo(
    () => rawFiles.map(normalizeFileInput),
    [rawFiles]
  );
  const initialFilesToStage: string[] = useMemo(
    () => filesWithStatus.map(f => f.path),
    [filesWithStatus]
  );
  // Create a map for quick status lookup
  const fileStatusMap = useMemo(
    () => new Map(filesWithStatus.map(f => [f.path, f.status])),
    [filesWithStatus]
  );
  const initialCommitMessage: string = args.commitMessage || '';
  const reasoning: string = args.reasoning || '';
  const rawToolResult = toolCall.result;
  const structuredResult = useMemo(
    () => extractStructuredCommitResult(rawToolResult),
    [rawToolResult]
  );
  const toolResult = useMemo(() => {
    return extractToolResultText(rawToolResult);
  }, [rawToolResult]);
  const isCompleted = useMemo(
    () => isToolResultCompleted(rawToolResult, toolResult, structuredResult),
    [rawToolResult, toolResult, structuredResult]
  );

  // Parse completed state from result
  const completedState = useMemo(() => {
    if (!isCompleted) return null;

    const hashMatch = toolResult.match(/commit hash[:\s]+([a-f0-9]+)/i);
    const dateMatch = toolResult.match(/commit date[:\s]+(.+)/i);

    if (structuredResult?.action) {
      const action = structuredResult.action.toLowerCase();
      if (action === 'committed') {
        return {
          type: 'committed' as const,
          commitHash: structuredResult.commitHash || hashMatch?.[1],
          commitDate: structuredResult.commitDate || dateMatch?.[1]?.trim(),
        };
      }
      if (action === 'cancelled' || action === 'canceled') {
        return { type: 'cancelled' as const };
      }
    }

    if (structuredResult?.error) {
      return { type: 'error' as const, error: structuredResult.error };
    }

    if (structuredResult?.success === false) {
      return { type: 'error' as const, error: toolResult || 'Commit failed' };
    }

    if (structuredResult?.status) {
      const status = structuredResult.status.toLowerCase();
      if (status === 'failed') {
        return { type: 'error' as const, error: toolResult || structuredResult.error || 'Commit failed' };
      }
      if (status === 'cancelled' || status === 'canceled') {
        return { type: 'cancelled' as const };
      }
      if (status === 'completed') {
        return {
          type: 'committed' as const,
          commitHash: structuredResult.commitHash || hashMatch?.[1],
          commitDate: structuredResult.commitDate || dateMatch?.[1]?.trim(),
        };
      }
    }

    if (!toolResult) {
      // Completed with no textual payload - treat as committed fallback.
      return {
        type: 'committed' as const,
        commitHash: structuredResult?.commitHash,
        commitDate: structuredResult?.commitDate,
      };
    }

    const resultLower = toolResult.toLowerCase();
    if (resultLower.includes('committed') || resultLower.includes('commit hash')) {
      // Extract commit hash and date if present
      return {
        type: 'committed' as const,
        commitHash: hashMatch?.[1],
        commitDate: dateMatch?.[1]?.trim(),
      };
    } else if (resultLower.includes('cancelled') || resultLower.includes('canceled')) {
      return { type: 'cancelled' as const };
    } else if (resultLower.includes('failed') || resultLower.includes('error')) {
      return { type: 'error' as const, error: toolResult };
    }
    return {
      type: 'committed' as const,
      commitHash: structuredResult?.commitHash || hashMatch?.[1],
      commitDate: structuredResult?.commitDate || dateMatch?.[1]?.trim(),
    };
  }, [isCompleted, toolResult, structuredResult]);

  // Claude-style tool IDs are durable enough to send back directly. Codex
  // canonical events now arrive with synthetic edit-group IDs of the form
  // `nimtc|<item_n>|<ts>|<idx>` minted by CodexRawParser, so they also pass
  // through unchanged. The fallback below wraps a bare `item_N` for legacy
  // canonical events written before the synthetic-ID change so the
  // main-process resolver can still map them to the correct proposal row.
  const proposalId = useMemo(() => {
    const providerToolCallId = toolCall.providerToolCallId || '';
    if (!providerToolCallId) {
      return '';
    }
    if (/^item_\d+$/.test(providerToolCallId)) {
      return buildCodexToolLookupId(
        providerToolCallId,
        message.createdAt.getTime(),
        message.id,
      );
    }
    return providerToolCallId;
  }, [message.createdAt, message.id, toolCall.providerToolCallId]);

  // If no proposal ID, cannot proceed
  if (!proposalId) {
    return null;
  }

  // Widget is interactive if the tool hasn't completed yet
  const isPending = !isCompleted;

  // Local state for editing
  const [filesToStage, setFilesToStage] = useState<Set<string>>(new Set(initialFilesToStage));
  const [commitMessage, setCommitMessage] = useState(initialCommitMessage);
  const [isCommitting, setIsCommitting] = useState(false);
  const [hasResponded, setHasResponded] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [localResult, setLocalResult] = useState<{
    success: boolean;
    commitHash?: string;
    commitDate?: string;
    error?: string;
  } | null>(null);
  // Latch when the widget has rendered as auto-committed. This must persist
  // even if the user later disables auto-commit -- the commit has already
  // happened, so the widget should stay in the success state.
  const [wasAutoCommitted, setWasAutoCommitted] = useState(false);

  // Diff peek state — encapsulated by useDiffPeek hook (shared with FilesEditedSidebar).
  const { peekSupported, registerRowEl, togglePeek, isActive, popoverElement } = useDiffPeek({
    getDiff: host?.gitFileDiff,
    width: host?.diffPeekSize?.width,
    height: host?.diffPeekSize?.height,
    onResize: host?.setDiffPeekSize,
  });

  // Build directory tree from files
  const directoryTree = useMemo(() => {
    return buildDirectoryTree(initialFilesToStage);
  }, [initialFilesToStage]);

  // Auto-expand all folders on mount
  useEffect(() => {
    const allPaths = getAllFolderPaths(directoryTree);
    setExpandedFolders(new Set(allPaths));
  }, [directoryTree]);

  // Latch wasAutoCommitted once the auto-commit success branch fires. Without
  // this, toggling auto-commit off after a successful auto-commit would re-render
  // the widget into the pending interactive UI even though the commit happened.
  useEffect(() => {
    if (host?.autoCommitEnabled && !isCommitting && !wasAutoCommitted) {
      setWasAutoCommitted(true);
    }
  }, [host?.autoCommitEnabled, isCommitting, wasAutoCommitted]);

  // Determine which result to show (tool result wins once available; local is only for pending UI)
  const displayResult = completedState ? {
    success: completedState.type === 'committed',
    commitHash: completedState.type === 'committed' ? completedState.commitHash : undefined,
    commitDate: completedState.type === 'committed' ? completedState.commitDate : undefined,
    error: completedState.type === 'cancelled' ? 'Cancelled' :
           completedState.type === 'error' ? completedState.error : undefined,
  } : localResult;

  const toggleFile = useCallback((filePath: string) => {
    setFilesToStage((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const toggleFolder = useCallback((folderPath: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  }, []);

  // Get all files in a directory node (recursively)
  const getFilesInNode = useCallback((node: DirectoryNode): string[] => {
    let files = [...node.files];
    node.subdirectories.forEach(subdir => {
      files = files.concat(getFilesInNode(subdir));
    });
    return files;
  }, []);

  // Toggle all files in a directory
  const toggleDirectoryFiles = useCallback((node: DirectoryNode) => {
    const filesInDir = getFilesInNode(node);
    const allSelected = filesInDir.every(f => filesToStage.has(f));

    setFilesToStage((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        // Deselect all
        filesInDir.forEach(f => next.delete(f));
      } else {
        // Select all
        filesInDir.forEach(f => next.add(f));
      }
      return next;
    });
  }, [filesToStage, getFilesInNode]);

  // Get status label for tooltip
  const getStatusLabel = (status: FileStatus): string => {
    switch (status) {
      case 'added': return 'New file';
      case 'modified': return 'Modified';
      case 'deleted': return 'Deleted';
      default: return 'Modified';
    }
  };

  // Get status color class
  const getStatusColorClass = (status: FileStatus): string => {
    switch (status) {
      case 'added': return 'text-nim-success';
      case 'modified': return 'text-nim-info';
      case 'deleted': return 'text-nim-error';
      default: return 'text-nim';
    }
  };

  // Render a single file item
  const renderFile = (filePath: string, isInDirectory = false) => {
    const isSelected = filesToStage.has(filePath);
    const fileName = filePath.split('/').pop() || filePath;
    const status = fileStatusMap.get(filePath) || 'modified';
    const isPinned = isActive(filePath);
    return (
      <div
        key={filePath}
        ref={(el) => registerRowEl(filePath, el)}
        className={`git-commit-widget__file group w-full flex items-center gap-1 text-left px-2 py-0.5 rounded border transition-all ${
          isPinned
            ? 'bg-[var(--nim-bg-hover)] border-[var(--nim-primary)]'
            : 'border-transparent bg-transparent hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-border)]'
        }`}
      >
        <button
          type="button"
          className="git-commit-widget__file-main flex-1 min-w-0 flex items-center gap-1 text-left bg-transparent border-0 p-0 cursor-pointer"
          onClick={() => toggleFile(filePath)}
          title={getStatusLabel(status)}
        >
          {/* Placeholder for expand caret (to align with folder rows) - only in directory tree */}
          {isInDirectory && (
            <div className="git-commit-widget__caret-placeholder w-4 h-4 shrink-0" />
          )}
          {/* Checkbox for file selection */}
          <div
            className={`git-commit-widget__checkbox w-4 h-4 shrink-0 rounded-[3px] border-[1.5px] cursor-pointer flex items-center justify-center transition-all ${
              isSelected
                ? 'bg-[var(--nim-file-edited)] border-[var(--nim-file-edited)]'
                : 'border-[var(--nim-text-faint)] bg-transparent hover:border-[var(--nim-text-muted)]'
            }`}
          >
            {isSelected && (
              <svg width="8" height="6" viewBox="0 0 8 6" fill="none" className="text-white">
                <path d="M1 3L3 5L7 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </div>
          <div className="git-commit-widget__file-info flex-1 min-w-0">
            <span className={`git-commit-widget__file-name text-[0.8125rem] font-medium overflow-hidden text-ellipsis whitespace-nowrap ${getStatusColorClass(status)}`}>
              {fileName}
            </span>
          </div>
        </button>
        {peekSupported && (
          <button
            type="button"
            data-testid="git-commit-file-peek"
            className={`git-commit-widget__peek-btn shrink-0 w-5 h-5 flex items-center justify-center rounded text-[var(--nim-text-faint)] hover:text-[var(--nim-primary)] hover:bg-[var(--nim-bg-tertiary)] transition-opacity bg-transparent border-0 cursor-pointer ${
              isPinned ? 'opacity-100 text-[var(--nim-primary)]' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
            }`}
            title={isPinned ? 'Hide diff' : 'Show diff'}
            onClick={(e) => {
              e.stopPropagation();
              togglePeek(filePath);
            }}
          >
            <MaterialSymbol icon="difference" size={14} />
          </button>
        )}
      </div>
    );
  };

  // Render a directory node recursively
  const renderDirectoryNode = (node: DirectoryNode): React.ReactNode => {
    const isExpanded = expandedFolders.has(node.path);
    const hasContent = node.files.length > 0 || node.subdirectories.size > 0;
    const filesInDir = getFilesInNode(node);
    const selectedCount = filesInDir.filter(f => filesToStage.has(f)).length;
    const allSelected = selectedCount === filesInDir.length;
    const someSelected = selectedCount > 0 && !allSelected;

    // Root node - just render children
    if (!node.displayPath) {
      return (
        <>
          {Array.from(node.subdirectories.values()).map(subdir =>
            renderDirectoryNode(subdir)
          )}
          {node.files.map(file => renderFile(file))}
        </>
      );
    }

    return (
      <div key={node.path} className="git-commit-widget__directory-node mb-0.5">
        <button
          onClick={() => toggleFolder(node.path)}
          className="git-commit-widget__directory-header w-full flex items-center gap-1 px-2 py-0.5 text-[0.8125rem] font-medium text-[var(--nim-text-muted)] bg-transparent border border-transparent rounded transition-all cursor-pointer text-left hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
        >
          <MaterialSymbol
            icon={isExpanded ? 'expand_more' : 'chevron_right'}
            size={16}
            className="git-commit-widget__directory-chevron shrink-0 transition-transform text-[var(--nim-text-faint)]"
          />
          {/* Directory checkbox */}
          <div
            className={`git-commit-widget__checkbox w-4 h-4 shrink-0 rounded-[3px] border-[1.5px] cursor-pointer flex items-center justify-center transition-all ${
              allSelected
                ? 'bg-[var(--nim-file-edited)] border-[var(--nim-file-edited)]'
                : someSelected
                  ? 'bg-[var(--nim-file-edited)] border-[var(--nim-file-edited)] opacity-60'
                  : 'border-[var(--nim-text-faint)] bg-transparent hover:border-[var(--nim-text-muted)]'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              toggleDirectoryFiles(node);
            }}
          >
            {allSelected && (
              <svg width="8" height="6" viewBox="0 0 8 6" fill="none" className="text-white">
                <path d="M1 3L3 5L7 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            {someSelected && (
              <div className="w-2 h-0.5 bg-white rounded-full" />
            )}
          </div>
          <MaterialSymbol
            icon={isExpanded ? 'folder_open' : 'folder'}
            size={16}
            className="git-commit-widget__directory-icon shrink-0 text-[var(--nim-text-muted)]"
          />
          <span className="git-commit-widget__directory-path flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{node.displayPath}</span>
          <span className="git-commit-widget__directory-count shrink-0 px-1 py-0.5 bg-[var(--nim-bg-tertiary)] rounded text-[9px] text-[var(--nim-text-faint)]">
            {selectedCount}/{node.fileCount}
          </span>
        </button>

        {isExpanded && hasContent && (
          <div className="git-commit-widget__directory-children mt-0.5 pl-4">
            {Array.from(node.subdirectories.values()).map(subdir =>
              renderDirectoryNode(subdir)
            )}
            {node.files.map(file => renderFile(file, true))}
          </div>
        )}
      </div>
    );
  };

  const handleConfirm = useCallback(async () => {
    if (filesToStage.size === 0 || !commitMessage.trim() || !isPending || !host) {
      return;
    }

    setIsCommitting(true);
    try {
      // Execute the git commit via host (works on both desktop and mobile)
      const result = await host.gitCommit(
        proposalId,
        Array.from(filesToStage),
        commitMessage
      );

      // If pending (mobile sent to desktop), stay in "Committing..." state.
      // The tool result will arrive via sync and update completedState.
      if (result.pending) {
        // Keep isCommitting true - don't reset
        return;
      }

      setIsCommitting(false);
      setLocalResult(result);
      setHasResponded(true);

      // Track git commit proposal response
      const fileCountBucket = filesToStage.size <= 5 ? '1-5' : filesToStage.size <= 10 ? '6-10' : filesToStage.size <= 20 ? '11-20' : '20+';
      host.trackEvent('git_commit_proposal_response', {
        action: result.success ? 'committed' : 'error',
        file_count: fileCountBucket,
        success: result.success,
        auto_commit: host.autoCommitEnabled ?? false,
      });
    } catch (error) {
      setIsCommitting(false);
      const errorResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      setLocalResult(errorResult);
    }
  }, [filesToStage, commitMessage, isPending, proposalId, host]);

  const handleCancel = useCallback(() => {
    if (hasResponded || !isPending || !host) return; // Prevent double-response

    setLocalResult({ success: false, error: 'Cancelled' });
    setHasResponded(true);

    // Track git commit proposal response
    const fileCountBucket = filesToStage.size <= 5 ? '1-5' : filesToStage.size <= 10 ? '6-10' : filesToStage.size <= 20 ? '11-20' : '20+';
    host.trackEvent('git_commit_proposal_response', {
      action: 'cancelled',
      file_count: fileCountBucket,
    });

    // Send cancel response via host (works on both desktop and mobile)
    host.gitCommitCancel(proposalId).catch(err => {
      console.error('[GitCommitWidget] Failed to send cancel response:', err);
    });
  }, [proposalId, hasResponded, isPending, filesToStage.size, host]);

  // Auto-commit is handled entirely by the httpServer (main process) which commits
  // directly in the MCP tool handler before the widget renders. The widget should NOT
  // attempt its own auto-commit, as that races with the httpServer and fails because
  // files are already committed by the time the widget's git:commit IPC arrives.

  // No loading state needed - atom is reactive and updates when DB changes

  // Show completed/cancelled state (or if we've responded but waiting for tool result)
  if (displayResult || hasResponded) {
    // If we've responded but no displayResult yet, use localResult
    const effectiveResult = displayResult || localResult;
    if (!effectiveResult) {
      return null;
    }
    const result = effectiveResult;
    if (result.error === 'Cancelled') {
      return (
        <div
          data-testid="git-commit-widget"
          data-state="cancelled"
          className="git-commit-widget rounded-lg bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] overflow-hidden opacity-70"
        >
          <div className="git-commit-widget__header flex items-center gap-2 p-2 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
            <MaterialSymbol icon="close" size={16} className="text-[var(--nim-text-muted)]" />
            <span className="text-sm font-semibold text-[var(--nim-text)] flex-1">Commit Proposal</span>
            <span
              data-testid="git-commit-cancelled"
              className="flex items-center gap-1 text-xs font-medium text-[var(--nim-text-muted)] py-1 px-2 bg-[var(--nim-bg-tertiary)] rounded-full"
            >
              Cancelled
            </span>
          </div>
        </div>
      );
    }

    // Format the commit timestamp from the actual git commit date - only show if we have real data
    const commitTimestamp = result.commitDate
      ? new Date(result.commitDate).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : null;

    return (
      <div
        data-testid="git-commit-widget"
        data-state={result.success ? 'committed' : 'error'}
        className={`git-commit-widget rounded-lg bg-[var(--nim-bg-secondary)] border overflow-hidden ${result.success ? 'border-[var(--nim-success)]' : 'border-[var(--nim-error)]'}`}
      >
        <div className="git-commit-widget__header flex items-center gap-2 p-2 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
          <MaterialSymbol
            icon={result.success ? 'check_circle' : 'error'}
            size={16}
            className={result.success ? 'text-[var(--nim-success)]' : 'text-[var(--nim-error)]'}
          />
          <span className="text-sm font-semibold text-[var(--nim-text)] flex-1">
            {result.success ? 'Changes Committed' : 'Commit Failed'}
          </span>
          {result.success && result.commitHash && (
            <span
              data-testid="git-commit-committed"
              className="font-mono text-[0.6875rem] font-semibold text-[var(--nim-success)] bg-[color-mix(in_srgb,var(--nim-success)_12%,transparent)] py-0.5 px-2 rounded-full"
            >
              {result.commitHash.slice(0, 7)}
            </span>
          )}
        </div>
        {result.success ? (
          <div className="git-commit-widget__success-content p-2 bg-[color-mix(in_srgb,var(--nim-success)_8%,var(--nim-bg))] flex flex-col gap-2">
            {commitTimestamp && <div className="text-[0.6875rem] text-[var(--nim-text-faint)]">{commitTimestamp}</div>}
            <div className="text-[0.8125rem] font-medium text-[var(--nim-text)] leading-normal whitespace-pre-wrap font-mono">{commitMessage}</div>
            <div className="mt-1 pt-2 border-t border-[var(--nim-border)]">
              <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--nim-text-muted)] mb-1.5">
                {filesToStage.size} file{filesToStage.size !== 1 ? 's' : ''} committed
              </div>
              <div className="flex flex-wrap gap-1">
                {Array.from(filesToStage).map((filePath) => {
                  const fileName = filePath.split('/').pop() || filePath;
                  const status = fileStatusMap.get(filePath) || 'modified';
                  return (
                    <div key={filePath} className="text-xs" title={filePath}>
                      <span className={`font-mono ${getStatusColorClass(status)}`}>
                        {fileName}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            {host?.autoCommitEnabled && (
              <div className="mt-2 pt-2 border-t border-[var(--nim-border)]">
                <button
                  className="text-[0.75rem] text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] underline cursor-pointer bg-transparent border-none p-0 transition-colors"
                  onClick={() => {
                    host.setAutoCommitEnabled(false);
                    host.trackEvent('auto_commit_disabled', { source: 'commit_success_widget' });
                  }}
                >
                  Disable auto-approve
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="git-commit-widget__error-content p-2 bg-[color-mix(in_srgb,var(--nim-error)_8%,var(--nim-bg))] text-[var(--nim-error)] text-[0.8125rem]">
            {result.error}
          </div>
        )}
      </div>
    );
  }

  // If tool is not pending (has a result) but we didn't handle it above, something is wrong
  if (!isPending) {
    return null;
  }

  // When auto-commit is enabled AND we're not currently committing, the server
  // already committed in the MCP handler before the widget rendered. Show the
  // committed success state directly. If isCommitting is true, the user just
  // toggled auto-commit on and handleConfirm is running — let the normal commit
  // flow handle the UI (shows "Committing..." then completed state).
  // wasAutoCommitted latches once we've shown the auto-commit success UI so
  // toggling auto-commit off afterwards doesn't revert the widget to "pending".
  if ((host?.autoCommitEnabled || wasAutoCommitted) && !isCommitting) {
    return (
      <div
        data-testid="git-commit-widget"
        data-state="committed"
        className="git-commit-widget rounded-lg bg-[var(--nim-bg-secondary)] border border-[var(--nim-success)] overflow-hidden"
      >
        <div className="git-commit-widget__header flex items-center gap-2 p-2 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
          <MaterialSymbol icon="check_circle" size={16} className="text-[var(--nim-success)]" />
          <span className="text-sm font-semibold text-[var(--nim-text)] flex-1">Changes Committed</span>
        </div>
        <div className="git-commit-widget__success-content p-2 bg-[color-mix(in_srgb,var(--nim-success)_8%,var(--nim-bg))] flex flex-col gap-2">
          <div className="text-[0.8125rem] font-medium text-[var(--nim-text)] leading-normal whitespace-pre-wrap font-mono">{initialCommitMessage}</div>
          <div className="mt-1 pt-2 border-t border-[var(--nim-border)]">
            <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--nim-text-muted)] mb-1.5">
              {initialFilesToStage.length} file{initialFilesToStage.length !== 1 ? 's' : ''} committed
            </div>
            <div className="flex flex-wrap gap-1">
              {initialFilesToStage.map((filePath) => {
                const fileName = filePath.split('/').pop() || filePath;
                const status = fileStatusMap.get(filePath) || 'modified';
                return (
                  <div key={filePath} className="text-xs" title={filePath}>
                    <span className={`font-mono ${getStatusColorClass(status)}`}>
                      {fileName}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="mt-2 pt-2 border-t border-[var(--nim-border)]">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={host?.autoCommitEnabled ?? false}
                onChange={(e) => {
                  host?.setAutoCommitEnabled(e.target.checked);
                  host?.trackEvent(
                    e.target.checked ? 'auto_commit_enabled' : 'auto_commit_disabled',
                    { source: 'commit_success_widget' }
                  );
                }}
                className="accent-[var(--nim-primary)] w-3.5 h-3.5 cursor-pointer"
              />
              <span className="text-[0.75rem] text-[var(--nim-text-muted)]">Auto-approve future commits</span>
            </label>
          </div>
        </div>
      </div>
    );
  }

  // Show interactive UI for pending proposals
  return (
    <div
      data-testid="git-commit-widget"
      data-state="pending"
      className="git-commit-widget flex flex-col rounded-lg bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] overflow-hidden"
    >
      {/* Header matching FileEditsSidebar controls bar */}
      <div className="git-commit-widget__header flex items-center gap-2 p-2 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
        <MaterialSymbol icon="commit" size={16} className="text-[var(--nim-primary)]" />
        <span className="text-sm font-semibold text-[var(--nim-text)] flex-1">Commit Proposal</span>
      </div>

      <div className="git-commit-widget__content p-2 flex flex-col gap-3">
        {/* Reasoning */}
        {reasoning && (
          <div className="git-commit-widget__reasoning flex flex-col gap-1.5">
            <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--nim-text-muted)]">Analysis</div>
            <div className="p-2 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded text-[0.8125rem] text-[var(--nim-text-muted)] leading-normal">{reasoning}</div>
          </div>
        )}

        {/* Files to Stage */}
        <div className="git-commit-widget__files flex flex-col gap-1.5">
          <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--nim-text-muted)]">
            Files to Stage ({filesToStage.size}/{initialFilesToStage.length})
          </div>
          <div className="git-commit-widget__files-list flex flex-col max-h-[200px] overflow-y-auto p-1">
            {renderDirectoryNode(directoryTree)}
          </div>
        </div>

        {/* Commit Message */}
        <div className="git-commit-widget__message flex flex-col gap-1.5">
          <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--nim-text-muted)]">Commit Message</div>
          <textarea
            data-testid="git-commit-message-input"
            className="w-full p-2 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] text-[0.8125rem] font-mono resize-y leading-snug focus:outline-none focus:border-[var(--nim-border-focus)] placeholder:text-[var(--nim-text-faint)]"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            rows={6}
            placeholder="Enter commit message..."
          />
        </div>

        {/* Actions */}
        <div className="git-commit-widget__actions flex items-center gap-2 pt-2 border-t border-[var(--nim-border)]">
          <label className="flex items-center gap-1.5 cursor-pointer flex-1 min-w-0">
            <input
              type="checkbox"
              checked={host?.autoCommitEnabled ?? false}
              onChange={(e) => {
                host?.setAutoCommitEnabled(e.target.checked);
                host?.trackEvent(e.target.checked ? 'auto_commit_enabled' : 'auto_commit_disabled', { source: 'commit_widget' });
                // When enabling auto-commit on a pending proposal, trigger the commit
                // immediately — same code path as clicking "Confirm & Commit".
                // Without this, the widget re-renders showing success (because
                // autoCommitEnabled is now true) but no commit actually happens,
                // leaving the MCP tool call hanging.
                if (e.target.checked) {
                  handleConfirm();
                }
              }}
              className="accent-[var(--nim-primary)] w-3.5 h-3.5 cursor-pointer"
            />
            <span className="text-[0.75rem] text-[var(--nim-text-muted)]">Auto-approve commits</span>
          </label>
          <button
            data-testid="git-commit-cancel"
            className="git-commit-widget__cancel-btn flex items-center gap-1.5 py-1.5 px-3 text-[0.8125rem] font-medium border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] cursor-pointer transition-all hover:bg-[var(--nim-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleCancel}
            disabled={isCommitting}
          >
            Cancel
          </button>
          <button
            data-testid="git-commit-confirm"
            className="git-commit-widget__confirm-btn flex items-center gap-1.5 py-1.5 px-3 text-[0.8125rem] font-medium border-none rounded bg-[var(--nim-primary)] text-white cursor-pointer transition-all hover:bg-[var(--nim-primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleConfirm}
            disabled={isCommitting || filesToStage.size === 0 || !commitMessage.trim()}
          >
            <MaterialSymbol icon="check" size={14} />
            {isCommitting ? 'Committing...' : 'Confirm & Commit'}
          </button>
        </div>
      </div>

      {popoverElement}
    </div>
  );
};
