import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildFileDirectoryTree,
  getFilePathBasename,
  type FileDirectoryNode,
} from '@nimbalyst/extension-sdk/file-tree';
import { DiffPeekPopover } from './DiffPeekPopover';

const ipc = (window as unknown as {
  electronAPI: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
}).electronAPI;

export interface CommitDetail {
  body: string;
  files: Array<{ status: string; path: string; added: number; deleted: number }>;
  summary: { filesChanged: number; insertions: number; deletions: number };
}

interface CommitDetailContentProps {
  detail: CommitDetail | null;
  loading: boolean;
  author: string;
  date: string;
  layout: 'horizontal' | 'vertical';
  /**
   * Required for the vertical layout to enable per-file diff peek popovers.
   * The horizontal (hover-card) layout doesn't show diffs and ignores these.
   */
  workspacePath?: string;
  commitHash?: string;
}

// --- Directory tree (matches FileEditsSidebar's collapsing algorithm) ---

type DirectoryNode = FileDirectoryNode<CommitDetail['files'][number]>;

const STATUS_CLASS: Record<string, string> = {
  M: 'git-hover-status--modified',
  A: 'git-hover-status--added',
  D: 'git-hover-status--deleted',
  R: 'git-hover-status--renamed',
};

interface FileRowRenderOptions {
  pinnedPath: string | null;
  registerRowEl: (path: string, el: HTMLDivElement | null) => void;
  onRowClick: (path: string) => void;
  interactive: boolean;
}

function renderDirNode(node: DirectoryNode, depth: number, opts?: FileRowRenderOptions): React.ReactNode {
  const subdirs = Array.from(node.subdirectories.values()).sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  const sortedFiles = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
  const childDepth = node.displayPath ? depth + 1 : depth;
  return (
    <>
      {node.displayPath && (
        <div className="git-hover-file-row git-hover-file-row--dir" style={{ paddingLeft: depth * 10 + 6 }}>
          <span className="git-hover-dir-name">{node.displayPath}/</span>
        </div>
      )}
      {subdirs.map(sub => <React.Fragment key={sub.path}>{renderDirNode(sub, childDepth, opts)}</React.Fragment>)}
      {sortedFiles.map(file => {
        const name = getFilePathBasename(file.path);
        const isPinned = opts?.pinnedPath === file.path;
        const rowClasses = [
          'git-hover-file-row',
          opts?.interactive ? 'git-hover-file-row--clickable' : '',
          isPinned ? 'git-hover-file-row--pinned' : '',
        ].filter(Boolean).join(' ');
        return (
          <div
            key={file.path}
            ref={opts ? (el) => opts.registerRowEl(file.path, el) : undefined}
            className={rowClasses}
            style={{ paddingLeft: childDepth * 10 + 6 }}
            onClick={opts?.interactive ? () => opts.onRowClick(file.path) : undefined}
            role={opts?.interactive ? 'button' : undefined}
            tabIndex={opts?.interactive ? 0 : undefined}
            onKeyDown={opts?.interactive ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                opts.onRowClick(file.path);
              }
            } : undefined}
          >
            <span className={`git-hover-status ${STATUS_CLASS[file.status] ?? ''}`}>{file.status}</span>
            <span className="git-hover-file-name">{name}</span>
            <span className="git-hover-file-stats">
              {file.added > 0 && <span className="git-hover-stat-added">+{file.added}</span>}
              {file.deleted > 0 && <span className="git-hover-stat-deleted">-{file.deleted}</span>}
            </span>
          </div>
        );
      })}
    </>
  );
}

