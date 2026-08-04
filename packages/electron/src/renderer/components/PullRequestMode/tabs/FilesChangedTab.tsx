/**
 * FilesChangedTab — grouped file tree + full-file or all-files review diff.
 *
 * Full files mode keeps a single Monaco compare open for the selected file.
 * Collapsed diff mode renders a scrollable, GitHub-style diff stream across
 * every changed file and keeps the left tree in sync with the visible section.
 */

import type { JSX } from 'react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { getMonacoTheme } from '@nimbalyst/runtime/editors';
import { isDarkThemeAtom, themeIdAtom } from '@nimbalyst/runtime/store';
import { VList, type VListHandle } from 'virtua';
import { MonacoDiffViewer } from '../../HistoryDialog/MonacoDiffViewer';
import { PrFileDiff } from '../PrFileDiff';
import {
  prModeLayoutAtom,
  setPrModeLayoutAtom,
} from '../../../store/atoms/pullRequests';
import {
  getPullRequestService,
  type PullRequestFileRow,
  type PullRequestRow,
} from '../../../services/RendererPullRequestService';
import {
  buildPrDirectoryTree,
  getAllPrFolderPaths,
  type PrDirectoryNode,
} from '../prFileTree';

interface FilesChangedTabProps {
  workspaceId: string;
  remote: string;
  pr: PullRequestRow;
  refreshToken: number;
}

interface FileDiffContents {
  oldContent: string;
  newContent: string;
}

const STREAM_ITEM_SIZE = 260;
const LARGE_DIFF_LINE_LIMIT = 220;
const LARGE_DIFF_CHANGE_LIMIT = 400;

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  added: { label: 'A', className: 'text-nim-success' },
  removed: { label: 'D', className: 'text-nim-error' },
  modified: { label: 'M', className: 'text-nim-warning' },
  renamed: { label: 'R', className: 'text-nim-primary' },
};

