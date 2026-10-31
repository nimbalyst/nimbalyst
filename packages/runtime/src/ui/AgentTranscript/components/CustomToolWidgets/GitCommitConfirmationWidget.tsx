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
import { matchHunkRefs, parseUnifiedDiffToHunks } from '../../../git/unifiedDiffModel';
import { FileTree } from './gitCommit/FileTree';
import {
  buildHunkSelections,
  directoryCheckboxState,
  effectiveStagedFiles,
  fileCheckboxState,
} from './gitCommit/selectionModel';
import { useHunkSelection } from './gitCommit/useHunkSelection';
import {
  buildFileDirectoryTree,
  getFileDirectoryPaths,
  getFilePathBasename,
  type FileDirectoryNode,
} from '@nimbalyst/extension-sdk/file-tree';

// ============================================================
// File Status Types
// ============================================================

import { getStatusColorClass, type FileStatus } from './gitCommit/fileStatus';
export type { FileStatus };

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

export type DirectoryNode = FileDirectoryNode<string>;

/**
 * Comparator: sort DirectoryNodes alphabetically by displayPath.
 * Used by renderDirectoryNode for deterministic tree rendering.
 */
export function compareSubdirectoriesByDisplayPath(a: DirectoryNode, b: DirectoryNode): number {
  return a.displayPath.localeCompare(b.displayPath);
}

/**
 * Comparator: sort file path strings alphabetically by basename.
 * Used by renderDirectoryNode so files within a directory render in
 * alphabetical order regardless of how the model ordered them in
 * `filesToStage`.
 */
export function compareFilesByBasename(a: string, b: string): number {
  const aBase = getFilePathBasename(a);
  const bBase = getFilePathBasename(b);
  return aBase.localeCompare(bBase);
}

