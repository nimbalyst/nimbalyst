import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  useFloating,
  offset,
  flip,
  shift,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
  type VirtualElement,
} from '@floating-ui/react';
import type { FileEditSummary } from '../types';
import { MaterialSymbol } from '../../icons/MaterialSymbol';
import { useDiffPeek } from '../../git/useDiffPeek';
import {
  buildFileDirectoryTree,
  getFileDirectoryPaths,
  getWorkspaceRelativeFilePath,
  type FileDirectoryNode,
} from '@nimbalyst/extension-sdk/file-tree';

interface FileEditsSidebarProps {
  fileEdits: FileEditSummary[];
  onFileClick?: (filePath: string) => void;
  workspacePath?: string;
  /** Set of file paths that have pending AI edits awaiting review */
  pendingReviewFiles?: Set<string>;
  /** Whether to group files by directory (controlled externally) */
  groupByDirectory?: boolean;
  /** Callback when groupByDirectory changes */
  onGroupByDirectoryChange?: (value: boolean) => void;
  /** If true, hide the internal controls (for when controls are rendered externally) */
  hideControls?: boolean;
  /** Callback to open file in Files mode (main editor) */
  onOpenInFiles?: (filePath: string) => void;
  /** Callback to view diff for a file */
  onViewDiff?: (filePath: string) => void;
  /** Callback to copy file path */
  onCopyPath?: (filePath: string) => void;
  /** Callback to reveal file in system file browser */
  onRevealInFinder?: (filePath: string) => void;
  /** Callback to open file in external editor */
  onOpenInExternalEditor?: (filePath: string) => void;
  /** Display name for the external editor (e.g., "VS Code") */
  externalEditorName?: string;
  /** Whether to show checkboxes for file selection (Manual/Worktree mode) */
  showCheckboxes?: boolean;
  /** Set of selected file paths (for checkbox state) */
  selectedFiles?: Set<string>;
  /** Callback when file selection changes */
  onSelectionChange?: (filePath: string, selected: boolean) => void;
  /** Optional per-file gate for whether a file can be selected for commit */
  isFileSelectable?: (filePath: string) => boolean;
  /** Callback to select/deselect all files */
  onSelectAll?: (selected: boolean) => void;
  /** Callback for bulk selection changes (add/remove multiple files at once) */
  onBulkSelectionChange?: (filePaths: string[], selected: boolean) => void;
  /** Whether to show a root-level "Select All" checkbox (defaults to true when showCheckboxes is true) */
  showRootCheckbox?: boolean;
  /** Total count of session files (used to show "no uncommitted changes" vs "no files edited") */
  totalSessionFilesCount?: number;
  /** Callback to switch to session files view (when showing "no uncommitted changes") */
  onShowSessionFiles?: () => void;
  /** Total count of all uncommitted files in repo (for hint link in session-files mode) */
  totalUncommittedCount?: number;
  /** Callback to switch to all-uncommitted view */
  onShowAllUncommitted?: () => void;
  /** Current scope mode - used to customize empty state messages */
  scopeMode?: 'current-changes' | 'session-files' | 'all-changes';
  /**
   * Fetch the unified diff for a file (HEAD vs working tree).
   * When provided, each row gets a hover-revealed peek icon that opens an inline diff popover.
   */
  onGetDiff?: (filePath: string) => Promise<{ unifiedDiff: string; isBinary: boolean } | null>;
  /** Persisted popover width (px). Shared across diff peek surfaces. */
  diffPeekWidth?: number;
  /** Persisted popover height (px). Shared across diff peek surfaces. */
  diffPeekHeight?: number;
  /** Called (debounced) when the user resizes the popover. */
  onDiffPeekResize?: (size: { width: number; height: number }) => void;
}

interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  filePath: string;
}

interface FileGitStatus {
  status: 'modified' | 'staged' | 'untracked' | 'unchanged' | 'deleted';
  gitStatusCode?: string;
}

type EditedFile = {
  filePath: string;
  edits: FileEditSummary[];
  totalAdded: number;
  totalRemoved: number;
  operation?: string;
  timestamp: string;
};

type DirectoryNode = FileDirectoryNode<EditedFile>;

