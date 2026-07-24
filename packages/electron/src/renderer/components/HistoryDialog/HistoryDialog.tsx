import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { usePostHog } from 'posthog-js/react';
import { ProviderIcon, MarkdownEditor, MonacoEditor } from '@nimbalyst/runtime';
import { useHistory } from '../../hooks/useHistory';
import { DiffPreviewEditor, type DiffNavigationState } from './DiffPreviewEditor';
import { TextDiffViewer, type TextDiffNavigationState } from './TextDiffViewer';
import { MonacoDiffViewer } from './MonacoDiffViewer';
import { ImageDiffViewer } from './ImageDiffViewer';
import { createReadOnlyEditorHost } from './createReadOnlyEditorHost';
import { getFileType, type EditorType } from '../../utils/fileTypeDetector';
import { getFileName } from '../../utils/pathUtils';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import { nimAssetUrl } from '../../utils/assetUrl';

interface HistoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  filePath: string | null;
  onRestore?: (content: string) => void;
  theme?: string;
  workspacePath?: string;
  onOpenSessionInChat?: (sessionId: string) => void;
}

type VersionSelection = {
  snapshotId: string; // Composite ID: timestamp-hash-index
  timestamp: string; // Stored separately for loadSnapshot calls
  label: 'A' | 'B';
};

// Helper function to generate unique snapshot ID
const getSnapshotId = (snapshot: { timestamp: string; baseMarkdownHash: string }, index: number) => {
  return `${snapshot.timestamp}-${snapshot.baseMarkdownHash}-${index}`;
};

