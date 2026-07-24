import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  MaterialSymbol,
  buildFileDirectoryTree,
  getFileDirectoryPaths,
  getWorkspaceRelativeFilePath,
  type FileDirectoryNode,
} from '@nimbalyst/runtime';
import { getFileName } from '../../utils/pathUtils';
import {
  diffTreeGroupByDirectoryAtom,
  setDiffTreeGroupByDirectoryAtom,
  fileGutterCollapsedAtom,
  setFileGutterCollapsedAtom,
} from '../../store/atoms/projectState';
import { sessionFileEditsAtom, sessionPendingReviewFilesAtom } from '../../store/atoms/sessionFiles';

interface FileGutterProps {
  sessionId: string | null;
  workspacePath?: string;
  type: 'referenced' | 'edited';
  onFileClick?: (filePath: string) => void;
  /** Optional: Set of file paths that have pending AI edits awaiting review */
  pendingReviewFiles?: Set<string>;
}

interface FileData {
  filePath: string;
  operation?: 'create' | 'edit' | 'delete' | 'rename';
  linesAdded?: number;
  linesRemoved?: number;
}

interface FileGitStatus {
  status: 'modified' | 'staged' | 'untracked' | 'unchanged' | 'deleted';
  gitStatusCode?: string;
}

type DirectoryNode = FileDirectoryNode<FileData>;