export const FileEditsSidebar: React.FC<FileEditsSidebarProps> = ({
  fileEdits,
  onFileClick,
  workspacePath,
  pendingReviewFiles,
  groupByDirectory: groupByDirectoryProp,
  onGroupByDirectoryChange,
  hideControls = false,
  onOpenInFiles,
  onViewDiff,
  onCopyPath,
  onRevealInFinder,
  onOpenInExternalEditor,
  externalEditorName,
  showCheckboxes = false,
  selectedFiles,
  onSelectionChange,
  isFileSelectable,
  onSelectAll,
  onBulkSelectionChange,
  showRootCheckbox,
  totalSessionFilesCount,
  onShowSessionFiles,
  totalUncommittedCount,
  onShowAllUncommitted,
  scopeMode = 'current-changes',
  onGetDiff,
  diffPeekWidth,
  diffPeekHeight,
  onDiffPeekResize,
}) => {
  // Diff peek state — shared with GitCommitConfirmationWidget via useDiffPeek.
  const { peekSupported, registerRowEl, togglePeek, isActive, popoverElement } = useDiffPeek({
    getDiff: onGetDiff,
    width: diffPeekWidth,
    height: diffPeekHeight,
    onResize: onDiffPeekResize,
  });
  // Default showRootCheckbox to true when showCheckboxes is true
  const shouldShowRootCheckbox = showRootCheckbox ?? showCheckboxes;
  const [gitStatus, setGitStatus] = useState<Record<string, FileGitStatus>>({});
  // Use prop if provided, otherwise use local state
  const [localGroupByDirectory, setLocalGroupByDirectory] = useState(false);
  const groupByDirectory = groupByDirectoryProp ?? localGroupByDirectory;
  const setGroupByDirectory = onGroupByDirectoryChange ?? setLocalGroupByDirectory;
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ isOpen: false, x: 0, y: 0, filePath: '' });

  const { refs: contextMenuRefs, floatingStyles: contextMenuStyles, context: contextMenuContext } = useFloating({
    open: contextMenu.isOpen,
    onOpenChange: (open) => {
      if (!open) setContextMenu({ isOpen: false, x: 0, y: 0, filePath: '' });
    },
    placement: 'bottom-start',
    middleware: [offset(2), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const contextMenuDismiss = useDismiss(contextMenuContext);
  const contextMenuRole = useRole(contextMenuContext, { role: 'menu' });
  const { getFloatingProps: getContextMenuFloatingProps } = useInteractions([contextMenuDismiss, contextMenuRole]);

  // Convert absolute path to relative path from workspace root
  const getRelativePath = useCallback((filePath: string): string => {
    return getWorkspaceRelativeFilePath(filePath, workspacePath);
  }, [workspacePath]);

  // Build directory tree from file list
  const buildDirectoryTree = useCallback((files: EditedFile[]): DirectoryNode => (
    buildFileDirectoryTree(files, file => file.filePath, workspacePath)
  ), [workspacePath]);

  // Group edited files by file path
  const editedFiles = useMemo(() => {
    const edited = fileEdits.filter(edit => edit.linkType === 'edited');

    // Group by file path
    const groups = new Map<string, FileEditSummary[]>();
    edited.forEach(file => {
      const existing = groups.get(file.filePath) || [];
      existing.push(file);
      groups.set(file.filePath, existing);
    });

    return Array.from(groups.entries()).map(([filePath, edits]) => {
      const totalAdded = edits.reduce((sum, e) => sum + (e.linesAdded || 0), 0);
      const totalRemoved = edits.reduce((sum, e) => sum + (e.linesRemoved || 0), 0);
      const lastEdit = edits[edits.length - 1];

      return {
        filePath,
        edits,
        totalAdded,
        totalRemoved,
        operation: lastEdit.operation,
        timestamp: lastEdit.timestamp
      };
    });
  }, [fileEdits]);

  // Fetch git status for edited files
  useEffect(() => {
    if (!workspacePath || editedFiles.length === 0) {
      setGitStatus({});
      return;
    }

    const fetchGitStatus = async () => {
      try {
        const filePaths = editedFiles.map(f => getRelativePath(f.filePath));

        if (typeof window !== 'undefined' && (window as any).electronAPI) {
          const result = await (window as any).electronAPI.invoke(
            'git:get-file-status',
            workspacePath,
            filePaths
          );
          if (result.success && result.status) {
            setGitStatus(result.status);
          }
        }
      } catch (error) {
        console.error('[FileEditsSidebar] Failed to fetch git status:', error);
      }
    };

    fetchGitStatus();

    // Refresh on window focus
    const handleFocus = () => {
      fetchGitStatus();
    };

    // Listen for git status changes
    const handleGitStatusChanged = (data: { workspacePath: string }) => {
      if (data.workspacePath === workspacePath) {
        fetchGitStatus();
      }
    };

    window.addEventListener('focus', handleFocus);
    const unsubscribe = (window as any).electronAPI?.on?.('git:status-changed', handleGitStatusChanged);

    return () => {
      window.removeEventListener('focus', handleFocus);
      unsubscribe?.();
    };
  }, [editedFiles, workspacePath]);

  const toggleFolder = (folderPath: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  };

  const expandAll = useCallback(() => {
    if (editedFiles.length > 0) {
      const tree = buildDirectoryTree(editedFiles);
      const allPaths = getFileDirectoryPaths(tree);
      setExpandedFolders(new Set(allPaths));
    }
  }, [buildDirectoryTree, editedFiles]);

  const collapseAll = useCallback(() => {
    setExpandedFolders(new Set());
  }, []);

  // Auto-expand all folders when groupByDirectory is first enabled.
  // When files change, only expand NEW folders (don't reset manually collapsed ones).
  const prevGroupByDirectoryRef = React.useRef(groupByDirectory);
  useEffect(() => {
    if (!groupByDirectory || editedFiles.length === 0) {
      prevGroupByDirectoryRef.current = groupByDirectory;
      return;
    }

    const tree = buildDirectoryTree(editedFiles);
    const allPaths = getFileDirectoryPaths(tree);

    if (!prevGroupByDirectoryRef.current && groupByDirectory) {
      // groupByDirectory was just turned on - expand everything
      setExpandedFolders(new Set(allPaths));
    } else {
      // Files changed while already grouped - only add new folders, preserve collapsed state
      setExpandedFolders(prev => {
        const next = new Set(prev);
        let changed = false;
        for (const path of allPaths) {
          if (!prev.has(path)) {
            // This is a new folder not seen before - expand it by default
            next.add(path);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }

    prevGroupByDirectoryRef.current = groupByDirectory;
  }, [buildDirectoryTree, groupByDirectory, editedFiles]);

  // Listen for external expand/collapse events (when hideControls is true)
  useEffect(() => {
    if (!hideControls) return;

    const handleExpandAll = () => expandAll();
    const handleCollapseAll = () => collapseAll();

    window.addEventListener('file-edits-sidebar:expand-all', handleExpandAll);
    window.addEventListener('file-edits-sidebar:collapse-all', handleCollapseAll);

    return () => {
      window.removeEventListener('file-edits-sidebar:expand-all', handleExpandAll);
      window.removeEventListener('file-edits-sidebar:collapse-all', handleCollapseAll);
    };
  }, [hideControls, expandAll, collapseAll]);

  // Check if file has uncommitted changes (is selectable for commit)
  const isFileCommitted = useCallback((filePath: string): boolean => {
    const relativePath = getRelativePath(filePath);
    const status = gitStatus[relativePath];
    return !status || status.status === 'unchanged';
  }, [gitStatus, getRelativePath]);

  const isSelectableForCommit = useCallback((filePath: string): boolean => {
    if (isFileCommitted(filePath)) {
      return false;
    }
    return isFileSelectable ? isFileSelectable(filePath) : true;
  }, [isFileCommitted, isFileSelectable]);

  // Calculate root-level selection state for "Select All" checkbox
  const rootSelectionInfo = useMemo(() => {
    const allFilePaths = editedFiles.map(f => f.filePath);
    const selectablePaths = allFilePaths.filter(isSelectableForCommit);
    const uncommittedCount = selectablePaths.length;

    if (uncommittedCount === 0) {
      return { state: 'none' as const, uncommittedCount: 0 };
    }

    const selectedCount = selectablePaths.filter(p => selectedFiles?.has(p)).length;
    if (selectedCount === 0) {
      return { state: 'none' as const, uncommittedCount };
    }
    if (selectedCount === uncommittedCount) {
      return { state: 'all' as const, uncommittedCount };
    }
    return { state: 'some' as const, uncommittedCount };
  }, [editedFiles, selectedFiles, isSelectableForCommit]);

  // Get file status color class based on operation and git status
  const getFileStatusColor = (filePath: string, operation?: string): string => {
    const relativePath = getRelativePath(filePath);
    const status = gitStatus[relativePath];

    // If file has no git changes (committed/unchanged), use committed color
    const isCommitted = !status || status.status === 'unchanged';

    if (isCommitted) {
      return 'text-[var(--nim-file-committed)]';
    }

    // File has uncommitted changes - color by operation type
    if (operation === 'delete') {
      return 'text-[var(--nim-file-deleted)]';
    }
    if (operation === 'create') {
      return 'text-[var(--nim-file-new)]';
    }
    // edit, rename, or unknown operation
    return 'text-[var(--nim-file-edited)]';
  };

  // Get tooltip text for file status
  const getFileStatusTooltip = (filePath: string, operation?: string): string => {
    const relativePath = getRelativePath(filePath);
    const status = gitStatus[relativePath];

    const isCommitted = !status || status.status === 'unchanged';

    if (isCommitted) {
      if (operation === 'delete') {
        return `${relativePath} - Deleted and committed`;
      }
      return `${relativePath} - Committed`;
    }

    // Build tooltip based on operation and git status
    const operationText = {
      create: 'Created',
      edit: 'Edited',
      delete: 'Deleted',
      rename: 'Renamed'
    }[operation || 'edit'] || 'Modified';

    const gitStatusText = status ? ` (${status.status})` : '';
    return `${relativePath} - ${operationText}${gitStatusText}`;
  };

  const formatFileName = (filePath: string) => {
    // Handle both Windows (\) and Unix (/) path separators
    const parts = filePath.split(/[/\\]/);
    return parts[parts.length - 1];
  };

  // Context menu handlers
  const handleContextMenu = (e: React.MouseEvent, filePath: string) => {
    e.preventDefault();
    setContextMenu({
      isOpen: true,
      x: e.clientX,
      y: e.clientY,
      filePath
    });
  };

  const closeContextMenu = () => {
    setContextMenu({ isOpen: false, x: 0, y: 0, filePath: '' });
  };

  // Anchor the menu to a virtual element at the cursor so floating-ui can
  // flip/shift it back on screen near viewport edges.
  useEffect(() => {
    if (!contextMenu.isOpen) {
      contextMenuRefs.setPositionReference(null);
      return;
    }
    const virtual: VirtualElement = {
      getBoundingClientRect: () =>
        DOMRect.fromRect({ x: contextMenu.x, y: contextMenu.y, width: 0, height: 0 }),
    };
    contextMenuRefs.setPositionReference(virtual);
  }, [contextMenu.isOpen, contextMenu.x, contextMenu.y, contextMenuRefs]);

  const renderContextMenu = () => {
    if (!contextMenu.isOpen) return null;

    const hasContextActions = onOpenInFiles || onViewDiff || onCopyPath || onRevealInFinder || onOpenInExternalEditor;
    if (!hasContextActions) return null;

    return (
      <FloatingPortal>
        <div
          ref={contextMenuRefs.setFloating}
          className="file-edits-sidebar__context-menu z-50 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md shadow-lg py-1 min-w-[180px]"
          style={contextMenuStyles}
          {...getContextMenuFloatingProps({ onClick: (e) => e.stopPropagation() })}
        >
          {onOpenInFiles && (
            <button
              className="file-edits-sidebar__context-menu-item w-full flex items-center gap-2 px-3 py-1.5 text-[0.8125rem] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] text-left"
              onClick={() => {
                onOpenInFiles(contextMenu.filePath);
                closeContextMenu();
              }}
            >
              <MaterialSymbol icon="open_in_new" size={16} className="text-[var(--nim-text-muted)]" />
              Open in Files
            </button>
          )}
          {onViewDiff && (
            <button
              className="file-edits-sidebar__context-menu-item w-full flex items-center gap-2 px-3 py-1.5 text-[0.8125rem] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] text-left"
              onClick={() => {
                onViewDiff(contextMenu.filePath);
                closeContextMenu();
              }}
            >
              <MaterialSymbol icon="difference" size={16} className="text-[var(--nim-text-muted)]" />
              View Diff
            </button>
          )}
          {onOpenInExternalEditor && externalEditorName && (
            <button
              className="file-edits-sidebar__context-menu-item w-full flex items-center gap-2 px-3 py-1.5 text-[0.8125rem] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] text-left"
              onClick={() => {
                onOpenInExternalEditor(contextMenu.filePath);
                closeContextMenu();
              }}
            >
              <MaterialSymbol icon="open_in_new" size={16} className="text-[var(--nim-text-muted)]" />
              Open in {externalEditorName}
            </button>
          )}
          {(onOpenInFiles || onViewDiff || onOpenInExternalEditor) && (onCopyPath || onRevealInFinder) && (
            <div className="file-edits-sidebar__context-menu-divider h-px bg-[var(--nim-border)] my-1" />
          )}
          {onCopyPath && (
            <button
              className="file-edits-sidebar__context-menu-item w-full flex items-center gap-2 px-3 py-1.5 text-[0.8125rem] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] text-left"
              onClick={() => {
                onCopyPath(contextMenu.filePath);
                closeContextMenu();
              }}
            >
              <MaterialSymbol icon="content_copy" size={16} className="text-[var(--nim-text-muted)]" />
              Copy Path
            </button>
          )}
          {onRevealInFinder && (
            <button
              className="file-edits-sidebar__context-menu-item w-full flex items-center gap-2 px-3 py-1.5 text-[0.8125rem] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] text-left"
              onClick={() => {
                onRevealInFinder(contextMenu.filePath);
                closeContextMenu();
              }}
            >
              <MaterialSymbol icon="folder_open" size={16} className="text-[var(--nim-text-muted)]" />
              Reveal in Finder
            </button>
          )}
        </div>
      </FloatingPortal>
    );
  };

  const renderFile = ({ filePath, operation }: { filePath: string; totalAdded: number; totalRemoved: number; operation?: string }, isInDirectory = false) => {
    const hasPendingReview = pendingReviewFiles?.has(filePath);
    const fileColorClass = getFileStatusColor(filePath, operation);
    // Check both operation and git status for deleted files
    const relativePath = getRelativePath(filePath);
    const gitFileStatus = gitStatus[relativePath];
    const isDeleted = operation === 'delete' || gitFileStatus?.status === 'deleted';
    const tooltip = getFileStatusTooltip(filePath, operation);
    const committed = isFileCommitted(filePath);
    const selectable = isSelectableForCommit(filePath);
    const isSelected = selectedFiles?.has(filePath) ?? false;
    const isPinned = isActive(filePath);

    // Handler to toggle file selection without triggering file click
    const handleCheckboxClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelectionChange?.(filePath, !isSelected);
    };

    // Drag handler to enable dropping file as @-mention in AI input
    const handleDragStart = (e: React.DragEvent) => {
      e.dataTransfer.setData('application/x-nimbalyst-file-mention', relativePath);
      e.dataTransfer.effectAllowed = 'copy';
    };

    return (
      <div
        key={filePath}
        ref={(el) => registerRowEl(filePath, el)}
        draggable
        onDragStart={handleDragStart}
        onContextMenu={(e) => handleContextMenu(e, filePath)}
        className={`file-edits-sidebar__file group w-full flex items-center gap-1 px-2 py-0.5 rounded border border-transparent transition-all bg-transparent hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-border)] ${
          isPinned ? 'bg-[var(--nim-bg-hover)] border-[var(--nim-primary)]' : ''
        } ${hasPendingReview ? 'bg-[rgba(251,191,36,0.08)] border-[rgba(251,191,36,0.2)] hover:bg-[rgba(251,191,36,0.12)] hover:border-[rgba(251,191,36,0.3)]' : ''}`}
        title={tooltip}
      >
        <button
          type="button"
          onClick={() => {
            // Don't open deleted files - they don't exist anymore
            if (!isDeleted) {
              onFileClick?.(filePath);
            }
          }}
          className="file-edits-sidebar__file-main flex-1 min-w-0 flex items-center gap-1 text-left bg-transparent border-0 p-0 cursor-pointer"
        >
          {/* Placeholder for expand caret (to align with folder rows) - only in directory tree */}
          {isInDirectory && (
            <div className="file-edits-sidebar__caret-placeholder w-4 h-4 shrink-0" />
          )}
          {/* Checkbox for commit selection - only show when in checkbox mode */}
          {showCheckboxes && (
            !selectable ? (
              // Placeholder for non-selectable files (committed or outside commit scope)
              <div className="file-edits-sidebar__checkbox-placeholder w-4 h-4 shrink-0" />
            ) : (
              // Checkbox for selectable files
              <div
                onClick={handleCheckboxClick}
                className={`file-edits-sidebar__checkbox w-4 h-4 shrink-0 rounded-[3px] border-[1.5px] cursor-pointer flex items-center justify-center transition-all ${
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
            )
          )}
          <div className="file-edits-sidebar__file-info flex-1 min-w-0 flex items-center gap-1">
            <div
              className={`file-edits-sidebar__file-name text-[0.8125rem] font-medium overflow-hidden text-ellipsis whitespace-nowrap ${isDeleted ? 'line-through text-[var(--nim-text-muted)]' : fileColorClass}`}
            >
              {formatFileName(filePath)}
            </div>
            {isDeleted && (
              <span className="text-[0.6875rem] text-[var(--nim-text-muted)] shrink-0">(deleted)</span>
            )}
            {/* Yellow dot indicator for files pending review */}
            {hasPendingReview && (
              <span
                className="file-edits-sidebar__pending-dot w-1 h-1 rounded-full bg-[#fbbf24] shrink-0 ml-1"
                title="Pending review - changes not yet committed"
              />
            )}
          </div>
        </button>
        {peekSupported && !isDeleted && (
          <button
            type="button"
            data-testid="files-edited-file-peek"
            className={`file-edits-sidebar__peek-btn shrink-0 w-5 h-5 flex items-center justify-center rounded text-[var(--nim-text-faint)] hover:text-[var(--nim-primary)] hover:bg-[var(--nim-bg-tertiary)] transition-opacity bg-transparent border-0 cursor-pointer ${
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

  // Helper to collect all file paths from a directory node recursively
  const collectFilePaths = (node: DirectoryNode): string[] => {
    const paths: string[] = [];
    node.files.forEach(f => paths.push(f.filePath));
    node.subdirectories.forEach(subdir => {
      paths.push(...collectFilePaths(subdir));
    });
    return paths;
  };

  // Helper to check if all uncommitted files in a directory are selected
  const getDirectorySelectionState = (node: DirectoryNode): 'none' | 'some' | 'all' => {
    const allPaths = collectFilePaths(node);
    const uncommittedPaths = allPaths.filter(isSelectableForCommit);

    if (uncommittedPaths.length === 0) return 'none'; // All files are committed

    const selectedCount = uncommittedPaths.filter(p => selectedFiles?.has(p)).length;
    if (selectedCount === 0) return 'none';
    if (selectedCount === uncommittedPaths.length) return 'all';
    return 'some';
  };

  // Toggle selection for all uncommitted files in a directory
  const handleDirectoryCheckboxClick = (e: React.MouseEvent, node: DirectoryNode) => {
    e.stopPropagation();
    const allPaths = collectFilePaths(node);
    const uncommittedPaths = allPaths.filter(isSelectableForCommit);
    const selectionState = getDirectorySelectionState(node);

    // If none or some are selected, select all. If all are selected, deselect all.
    const shouldSelect = selectionState !== 'all';

    // Use bulk selection if available (handles multiple files atomically)
    if (onBulkSelectionChange) {
      onBulkSelectionChange(uncommittedPaths, shouldSelect);
    } else {
      // Fallback to individual calls (may have race condition issues)
      uncommittedPaths.forEach(p => {
        onSelectionChange?.(p, shouldSelect);
      });
    }
  };

  const renderDirectoryNode = (node: DirectoryNode): React.ReactNode => {
    const isExpanded = expandedFolders.has(node.path);
    const hasContent = node.files.length > 0 || node.subdirectories.size > 0;

    // Check if directory has any uncommitted files (for checkbox visibility)
    const allPaths = collectFilePaths(node);
    const hasUncommittedFiles = allPaths.some(isSelectableForCommit);
    const selectionState = getDirectorySelectionState(node);

    return (
      <div key={node.path || 'root'} className="file-edits-sidebar__directory-node mb-0.5">
        {node.displayPath && (
          <button
            onClick={() => toggleFolder(node.path)}
            className="file-edits-sidebar__directory-header w-full flex items-center gap-1 px-2 py-0.5 text-[0.8125rem] font-medium text-[var(--nim-text-muted)] bg-transparent border border-transparent rounded transition-all cursor-pointer text-left hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
          >
            <MaterialSymbol
              icon={isExpanded ? "expand_more" : "chevron_right"}
              size={16}
              className="file-edits-sidebar__directory-chevron shrink-0 transition-transform text-[var(--nim-text-faint)]"
            />
            {/* Directory checkbox - between caret and folder icon */}
            {showCheckboxes && (
              hasUncommittedFiles ? (
                <div
                  onClick={(e) => handleDirectoryCheckboxClick(e, node)}
                  className={`file-edits-sidebar__checkbox w-4 h-4 shrink-0 rounded-[3px] border-[1.5px] cursor-pointer flex items-center justify-center transition-all ${
                    selectionState === 'all'
                      ? 'bg-[var(--nim-file-edited)] border-[var(--nim-file-edited)]'
                      : selectionState === 'some'
                        ? 'bg-[var(--nim-file-edited)] border-[var(--nim-file-edited)] opacity-60'
                        : 'border-[var(--nim-text-faint)] bg-transparent hover:border-[var(--nim-text-muted)]'
                  }`}
                >
                  {selectionState !== 'none' && (
                    selectionState === 'all' ? (
                      <svg width="8" height="6" viewBox="0 0 8 6" fill="none" className="text-white">
                        <path d="M1 3L3 5L7 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    ) : (
                      // Indeterminate state (dash)
                      <div className="w-2 h-0.5 bg-white rounded-full" />
                    )
                  )}
                </div>
              ) : (
                // Placeholder when no uncommitted files
                <div className="file-edits-sidebar__checkbox-placeholder w-4 h-4 shrink-0" />
              )
            )}
            <MaterialSymbol
              icon={isExpanded ? "folder_open" : "folder"}
              size={16}
              className="file-edits-sidebar__directory-icon shrink-0 text-[var(--nim-text-muted)]"
            />
            <span className="file-edits-sidebar__directory-path flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{node.displayPath}</span>
            <span className="file-edits-sidebar__directory-count shrink-0 px-1 py-0.5 bg-[var(--nim-bg-tertiary)] rounded text-[9px] text-[var(--nim-text-faint)]">{node.fileCount}</span>
          </button>
        )}

        {(isExpanded || !node.displayPath) && hasContent && (
          <div className={node.displayPath ? "file-edits-sidebar__directory-children mt-0.5 pl-4" : undefined}>
            {/* Render subdirectories first */}
            {Array.from(node.subdirectories.values()).map(subdir =>
              renderDirectoryNode(subdir)
            )}

            {/* Render files */}
            {node.files.map(file => renderFile(file, true))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="file-edits-sidebar flex flex-col h-full bg-[var(--nim-bg-secondary)]">
      {!hideControls && editedFiles.length > 0 && (
        <div className="file-edits-sidebar__controls flex items-center gap-1 p-2 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
          <button
            onClick={() => setGroupByDirectory(!groupByDirectory)}
            className={`file-edits-sidebar__control-button flex items-center justify-center w-7 h-7 p-0 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text-muted)] cursor-pointer transition-all hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] disabled:opacity-40 disabled:cursor-not-allowed ${groupByDirectory ? 'bg-[var(--nim-primary)] text-white border-[var(--nim-primary)]' : ''}`}
            title="Group by directory"
          >
            <MaterialSymbol icon="folder" size={18} />
          </button>
          <button
            onClick={expandAll}
            disabled={!groupByDirectory}
            className="file-edits-sidebar__control-button flex items-center justify-center w-7 h-7 p-0 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text-muted)] cursor-pointer transition-all hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] disabled:opacity-40 disabled:cursor-not-allowed"
            title="Expand all"
          >
            <MaterialSymbol icon="unfold_more" size={18} />
          </button>
          <button
            onClick={collapseAll}
            disabled={!groupByDirectory}
            className="file-edits-sidebar__control-button flex items-center justify-center w-7 h-7 p-0 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text-muted)] cursor-pointer transition-all hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] disabled:opacity-40 disabled:cursor-not-allowed"
            title="Collapse all"
          >
            <MaterialSymbol icon="unfold_less" size={18} />
          </button>
        </div>
      )}
      <div className="file-edits-sidebar__files flex-1 overflow-y-auto p-1">
        {/* Root "Select All" checkbox */}
        {shouldShowRootCheckbox && editedFiles.length > 0 && rootSelectionInfo.uncommittedCount > 0 && (
          <div className="file-edits-sidebar__root-checkbox flex items-center gap-2 px-2 py-1.5 mb-1 border-b border-[var(--nim-border)]">
            <div
              onClick={() => onSelectAll?.(rootSelectionInfo.state !== 'all')}
              className={`w-4 h-4 shrink-0 rounded-[3px] border-[1.5px] cursor-pointer flex items-center justify-center transition-all ${
                rootSelectionInfo.state === 'all'
                  ? 'bg-[var(--nim-file-edited)] border-[var(--nim-file-edited)]'
                  : rootSelectionInfo.state === 'some'
                    ? 'bg-[var(--nim-file-edited)] border-[var(--nim-file-edited)] opacity-60'
                    : 'border-[var(--nim-text-faint)] bg-transparent hover:border-[var(--nim-text-muted)]'
              }`}
            >
              {rootSelectionInfo.state !== 'none' && (
                rootSelectionInfo.state === 'all' ? (
                  <svg width="8" height="6" viewBox="0 0 8 6" fill="none" className="text-white">
                    <path d="M1 3L3 5L7 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : (
                  <div className="w-2 h-0.5 bg-white rounded-full" />
                )
              )}
            </div>
            <span className="text-[0.8125rem] text-[var(--nim-text-muted)]">
              Select all ({rootSelectionInfo.uncommittedCount} uncommitted)
            </span>
          </div>
        )}
        {editedFiles.length === 0 ? (
          <div className="file-edits-sidebar__empty p-4 text-[var(--nim-text-faint)] text-sm text-center">
            {scopeMode === 'current-changes' && totalSessionFilesCount && totalSessionFilesCount > 0 ? (
              // Uncommitted Session Edits mode with no uncommitted changes
              <div className="flex flex-col items-center">
                <div>No uncommitted changes</div>
                {onShowSessionFiles && (
                  <button
                    onClick={onShowSessionFiles}
                    className="mt-2 text-[var(--nim-primary)] hover:underline cursor-pointer bg-transparent border-none text-sm"
                  >
                    Show all session edits ({totalSessionFilesCount})
                  </button>
                )}
                {onShowAllUncommitted && totalUncommittedCount && totalUncommittedCount > 0 && (
                  <button
                    onClick={onShowAllUncommitted}
                    className="mt-2 text-[var(--nim-primary)] hover:underline cursor-pointer bg-transparent border-none text-sm"
                  >
                    Show all uncommitted files ({totalUncommittedCount})
                  </button>
                )}
              </div>
            ) : scopeMode === 'current-changes' ? (
              // Uncommitted Session Edits mode with no session files at all
              <>
                <div>No files edited yet</div>
                {onShowAllUncommitted && totalUncommittedCount && totalUncommittedCount > 0 && (
                  <button
                    onClick={onShowAllUncommitted}
                    className="mt-2 text-[var(--nim-primary)] hover:underline cursor-pointer bg-transparent border-none text-sm"
                  >
                    Show all uncommitted files ({totalUncommittedCount})
                  </button>
                )}
              </>
            ) : scopeMode === 'session-files' ? (
              // All Session Edits mode with no files
              <>
                <div>No files edited in this session</div>
                {onShowAllUncommitted && totalUncommittedCount && totalUncommittedCount > 0 && (
                  <button
                    onClick={onShowAllUncommitted}
                    className="mt-2 text-[var(--nim-primary)] hover:underline cursor-pointer bg-transparent border-none text-sm"
                  >
                    Show all uncommitted files ({totalUncommittedCount})
                  </button>
                )}
              </>
            ) : scopeMode === 'all-changes' ? (
              // All Uncommitted Files mode with no files
              <>
                <div>No uncommitted files</div>
                {onShowSessionFiles && totalSessionFilesCount && totalSessionFilesCount > 0 && (
                  <button
                    onClick={onShowSessionFiles}
                    className="mt-2 text-[var(--nim-primary)] hover:underline cursor-pointer bg-transparent border-none text-sm"
                  >
                    Show session edits ({totalSessionFilesCount})
                  </button>
                )}
              </>
            ) : (
              'No files edited yet'
            )}
          </div>
        ) : (
          <>
            {groupByDirectory ? (
              renderDirectoryNode(buildDirectoryTree(editedFiles))
            ) : (
              editedFiles.map(file => renderFile(file))
            )}
            {/* Show link to all uncommitted files when in session-files mode and there are additional uncommitted files */}
            {scopeMode === 'session-files' && onShowAllUncommitted && totalUncommittedCount && totalUncommittedCount > editedFiles.length && (
              <div className="file-edits-sidebar__uncommitted-hint px-2 py-3 text-center">
                <button
                  onClick={onShowAllUncommitted}
                  className="text-[var(--nim-primary)] hover:underline cursor-pointer bg-transparent border-none text-sm"
                >
                  Show all uncommitted files ({totalUncommittedCount})
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {renderContextMenu()}
      {popoverElement}
    </div>
  );
};