interface StructuredCommitResult {
  action?: string;
  commitHash?: string;
  commitDate?: string;
  commitMessage?: string;
  error?: string;
  success?: boolean;
  status?: string;
  /** Files that were selected but belong to no repo, so committed nowhere. */
  uncommittableFiles?: string[];
  /**
   * Per-repo outcome. Present on older proposals made before one-repo-per-call,
   * which could still split at execution; `commitHash` is only the first of
   * them, so without this the other commits have no hash anywhere in the UI.
   */
  repoResults?: Array<{ repoPath: string; success: boolean; commitHash?: string; error?: string }>;
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
 *
 * Strings that look like a JSON object are parsed once and walked: the
 * MCP/app-server path sometimes serializes the auto-commit result before
 * stashing it on the tool_call row, so without this the widget's
 * `commitHash`/`commitDate` extraction silently no-ops and the "Changes
 * Committed" card renders without its hash badge or timestamp.
 */
function extractStructuredCommitResult(value: unknown, seen: Set<object> = new Set()): StructuredCommitResult | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return extractStructuredCommitResult(parsed, seen);
      } catch {
        return null;
      }
    }
    return null;
  }

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
  if (Array.isArray(record.uncommittableFiles)) {
    result.uncommittableFiles = record.uncommittableFiles.filter(
      (file): file is string => typeof file === 'string'
    );
    hasAnyField = true;
  }
  if (Array.isArray(record.repoResults)) {
    result.repoResults = record.repoResults.filter(
      (entry): entry is { repoPath: string; success: boolean; commitHash?: string; error?: string } =>
        !!entry && typeof entry === 'object' && typeof (entry as { repoPath?: unknown }).repoPath === 'string'
    );
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
    result.uncommittableFiles = result.uncommittableFiles ?? nested.uncommittableFiles;
    result.repoResults = result.repoResults ?? nested.repoResults;
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
      if (action === 'error' || action === 'failed') {
        return {
          type: 'error' as const,
          error: structuredResult.error || toolResult || 'Commit failed',
        };
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
  const [staleHunkNotice, setStaleHunkNotice] = useState<string | null>(null);
  // Best-effort name of the session that most likely owns the hunks this
  // session did not write. Null when it cannot be attributed.
  const [siblingSessionLabel, setSiblingSessionLabel] = useState<string | null>(null);

  const {
    hunkStates,
    expandedFiles,
    loadingHunks,
    loadHunkState,
    toggleFileExpanded,
    toggleHunk,
    selectAllHunks,
    selectAllHunksFor,
  } = useHunkSelection(host, initialFilesToStage, isPending);
  const [localResult, setLocalResult] = useState<{
    success: boolean;
    commitHash?: string;
    commitDate?: string;
    error?: string;
  } | null>(null);
  // Diff peek state — encapsulated by useDiffPeek hook (shared with FilesEditedSidebar).
  const { peekSupported, registerRowEl, togglePeek, isActive, popoverElement } = useDiffPeek({
    getDiff: host?.gitFileDiff,
    width: host?.diffPeekSize?.width,
    height: host?.diffPeekSize?.height,
    onResize: host?.setDiffPeekSize,
  });

  // The repo this proposal commits into, resolved in the main process from the
  // files. One proposal is one repo, so this is a single value.
  const repoPath: string | undefined = args.repoPath;
  const targetWorktree: { path: string; branch: string | null } | undefined =
    args.targetWorktree && typeof args.targetWorktree.path === 'string' ? args.targetWorktree : undefined;
  // The server decides each proposal's approval and records it on the input.
  // The preference can disagree: a sibling worktree is always approved by hand
  // (#1756), and the setting may have changed since. Rows written before the
  // field existed fall back to the preference.
  const autoApproved: boolean = typeof args.autoApproved === 'boolean'
    ? args.autoApproved
    : host?.autoCommitEnabled === true;
  const repoLabel = useMemo(
    () => (repoPath ? repoPath.split('/').filter(Boolean).pop() : undefined),
    [repoPath]
  );

  // Files in an attached folder arrive absolute. Rendered as-is they build a
  // tree from `/` -- Users → ghinkle → sources → … -- beside a shallow relative
  // tree for the primary repo. Display them relative to the repo they commit
  // into; the underlying path strings are untouched, since staging and hunk
  // selection key on them.
  const displayPathFor = useMemo(() => {
    const prefix = repoPath?.endsWith('/') ? repoPath : repoPath ? `${repoPath}/` : undefined;
    return (filePath: string): string =>
      prefix && filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
  }, [repoPath]);

  // Build directory tree from files
  const directoryTree = useMemo(() => {
    return buildFileDirectoryTree(initialFilesToStage, displayPathFor);
  }, [initialFilesToStage, displayPathFor]);

  // Auto-expand all folders on mount
  useEffect(() => {
    const allPaths = getFileDirectoryPaths(directoryTree);
    setExpandedFolders(new Set(allPaths));
  }, [directoryTree]);


  // Determine which result to show (tool result wins once available; local is only for pending UI)
  // Extra commits beyond the one `commitHash` names, and files that landed
  // nowhere. Both are reported by the commit service and were previously
  // dropped before reaching the user.
  const extraRepoResults = useMemo(
    () => (structuredResult?.repoResults ?? []).filter((entry) => entry.repoPath !== repoPath),
    [structuredResult?.repoResults, repoPath]
  );
  const uncommittableFiles = structuredResult?.uncommittableFiles ?? [];

  const displayResult = completedState ? {
    success: completedState.type === 'committed',
    commitHash: completedState.type === 'committed' ? completedState.commitHash : undefined,
    commitDate: completedState.type === 'committed' ? completedState.commitDate : undefined,
    error: completedState.type === 'cancelled' ? 'Cancelled' :
           completedState.type === 'error' ? completedState.error : undefined,
  } : localResult;

  const toggleFile = useCallback((filePath: string) => {
    // A partially-selected file deselects entirely on click, matching the
    // folder checkbox: the tri-state is a readout, not a third click target.
    if (fileCheckboxState(filePath, filesToStage, hunkStates) === 'none') {
      setFilesToStage((prev) => new Set(prev).add(filePath));
      selectAllHunksFor([filePath]);
    } else {
      setFilesToStage((prev) => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
    }
  }, [filesToStage, hunkStates, selectAllHunksFor]);

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
    const deselect = directoryCheckboxState(filesInDir, filesToStage, hunkStates) !== 'none';

    setFilesToStage((prev) => {
      const next = new Set(prev);
      if (deselect) {
        filesInDir.forEach(f => next.delete(f));
      } else {
        filesInDir.forEach(f => next.add(f));
      }
      return next;
    });
    if (!deselect) {
      // Re-selecting a directory restores each file to its whole self rather
      // than reviving a stale partial selection the user had backed out of.
      selectAllHunksFor(filesInDir);
    }
  }, [filesToStage, hunkStates, getFilesInNode, selectAllHunksFor]);


  const stagedFiles = useMemo(
    () => effectiveStagedFiles(filesToStage, hunkStates),
    [filesToStage, hunkStates]
  );

  const handleConfirm = useCallback(async () => {
    if (stagedFiles.length === 0 || !commitMessage.trim() || !isPending || !host) {
      return;
    }

    setIsCommitting(true);
    try {
      // `hunkSelections` stays undefined unless some file is a strict subset,
      // so an unrefined proposal takes exactly the pre-existing path.
      const hunkSelections = buildHunkSelections(filesToStage, hunkStates);

      // Re-check the refs against a fresh diff before committing. The service
      // verifies this too and is the real guarantee, but its failure closes the
      // proposal; catching it here keeps the widget interactive so the user can
      // just re-pick after a sibling session touched the file.
      if (hunkSelections.length > 0 && host.gitFileDiff) {
        const stalePaths: string[] = [];
        for (const selection of hunkSelections) {
          const fresh = await host.gitFileDiff(selection.path);
          if (!fresh) continue;
          const parsed = parseUnifiedDiffToHunks(fresh.unifiedDiff);
          if (matchHunkRefs(parsed, selection.hunks).unmatched.length > 0) {
            stalePaths.push(selection.path);
          }
        }
        if (stalePaths.length > 0) {
          setIsCommitting(false);
          setStaleHunkNotice(
            `${stalePaths.map(getFilePathBasename).join(', ')} changed since this proposal was created. The hunks below have been refreshed — check your selection and commit again.`
          );
          await Promise.all(stalePaths.map((p) => loadHunkState(p)));
          return;
        }
      }

      setStaleHunkNotice(null);
      // Execute the git commit via host (works on both desktop and mobile).
      const result = await host.gitCommit(
        proposalId,
        stagedFiles,
        commitMessage,
        hunkSelections.length > 0 ? hunkSelections : undefined
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
        partial_files: hunkSelections.length,
        hunks_deselected: hunkSelections.reduce((total, selection) => {
          const state = hunkStates.get(selection.path);
          return total + (state ? state.hunks.length - selection.hunks.length : 0);
        }, 0),
      });
    } catch (error) {
      setIsCommitting(false);
      const errorResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      setLocalResult(errorResult);
    }
  }, [stagedFiles, filesToStage, hunkStates, commitMessage, isPending, proposalId, host, loadHunkState]);

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
                  const fileName = getFilePathBasename(filePath);
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
            {extraRepoResults.length > 0 && (
              <div className="git-commit-widget__repo-results mt-1 pt-2 border-t border-[var(--nim-border)]">
                <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--nim-text-muted)] mb-1.5">
                  Also committed
                </div>
                {extraRepoResults.map((entry) => (
                  <div key={entry.repoPath} className="flex items-center gap-2 text-xs" title={entry.repoPath}>
                    <span className="text-[var(--nim-text-muted)]">
                      {entry.repoPath.split('/').filter(Boolean).pop()}
                    </span>
                    <span className={`font-mono ${entry.success ? 'text-[var(--nim-success)]' : 'text-[var(--nim-error)]'}`}>
                      {entry.success ? entry.commitHash?.slice(0, 7) : (entry.error ?? 'failed')}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {uncommittableFiles.length > 0 && (
              <div className="git-commit-widget__uncommittable mt-1 pt-2 border-t border-[var(--nim-border)]">
                <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--nim-warning)] mb-1.5">
                  {uncommittableFiles.length} file{uncommittableFiles.length !== 1 ? 's' : ''} in no repository — not committed
                </div>
                <div className="flex flex-wrap gap-1">
                  {uncommittableFiles.map((filePath) => (
                    <span key={filePath} className="text-xs font-mono text-[var(--nim-text-muted)]" title={filePath}>
                      {getFilePathBasename(filePath)}
                    </span>
                  ))}
                </div>
              </div>
            )}
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
          <div
            data-testid="git-commit-error"
            className="git-commit-widget__error-content p-2 bg-[color-mix(in_srgb,var(--nim-error)_8%,var(--nim-bg))] text-[var(--nim-error)] text-[0.8125rem]"
          >
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

  // Auto-approval is not evidence that the server committed. Wait for its
  // result without issuing a second git:commit from the widget.
  if (autoApproved && !targetWorktree && !isCommitting) {
    return (
      <div data-testid="git-commit-widget" data-state="committing"
        className="git-commit-widget rounded-lg bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] overflow-hidden">
        <div className="git-commit-widget__header flex items-center gap-2 p-2">
          <MaterialSymbol icon="progress_activity" size={16} className="animate-spin" />
          <span className="text-sm font-semibold">Committing changes…</span>
        </div>
        <div className="p-2 text-[0.8125rem] whitespace-pre-wrap font-mono">{initialCommitMessage}</div>
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
        {/* Which repo this commits into. A multi-root workspace can have a
            proposal per repo on screen at once; without this they are
            indistinguishable. */}
        {repoLabel && (
          <span
            className="git-commit-widget__repo text-[0.6875rem] font-medium px-1.5 py-0.5 rounded bg-[var(--nim-bg)] border border-[var(--nim-border)] text-[var(--nim-text-muted)]"
            title={repoPath}
          >
            {repoLabel}
          </span>
        )}
      </div>

      <div className="git-commit-widget__content p-2 flex flex-col gap-3">
        {/* #1756: an explicit sibling worktree, not the session's checkout.
            Never auto-committed, so the user sees where it lands first. */}
        {targetWorktree && (
          <div className="git-commit-widget__target-worktree flex items-start gap-1.5 p-2 rounded border border-[var(--nim-warning)] bg-[var(--nim-bg)] text-[0.8125rem] text-[var(--nim-text)] select-text">
            <MaterialSymbol icon="alt_route" size={14} className="text-[var(--nim-warning)] mt-0.5" />
            <span className="min-w-0 break-all">
              Commits to another worktree{targetWorktree.branch ? <> on branch <code>{targetWorktree.branch}</code></> : ' (detached HEAD)'} at <code>{targetWorktree.path}</code>
            </span>
          </div>
        )}

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
            Files to Stage ({stagedFiles.length}/{initialFilesToStage.length})
          </div>
          {staleHunkNotice && (
            <div
              data-testid="git-commit-stale-hunks"
              className="flex items-start gap-1.5 px-2 py-1 rounded border-l-2 border-[var(--nim-error)] bg-[color-mix(in_srgb,var(--nim-error)_9%,transparent)] text-[0.6875rem] leading-snug text-[var(--nim-error)]"
            >
              <MaterialSymbol icon="error" size={12} className="shrink-0 mt-px" />
              <span className="flex-1 min-w-0">{staleHunkNotice}</span>
            </div>
          )}
          <div className="git-commit-widget__files-list flex flex-col max-h-[200px] overflow-y-auto p-1">
            <FileTree
              tree={directoryTree}
              ctx={{
                filesToStage,
                hunkStates,
                expandedFiles,
                expandedFolders,
                loadingHunks,
                fileStatusMap,
                siblingSessionLabel,
                isCommitting,
                peekSupported,
                registerRowEl,
                isActive,
                togglePeek,
                toggleFile,
                toggleFileExpanded,
                toggleHunk,
                selectAllHunks,
                toggleFolder,
                toggleDirectoryFiles,
                getFilesInNode,
                getFilePathBasename,
                compareFilesByBasename,
                compareSubdirectoriesByDisplayPath,
              }}
            />
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
                // The server already chose manual approval for this proposal;
                // changing the preference alone would leave its call waiting.
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
            disabled={isCommitting || stagedFiles.length === 0 || !commitMessage.trim()}
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