export function formatRelative(dateStr: string): string {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

export function formatAbsolute(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function SummaryBar({ detail, author, date }: { detail: CommitDetail; author: string; date: string }) {
  return (
    <div className="git-hover-summary">
      <span className="git-hover-summary-author">{author}</span>
      <span className="git-hover-summary-sep">·</span>
      <span className="git-hover-summary-date" title={formatAbsolute(date)}>{formatRelative(date)}</span>
      <span className="git-hover-summary-date git-hover-summary-date--abs">{formatAbsolute(date)}</span>
      <span className="git-hover-summary-sep">·</span>
      <span className="git-hover-summary-files">
        {detail.summary.filesChanged} file{detail.summary.filesChanged !== 1 ? 's' : ''} changed
      </span>
      {detail.summary.insertions > 0 && <span className="git-hover-stat-added">+{detail.summary.insertions}</span>}
      {detail.summary.deletions > 0 && <span className="git-hover-stat-deleted">-{detail.summary.deletions}</span>}
    </div>
  );
}

interface DiffState {
  diff: string;
  isBinary: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY_DIFF: DiffState = { diff: '', isBinary: false, loading: false, error: null };

/**
 * Walks a directory tree in display order (subdirs sorted, files sorted)
 * and returns the flat list of file paths. Matches the order produced by
 * renderDirNode so arrow-key navigation lines up with what the user sees.
 */
function flattenTreePaths(node: DirectoryNode): string[] {
  const out: string[] = [];
  const subdirs = Array.from(node.subdirectories.values()).sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  for (const sub of subdirs) out.push(...flattenTreePaths(sub));
  const sortedFiles = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sortedFiles) out.push(f.path);
  return out;
}

/**
 * Click-to-toggle diff peek for a commit's per-file rows.
 * Caches diffs per (hash, path) for the lifetime of this commit selection so
 * re-clicking the same row reopens instantly without refetching.
 */
function useCommitDiffPeek(
  workspacePath: string | undefined,
  commitHash: string | undefined,
  flatPaths: string[],
) {
  const [pinnedPath, setPinnedPath] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [diffState, setDiffState] = useState<DiffState>(EMPTY_DIFF);
  const rowElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const cacheRef = useRef<Map<string, { diff: string; isBinary: boolean }>>(new Map());
  const requestRef = useRef(0);

  // Invalidate cache when the selected commit changes -- the same path will
  // mean a different diff in a different commit.
  useEffect(() => {
    cacheRef.current.clear();
    setPinnedPath(null);
    setAnchorRect(null);
    setDiffState(EMPTY_DIFF);
  }, [commitHash, workspacePath]);

  const registerRowEl = useCallback((path: string, el: HTMLDivElement | null) => {
    if (el) rowElsRef.current.set(path, el);
    else rowElsRef.current.delete(path);
  }, []);

  // Pin a specific path. Scrolls the row into view and re-anchors the popover.
  const pinPath = useCallback((path: string) => {
    const el = rowElsRef.current.get(path);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      setAnchorRect(el.getBoundingClientRect());
      el.focus({ preventScroll: true });
    }
    setPinnedPath(path);
  }, []);

  const onRowClick = useCallback((path: string) => {
    if (!workspacePath || !commitHash) return;
    setPinnedPath((prev) => {
      if (prev === path) {
        setAnchorRect(null);
        return null;
      }
      const el = rowElsRef.current.get(path);
      if (el) setAnchorRect(el.getBoundingClientRect());
      return path;
    });
  }, [workspacePath, commitHash]);

  const movePin = useCallback((delta: number) => {
    if (flatPaths.length === 0) return;
    const currentIdx = pinnedPath ? flatPaths.indexOf(pinnedPath) : -1;
    let nextIdx: number;
    if (currentIdx === -1) {
      nextIdx = delta > 0 ? 0 : flatPaths.length - 1;
    } else {
      nextIdx = Math.max(0, Math.min(flatPaths.length - 1, currentIdx + delta));
    }
    const nextPath = flatPaths[nextIdx];
    if (nextPath && nextPath !== pinnedPath) pinPath(nextPath);
  }, [flatPaths, pinnedPath, pinPath]);

  // Fetch diff when pinnedPath changes
  useEffect(() => {
    if (!pinnedPath || !workspacePath || !commitHash) {
      setDiffState(EMPTY_DIFF);
      return;
    }
    const cached = cacheRef.current.get(pinnedPath);
    if (cached) {
      setDiffState({ diff: cached.diff, isBinary: cached.isBinary, loading: false, error: null });
      return;
    }
    const requestId = ++requestRef.current;
    setDiffState({ diff: '', isBinary: false, loading: true, error: null });
    ipc.invoke('git:commit-file-diff', workspacePath, commitHash, pinnedPath)
      .then((res) => {
        if (requestId !== requestRef.current) return;
        const result = res as { unifiedDiff: string; isBinary: boolean };
        cacheRef.current.set(pinnedPath, { diff: result.unifiedDiff, isBinary: result.isBinary });
        setDiffState({ diff: result.unifiedDiff, isBinary: result.isBinary, loading: false, error: null });
      })
      .catch((err) => {
        if (requestId !== requestRef.current) return;
        setDiffState({
          diff: '', isBinary: false, loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [pinnedPath, workspacePath, commitHash]);

  const closePeek = useCallback(() => {
    setPinnedPath(null);
    setAnchorRect(null);
  }, []);

  return { pinnedPath, anchorRect, diffState, registerRowEl, onRowClick, movePin, closePeek };
}

export function CommitDetailContent({
  detail,
  loading,
  author,
  date,
  layout,
  workspacePath,
  commitHash,
}: CommitDetailContentProps) {
  // Persisted popover size (shared with the git changes panel & commit proposal widget).
  const [diffPeekSize, setDiffPeekSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    ipc.invoke('ai:getSettings')
      .then((settings) => {
        if (cancelled) return;
        const size = (settings as { diffPeekSize?: { width: number; height: number } | null } | null)?.diffPeekSize;
        if (size && typeof size.width === 'number' && typeof size.height === 'number') {
          setDiffPeekSize(size);
        }
      })
      .catch(() => { /* not fatal */ });
    return () => { cancelled = true; };
  }, []);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleResize = useCallback((size: { width: number; height: number }) => {
    setDiffPeekSize(size);
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      ipc.invoke('ai:saveSettings', { diffPeekSize: size }).catch((err) => {
        console.error('[CommitDetailContent] Failed to persist diff peek size:', err);
      });
    }, 300);
  }, []);
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, []);

  const tree = useMemo(
    () => detail ? buildFileDirectoryTree(detail.files, file => file.path) : null,
    [detail],
  );
  const flatPaths = useMemo(() => tree ? flattenTreePaths(tree) : [], [tree]);

  const peek = useCommitDiffPeek(workspacePath, commitHash, flatPaths);

  const interactive = layout === 'vertical' && !!workspacePath && !!commitHash;

  // When the popover is pinned, arrow keys step through files. Stop propagation
  // so the parent commit list (which also handles arrows) doesn't move with us.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !peek.pinnedPath) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      peek.movePin(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      peek.movePin(-1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      peek.closePeek();
    }
  }, [interactive, peek]);

  const rowOptions: FileRowRenderOptions | undefined = useMemo(() => {
    if (!interactive) return undefined;
    return {
      pinnedPath: peek.pinnedPath,
      registerRowEl: peek.registerRowEl,
      onRowClick: peek.onRowClick,
      interactive: true,
    };
  }, [interactive, peek.pinnedPath, peek.registerRowEl, peek.onRowClick]);

  if (loading) return <div className="git-hover-loading">Loading...</div>;
  if (!detail || !tree) return null;

  if (layout === 'horizontal') {
    return (
      <>
        <div className="git-hover-body-row">
          <pre className="git-hover-body">{detail.body}</pre>
          <div className="git-hover-files">{renderDirNode(tree, 0)}</div>
        </div>
        <SummaryBar detail={detail} author={author} date={date} />
      </>
    );
  }

  // Vertical layout for selection panel
  return (
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions */
    <div className="git-detail-vertical" onKeyDown={handleKeyDown}>
      <pre className="git-detail-message">{detail.body}</pre>
      <div className="git-detail-files">{renderDirNode(tree, 0, rowOptions)}</div>
      <SummaryBar detail={detail} author={author} date={date} />

      {interactive && peek.pinnedPath && peek.anchorRect && (
        <DiffPeekPopover
          anchorRect={peek.anchorRect}
          filePath={peek.pinnedPath}
          mode="pinned"
          diff={peek.diffState.diff}
          isBinary={peek.diffState.isBinary}
          loading={peek.diffState.loading}
          error={peek.diffState.error}
          onClose={peek.closePeek}
          onPin={() => { /* already pinned; no-op */ }}
          onOpenInEditor={() => {
            if (!workspacePath) return;
            ipc.invoke('workspace:open-file', { workspacePath, filePath: peek.pinnedPath }).catch((err) => {
              console.error('[CommitDetailContent] workspace:open-file failed:', err);
            });
          }}
          width={diffPeekSize?.width}
          height={diffPeekSize?.height}
          onResize={handleResize}
        />
      )}
    </div>
  );
}
