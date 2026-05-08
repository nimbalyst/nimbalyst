import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useFloating, offset, flip, shift, FloatingPortal,
  useDismiss, useInteractions, autoUpdate,
} from '@floating-ui/react';
import type { PanelHostProps } from '@nimbalyst/extension-sdk';
import { CommitHoverCard } from './CommitHoverCard';
import { CommitContextMenu } from './CommitContextMenu';
import { CommitDetailContent, type CommitDetail } from './CommitDetailContent';
import { BranchPicker } from './BranchPicker';
import { ChangesTab } from './ChangesTab';
import { OutputTab } from './OutputTab';
import { useOperationLog, getSuggestionForError } from '../hooks/useOperationLog';

type GitTab = 'log' | 'changes' | 'output';

interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
  refs?: string;
}

interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  hasUncommitted: boolean;
}

interface GitBranchResult {
  branches: string[];
  current: string;
}

interface PushResult {
  success: boolean;
  error?: string;
}

interface PullResult {
  success: boolean;
  error?: string;
}

interface FetchResult {
  success: boolean;
  error?: string;
}

type DateFilter = 'all' | 'day' | 'week' | 'month';

// Access the generic Electron IPC invoke
const ipc = (window as unknown as {
  electronAPI: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
}).electronAPI;

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return date.toLocaleDateString();
}

function getDateSince(filter: DateFilter): string | undefined {
  if (filter === 'all') return undefined;
  const now = new Date();
  if (filter === 'day') {
    now.setDate(now.getDate() - 1);
  } else if (filter === 'week') {
    now.setDate(now.getDate() - 7);
  } else if (filter === 'month') {
    now.setMonth(now.getMonth() - 1);
  }
  return now.toISOString();
}

