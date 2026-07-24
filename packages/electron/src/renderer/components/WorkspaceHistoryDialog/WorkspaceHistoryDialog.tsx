import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useHistory } from '../../hooks/useHistory';
import { DiffPreviewEditor, type DiffNavigationState } from '../HistoryDialog/DiffPreviewEditor';
import { TextDiffViewer, type TextDiffNavigationState } from '../HistoryDialog/TextDiffViewer';
import { MonacoDiffViewer } from '../HistoryDialog/MonacoDiffViewer';
import { getFileType, type EditorType } from '../../utils/fileTypeDetector';
import { getFileName } from '../../utils/pathUtils';
import { WorkspaceHistoryFileTree } from './WorkspaceHistoryFileTree';

interface WorkspaceFile {
  path: string;
  latestTimestamp: number;
  snapshotCount: number;
  exists: boolean;
}

interface WorkspaceHistoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  workspacePath: string;
  onFileRestored?: () => void;
  theme?: string;
}

export function WorkspaceHistoryDialog({
  isOpen,
  onClose,
  workspacePath,
  onFileRestored,
  theme = 'light'
}: WorkspaceHistoryDialogProps) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedDeletedFiles, setSelectedDeletedFiles] = useState<Set<string>>(new Set());
  const [isRestoring, setIsRestoring] = useState(false);

  // History for selected file
  const { snapshots, loading: snapshotsLoading, refreshSnapshots, loadSnapshot, deleteSnapshot } = useHistory(selectedFilePath);

  // Snapshot selection state
  const [selectedSnapshotTimestamp, setSelectedSnapshotTimestamp] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>('');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [diffMode, setDiffMode] = useState(false);
  const [diffViewMode, setDiffViewMode] = useState<'rich' | 'text'>('rich');
  const [versionAContent, setVersionAContent] = useState<string>('');
  const [versionBContent, setVersionBContent] = useState<string>('');
  const [versionAMeta, setVersionAMeta] = useState<{ type: string; timestamp: string } | null>(null);
  const [versionBMeta, setVersionBMeta] = useState<{ type: string; timestamp: string } | null>(null);
  const [navigationState, setNavigationState] = useState<DiffNavigationState | TextDiffNavigationState | null>(null);

  const fileType: EditorType = useMemo(() => {
    return selectedFilePath ? getFileType(selectedFilePath) : 'markdown';
  }, [selectedFilePath]);

  // Load workspace files on open
  useEffect(() => {
    if (isOpen && workspacePath) {
      loadWorkspaceFiles();
    }
  }, [isOpen, workspacePath]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setFiles([]);
      setSelectedFilePath(null);
      setSelectedDeletedFiles(new Set());
      setSelectedSnapshotTimestamp(null);
      setPreviewContent('');
      setDiffMode(false);
    }
  }, [isOpen]);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Load snapshots when file is selected
  useEffect(() => {
    if (selectedFilePath) {
      refreshSnapshots();
      setSelectedSnapshotTimestamp(null);
      setPreviewContent('');
      setDiffMode(false);
    }
  }, [selectedFilePath, refreshSnapshots]);

  const loadWorkspaceFiles = async () => {
    setLoading(true);
    try {
      // Get all files with history
      const filesWithHistory = await window.electronAPI.invoke('history:list-workspace-files', workspacePath);

      if (filesWithHistory.length === 0) {
        setFiles([]);
        setLoading(false);
        return;
      }

      // Check which files exist
      const filePaths = filesWithHistory.map((f: any) => f.path);
      const existsMap = await window.electronAPI.invoke('history:check-files-exist', filePaths);

      // Combine data
      const filesWithExistence: WorkspaceFile[] = filesWithHistory.map((f: any) => ({
        path: f.path,
        latestTimestamp: f.latestTimestamp,
        snapshotCount: f.snapshotCount,
        exists: existsMap[f.path] ?? false
      }));

      setFiles(filesWithExistence);
    } catch (error) {
      console.error('[WorkspaceHistoryDialog] Failed to load workspace files:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = (filePath: string) => {
    setSelectedFilePath(filePath);
  };

  const handleDeletedFileToggle = (filePath: string, checked: boolean) => {
    setSelectedDeletedFiles(prev => {
      const next = new Set(prev);
      if (checked) {
        next.add(filePath);
      } else {
        next.delete(filePath);
      }
      return next;
    });
  };

  const handleSnapshotSelect = async (timestamp: string, index: number) => {
    setSelectedSnapshotTimestamp(timestamp);

    const previousSnapshot = snapshots[index + 1];

    if (previousSnapshot) {
      await loadDiffMode(previousSnapshot.timestamp, timestamp);
    } else {
      // No previous version - just show the content
      setDiffMode(false);
      setLoadingPreview(true);
      try {
        const content = await loadSnapshot(timestamp);
        if (content) {
          setPreviewContent(content);
        }
      } catch (error) {
        console.error('Failed to load snapshot:', error);
        setPreviewContent('Failed to load snapshot');
      } finally {
        setLoadingPreview(false);
      }
    }
  };

  const loadDiffMode = async (olderTimestamp: string, newerTimestamp: string) => {
    setLoadingPreview(true);
    try {
      const indexOlder = snapshots.findIndex(s => s.timestamp === olderTimestamp);
      const indexNewer = snapshots.findIndex(s => s.timestamp === newerTimestamp);

      let actualOlderTimestamp = olderTimestamp;
      let actualNewerTimestamp = newerTimestamp;

      if (indexOlder < indexNewer) {
        actualOlderTimestamp = newerTimestamp;
        actualNewerTimestamp = olderTimestamp;
      }

      const snapshotA = snapshots.find(s => s.timestamp === actualOlderTimestamp);
      const snapshotB = snapshots.find(s => s.timestamp === actualNewerTimestamp);

      const [contentA, contentB] = await Promise.all([
        loadSnapshot(actualOlderTimestamp),
        loadSnapshot(actualNewerTimestamp),
      ]);

      if (contentA && contentB && snapshotA && snapshotB) {
        setVersionAContent(contentA);
        setVersionBContent(contentB);
        setVersionAMeta({ type: snapshotA.type, timestamp: snapshotA.timestamp });
        setVersionBMeta({ type: snapshotB.type, timestamp: snapshotB.timestamp });
        setPreviewContent(contentB);
        setDiffMode(true);
        setLoadingPreview(false);
      }
    } catch (error) {
      console.error('Failed to load snapshots for diff:', error);
      setLoadingPreview(false);
    }
  };

  const handleRestoreVersion = async () => {
    if (!selectedFilePath || !selectedSnapshotTimestamp) return;

    const selectedFile = files.find(f => f.path === selectedFilePath);
    const isDeleted = selectedFile && !selectedFile.exists;

    if (isDeleted) {
      const confirmed = window.confirm(
        'This file has been deleted. Restoring will recreate the file on disk. Continue?'
      );
      if (!confirmed) return;
    }

    setIsRestoring(true);
    try {
      const result = await window.electronAPI.invoke(
        'history:restore-deleted-file',
        selectedFilePath,
        selectedSnapshotTimestamp
      );

      if (result.success) {
        // Refresh file list to update exists status
        await loadWorkspaceFiles();
        onFileRestored?.();
      } else {
        alert(`Failed to restore file: ${result.error}`);
      }
    } catch (error: any) {
      console.error('Failed to restore file:', error);
      alert(`Failed to restore file: ${error.message}`);
    } finally {
      setIsRestoring(false);
    }
  };

  const handleBatchRestore = async () => {
    if (selectedDeletedFiles.size === 0) return;

    const count = selectedDeletedFiles.size;
    const confirmed = window.confirm(
      `Restore ${count} deleted file${count > 1 ? 's' : ''} to their most recent versions?`
    );
    if (!confirmed) return;

    setIsRestoring(true);
    try {
      const filePaths = Array.from(selectedDeletedFiles);
      const results = await window.electronAPI.invoke('history:batch-restore-deleted-files', filePaths);

      const successful = results.filter((r: any) => r.success).length;
      const failed = results.filter((r: any) => !r.success);

      if (failed.length > 0) {
        const failedNames = failed.map((r: any) => getFileName(r.path)).join(', ');
        alert(`Restored ${successful} file${successful !== 1 ? 's' : ''}. Failed: ${failedNames}`);
      }

      // Clear selection and refresh
      setSelectedDeletedFiles(new Set());
      await loadWorkspaceFiles();
      onFileRestored?.();
    } catch (error: any) {
      console.error('Failed to batch restore:', error);
      alert(`Failed to restore files: ${error.message}`);
    } finally {
      setIsRestoring(false);
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    }

    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    }

    if (diff < 604800000) {
      const days = Math.floor(diff / 86400000);
      return `${days} day${days !== 1 ? 's' : ''} ago`;
    }

    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const formatVersionLabel = (type: string, timestamp: string) => {
    const typeLabel = type === 'ai-diff' ? 'AI Edit'
      : type === 'pre-apply' ? 'Pre-edit'
      : type === 'pre-edit' ? 'AI Session Start'
      : type === 'incremental-approval' ? 'Partial Review'
      : type === 'manual' ? 'Manual Save'
      : type === 'auto-save' ? 'Auto-save'
      : type === 'external-change' ? 'External Change'
      : type;

    const timeLabel = formatTimestamp(timestamp);
    return `${typeLabel} ${timeLabel}`;
  };

  const getSnapshotIcon = (type: string) => {
    switch (type) {
      case 'auto-save':
        return 'save';
      case 'manual':
        return 'push_pin';
      case 'ai-diff':
        return 'smart_toy';
      case 'pre-apply':
        return 'bolt';
      case 'pre-edit':
        return 'flag';
      case 'incremental-approval':
        return 'task_alt';
      case 'external-change':
        return 'sync_alt';
      case 'auto':
        return 'schedule';
      default:
        return 'description';
    }
  };

  const handleNavigationStateChange = useCallback((state: DiffNavigationState | TextDiffNavigationState) => {
    setNavigationState(state);
  }, []);

  const deletedFilesCount = files.filter(f => !f.exists).length;
  const selectedFile = files.find(f => f.path === selectedFilePath);
  const isSelectedFileDeleted = selectedFile && !selectedFile.exists;

  if (!isOpen) return null;

  const getSnapshotIconBgClass = (type: string) => {
    switch (type) {
      case 'auto-save':
      case 'auto':
        return 'bg-blue-500/10 text-blue-500';
      case 'manual':
        return 'bg-emerald-500/10 text-emerald-500';
      case 'ai-diff':
      case 'pre-apply':
      case 'pre-edit':
        return 'bg-purple-500/10 text-purple-500';
      case 'external-change':
        return 'bg-orange-500/10 text-orange-500';
      case 'incremental-approval':
        return 'bg-teal-500/10 text-teal-500';
      default:
        return 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]';
    }
  };

  return (
    <div className="workspace-history-dialog-overlay nim-overlay" onClick={onClose}>
      <div
        className="workspace-history-dialog nim-modal w-[90%] max-w-[1200px] h-[80%] max-h-[800px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="workspace-history-dialog-header flex items-center justify-between px-4 py-3 border-b border-[var(--nim-border)]">
          <div className="workspace-history-dialog-title flex items-center gap-2">
            <span className="material-symbols-outlined text-xl text-[var(--nim-text-muted)]">history</span>
            <h2 className="m-0 text-base font-semibold text-[var(--nim-text)]">Folder History</h2>
          </div>
          <button className="workspace-history-dialog-close nim-btn-icon" onClick={onClose}>
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        <div className="workspace-history-dialog-content flex-1 flex overflow-hidden">
          {/* Left Panel - File Tree */}
          <div className="workspace-history-file-panel w-[350px] border-r border-[var(--nim-border)] flex flex-col bg-[var(--nim-bg-secondary)]">
            <div className="workspace-history-file-panel-header px-3 py-2 border-b border-[var(--nim-border)] text-xs font-semibold text-[var(--nim-text-muted)] uppercase tracking-wide flex items-center justify-between">
              <span>Files with History ({files.length} files{deletedFilesCount > 0 ? `, ${deletedFilesCount} deleted` : ''})</span>
              {loading && <span className="workspace-history-loading text-[11px] font-normal text-[var(--nim-text-faint)]">Loading...</span>}
            </div>
            <WorkspaceHistoryFileTree
              files={files}
              workspacePath={workspacePath}
              selectedFilePath={selectedFilePath}
              selectedDeletedFiles={selectedDeletedFiles}
              onFileSelect={handleFileSelect}
              onDeletedFileToggle={handleDeletedFileToggle}
            />
          </div>

          {/* Right Panel - History View */}
          <div className="workspace-history-preview-panel flex-1 flex flex-col min-w-0 overflow-hidden">
            <div className="workspace-history-preview-header px-4 py-2 border-b border-[var(--nim-border)] flex items-center justify-between bg-[var(--nim-bg-secondary)] gap-3 min-h-[44px]">
              <div className="workspace-history-preview-header-left flex items-center gap-2 min-w-0 flex-1">
                {selectedFilePath ? (
                  <>
                    <span className="material-symbols-outlined text-lg text-[var(--nim-text-muted)] shrink-0">description</span>
                    <span className="workspace-history-selected-file text-[13px] font-medium text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis">
                      {selectedFilePath.replace(workspacePath + '/', '')}
                    </span>
                    <span className="workspace-history-snapshot-count text-xs text-[var(--nim-text-faint)] shrink-0">
                      ({snapshots.length} snapshot{snapshots.length !== 1 ? 's' : ''})
                    </span>
                  </>
                ) : (
                  <span className="workspace-history-no-selection text-[13px] text-[var(--nim-text-muted)]">Select a file to view history</span>
                )}
              </div>
              <div className="workspace-history-header-buttons flex items-center gap-2 shrink-0">
                {selectedDeletedFiles.size > 0 && (
                  <button
                    className="workspace-history-restore-selected-button px-3.5 py-1.5 bg-emerald-500 text-white border-none rounded-md text-xs font-medium cursor-pointer transition-all duration-200 flex items-center gap-1 whitespace-nowrap hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={handleBatchRestore}
                    disabled={isRestoring}
                  >
                    <span className="material-symbols-outlined text-base">restore</span>
                    Restore Selected ({selectedDeletedFiles.size})
                  </button>
                )}
                {selectedFilePath && selectedSnapshotTimestamp && (
                  <button
                    className="workspace-history-restore-button nim-btn-primary px-3.5 py-1.5 text-xs font-medium rounded-md flex items-center gap-1 whitespace-nowrap"
                    onClick={handleRestoreVersion}
                    disabled={isRestoring || !previewContent}
                  >
                    <span className="material-symbols-outlined text-base">restore</span>
                    {isSelectedFileDeleted ? 'Restore File' : 'Restore This Version'}
                  </button>
                )}
              </div>
            </div>

            {selectedFilePath ? (
              <div className="workspace-history-preview-content-wrapper flex-1 flex flex-col overflow-hidden">
                {/* Snapshot List */}
                <div className="workspace-history-snapshot-list border-b border-[var(--nim-border)] max-h-[200px] overflow-y-auto nim-scrollbar">
                  {snapshotsLoading ? (
                    <div className="workspace-history-snapshots-loading p-5 text-center text-[var(--nim-text-muted)] text-[13px]">Loading snapshots...</div>
                  ) : snapshots.length === 0 ? (
                    <div className="workspace-history-no-snapshots p-5 text-center text-[var(--nim-text-muted)] text-[13px]">No snapshots available</div>
                  ) : (
                    snapshots.map((snapshot, index) => (
                      <div
                        key={`${snapshot.timestamp}-${index}`}
                        className={`workspace-history-snapshot-item flex items-center gap-2.5 px-4 py-2 cursor-pointer border-b border-[var(--nim-border)] last:border-b-0 transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] ${selectedSnapshotTimestamp === snapshot.timestamp ? 'selected bg-[var(--nim-bg-tertiary)] border-l-[3px] border-l-[var(--nim-primary)] pl-[13px]' : ''}`}
                        onClick={() => handleSnapshotSelect(snapshot.timestamp, index)}
                      >
                        <div className={`workspace-history-snapshot-icon w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${getSnapshotIconBgClass(snapshot.type)}`}>
                          <span className="material-symbols-outlined text-base">{getSnapshotIcon(snapshot.type)}</span>
                        </div>
                        <div className="workspace-history-snapshot-info flex-1 min-w-0">
                          <span className="workspace-history-snapshot-type block text-xs font-medium text-[var(--nim-text)] capitalize">{snapshot.type.replace('-', ' ')}</span>
                          <span className="workspace-history-snapshot-time block text-[11px] text-[var(--nim-text-faint)]">{formatTimestamp(snapshot.timestamp)}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* Preview Area */}
                <div className="workspace-history-preview-area flex-1 overflow-auto bg-[var(--nim-bg)] flex flex-col nim-scrollbar">
                  {diffMode && versionAMeta && versionBMeta && (
                    <div className="workspace-history-diff-header px-4 py-2 flex items-center gap-2 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] flex-wrap">
                      <span className="workspace-history-diff-label old px-2 py-0.5 rounded bg-[var(--nim-bg-tertiary)] text-[11px] font-medium text-[var(--nim-error)]">
                        {formatVersionLabel(versionAMeta.type, versionAMeta.timestamp)}
                      </span>
                      <span className="workspace-history-diff-separator text-[11px] font-semibold text-[var(--nim-text-faint)]">vs</span>
                      <span className="workspace-history-diff-label new px-2 py-0.5 rounded bg-[var(--nim-bg-tertiary)] text-[11px] font-medium text-[var(--nim-success)]">
                        {formatVersionLabel(versionBMeta.type, versionBMeta.timestamp)}
                      </span>
                      {fileType === 'markdown' && (
                        <div className="workspace-history-diff-mode-toggle flex bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md p-0.5 gap-0.5 ml-auto">
                          <button
                            className={`workspace-history-diff-mode-button px-3 py-1 text-[11px] font-medium border-none rounded cursor-pointer transition-all duration-200 ${diffViewMode === 'rich' ? 'active text-white bg-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'}`}
                            onClick={() => setDiffViewMode('rich')}
                          >
                            Rich
                          </button>
                          <button
                            className={`workspace-history-diff-mode-button px-3 py-1 text-[11px] font-medium border-none rounded cursor-pointer transition-all duration-200 ${diffViewMode === 'text' ? 'active text-white bg-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'}`}
                            onClick={() => setDiffViewMode('text')}
                          >
                            Text
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {loadingPreview ? (
                    <div className="workspace-history-preview-loading flex flex-col items-center justify-center p-10 gap-3 text-[var(--nim-text-muted)] text-[13px]">
                      <div className="workspace-history-preview-loading-spinner w-6 h-6 border-2 border-[var(--nim-border)] border-t-[var(--nim-primary)] rounded-full animate-spin" />
                      Loading preview...
                    </div>
                  ) : diffMode ? (
                    <div className="workspace-history-diff-content flex-1 overflow-auto nim-scrollbar">
                      {fileType === 'markdown' ? (
                        diffViewMode === 'rich' ? (
                          <DiffPreviewEditor
                            key={`${versionAMeta?.timestamp}-${versionBMeta?.timestamp}`}
                            oldMarkdown={versionAContent}
                            newMarkdown={versionBContent}
                            onNavigationStateChange={handleNavigationStateChange}
                            onNavigatePrevious={() => {}}
                            onNavigateNext={() => {}}
                            theme={theme}
                          />
                        ) : (
                          <TextDiffViewer
                            key={`${versionAMeta?.timestamp}-${versionBMeta?.timestamp}`}
                            oldText={versionAContent}
                            newText={versionBContent}
                            onNavigationStateChange={handleNavigationStateChange}
                            onNavigatePrevious={() => {}}
                            onNavigateNext={() => {}}
                          />
                        )
                      ) : (
                        <MonacoDiffViewer
                          key={`${versionAMeta?.timestamp}-${versionBMeta?.timestamp}`}
                          oldContent={versionAContent}
                          newContent={versionBContent}
                          filePath={selectedFilePath || ''}
                          theme={theme}
                        />
                      )}
                    </div>
                  ) : selectedSnapshotTimestamp ? (
                    <pre className="workspace-history-preview-text m-0 p-4 font-mono text-[13px] leading-relaxed text-[var(--nim-text)] whitespace-pre-wrap break-words">{previewContent}</pre>
                  ) : (
                    <div className="workspace-history-preview-empty flex items-center justify-center flex-1 text-[var(--nim-text-muted)] text-[13px]">
                      Select a snapshot to preview
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="workspace-history-no-file-selected flex flex-col items-center justify-center flex-1 gap-3 text-[var(--nim-text-faint)]">
                <span className="material-symbols-outlined text-5xl opacity-30">folder_open</span>
                <p className="m-0 text-sm">Select a file from the tree to view its history</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