export function HistoryDialog({ isOpen, onClose, filePath, onRestore, theme = 'light', workspacePath, onOpenSessionInChat }: HistoryDialogProps) {
  const posthog = usePostHog();
  const { snapshots, loading, refreshSnapshots, loadSnapshot, deleteSnapshot } = useHistory(filePath);
  const [selectedVersions, setSelectedVersions] = useState<VersionSelection[]>([]);
  const [previewContent, setPreviewContent] = useState<string>('');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [diffMode, setDiffMode] = useState(false);
  const [richView, setRichView] = useState(true);
  const [viewMode, setViewMode] = useState<'changes' | 'version'>('changes');
  const [compactView, setCompactView] = useState(true);
  const [versionAContent, setVersionAContent] = useState<string>('');
  const [versionBContent, setVersionBContent] = useState<string>('');
  const [versionAMeta, setVersionAMeta] = useState<{ type: string; timestamp: string } | null>(null);
  const [versionBMeta, setVersionBMeta] = useState<{ type: string; timestamp: string } | null>(null);
  const [navigationState, setNavigationState] = useState<DiffNavigationState | TextDiffNavigationState | null>(null);
  const [sessionInfo, setSessionInfo] = useState<Record<string, { title: string; provider: string }>>({});

  // Detect file type
  const fileType: EditorType = useMemo(() => {
    return filePath ? getFileType(filePath) : 'markdown';
  }, [filePath]);

  const displayedSnapshots = useMemo(() => {
    if (!compactView || snapshots.length === 0) {
      return snapshots;
    }

    const importantTypes = ['manual', 'external-change', 'ai-diff', 'pre-apply', 'pre-edit'];
    const minorTypes = ['auto-save', 'auto', 'incremental-approval'];
    const timeGroupInterval = 5 * 60 * 1000; // 5 minutes in milliseconds

    const result = [];
    const grouped: { [key: number]: typeof snapshots } = {};

    // Group minor snapshots by time interval
    for (let i = 0; i < snapshots.length; i++) {
      const snapshot = snapshots[i];
      const isFirst = i === snapshots.length - 1; // oldest (last in array)
      const isLast = i === 0; // newest (first in array)
      const isImportant = importantTypes.includes(snapshot.type);

      if (isFirst || isLast || isImportant) {
        result.push(snapshot);
      } else if (minorTypes.includes(snapshot.type)) {
        const timestamp = new Date(snapshot.timestamp).getTime();
        const groupKey = Math.floor(timestamp / timeGroupInterval);

        if (!grouped[groupKey]) {
          grouped[groupKey] = [];
        }
        grouped[groupKey].push(snapshot);
      } else {
        // Unknown types, include them
        result.push(snapshot);
      }
    }

    // Add one representative from each time group (the newest one)
    Object.values(grouped).forEach((group) => {
      if (group.length > 0) {
        result.push(group[0]); // First item is newest in the group
      }
    });

    // Sort by timestamp (newest first)
    return result.sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }, [snapshots, compactView]);

  useEffect(() => {
    if (isOpen && filePath) {
      refreshSnapshots();
      // Track file history dialog opened
      posthog?.capture('file_history_opened', {
        fileType,
      });
    }
  }, [isOpen, filePath, refreshSnapshots, posthog, fileType]);

  // Fetch session info for AI edit snapshots
  useEffect(() => {
    if (!isOpen || !workspacePath || snapshots.length === 0) return;

    const fetchSessionInfo = async () => {
      // Collect unique session IDs from snapshots
      const sessionIds = new Set<string>();
      for (const snapshot of snapshots) {
        const sessionId = snapshot.metadata?.sessionId;
        if (sessionId) {
          sessionIds.add(sessionId);
        }
      }

      if (sessionIds.size === 0) return;

      try {
        // Fetch lightweight session list (just metadata, no messages)
        const sessions = await window.electronAPI?.ai?.getSessionList?.(workspacePath);
        if (sessions) {
          const info: Record<string, { title: string; provider: string }> = {};
          for (const session of sessions) {
            if (sessionIds.has(session.id)) {
              info[session.id] = {
                title: session.title || 'Untitled Session',
                provider: session.provider || 'claude'
              };
            }
          }
          if (Object.keys(info).length > 0) {
            setSessionInfo(info);
          }
        }
      } catch (error) {
        console.error('[HistoryDialog] Failed to fetch session info:', error);
      }
    };

    fetchSessionInfo();
  }, [isOpen, workspacePath, snapshots]);

  useEffect(() => {
    // Reset selection when dialog opens/closes
    if (!isOpen) {
      setSelectedVersions([]);
      setPreviewContent('');
      setDiffMode(false);
      setRichView(true);
      setViewMode('changes');
      setVersionAContent('');
      setVersionBContent('');
      setVersionAMeta(null);
      setVersionBMeta(null);
    }
  }, [isOpen]);

  useEffect(() => {
    // Handle Escape key to close dialog
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

  // Reload preview when view mode changes
  useEffect(() => {
    if (selectedVersions.length !== 1) return;

    const selection = selectedVersions[0];
    const idParts = selection.snapshotId.split('-');
    const selectedIndex = parseInt(idParts[idParts.length - 1]);
    const previousSnapshot = displayedSnapshots[selectedIndex + 1];

    const reloadPreview = async () => {
      if (viewMode === 'changes' && previousSnapshot) {
        await loadDiffMode(previousSnapshot.timestamp, selection.timestamp);
      } else {
        // Version mode or no previous - just show content
        setDiffMode(false);
        setLoadingPreview(true);
        try {
          const content = await loadSnapshot(selection.timestamp);
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

    reloadPreview();
  }, [viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSnapshotSelect = async (snapshotId: string, timestamp: string, clickedIndex: number, isCommandClick: boolean) => {
    // Check if this version is already selected
    const existingIndex = selectedVersions.findIndex(v => v.snapshotId === snapshotId);

    if (existingIndex >= 0) {
      // Deselect this version
      const newSelections = selectedVersions.filter(v => v.snapshotId !== snapshotId);
      setSelectedVersions(newSelections);
      setDiffMode(false);

      // If we still have one selection, load based on view mode
      if (newSelections.length === 1) {
        const remainingSelection = newSelections[0];
        // Parse the index from the snapshotId (last segment after final dash)
        const idParts = remainingSelection.snapshotId.split('-');
        const remainingIndex = parseInt(idParts[idParts.length - 1]);
        const previousSnapshot = displayedSnapshots[remainingIndex + 1];

        if (viewMode === 'changes' && previousSnapshot) {
          await loadDiffMode(previousSnapshot.timestamp, remainingSelection.timestamp);
        } else {
          // Version mode or no previous - just show content
          setLoadingPreview(true);
          try {
            const content = await loadSnapshot(remainingSelection.timestamp);
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
      } else {
        setPreviewContent('');
      }
      return;
    }

    // Command-click: add to selection for manual diff (only in changes mode)
    if (isCommandClick && viewMode === 'changes') {
      if (selectedVersions.length < 2) {
        const label: 'A' | 'B' = selectedVersions.length === 0 ? 'A' : 'B';
        const newSelections = [...selectedVersions, { snapshotId, timestamp, label }];
        setSelectedVersions(newSelections);

        if (newSelections.length === 2) {
          // Two selections - load both and enter diff mode
          await loadDiffMode(newSelections[0].timestamp, newSelections[1].timestamp);
        }
      }
      return;
    }

    // Regular click: reset to single selection
    setSelectedVersions([{ snapshotId, timestamp, label: 'A' }]);

    if (viewMode === 'changes') {
      // Changes mode: show diff with previous version
      const previousSnapshot = displayedSnapshots[clickedIndex + 1];
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
    } else {
      // Version mode: just show the content
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
      // Determine which is older (A should be older)
      const indexOlder = snapshots.findIndex(s => s.timestamp === olderTimestamp);
      const indexNewer = snapshots.findIndex(s => s.timestamp === newerTimestamp);

      let actualOlderTimestamp = olderTimestamp;
      let actualNewerTimestamp = newerTimestamp;

      // In the snapshots list, newer versions come first (index 0 is newest)
      // So higher index means older
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

      if (contentA != null && contentB != null && snapshotA && snapshotB) {
        setVersionAContent(contentA);
        setVersionBContent(contentB);
        setVersionAMeta({ type: snapshotA.type, timestamp: snapshotA.timestamp });
        setVersionBMeta({ type: snapshotB.type, timestamp: snapshotB.timestamp });
        // Set preview content to the newer version for restore functionality
        setPreviewContent(contentB);
        setDiffMode(true);
      } else {
        console.warn('[HistoryDialog] Diff load skipped: missing content or metadata', {
          hasContentA: contentA != null,
          hasContentB: contentB != null,
          hasSnapshotA: !!snapshotA,
          hasSnapshotB: !!snapshotB,
        });
      }
    } catch (error) {
      console.error('Failed to load snapshots for diff:', error);
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleRestore = () => {
    console.log('[HistoryDialog] handleRestore called', {
      hasPreviewContent: !!previewContent,
      hasOnRestore: !!onRestore,
      contentLength: previewContent?.length
    });
    if (previewContent && onRestore) {
      // Track file history restore
      posthog?.capture('file_history_restored', {
        fileType,
      });
      onRestore(previewContent);
      onClose();
    } else {
      console.error('[HistoryDialog] Cannot restore:', {
        previewContent: previewContent ? 'exists' : 'missing',
        onRestore: onRestore ? 'exists' : 'missing'
      });
    }
  };

  const handleDelete = async (snapshotId: string, timestamp: string) => {
    if (window.confirm('Are you sure you want to delete this snapshot?')) {
      await deleteSnapshot(timestamp);
      // Remove from selections if selected
      const newSelections = selectedVersions.filter(v => v.snapshotId !== snapshotId);
      if (newSelections.length !== selectedVersions.length) {
        setSelectedVersions(newSelections);
        setPreviewContent('');
        setDiffMode(false);
      }
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    // Less than 1 hour
    if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    }

    // Less than 24 hours
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    }

    // Less than 7 days
    if (diff < 604800000) {
      const days = Math.floor(diff / 86400000);
      return `${days} day${days !== 1 ? 's' : ''} ago`;
    }

    // Show full date
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

  // Navigation handlers
  const handleNavigatePrevious = useCallback(() => {
    if (richView) {
      (window as any).__richDiffNavigatePrevious?.();
    } else {
      (window as any).__textDiffNavigatePrevious?.();
    }
  }, [richView]);

  const handleNavigateNext = useCallback(() => {
    if (richView) {
      (window as any).__richDiffNavigateNext?.();
    } else {
      (window as any).__textDiffNavigateNext?.();
    }
  }, [richView]);

  const handleNavigationStateChange = useCallback((state: DiffNavigationState | TextDiffNavigationState) => {
    setNavigationState(state);
  }, []);

  if (!isOpen) return null;

  return (
    <div className="history-dialog-overlay fixed inset-0 flex items-center justify-center z-[10000] bg-black/50" onClick={onClose}>
      <div className="history-dialog flex flex-col overflow-hidden rounded-xl bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_20px_60px_rgba(0,0,0,0.3)] w-[90vw] max-w-[1200px] h-[80vh] max-h-[800px]" onClick={(e) => e.stopPropagation()}>
        <div className="history-dialog-header flex items-center justify-between py-3 px-4 border-b border-[var(--nim-border)]">
          <div className="history-dialog-title flex flex-col gap-0.5 min-w-0 flex-1">
            <h2 className="m-0 text-base font-semibold text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis">{filePath ? getFileName(filePath) : 'Document History'}</h2>
            {filePath && <span className="history-dialog-path text-[11px] text-[var(--nim-text-muted)] whitespace-nowrap overflow-hidden text-ellipsis">{filePath}</span>}
          </div>
          <div className="history-dialog-header-right flex items-center gap-3">
            {fileType === 'markdown' && (
              <div className="view-variant-toggle flex bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md p-0.5 gap-0.5">
                <button
                  className={`view-mode-button py-1 px-3 text-[11px] font-medium border-none rounded cursor-pointer transition-all duration-200 ${richView ? 'text-white bg-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'}`}
                  onClick={() => setRichView(true)}
                  title="Rendered view"
                >
                  Rich
                </button>
                <button
                  className={`view-mode-button py-1 px-3 text-[11px] font-medium border-none rounded cursor-pointer transition-all duration-200 ${!richView ? 'text-white bg-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'}`}
                  onClick={() => setRichView(false)}
                  title="Raw source"
                >
                  Raw
                </button>
              </div>
            )}
            <div className="view-mode-toggle flex bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md p-0.5 gap-0.5">
              <button
                className={`view-mode-button py-1 px-3 text-[11px] font-medium border-none rounded cursor-pointer transition-all duration-200 ${viewMode === 'changes' ? 'text-white bg-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'}`}
                onClick={() => setViewMode('changes')}
                title="Show diff with previous version"
              >
                Diff
              </button>
              <button
                className={`view-mode-button py-1 px-3 text-[11px] font-medium border-none rounded cursor-pointer transition-all duration-200 ${viewMode === 'version' ? 'text-white bg-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'}`}
                onClick={() => setViewMode('version')}
                title="View full content"
              >
                Full
              </button>
            </div>
            <button className="history-dialog-close nim-btn-icon" onClick={onClose}>
              <span className="material-symbols-outlined text-xl">close</span>
            </button>
          </div>
        </div>

        <div className="history-dialog-content flex-1 flex overflow-hidden">
          <div className="history-list w-[350px] border-r border-[var(--nim-border)] flex flex-col">
            <div className="history-list-header py-2 px-3 border-b border-[var(--nim-border)] flex items-center justify-between bg-[var(--nim-bg-secondary)]">
              <div className="history-list-header-left flex items-center gap-2">
                <h3 className="m-0 text-xs font-semibold text-[var(--nim-text-muted)] uppercase tracking-wider">Snapshots ({displayedSnapshots.length}{compactView && snapshots.length !== displayedSnapshots.length ? ` of ${snapshots.length}` : ''})</h3>
                {loading && <span className="history-loading text-xs text-[var(--nim-text-muted)]">Loading...</span>}
              </div>
              {snapshots.length > 5 && (
                <button
                  className="history-compact-toggle nim-btn-icon"
                  onClick={() => setCompactView(!compactView)}
                  title={compactView ? 'Show all versions' : 'Hide minor auto-saves'}
                >
                  <span className="material-symbols-outlined text-lg">
                    {compactView ? 'unfold_more' : 'unfold_less'}
                  </span>
                </button>
              )}
            </div>

            {displayedSnapshots.length === 0 ? (
              <div className="history-empty py-10 px-5 text-center text-[var(--nim-text-muted)] text-sm">
                No history available for this document
              </div>
            ) : (
              <div className="history-items nim-scrollbar flex-1 overflow-y-auto p-1">
                {displayedSnapshots.map((snapshot, index) => {
                  const snapshotId = getSnapshotId(snapshot, index);
                  const isSelected = selectedVersions.some(v => v.snapshotId === snapshotId);
                  const sessionId = snapshot.metadata?.sessionId;
                  const session = sessionId ? sessionInfo[sessionId] : null;
                  const isAIEdit = ['pre-edit', 'ai-diff', 'ai-edit', 'incremental-approval'].includes(snapshot.type);
                  const relativeTime = getRelativeTimeString(new Date(snapshot.timestamp).getTime());

                  const handleSessionClick = (e: React.MouseEvent) => {
                    e.stopPropagation();
                    if (sessionId && onOpenSessionInChat) {
                      onOpenSessionInChat(sessionId);
                      onClose();
                    }
                  };

                  return (
                  <div
                    key={snapshotId}
                    data-testid={`history-item-${index}`}
                    data-snapshot-id={snapshotId}
                    data-snapshot-type={snapshot.type}
                    data-selected={isSelected}
                    className={`history-item mb-0.5 rounded cursor-pointer transition-all duration-150 ${isSelected ? 'selected bg-[var(--nim-primary)]' : 'hover:bg-[var(--nim-bg-hover)]'}`}
                    onClick={(e) => handleSnapshotSelect(snapshotId, snapshot.timestamp, index, e.metaKey || e.ctrlKey)}
                  >
                    <div className="history-item-content py-1.5 px-2 flex items-center justify-between">
                      <div className="history-item-main flex items-center gap-2 flex-1 min-w-0">
                        <span className={`history-item-icon material-symbols-outlined text-lg shrink-0 ${isSelected ? 'text-white' : 'text-[var(--nim-text-muted)]'}`}>{getSnapshotIcon(snapshot.type)}</span>
                        <div className="history-item-info flex flex-col gap-0.5 min-w-0 flex-1">
                          <div className="history-item-type-row flex items-center justify-between gap-2">
                            <span className={`history-item-type text-xs font-medium capitalize whitespace-nowrap ${isSelected ? 'text-white' : 'text-[var(--nim-text)]'}`}>{snapshot.type.replace('-', ' ')}</span>
                            <span className={`history-item-time text-[11px] whitespace-nowrap shrink-0 ${isSelected ? 'text-white' : 'text-[var(--nim-text-faint)]'}`}>{relativeTime}</span>
                          </div>
                          {isAIEdit && session && (
                            <span
                              className={`history-item-session-link flex items-center gap-1 text-[11px] cursor-pointer transition-colors duration-150 max-w-full overflow-hidden no-underline ${isSelected ? 'text-white/80 hover:text-white' : 'text-[var(--nim-link)] hover:text-[var(--nim-link-hover)]'}`}
                            >
                              <ProviderIcon provider={session.provider} size={11} />
                              <a title="Open AI session in chat"
                                  onClick={handleSessionClick}
                                  className="history-item-session-name whitespace-nowrap overflow-hidden text-ellipsis hover:underline">{session.title}</a>
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="history-item-actions flex items-center gap-2 shrink-0">
                        <button
                          className={`history-item-delete w-5 h-5 border-none bg-transparent cursor-pointer opacity-0 transition-all duration-200 rounded flex items-center justify-center shrink-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-[var(--nim-error-light)] [.history-item:hover_&]:opacity-60`}
                          data-testid={`history-item-delete-${index}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(snapshotId, snapshot.timestamp);
                          }}
                          title="Delete snapshot"
                        >
                          <span className={`material-symbols-outlined text-base ${isSelected ? 'text-white' : 'text-[var(--nim-text-muted)]'} [.history-item-delete:hover_&]:text-[var(--nim-error)]`}>delete</span>
                        </button>
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="history-preview flex-1 flex flex-col relative min-w-0 overflow-hidden">
            <div className="history-preview-header py-2 px-3 border-b border-[var(--nim-border)] flex items-center justify-between bg-[var(--nim-bg-secondary)] gap-3">
              <div className="history-preview-header-left flex items-center gap-3 min-w-0 flex-1 overflow-hidden flex-wrap">
                <h3 className="m-0 text-xs font-semibold text-[var(--nim-text-muted)] uppercase tracking-wider">{diffMode ? 'Diff Preview' : 'Preview'}</h3>
                {diffMode && versionAMeta && versionBMeta && (
                  <div className="diff-version-labels flex items-center gap-2 text-[11px] text-[var(--nim-text-muted)]">
                    <span className="diff-version-label diff-version-old py-0.5 px-2 rounded bg-[var(--nim-bg-tertiary)] font-medium text-[var(--nim-error)]">
                      {formatVersionLabel(versionAMeta.type, versionAMeta.timestamp)}
                    </span>
                    <span className="diff-version-separator font-semibold text-[var(--nim-text-faint)]">vs</span>
                    <span className="diff-version-label diff-version-new py-0.5 px-2 rounded bg-[var(--nim-bg-tertiary)] font-medium text-[var(--nim-success)]">
                      {formatVersionLabel(versionBMeta.type, versionBMeta.timestamp)}
                    </span>
                  </div>
                )}
                {diffMode && fileType === 'markdown' && (
                  <>
                    {navigationState && navigationState.totalGroups > 0 && (
                      <div className="diff-navigation-controls flex items-center gap-2 ml-3">
                        <button
                          className="diff-nav-button w-6 h-6 p-0 border border-[var(--nim-border)] bg-[var(--nim-bg)] rounded cursor-pointer flex items-center justify-center text-[var(--nim-text-muted)] transition-all duration-200 hover:not-disabled:bg-[var(--nim-bg-hover)] hover:not-disabled:text-[var(--nim-text)] disabled:opacity-40 disabled:cursor-not-allowed"
                          onClick={handleNavigatePrevious}
                          disabled={!navigationState.canGoPrevious}
                          title="Previous change"
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <path d="M6 9L3 6L6 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        <span className="diff-change-counter text-[11px] font-medium text-[var(--nim-text-muted)] min-w-[50px] text-center">
                          {navigationState.currentIndex + 1} / {navigationState.totalGroups}
                        </span>
                        <button
                          className="diff-nav-button w-6 h-6 p-0 border border-[var(--nim-border)] bg-[var(--nim-bg)] rounded cursor-pointer flex items-center justify-center text-[var(--nim-text-muted)] transition-all duration-200 hover:not-disabled:bg-[var(--nim-bg-hover)] hover:not-disabled:text-[var(--nim-text)] disabled:opacity-40 disabled:cursor-not-allowed"
                          onClick={handleNavigateNext}
                          disabled={!navigationState.canGoNext}
                          title="Next change"
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <path d="M6 3L9 6L6 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        {!richView && 'addedLines' in navigationState && (
                          <div className="diff-stats flex items-center gap-2 ml-2 pl-2 border-l border-[var(--nim-border)]">
                            <span className="diff-stat diff-stat-added text-[11px] font-semibold py-0.5 px-1.5 rounded-sm text-[var(--nim-success)] bg-[var(--nim-success-light)]">+{navigationState.addedLines}</span>
                            <span className="diff-stat diff-stat-removed text-[11px] font-semibold py-0.5 px-1.5 rounded-sm text-[var(--nim-error)] bg-[var(--nim-error-light)]">-{navigationState.removedLines}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
              {selectedVersions.length === 1 && (
                <button
                  className="history-restore-button py-1.5 px-4 bg-[var(--nim-primary)] text-white border-none rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 shrink-0 whitespace-nowrap hover:not-disabled:bg-[var(--nim-primary-hover)] hover:not-disabled:-translate-y-px hover:not-disabled:shadow-[0_2px_8px_rgba(59,130,246,0.3)] disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={handleRestore}
                  disabled={!previewContent}
                >
                  Restore This Version
                </button>
              )}
            </div>

            {diffMode ? (
              <div className="history-preview-content nim-scrollbar flex-1 overflow-auto [&:has(.diff-preview-editor)]:p-0">
                {fileType === 'markdown' ? (
                  // Markdown files: use rich or text diff
                  richView ? (
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
                ) : fileType === 'image' ? (
                  // Image files: use image diff viewer
                  <ImageDiffViewer
                    key={`${versionAMeta?.timestamp}-${versionBMeta?.timestamp}`}
                    oldImagePath={filePath || ''}
                    newImagePath={filePath || ''}
                    filePath={filePath || ''}
                  />
                ) : (
                  // Code files: use Monaco diff viewer
                  <MonacoDiffViewer
                    key={`${versionAMeta?.timestamp}-${versionBMeta?.timestamp}`}
                    oldContent={versionAContent}
                    newContent={versionBContent}
                    filePath={filePath || ''}
                    theme={theme}
                  />
                )}
              </div>
            ) : selectedVersions.length === 1 ? (
              <div className="history-preview-content nim-scrollbar flex-1 overflow-auto [&:has(.monaco-editor)]:overflow-hidden [&:has(.nimbalyst-editor-root)]:overflow-hidden">
                {fileType === 'image' ? (
                  <div className="image-preview flex items-center justify-center w-full h-full bg-[var(--nim-bg-tertiary)] p-4 [&_img]:max-w-full [&_img]:max-h-full [&_img]:object-contain">
                    <img src={nimAssetUrl(filePath || '')} alt="Preview" />
                  </div>
                ) : fileType === 'markdown' && richView ? (
                  <div className="markdown-preview h-full">
                    <MarkdownEditor
                      key={selectedVersions[0]?.timestamp}
                      host={createReadOnlyEditorHost({
                        filePath: filePath || '',
                        fileName: getFileName(filePath || ''),
                        theme: theme || 'light',
                        content: previewContent,
                      })}
                      config={{
                        theme: theme,
                      }}
                    />
                  </div>
                ) : (
                  <MonacoEditor
                    key={selectedVersions[0]?.timestamp}
                    host={createReadOnlyEditorHost({
                      filePath: filePath || '',
                      fileName: getFileName(filePath || ''),
                      theme: theme || 'light',
                      content: previewContent,
                    })}
                    fileName={getFileName(filePath || '')}
                    config={{
                      theme: theme,
                      isActive: true,
                    }}
                  />
                )}
              </div>
            ) : (
              <div className="history-preview-empty flex-1 flex items-center justify-center text-[var(--nim-text-muted)] text-sm">
                {viewMode === 'changes'
                  ? 'Select a snapshot to see diff, or Cmd+Click two to compare'
                  : 'Select a snapshot to view'}
              </div>
            )}

            {loadingPreview && (richView || !diffMode) && (
              <div className="history-preview-loading absolute inset-0 flex flex-col items-center justify-center bg-[var(--nim-bg)] z-10 gap-3">
                <div className="history-preview-loading-spinner w-10 h-10 border-[3px] border-[var(--nim-border)] border-t-[var(--nim-primary)] rounded-full animate-spin" />
                <div className="history-preview-loading-text text-[var(--nim-text-muted)] text-sm">
                  {selectedVersions.length === 2 ? 'Loading diff...' : 'Loading preview...'}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