export function GitLogPanel({ host }: PanelHostProps) {
  const workspacePath = host.workspacePath;

  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [authorFilter, setAuthorFilter] = useState<string>('');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [searchFilter, setSearchFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  type PullStrategy = 'rebase' | 'merge' | 'ff-only';
  const [pullStrategy, setPullStrategy] = useState<PullStrategy>(
    () => host.storage.getGlobal<PullStrategy>('pullStrategy') ?? 'rebase'
  );
  const [pullMenuOpen, setPullMenuOpen] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [panelHeight, setPanelHeight] = useState(300);
  const resizeStartY = useRef<number>(0);
  const resizeStartHeight = useRef<number>(0);

  // Hover card state
  const [hoveredHash, setHoveredHash] = useState<string | null>(null);
  const [hoveredAuthor, setHoveredAuthor] = useState<string>('');
  const [hoveredDate, setHoveredDate] = useState<string>('');
  const [hoverAnchorRect, setHoverAnchorRect] = useState<DOMRect | null>(null);
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ commit: GitCommit; x: number; y: number } | null>(null);

  // Selection state
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<CommitDetail | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);

  // Detail panel resize (persisted globally so it's consistent across workspaces)
  const [detailWidth, setDetailWidth] = useState(() => host.storage.getGlobal<number>('detailWidth') ?? 340);
  const detailResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Tab state
  const [activeTab, setActiveTab] = useState<GitTab>('log');
  const { entries: logEntries, clearLog, withLog } = useOperationLog();

  // Changes tab: file mask filter (active value per-workspace, history shared globally)
  const [fileMaskEnabled, setFileMaskEnabled] = useState<boolean>(
    () => host.storage.get<boolean>('changesFileMaskEnabled') ?? false
  );
  const [fileMaskInput, setFileMaskInput] = useState<string>(
    () => host.storage.get<string>('changesFileMask') ?? ''
  );
  const [fileMaskHistory, setFileMaskHistory] = useState<string[]>(
    () => host.storage.getGlobal<string[]>('changesFileMaskHistory') ?? []
  );
  const updateFileMaskEnabled = useCallback((enabled: boolean) => {
    setFileMaskEnabled(enabled);
    void host.storage.set('changesFileMaskEnabled', enabled);
  }, [host.storage]);
  const updateFileMaskInput = useCallback((value: string) => {
    setFileMaskInput(value);
    void host.storage.set('changesFileMask', value);
  }, [host.storage]);
  const commitFileMaskToHistory = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setFileMaskHistory(prev => {
      const next = [trimmed, ...prev.filter(v => v !== trimmed)].slice(0, 10);
      void host.storage.setGlobal('changesFileMaskHistory', next);
      return next;
    });
  }, [host.storage]);
  const removeFileMaskHistoryEntry = useCallback((value: string) => {
    setFileMaskHistory(prev => {
      const next = prev.filter(v => v !== value);
      void host.storage.setGlobal('changesFileMaskHistory', next);
      return next;
    });
  }, [host.storage]);

  const handleDetailResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    detailResizeRef.current = { startX: e.clientX, startWidth: detailWidth };
    const onMove = (me: MouseEvent) => {
      if (!detailResizeRef.current) return;
      const delta = detailResizeRef.current.startX - me.clientX;
      setDetailWidth(Math.max(200, Math.min(700, detailResizeRef.current.startWidth + delta)));
    };
    const onUp = () => {
      if (detailResizeRef.current) {
        // Use functional update to read the final width without stale closure
        setDetailWidth(w => { void host.storage.setGlobal('detailWidth', w); return w; });
      }
      detailResizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [detailWidth, host.storage]);

  const showMessage = useCallback((msg: string, isError = false) => {
    if (isError) {
      setActionError(msg);
      setActionMessage(null);
      // Errors persist until dismissed - do NOT auto-clear
    } else {
      setActionMessage(msg);
      setActionError(null);
      // Success messages auto-clear after 4s
      setTimeout(() => {
        setActionMessage(null);
      }, 4000);
    }
  }, []);

  const loadBranches = useCallback(async () => {
    try {
      const result = await ipc.invoke('git:branches', workspacePath) as GitBranchResult;
      setBranches(result.branches);
      if (result.current) {
        setSelectedBranch(current => current || result.current);
      }
    } catch {
      // Non-fatal: branch selector stays empty
    }
  }, [workspacePath]);

  const loadStatus = useCallback(async () => {
    try {
      const result = await ipc.invoke('git:status', workspacePath) as GitStatusResult;
      setStatus(result);
      if (result.branch) {
        setSelectedBranch(current => current || result.branch);
      }
    } catch {
      // Non-fatal
    }
  }, [workspacePath]);

  const loadCommits = useCallback(async () => {
    setLoading(true);
    try {
      const since = getDateSince(dateFilter);
      const result = await ipc.invoke('git:log', workspacePath, 100, {
        branch: selectedBranch || undefined,
        author: authorFilter || undefined,
        since,
        aheadBehind: true,
      }) as GitCommit[];

      // Client-side text search filter
      const filtered = searchFilter
        ? result.filter(c =>
            c.message.toLowerCase().includes(searchFilter.toLowerCase()) ||
            c.author.toLowerCase().includes(searchFilter.toLowerCase()) ||
            c.hash.startsWith(searchFilter)
          )
        : result;

      setCommits(filtered);
    } catch (err) {
      console.error('[GitLogPanel] Failed to load commits:', err);
    } finally {
      setLoading(false);
    }
  }, [workspacePath, selectedBranch, authorFilter, dateFilter, searchFilter]);

  // Initial load
  useEffect(() => {
    loadStatus();
    loadBranches();
  }, [loadStatus, loadBranches]);

  // Reload commits when filters change
  useEffect(() => {
    if (workspacePath) {
      loadCommits();
    }
  }, [loadCommits, workspacePath]);

  // Auto-refresh when git HEAD changes (commits, checkouts, merges, etc.)
  // Uses PanelHost.onWorkspaceEvent which filters to the current workspace centrally.
  useEffect(() => {
    return host.onWorkspaceEvent('git:status-changed', () => {
      loadStatus();
      loadBranches();
      loadCommits();
    });
  }, [host, loadStatus, loadBranches, loadCommits]);

  // Drag-to-resize handle
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    setIsResizing(true);
    resizeStartY.current = e.clientY;
    resizeStartHeight.current = panelHeight;
    e.preventDefault();
  }, [panelHeight]);

  useEffect(() => {
    if (!isResizing) return;

    const onMouseMove = (e: MouseEvent) => {
      const delta = resizeStartY.current - e.clientY;
      const newHeight = Math.max(150, Math.min(600, resizeStartHeight.current + delta));
      setPanelHeight(newHeight);
    };

    const onMouseUp = () => setIsResizing(false);

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [isResizing]);

  const handlePush = useCallback(async () => {
    setActionLoading('push');
    try {
      const result = await withLog(
        'git push origin',
        () => ipc.invoke('git:push', workspacePath) as Promise<PushResult>,
        {
          isError: (r) => !r.success,
          getError: (r) => r.error,
          formatSuggestion: (r) => r.error ? getSuggestionForError(r.error) : undefined,
          formatOutput: () => 'Pushed successfully',
        }
      );
      if (result.success) {
        showMessage('Pushed successfully');
        loadStatus();
        loadCommits();
      } else {
        showMessage(result.error || 'Push failed', true);
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : 'Push failed', true);
    } finally {
      setActionLoading(null);
    }
  }, [workspacePath, showMessage, loadStatus, loadCommits, withLog]);

  const handlePull = useCallback(async () => {
    setActionLoading('pull');
    try {
      const opts = pullStrategy === 'rebase' ? { rebase: true } : pullStrategy === 'ff-only' ? { ffOnly: true } : {};
      const strategyLabel = pullStrategy === 'rebase' ? ' --rebase' : pullStrategy === 'ff-only' ? ' --ff-only' : '';
      const result = await withLog(
        `git pull${strategyLabel} origin`,
        () => ipc.invoke('git:pull', workspacePath, opts) as Promise<PullResult>,
        {
          isError: (r) => !r.success,
          getError: (r) => r.error,
          formatSuggestion: (r) => r.error ? getSuggestionForError(r.error) : undefined,
          formatOutput: () => 'Pulled successfully',
        }
      );
      if (result.success) {
        showMessage('Pulled successfully');
        loadStatus();
        loadCommits();
      } else {
        showMessage(result.error || 'Pull failed', true);
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : 'Pull failed', true);
    } finally {
      setActionLoading(null);
    }
  }, [workspacePath, showMessage, loadStatus, loadCommits, pullStrategy, withLog]);

  const handleChangePullStrategy = useCallback((strategy: PullStrategy) => {
    setPullStrategy(strategy);
    setPullMenuOpen(false);
    void host.storage.setGlobal('pullStrategy', strategy);
  }, [host.storage]);

  const handleFetch = useCallback(async () => {
    setActionLoading('fetch');
    try {
      const result = await withLog(
        'git fetch origin',
        () => ipc.invoke('git:fetch', workspacePath) as Promise<FetchResult>,
        {
          isError: (r) => !r.success,
          getError: (r) => r.error,
          formatSuggestion: (r) => r.error ? getSuggestionForError(r.error) : undefined,
          formatOutput: () => 'Fetched successfully',
        }
      );
      if (result.success) {
        showMessage('Fetched successfully');
        loadStatus();
      } else {
        showMessage(result.error || 'Fetch failed', true);
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : 'Fetch failed', true);
    } finally {
      setActionLoading(null);
    }
  }, [workspacePath, showMessage, loadStatus, withLog]);

  const handleRefresh = useCallback(() => {
    loadStatus();
    loadBranches();
    loadCommits();
  }, [loadStatus, loadBranches, loadCommits]);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  }, []);

  const startHideTimer = useCallback(() => {
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    hideTimerRef.current = setTimeout(() => {
      setHoveredHash(null);
      setHoverAnchorRect(null);
      setCommitDetail(null);
    }, 150);
  }, []);

  const handleRowMouseEnter = useCallback((hash: string, author: string, date: string, e: React.MouseEvent<HTMLTableRowElement>) => {
    // Don't show hover card when a commit is selected (detail panel is already visible)
    if (selectedIndex !== null) return;
    clearHideTimer();
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    const rect = e.currentTarget.getBoundingClientRect();
    showTimerRef.current = setTimeout(async () => {
      setHoveredHash(hash);
      setHoveredAuthor(author);
      setHoveredDate(date);
      setHoverAnchorRect(rect);
      setDetailLoading(true);
      setCommitDetail(null);
      try {
        const detail = await ipc.invoke('git:commit-detail', workspacePath, hash) as CommitDetail;
        setCommitDetail(detail);
      } catch {
        // non-fatal
      } finally {
        setDetailLoading(false);
      }
    }, 350);
  }, [workspacePath, clearHideTimer, selectedIndex]);

  const handleRowMouseLeave = useCallback(() => {
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    startHideTimer();
  }, [startHideTimer]);

  const handleRowContextMenu = useCallback((commit: GitCommit, e: React.MouseEvent) => {
    e.preventDefault();
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    setHoveredHash(null);
    setContextMenu({ commit, x: e.clientX, y: e.clientY });
  }, []);

  // Fetch detail for selected commit
  useEffect(() => {
    if (selectedIndex === null || !commits[selectedIndex]) {
      setSelectedDetail(null);
      return;
    }
    const hash = commits[selectedIndex].hash;
    let cancelled = false;
    setSelectedLoading(true);
    setSelectedDetail(null);
    ipc.invoke('git:commit-detail', workspacePath, hash)
      .then((d) => { if (!cancelled) setSelectedDetail(d as CommitDetail); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setSelectedLoading(false); });
    return () => { cancelled = true; };
  }, [selectedIndex, commits, workspacePath]);

  // Scroll selected row into view
  useEffect(() => {
    if (selectedIndex !== null && tbodyRef.current) {
      tbodyRef.current.rows[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't intercept when focus is inside an input/select
    if ((e.target as HTMLElement).closest('input, select')) return;
    if (commits.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => i === null ? 0 : Math.min(i + 1, commits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => i === null ? commits.length - 1 : Math.max(i - 1, 0));
    } else if (e.key === 'Escape') {
      setSelectedIndex(null);
    }
  }, [commits.length]);

  const handleRowClick = useCallback((index: number) => {
    setSelectedIndex(i => i === index ? null : index);
    // Dismiss hover card on click
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    setHoveredHash(null);
  }, []);

  const remoteStatus = status ? (
    status.ahead > 0 || status.behind > 0
      ? `↑${status.ahead} ↓${status.behind}`
      : 'up to date'
  ) : '';

  const hasChanges = status?.hasUncommitted ?? false;

  return (
    <div
      className="git-log-panel"
      style={{ height: panelHeight }}
    >
      {/* Drag handle */}
      <div
        className="git-log-resize-handle"
        onMouseDown={handleResizeStart}
        style={{ cursor: 'ns-resize' }}
      />

      {/* Tab bar + Toolbar */}
      <div className="git-log-toolbar">
        <div className="git-log-toolbar-left">
          {/* Tab buttons */}
          <div className="git-tab-bar">
            <button
              className={`git-tab-btn${activeTab === 'log' ? ' git-tab-btn--active' : ''}`}
              onClick={() => setActiveTab('log')}
            >
              Log
            </button>
            <button
              className={`git-tab-btn${activeTab === 'changes' ? ' git-tab-btn--active' : ''}`}
              onClick={() => setActiveTab('changes')}
            >
              Changes{hasChanges ? <span className="git-tab-dot" /> : null}
            </button>
            <button
              className={`git-tab-btn${activeTab === 'output' ? ' git-tab-btn--active' : ''}`}
              onClick={() => setActiveTab('output')}
            >
              Output{logEntries.some(e => e.status === 'error') ? <span className="git-tab-dot git-tab-dot--error" /> : null}
            </button>
          </div>

          {/* Branch selector */}
          <BranchPicker
            branches={branches}
            current={selectedBranch}
            onChange={setSelectedBranch}
          />

          {/* Remote status */}
          {remoteStatus && (
            <span className={`git-log-remote-status ${remoteStatus === 'up to date' ? 'up-to-date' : 'diverged'}`}>
              {remoteStatus}
            </span>
          )}
        </div>

        <div className="git-log-toolbar-actions">
          {/* Action buttons */}
          <button
            className="git-log-action-btn"
            onClick={handlePush}
            disabled={!!actionLoading}
            title="Push"
          >
            {actionLoading === 'push' ? '...' : '\u2191 Push'}
          </button>
          <div className="git-log-split-btn">
            <button
              className="git-log-action-btn git-log-split-btn-main"
              onClick={handlePull}
              disabled={!!actionLoading}
              title={`Pull (${pullStrategy})`}
            >
              {actionLoading === 'pull' ? '...' : '\u2193 Pull'}
            </button>
            <button
              className="git-log-action-btn git-log-split-btn-arrow"
              onClick={() => setPullMenuOpen(v => !v)}
              disabled={!!actionLoading}
              title="Pull strategy"
            >
              {'\u25BE'}
            </button>
            {pullMenuOpen && (
              <div className="git-log-split-menu">
                <button
                  className={`git-log-split-menu-item${pullStrategy === 'rebase' ? ' git-log-split-menu-item--active' : ''}`}
                  onClick={() => handleChangePullStrategy('rebase')}
                >
                  Rebase
                </button>
                <button
                  className={`git-log-split-menu-item${pullStrategy === 'merge' ? ' git-log-split-menu-item--active' : ''}`}
                  onClick={() => handleChangePullStrategy('merge')}
                >
                  Merge
                </button>
                <button
                  className={`git-log-split-menu-item${pullStrategy === 'ff-only' ? ' git-log-split-menu-item--active' : ''}`}
                  onClick={() => handleChangePullStrategy('ff-only')}
                >
                  Fast-forward only
                </button>
              </div>
            )}
          </div>
          <button
            className="git-log-action-btn"
            onClick={handleFetch}
            disabled={!!actionLoading}
            title="Fetch"
          >
            {actionLoading === 'fetch' ? '...' : 'Fetch'}
          </button>
          <button
            className="git-log-action-btn git-log-action-btn--refresh"
            onClick={handleRefresh}
            disabled={!!actionLoading}
            title="Refresh"
          >
            {'\u21BA'}
          </button>
        </div>

        {/* Log-specific filters (only shown on log tab) */}
        {activeTab === 'log' && (
          <div className="git-log-toolbar-filters">
            <input
              className="git-log-input"
              type="text"
              placeholder="Author..."
              value={authorFilter}
              onChange={e => setAuthorFilter(e.target.value)}
            />
            <select
              className="git-log-select git-log-select--sm"
              value={dateFilter}
              onChange={e => setDateFilter(e.target.value as DateFilter)}
            >
              <option value="all">All time</option>
              <option value="day">Last day</option>
              <option value="week">Last week</option>
              <option value="month">Last month</option>
            </select>
            <input
              className="git-log-input git-log-input--search"
              type="text"
              placeholder="Search commits..."
              value={searchFilter}
              onChange={e => setSearchFilter(e.target.value)}
            />
          </div>
        )}

        {/* Changes-specific filters (only shown on changes tab) */}
        {activeTab === 'changes' && (
          <FileMaskFilter
            enabled={fileMaskEnabled}
            value={fileMaskInput}
            history={fileMaskHistory}
            onEnabledChange={updateFileMaskEnabled}
            onValueChange={updateFileMaskInput}
            onCommitToHistory={commitFileMaskToHistory}
            onRemoveHistoryEntry={removeFileMaskHistoryEntry}
          />
        )}
      </div>

      {/* Status message (visible on all tabs) */}
      {(actionMessage || actionError) && (
        <div className={`git-log-status-bar ${actionError ? 'error' : 'success'}`}>
          {actionMessage || actionError}
          {actionError && (
            <>
              <button
                className="git-log-status-details-btn"
                onClick={() => setActiveTab('output')}
              >
                Show Details
              </button>
              <button
                className="git-changes-dismiss-btn"
                onClick={() => setActionError(null)}
                title="Dismiss"
              >
                &#10005;
              </button>
            </>
          )}
        </div>
      )}

      {/* Context menu (log tab only) */}
      {contextMenu && (
        <CommitContextMenu
          commit={contextMenu.commit}
          x={contextMenu.x}
          y={contextMenu.y}
          workspacePath={workspacePath}
          onClose={() => setContextMenu(null)}
          onMessage={showMessage}
          onRefresh={handleRefresh}
        />
      )}

      {/* Hover card (log tab only) */}
      {activeTab === 'log' && hoveredHash && hoverAnchorRect && (
        <CommitHoverCard
          detail={commitDetail}
          loading={detailLoading}
          anchorRect={hoverAnchorRect}
          author={hoveredAuthor}
          date={hoveredDate}
          onMouseEnter={clearHideTimer}
          onMouseLeave={startHideTimer}
        />
      )}

      {/* Tab content */}
      {activeTab === 'log' && (
        /* eslint-disable-next-line jsx-a11y/no-static-element-interactions */
        <div className="git-log-body" tabIndex={0} onKeyDown={handleKeyDown}>
          <div className="git-log-content">
            {loading ? (
              <div className="git-log-empty">Loading commits...</div>
            ) : commits.length === 0 ? (
              <div className="git-log-empty">No commits found</div>
            ) : (
              <table className="git-log-table">
                <thead>
                  <tr>
                    <th className="git-log-th git-log-th--graph" />
                    <th className="git-log-th git-log-th--hash">Hash</th>
                    <th className="git-log-th git-log-th--message">Message</th>
                    <th className="git-log-th git-log-th--author">Author</th>
                    <th className="git-log-th git-log-th--date">Date</th>
                  </tr>
                </thead>
                <tbody ref={tbodyRef}>
                  {commits.map((commit, index) => {
                    const isUnpushed = index < (status?.ahead ?? 0);
                    const isFirst = index === 0;
                    const isLast = index === commits.length - 1;
                    const isSelected = index === selectedIndex;
                    return (
                      <tr
                        key={commit.hash}
                        className={`git-log-row${isSelected ? ' git-log-row--selected' : ''}`}
                        onClick={() => handleRowClick(index)}
                        onMouseEnter={(e) => handleRowMouseEnter(commit.hash, commit.author, commit.date, e)}
                        onMouseLeave={handleRowMouseLeave}
                        onContextMenu={(e) => handleRowContextMenu(commit, e)}
                      >
                        <td className="git-log-td git-log-td--graph">
                          <div className="git-log-graph-cell">
                            {!isFirst && <div className="git-log-graph-line git-log-graph-line--top" />}
                            <svg width="10" height="10" className="git-log-graph-dot" viewBox="0 0 10 10">
                              <circle
                                cx="5" cy="5" r="3.5"
                                fill={isUnpushed ? 'transparent' : 'var(--nim-text-faint)'}
                                stroke={isUnpushed ? 'var(--nim-primary)' : 'var(--nim-text-faint)'}
                                strokeWidth="1.5"
                              />
                            </svg>
                            {!isLast && <div className="git-log-graph-line git-log-graph-line--bottom" />}
                          </div>
                        </td>
                        <td className="git-log-td git-log-td--hash">
                          <code>{commit.hash.slice(0, 7)}</code>
                        </td>
                        <td className="git-log-td git-log-td--message">
                          {commit.message}
                        </td>
                        <td className="git-log-td git-log-td--author">
                          {commit.author}
                        </td>
                        <td className="git-log-td git-log-td--date">
                          {formatRelativeDate(commit.date)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Selection detail panel */}
          {selectedIndex !== null && commits[selectedIndex] && (
            <div className="git-log-detail-panel" style={{ width: detailWidth }}>
              {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
              <div className="git-log-detail-resize-handle" onMouseDown={handleDetailResizeStart} />
              <CommitDetailContent
                detail={selectedDetail}
                loading={selectedLoading}
                author={commits[selectedIndex].author}
                date={commits[selectedIndex].date}
                layout="vertical"
                workspacePath={workspacePath}
                commitHash={commits[selectedIndex].hash}
              />
            </div>
          )}
        </div>
      )}

      {activeTab === 'changes' && (
        <ChangesTab
          workspacePath={workspacePath}
          withLog={withLog}
          onWorkspaceEvent={(event, handler) => host.onWorkspaceEvent(event, handler)}
          onShowOutput={() => setActiveTab('output')}
          fileMaskEnabled={fileMaskEnabled}
          fileMaskInput={fileMaskInput}
        />
      )}

      {activeTab === 'output' && (
        <OutputTab
          entries={logEntries}
          onClear={clearLog}
        />
      )}
    </div>
  );
}

interface FileMaskFilterProps {
  enabled: boolean;
  value: string;
  history: string[];
  onEnabledChange: (enabled: boolean) => void;
  onValueChange: (value: string) => void;
  onCommitToHistory: (value: string) => void;
  onRemoveHistoryEntry: (value: string) => void;
}

function FileMaskFilter({
  enabled,
  value,
  history,
  onEnabledChange,
  onValueChange,
  onCommitToHistory,
  onRemoveHistoryEntry,
}: FileMaskFilterProps) {
  const [historyOpen, setHistoryOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open: historyOpen,
    onOpenChange: setHistoryOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const dismiss = useDismiss(context, { escapeKey: true, outsidePress: true });
  const { getFloatingProps } = useInteractions([dismiss]);

  const commit = useCallback(() => {
    onCommitToHistory(value);
  }, [onCommitToHistory, value]);

  return (
    <div className="git-log-toolbar-filters" ref={refs.setReference}>
      <label className="git-changes-mask-toggle" title="Filter visible files by glob patterns">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => onEnabledChange(e.target.checked)}
        />
        <span>File mask:</span>
      </label>
      <div className="git-changes-mask-input-wrap">
        <input
          className="git-log-input git-log-input--search git-changes-mask-input"
          type="text"
          placeholder="*.ts,*.tsx"
          value={value}
          onChange={e => onValueChange(e.target.value)}
          onFocus={() => { if (!enabled) onEnabledChange(true); }}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              commit();
              (e.currentTarget as HTMLInputElement).blur();
            } else if (e.key === 'ArrowDown' && history.length > 0) {
              e.preventDefault();
              setHistoryOpen(true);
            }
          }}
          spellCheck={false}
        />
        {history.length > 0 && (
          <button
            type="button"
            className="git-changes-mask-history-btn"
            onClick={() => setHistoryOpen(o => !o)}
            title="Recent file masks"
            aria-label="Recent file masks"
          >
            <span className="git-changes-mask-history-chevron">▾</span>
          </button>
        )}
      </div>
      {value && (
        <button
          type="button"
          className="git-changes-mask-clear"
          onClick={() => onValueChange('')}
          title="Clear mask"
        >
          &#10005;
        </button>
      )}

      {historyOpen && history.length > 0 && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="git-changes-mask-history-menu"
            {...getFloatingProps()}
          >
            <div className="git-changes-mask-history-header">Recent file masks</div>
            {history.map(entry => (
              <div key={entry} className="git-changes-mask-history-row">
                <button
                  type="button"
                  className="git-changes-mask-history-item"
                  onClick={() => {
                    onValueChange(entry);
                    if (!enabled) onEnabledChange(true);
                    setHistoryOpen(false);
                  }}
                  title={entry}
                >
                  {entry}
                </button>
                <button
                  type="button"
                  className="git-changes-mask-history-remove"
                  onClick={e => {
                    e.stopPropagation();
                    onRemoveHistoryEntry(entry);
                  }}
                  title="Remove from history"
                  aria-label="Remove from history"
                >
                  &#10005;
                </button>
              </div>
            ))}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