export function FilesChangedTab({
  workspaceId,
  remote,
  pr,
  refreshToken,
}: FilesChangedTabProps): JSX.Element {
  const isDark = useAtomValue(isDarkThemeAtom);
  const themeId = useAtomValue(themeIdAtom);
  const layout = useAtomValue(prModeLayoutAtom);
  const setLayout = useSetAtom(setPrModeLayoutAtom);
  const monacoThemeName = getMonacoTheme(themeId, isDark, themeId);

  const [files, setFiles] = useState<PullRequestFileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  // Signature of the folder set we last auto-expanded; lets us re-expand whenever
  // a new PR (or a structural change) loads, while respecting manual collapses
  // during a single viewing of the same structure.
  const expandedSignatureRef = useRef<string>('');

  const [selectedDiff, setSelectedDiff] = useState<FileDiffContents>({
    oldContent: '',
    newContent: '',
  });
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [expandedLargeDiffs, setExpandedLargeDiffs] = useState<Set<string>>(new Set());
  const [collapsedStreamFiles, setCollapsedStreamFiles] = useState<Set<string>>(new Set());

  const streamListRef = useRef<VListHandle | null>(null);

  useEffect(() => {
    // Force the next folder load to auto-expand, even if the new PR happens to
    // share the previous one's folder structure.
    expandedSignatureRef.current = '';
    setExpandedLargeDiffs(new Set());
    setCollapsedStreamFiles(new Set());
  }, [pr.id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPullRequestService()
      .files(workspaceId, remote, pr.number)
      .then((rows) => {
        if (cancelled) return;
        setFiles(rows);
        setSelectedPath((prev) =>
          prev && rows.some((row) => row.path === prev) ? prev : rows[0]?.path ?? null,
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load files');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, remote, pr.number, refreshToken]);

  const directoryTree = useMemo(() => buildPrDirectoryTree(files), [files]);

  useEffect(() => {
    const allFolders = getAllPrFolderPaths(directoryTree);
    if (allFolders.length === 0) {
      expandedSignatureRef.current = '';
      return;
    }
    const signature = [...allFolders].sort().join('\0');
    // Same folder structure we already expanded for — keep the user's manual
    // collapse/expand state. A new structure (PR switch / refresh) re-expands all.
    if (signature === expandedSignatureRef.current) return;
    expandedSignatureRef.current = signature;
    setExpandedFolders(new Set(allFolders));
  }, [directoryTree]);

  const selectedFile = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath],
  );

  const loadFileDiffContents = useCallback(
    async (file: PullRequestFileRow): Promise<FileDiffContents> => {
      const service = getPullRequestService();
      const basePath = file.previousPath ?? file.path;
      const needBase = file.status !== 'added';
      const needHead = file.status !== 'removed';

      const [oldContent, newContent] = await Promise.all([
        needBase
          ? service.fileContents(workspaceId, remote, pr.baseRef, basePath)
          : Promise.resolve(''),
        needHead
          ? service.fileContents(workspaceId, remote, pr.headSha, file.path)
          : Promise.resolve(''),
      ]);

      return { oldContent, newContent };
    },
    [workspaceId, remote, pr.baseRef, pr.headSha],
  );

  useEffect(() => {
    if (layout.filesViewMode !== 'full' || !selectedFile) {
      if (!selectedFile) {
        setSelectedDiff({ oldContent: '', newContent: '' });
        setContentError(null);
        setContentLoading(false);
      }
      return;
    }

    if (selectedFile.patch === null) {
      setSelectedDiff({ oldContent: '', newContent: '' });
      setContentError(null);
      setContentLoading(false);
      return;
    }

    let cancelled = false;
    setContentLoading(true);
    setContentError(null);

    loadFileDiffContents(selectedFile)
      .then((contents) => {
        if (cancelled) return;
        setSelectedDiff(contents);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setContentError(err instanceof Error ? err.message : 'Failed to load file contents');
        }
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [layout.filesViewMode, selectedFile, loadFileDiffContents]);

  const syncPatchViewport = useCallback(
    (offset: number) => {
      const list = streamListRef.current;
      if (!list || files.length === 0) return;

      const firstVisibleIndex = Math.max(0, list.findItemIndex(offset));
      const activeFile = files[firstVisibleIndex];
      if (activeFile) {
        setSelectedPath((prev) => (prev === activeFile.path ? prev : activeFile.path));
      }
    },
    [files],
  );

  useEffect(() => {
    if (layout.filesViewMode !== 'patch') return;
    syncPatchViewport(streamListRef.current?.scrollOffset ?? 0);
  }, [layout.filesViewMode, files, syncPatchViewport]);

  const toggleFolder = (folderPath: string): void => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  };

  const expandAll = (): void => {
    setExpandedFolders(new Set(getAllPrFolderPaths(directoryTree)));
  };

  const collapseAll = (): void => {
    setExpandedFolders(new Set());
  };

  const handleSelectFile = (filePath: string): void => {
    setSelectedPath(filePath);
    if (layout.filesViewMode === 'patch') {
      const index = files.findIndex((file) => file.path === filePath);
      if (index >= 0) {
        streamListRef.current?.scrollToIndex(index, { align: 'start', smooth: true });
      }
    }
  };

  const handleExpandLargeDiff = (filePath: string): void => {
    setExpandedLargeDiffs((prev) => {
      const next = new Set(prev);
      next.add(filePath);
      return next;
    });
  };

  const handleToggleStreamFile = (filePath: string): void => {
    let isOpening = false;
    setCollapsedStreamFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
        isOpening = true;
      } else {
        next.add(filePath);
      }
      return next;
    });

    if (isOpening) {
      setSelectedPath(filePath);
    }
  };

  const renderChangeCounts = (file: PullRequestFileRow): JSX.Element | null => {
    if (file.additions === 0 && file.deletions === 0) return null;
    return (
      <span className="shrink-0 text-[10px] font-mono text-nim-faint">
        {file.additions > 0 && <span className="text-nim-success">+{file.additions}</span>}
        {file.additions > 0 && file.deletions > 0 && ' '}
        {file.deletions > 0 && <span className="text-nim-error">-{file.deletions}</span>}
      </span>
    );
  };

  const renderFileRow = (file: PullRequestFileRow, depth: number): JSX.Element => {
    const style = STATUS_STYLE[file.status] ?? STATUS_STYLE.modified;
    const isSelected = file.path === selectedPath;
    const name = file.path.split('/').pop() ?? file.path;

    return (
      <button
        key={file.path}
        data-testid="pr-file-row"
        onClick={() => handleSelectFile(file.path)}
        className={`w-full flex items-center gap-2 py-1.5 pr-2 text-left text-xs transition-colors ${
          isSelected
            ? 'bg-nim-active text-nim'
            : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
        }`}
        style={{ paddingLeft: `${depth * 14 + 10}px` }}
        title={`${file.path} (${file.status})`}
      >
        <span className="flex-1 min-w-0">
          <span className={`truncate block ${style.className}`}>{name}</span>
          {file.previousPath && file.previousPath !== file.path && (
            <span className="truncate block text-[10px] text-nim-faint">{file.previousPath}</span>
          )}
        </span>
        {renderChangeCounts(file)}
      </button>
    );
  };

  const renderDirectoryNode = (node: PrDirectoryNode, depth = 0): React.ReactNode => {
    const items: React.ReactNode[] = [];
    const sortedSubdirs = Array.from(node.subdirectories.values()).sort((a, b) =>
      a.displayPath.localeCompare(b.displayPath),
    );
    const sortedFiles = [...node.files].sort((a, b) => a.path.localeCompare(b.path));

    for (const subdir of sortedSubdirs) {
      const expanded = expandedFolders.has(subdir.path);
      items.push(
        <div key={subdir.path}>
          <button
            type="button"
            onClick={() => toggleFolder(subdir.path)}
            className="w-full flex items-center gap-2 py-1 pr-2 text-left text-xs text-nim-muted hover:bg-nim-tertiary hover:text-nim transition-colors"
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            data-testid="pr-file-folder-row"
          >
            <MaterialSymbol
              icon={expanded ? 'expand_more' : 'chevron_right'}
              size={14}
              className="shrink-0"
            />
            <MaterialSymbol icon="folder" size={14} className="shrink-0 text-nim-faint" />
            <span className="truncate flex-1">{subdir.displayPath}</span>
            <span className="text-[10px] text-nim-faint shrink-0">{subdir.fileCount}</span>
          </button>
          {expanded && renderDirectoryNode(subdir, depth + 1)}
        </div>,
      );
    }

    for (const file of sortedFiles) {
      items.push(renderFileRow(file, depth + 1));
    }

    return items;
  };

  return (
    <div
      className="pr-files-tab flex flex-row flex-1 min-h-0 overflow-hidden"
      data-testid="pr-files-tab"
    >
      <div className="w-72 shrink-0 border-r border-nim overflow-hidden bg-nim-secondary flex flex-col">
        <div className="px-3 py-2 border-b border-nim">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-nim-faint">
              Files Changed
            </div>
            <span className="text-[11px] text-nim-muted">{files.length}</span>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={expandAll}
              className="text-[11px] text-nim-muted hover:text-nim transition-colors"
            >
              Expand all
            </button>
            <button
              type="button"
              onClick={collapseAll}
              className="text-[11px] text-nim-muted hover:text-nim transition-colors"
            >
              Collapse all
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && files.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-6 text-nim-muted text-xs">
              <div className="spinner w-4 h-4 border-[2px] border-nim-secondary border-t-nim-primary rounded-full animate-spin" />
              Loading…
            </div>
          ) : error ? (
            <div className="text-nim-error text-xs p-3">{error}</div>
          ) : files.length === 0 ? (
            <div className="text-nim-faint text-xs p-3">No changed files.</div>
          ) : (
            <div className="py-1">{renderDirectoryNode(directoryTree)}</div>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <div className="shrink-0 border-b border-nim px-3 py-2 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-nim-faint">
              Diff View
            </div>
            <div className="text-xs text-nim-muted truncate" title={selectedFile?.path ?? ''}>
              {layout.filesViewMode === 'patch'
                ? 'Scroll through all changed files'
                : selectedFile?.path ?? 'Select a file to view its diff'}
            </div>
          </div>
          {layout.filesViewMode === 'patch' && (
            <div className="flex items-center rounded border border-nim overflow-hidden">
              <button
                type="button"
                onClick={() => setLayout({ patchDiffLayout: 'unified' })}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  layout.patchDiffLayout === 'unified'
                    ? 'bg-nim-active text-nim'
                    : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
                }`}
                data-testid="pr-patch-layout-unified"
              >
                Unified
              </button>
              <button
                type="button"
                onClick={() => setLayout({ patchDiffLayout: 'split' })}
                className={`px-2.5 py-1 text-xs border-l border-nim transition-colors ${
                  layout.patchDiffLayout === 'split'
                    ? 'bg-nim-active text-nim'
                    : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
                }`}
                data-testid="pr-patch-layout-split"
              >
                Split
              </button>
            </div>
          )}
          <div className="flex items-center rounded border border-nim overflow-hidden">
            <button
              type="button"
              onClick={() => setLayout({ filesViewMode: 'full' })}
              className={`px-2.5 py-1 text-xs transition-colors ${
                layout.filesViewMode === 'full'
                  ? 'bg-nim-active text-nim'
                  : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
              }`}
              data-testid="pr-files-mode-full"
            >
              Full files
            </button>
            <button
              type="button"
              onClick={() => setLayout({ filesViewMode: 'patch' })}
              className={`px-2.5 py-1 text-xs border-l border-nim transition-colors ${
                layout.filesViewMode === 'patch'
                  ? 'bg-nim-active text-nim'
                  : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
              }`}
              data-testid="pr-files-mode-patch"
            >
              Collapsed diff
            </button>
          </div>
        </div>

        {layout.filesViewMode === 'patch' ? (
          <div className="flex-1 min-h-0 overflow-hidden bg-nim-secondary">
            {files.length === 0 ? (
              <div className="flex items-center justify-center h-full text-nim-faint text-sm">
                No changed files.
              </div>
            ) : (
              <VList
                ref={streamListRef}
                className="!h-full !w-full"
                style={{ height: '100%' }}
                data={files}
                bufferSize={800}
                itemSize={STREAM_ITEM_SIZE}
                onScroll={syncPatchViewport}
              >
                {(file, index) => (
                  <PatchStreamSection
                    key={file.path}
                    file={file}
                    viewType={layout.patchDiffLayout}
                    selected={file.path === selectedPath}
                    collapsed={collapsedStreamFiles.has(file.path)}
                    onToggleCollapsed={() => handleToggleStreamFile(file.path)}
                    expanded={expandedLargeDiffs.has(file.path)}
                    onExpand={() => handleExpandLargeDiff(file.path)}
                    showCollapsed={shouldCollapseLargeDiff(file)}
                    isFirst={index === 0}
                  />
                )}
              </VList>
            )}
          </div>
        ) : !selectedFile ? (
          <div className="flex items-center justify-center h-full text-nim-faint text-sm">
            Select a file to view its diff.
          </div>
        ) : selectedFile.patch === null ? (
          <div className="flex flex-col items-center justify-center h-full text-nim-faint text-sm gap-2">
            <MaterialSymbol icon="draft" size={32} className="opacity-50" />
            Binary file — no text diff available.
          </div>
        ) : contentError ? (
          <div className="flex items-center justify-center h-full text-nim-error text-sm">
            {contentError}
          </div>
        ) : contentLoading ? (
          <div className="flex items-center justify-center gap-2 h-full text-nim-muted text-sm">
            <div className="spinner w-5 h-5 border-[3px] border-nim-secondary border-t-nim-primary rounded-full animate-spin" />
            Loading diff…
          </div>
        ) : (
          <MonacoDiffViewer
            key={`${pr.id}:${selectedFile.path}`}
            oldContent={selectedDiff.oldContent}
            newContent={selectedDiff.newContent}
            filePath={selectedFile.path}
            theme={isDark ? 'dark' : 'light'}
            monacoThemeName={monacoThemeName}
          />
        )}
      </div>
    </div>
  );
}

function PatchStreamSection({
  file,
  viewType,
  selected,
  collapsed,
  onToggleCollapsed,
  expanded,
  onExpand,
  showCollapsed,
  isFirst,
}: {
  file: PullRequestFileRow;
  viewType: 'unified' | 'split';
  selected: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  expanded: boolean;
  onExpand: () => void;
  showCollapsed: boolean;
  isFirst: boolean;
}): JSX.Element {
  const style = STATUS_STYLE[file.status] ?? STATUS_STYLE.modified;
  const collapseLargeDiff = showCollapsed && !expanded;

  return (
    <div
      data-file-path={file.path}
      className={`${selected ? 'bg-nim-active/30' : ''} ${isFirst ? '' : 'border-t border-nim'}`}
    >
      <button
        type="button"
        onClick={onToggleCollapsed}
        className="w-full flex items-center gap-3 px-4 py-2 border-b border-nim bg-nim-secondary text-left hover:bg-nim-tertiary transition-colors"
      >
        <MaterialSymbol
          icon={collapsed ? 'chevron_right' : 'expand_more'}
          size={16}
          className="text-nim-faint shrink-0"
        />
        <MaterialSymbol icon="description" size={15} className="text-nim-faint shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-nim truncate" title={file.path}>
            {file.path}
          </div>
          {file.previousPath && file.previousPath !== file.path && (
            <div className="text-[11px] text-nim-faint truncate" title={file.previousPath}>
              renamed from {file.previousPath}
            </div>
          )}
        </div>
        <span className={`text-xs font-mono font-semibold ${style.className}`}>{style.label}</span>
        {(file.additions > 0 || file.deletions > 0) && (
          <span className="text-xs font-mono text-nim-muted shrink-0">
            {file.additions > 0 && <span className="text-nim-success">+{file.additions}</span>}
            {file.additions > 0 && file.deletions > 0 && ' '}
            {file.deletions > 0 && <span className="text-nim-error">-{file.deletions}</span>}
          </span>
        )}
      </button>

      {collapsed ? null : file.patch === null ? (
        <div className="px-4 py-6 text-sm text-nim-faint flex items-center gap-2">
          <MaterialSymbol icon="draft" size={18} />
          Binary file — no text diff available.
        </div>
      ) : collapseLargeDiff ? (
        <div className="px-6 py-10 flex flex-col items-center justify-center gap-3 text-center">
          <button
            type="button"
            onClick={onExpand}
            className="text-2xl font-semibold text-nim-primary hover:text-nim-primary-hover transition-colors"
          >
            Load Diff
          </button>
          <div className="text-sm text-nim-muted max-w-md">
            Large diffs are not rendered by default.
          </div>
        </div>
      ) : file.patch ? (
        <PrFileDiff file={file} viewType={viewType} />
      ) : (
        <div className="px-4 py-6 text-sm text-nim-faint">
          No patch preview available for this file.
        </div>
      )}
    </div>
  );
}

function countPatchLines(patch: string | null): number {
  if (!patch) return 0;
  return patch.split('\n').length;
}

function shouldCollapseLargeDiff(file: PullRequestFileRow): boolean {
  return (
    countPatchLines(file.patch) > LARGE_DIFF_LINE_LIMIT ||
    file.additions + file.deletions > LARGE_DIFF_CHANGE_LIMIT
  );
}