export function FileGutter({ sessionId, workspacePath, type, onFileClick, pendingReviewFiles }: FileGutterProps) {
  const [files, setFiles] = useState<FileData[]>([]);
  const fileGutterCollapsed = useAtomValue(fileGutterCollapsedAtom);
  const setFileGutterCollapsed = useSetAtom(setFileGutterCollapsedAtom);
  const isExpanded = !(fileGutterCollapsed[type] ?? false);
  const toggleExpanded = useCallback(() => {
    if (!workspacePath) return;
    setFileGutterCollapsed({ type, collapsed: isExpanded, workspacePath });
  }, [isExpanded, setFileGutterCollapsed, type, workspacePath]);
  const [gitStatus, setGitStatus] = useState<Record<string, FileGitStatus>>({});
  const [groupByDirectory] = useAtom(diffTreeGroupByDirectoryAtom);
  const setDiffTreeGroupByDirectory = useSetAtom(setDiffTreeGroupByDirectoryAtom);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Wrapper to pass workspacePath to the setter atom
  const setGroupByDirectory = useCallback((value: boolean) => {
    if (workspacePath) {
      setDiffTreeGroupByDirectory({ groupByDirectory: value, workspacePath });
    }
  }, [workspacePath, setDiffTreeGroupByDirectory]);

  // Note: groupByDirectory is hydrated from workspace state once at app init (in App.tsx)
  // No need to load it here - just use the Jotai atom value

  // Convert absolute path to relative path from workspace root
  const getRelativePath = (filePath: string): string => {
    return getWorkspaceRelativeFilePath(filePath, workspacePath);
  };

  // Group files by path and aggregate stats
  const groupedFiles = useMemo(() => {
    // In Files mode, pending-review can update before session_files linkage.
    // Merge pending file paths so the Edited list stays in sync with the
    // pending-review banner without requiring a manual refresh.
    let sourceFiles = files;
    if (type === 'edited' && pendingReviewFiles && pendingReviewFiles.size > 0) {
      const existingPaths = new Set(files.map(file => file.filePath));
      const pendingOnly: FileData[] = [];
      for (const filePath of pendingReviewFiles) {
        if (!existingPaths.has(filePath)) {
          pendingOnly.push({ filePath });
          existingPaths.add(filePath);
        }
      }
      if (pendingOnly.length > 0) {
        sourceFiles = [...files, ...pendingOnly];
      }
    }

    const groups = new Map<string, FileData>();
    sourceFiles.forEach(file => {
      const existing = groups.get(file.filePath);
      if (existing) {
        // Aggregate stats
        groups.set(file.filePath, {
          filePath: file.filePath,
          operation: file.operation || existing.operation,
          linesAdded: (existing.linesAdded || 0) + (file.linesAdded || 0),
          linesRemoved: (existing.linesRemoved || 0) + (file.linesRemoved || 0)
        });
      } else {
        groups.set(file.filePath, { ...file });
      }
    });
    return Array.from(groups.values());
  }, [files, pendingReviewFiles, type]);

  // Build directory tree from file list
  const buildDirectoryTree = (fileList: FileData[]): DirectoryNode => (
    buildFileDirectoryTree(fileList, file => file.filePath, workspacePath)
  );

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

  const expandAll = () => {
    if (groupedFiles.length > 0) {
      const tree = buildDirectoryTree(groupedFiles);
      const allPaths = getFileDirectoryPaths(tree);
      setExpandedFolders(new Set(allPaths));
    }
  };

  const collapseAll = () => {
    setExpandedFolders(new Set());
  };

  const fetchFiles = useCallback(async () => {
    if (!sessionId) {
      setFiles([]);
      return;
    }
    try {
      if (typeof window !== 'undefined' && (window as any).electronAPI) {
        const result = await (window as any).electronAPI.invoke(
          'session-files:get-by-session',
          sessionId,
          type
        );
        if (result.success && result.files) {
          const fileData: FileData[] = result.files.map((f: any) => ({
            filePath: f.filePath,
            operation: f.metadata?.operation,
            linesAdded: f.metadata?.linesAdded,
            linesRemoved: f.metadata?.linesRemoved
          }));
          setFiles(fileData);
        }
      }
    } catch (error) {
      console.error('[FileGutter] Failed to fetch file links:', error);
    }
  }, [sessionId, type]);

  // Auto-expand all folders when groupByDirectory is enabled or files change
  useEffect(() => {
    if (groupByDirectory && groupedFiles.length > 0) {
      const tree = buildDirectoryTree(groupedFiles);
      const allPaths = getFileDirectoryPaths(tree);
      setExpandedFolders(new Set(allPaths));
    }
  }, [groupByDirectory, groupedFiles]);

  // Watch centrally-maintained atoms (updated by fileStateListeners.ts) and
  // refetch when they change. Avoids component-level IPC subscriptions.
  const sessionFileEdits = useAtomValue(sessionFileEditsAtom(sessionId ?? ''));
  const centralPendingReviewFiles = useAtomValue(sessionPendingReviewFilesAtom(sessionId ?? ''));
  useEffect(() => {
    fetchFiles();
  }, [fetchFiles, sessionFileEdits, centralPendingReviewFiles]);

  // Fetch git status for edited files
  useEffect(() => {
    if (!workspacePath || type !== 'edited' || groupedFiles.length === 0) {
      setGitStatus({});
      return;
    }

    const fetchGitStatus = async () => {
      try {
        const filePaths = groupedFiles.map(f => getRelativePath(f.filePath));

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
        console.error('[FileGutter] Failed to fetch git status:', error);
      }
    };

    fetchGitStatus();

    // Refresh on window focus
    const handleFocus = () => {
      fetchGitStatus();
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [groupedFiles, workspacePath, type]);

  if (groupedFiles.length === 0) {
    return null;
  }

  const handleFileClick = (filePath: string) => {
    if (onFileClick) {
      onFileClick(filePath);
    } else if (window.electronAPI && workspacePath) {
      window.electronAPI.invoke('workspace:open-file', { workspacePath, filePath });
    }
  };

  const getOperationIcon = (operation?: string) => {
    switch (operation) {
      case 'create':
        return <MaterialSymbol icon="add" size={14} className="file-gutter__icon file-gutter__icon--create w-3.5 h-3.5 text-[var(--nim-success)]" />;
      case 'edit':
        return <MaterialSymbol icon="edit" size={14} className="file-gutter__icon file-gutter__icon--edit w-3.5 h-3.5 text-[var(--nim-primary)]" />;
      case 'delete':
        return <MaterialSymbol icon="delete" size={14} className="file-gutter__icon file-gutter__icon--delete w-3.5 h-3.5 text-[var(--nim-error)]" />;
      case 'rename':
        return <MaterialSymbol icon="drive_file_rename_outline" size={14} className="file-gutter__icon file-gutter__icon--rename w-3.5 h-3.5 text-[var(--nim-warning)]" />;
      default:
        return null;
    }
  };

  const renderGitStatus = (filePath: string) => {
    if (type !== 'edited') return null;

    const relativePath = getRelativePath(filePath);
    const status = gitStatus[relativePath];
    if (!status || status.status === 'unchanged') {
      return null;
    }

    const statusChar = {
      modified: 'M',
      staged: 'S',
      untracked: '?',
      deleted: 'D',
      unchanged: ''
    }[status.status];

    const statusClasses: Record<string, string> = {
      modified: 'bg-[var(--nim-warning)]',
      staged: 'bg-[var(--nim-success)]',
      untracked: 'bg-[var(--nim-text-faint)] text-[var(--nim-bg)]',
      deleted: 'bg-[var(--nim-error)]'
    };

    return (
      <span
        className={`file-gutter__git-status file-gutter__git-status--${status.status} inline-flex items-center justify-center w-3.5 h-3.5 text-[0.65rem] font-semibold rounded-sm shrink-0 text-white ${statusClasses[status.status] || ''}`}
        title={`Git status: ${status.status}`}
      >
        {statusChar}
      </span>
    );
  };

  const getSectionIcon = () => {
    if (type === 'referenced') {
      return <MaterialSymbol icon="tag" size={14} className="file-gutter__section-icon w-4 h-4" />;
    }
    return <MaterialSymbol icon="edit_document" size={14} className="file-gutter__section-icon w-4 h-4" />;
  };

  const renderDirectoryNode = (node: DirectoryNode): React.ReactNode => {
    const isExpanded = expandedFolders.has(node.path);
    const hasContent = node.files.length > 0 || node.subdirectories.size > 0;

    return (
      <div key={node.path} className="file-gutter__directory-node mb-0.5">
        {node.displayPath && (
          <button
            onClick={() => toggleFolder(node.path)}
            className="file-gutter__directory-header w-full flex items-center gap-1 px-2 py-0.5 text-[0.8125rem] font-medium text-[var(--nim-text-muted)] bg-transparent border border-transparent rounded cursor-pointer transition-all duration-200 text-left hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
          >
            <MaterialSymbol
              icon={isExpanded ? "expand_more" : "chevron_right"}
              size={16}
              className="file-gutter__directory-chevron shrink-0 transition-transform duration-200 text-[var(--nim-text-faint)]"
            />
            <MaterialSymbol
              icon={isExpanded ? "folder_open" : "folder"}
              size={16}
              className="file-gutter__directory-icon shrink-0 text-[var(--nim-text-muted)]"
            />
            <span className="file-gutter__directory-path flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{node.displayPath}</span>
            <span className="file-gutter__directory-count shrink-0 py-0.5 px-1 bg-[var(--nim-bg-tertiary)] rounded text-[9px] text-[var(--nim-text-faint)]">{node.fileCount}</span>
          </button>
        )}

        {(isExpanded || !node.displayPath) && hasContent && (
          <div className={node.displayPath ? "file-gutter__directory-children mt-0.5 pl-4" : "file-gutter__directory-children mt-0.5"}>
            {Array.from(node.subdirectories.values()).map(subdir =>
              renderDirectoryNode(subdir)
            )}

            {node.files.map((file) => {
              const fileName = getFileName(file.filePath);
              const hasStats = type === 'edited' && (file.linesAdded || file.linesRemoved);
              const hasPendingReview = type === 'edited' && pendingReviewFiles?.has(file.filePath);

              return (
                <button
                  key={file.filePath}
                  onClick={() => handleFileClick(file.filePath)}
                  className={`file-gutter__file w-full text-left px-2 py-0.5 rounded border border-transparent transition-all duration-200 bg-transparent hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-border)] ${hasPendingReview ? 'file-gutter__file--pending bg-[rgba(251,191,36,0.08)] border-[rgba(251,191,36,0.2)] hover:bg-[rgba(251,191,36,0.15)] hover:border-[rgba(251,191,36,0.3)]' : ''}`}
                  title={getRelativePath(file.filePath)}
                >
                  <div className="file-gutter__file-content flex items-center gap-1.5">
                    {hasPendingReview && (
                      <MaterialSymbol
                        icon="rate_review"
                        size={14}
                        className="file-gutter__pending-icon text-[var(--nim-warning)] shrink-0"
                        title="Pending review"
                      />
                    )}
                    {file.operation && (
                      <div className="file-gutter__file-operation-icon shrink-0">
                        {getOperationIcon(file.operation)}
                      </div>
                    )}
                    {renderGitStatus(file.filePath)}
                    <div className="file-gutter__file-info flex-1 min-w-0">
                      <div className="file-gutter__file-name text-[0.8125rem] text-[var(--nim-text)] font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                        {fileName}
                      </div>
                    </div>
                    {hasStats && (
                      <div className="file-gutter__file-stats flex items-center gap-1 text-[0.6875rem] shrink-0">
                        {file.linesAdded ? (
                          <span className="file-gutter__file-stats-added text-[var(--nim-success)]">+{file.linesAdded}</span>
                        ) : null}
                        {file.linesRemoved ? (
                          <span className="file-gutter__file-stats-removed text-[var(--nim-error)]">-{file.linesRemoved}</span>
                        ) : null}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const label = type === 'referenced' ? 'Referenced' : 'Edited';

  return (
    <div className={`file-gutter flex flex-col bg-[var(--nim-bg-secondary)] max-h-[50%] shrink-0 ${type === 'referenced' ? 'file-gutter--referenced border-b border-[var(--nim-border)]' : 'file-gutter--edited border-t border-[var(--nim-border)]'}`}>
      <div className="file-gutter__header-container flex items-center justify-between gap-2 py-1 px-2">
        <button
          onClick={toggleExpanded}
          className="file-gutter__header w-full flex items-center justify-between py-1 px-2 text-base font-semibold text-[var(--nim-text-muted)] bg-transparent border-none rounded cursor-pointer transition-all duration-200 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
        >
          <div className="file-gutter__header-content flex items-center gap-1.5">
            {getSectionIcon()}
            <span>{label}</span>
            <span className="file-gutter__count py-0.5 px-1 bg-[var(--nim-bg-tertiary)] rounded text-[9px]">{groupedFiles.length}</span>
          </div>
          <MaterialSymbol
            icon="expand_more"
            size={16}
            className={`file-gutter__chevron w-3 h-3 transition-transform duration-200 ${isExpanded ? '' : 'file-gutter__chevron--collapsed -rotate-90'}`}
          />
        </button>

        {groupedFiles.length > 0 && (
          <div className="file-gutter__controls flex items-center gap-1 shrink-0">
            <button
              onClick={() => setGroupByDirectory(!groupByDirectory)}
              className={`file-gutter__control-button flex items-center justify-center w-6 h-6 p-0 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text-muted)] cursor-pointer transition-all duration-200 hover:not-disabled:bg-[var(--nim-bg-hover)] hover:not-disabled:text-[var(--nim-text)] hover:not-disabled:border-[var(--nim-border-secondary)] disabled:opacity-40 disabled:cursor-not-allowed ${groupByDirectory ? 'file-gutter__control-button--active bg-[var(--nim-primary)] text-white border-[var(--nim-primary)] hover:bg-[var(--nim-primary)] hover:border-[var(--nim-primary)]' : ''}`}
              title="Group by directory"
            >
              <MaterialSymbol icon="folder" size={16} />
            </button>
            <button
              onClick={expandAll}
              disabled={!groupByDirectory}
              className="file-gutter__control-button flex items-center justify-center w-6 h-6 p-0 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text-muted)] cursor-pointer transition-all duration-200 hover:enabled:bg-[var(--nim-bg-hover)] hover:enabled:text-[var(--nim-text)] hover:enabled:border-[var(--nim-border-secondary)] disabled:opacity-40 disabled:cursor-not-allowed"
              title="Expand all"
            >
              <MaterialSymbol icon="unfold_more" size={16} />
            </button>
            <button
              onClick={collapseAll}
              disabled={!groupByDirectory}
              className="file-gutter__control-button flex items-center justify-center w-6 h-6 p-0 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text-muted)] cursor-pointer transition-all duration-200 hover:enabled:bg-[var(--nim-bg-hover)] hover:enabled:text-[var(--nim-text)] hover:enabled:border-[var(--nim-border-secondary)] disabled:opacity-40 disabled:cursor-not-allowed"
              title="Collapse all"
            >
              <MaterialSymbol icon="unfold_less" size={16} />
            </button>
          </div>
        )}
      </div>

      {isExpanded && (
        <div className="file-gutter__files p-1 overflow-y-auto flex-1 min-h-0">
          {groupByDirectory ? (
            renderDirectoryNode(buildDirectoryTree(groupedFiles))
          ) : (
            groupedFiles.map((file) => {
              const fileName = getFileName(file.filePath);
              const hasStats = type === 'edited' && (file.linesAdded || file.linesRemoved);
              const hasPendingReview = type === 'edited' && pendingReviewFiles?.has(file.filePath);

              return (
                <button
                  key={file.filePath}
                  onClick={() => handleFileClick(file.filePath)}
                  className={`file-gutter__file w-full text-left px-2 py-0.5 rounded border border-transparent transition-all duration-200 bg-transparent hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-border)] ${hasPendingReview ? 'file-gutter__file--pending bg-[rgba(251,191,36,0.08)] border-[rgba(251,191,36,0.2)] hover:bg-[rgba(251,191,36,0.15)] hover:border-[rgba(251,191,36,0.3)]' : ''}`}
                  title={getRelativePath(file.filePath)}
                >
                  <div className="file-gutter__file-content flex items-center gap-1.5">
                    {hasPendingReview && (
                      <MaterialSymbol
                        icon="rate_review"
                        size={14}
                        className="file-gutter__pending-icon text-[var(--nim-warning)] shrink-0"
                        title="Pending review"
                      />
                    )}
                    {file.operation && (
                      <div className="file-gutter__file-operation-icon shrink-0">
                        {getOperationIcon(file.operation)}
                      </div>
                    )}
                    {renderGitStatus(file.filePath)}
                    <div className="file-gutter__file-info flex-1 min-w-0">
                      <div className="file-gutter__file-name text-[0.8125rem] text-[var(--nim-text)] font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                        {fileName}
                      </div>
                    </div>
                    {hasStats && (
                      <div className="file-gutter__file-stats flex items-center gap-1 text-[0.6875rem] shrink-0">
                        {file.linesAdded ? (
                          <span className="file-gutter__file-stats-added text-[var(--nim-success)]">+{file.linesAdded}</span>
                        ) : null}
                        {file.linesRemoved ? (
                          <span className="file-gutter__file-stats-removed text-[var(--nim-error)]">-{file.linesRemoved}</span>
                        ) : null}
                      </div>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
