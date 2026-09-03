import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useFloating, offset, flip, shift, FloatingPortal,
  useDismiss, useInteractions, autoUpdate,
} from '@floating-ui/react';
import type { PanelHostProps } from '@nimbalyst/extension-sdk';
import {
  GIT_SHOW_OUTPUT_REQUEST_EVENT,
  type GitShowOutputRequestDetail,
} from '@nimbalyst/extension-sdk/git-operation-log';
import { CommitHoverCard } from './CommitHoverCard';
import { CommitContextMenu } from './CommitContextMenu';
import { CommitDetailContent, type CommitDetail } from './CommitDetailContent';
import { BranchPicker } from './BranchPicker';
import { ALL_REPOS, RepoPicker } from './RepoPicker';
import { ChangesTab } from './ChangesTab';
import { OutputTab } from './OutputTab';
import { GitStatusBar } from './GitStatusBar';
import { PanelHideButton } from './PanelHideButton';
import { useOperationLog, getSuggestionForError } from '../hooks/useOperationLog';
import { usePanelState, readSelectedHash } from '../hooks/usePanelState';
import { useSessionsForCommits } from '../hooks/useSessionsForCommits';
import { filterCommits } from '../commitFilters';
import { repoLabels } from '../repoPaths';

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

/**
 * `git:status-changed` payload. The index and ref watchers send `workspacePath`
 * alone; main adds a computed snapshot and a monotonic revision when it
 * refreshes after a Git operation settles, and `repoPath` naming the repository
 * that actually moved (absent on older payloads).
 */
interface GitStatusChangedPayload {
  workspacePath: string;
  repoPath?: string;
  revision?: number;
  status?: GitStatusResult;
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

// Access the generic Electron IPC invoke
const ipc = (window as unknown as {
  electronAPI: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
}).electronAPI;

/** App.tsx listens for this event and routes the session into Agent mode. */
function openSession(sessionId: string, workspacePath: string): void {
  window.dispatchEvent(
    new CustomEvent('open-ai-session', {
      detail: { sessionId, workspacePath },
    }),
  );
}

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

export function GitLogPanel({ host }: PanelHostProps) {
  const workspacePath = host.workspacePath;

  // Every git command in this panel runs against `repoPath`, not the workspace.
  // A single-folder project resolves to one repo equal to the workspace path,
  // so the panel behaves exactly as it did before multi-root workspaces.
  const [repos, setRepos] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(
    () => host.storage.get<string>('selectedRepo') ?? null,
  );
  const [branchByRepo, setBranchByRepo] = useState<Record<string, string>>({});
  // "All repositories" is a Changes-tab scope only. Log and Output stay on one
  // repo -- a merged commit log across repos is meaningless -- so they fall
  // back to the first repo while the scope is ALL.
  const showAllRepos = selectedRepo === ALL_REPOS && repos.length > 1;
  const repoPath = !showAllRepos && selectedRepo && repos.includes(selectedRepo)
    ? selectedRepo
    : repos[0] ?? workspacePath;
  /** Repos the Changes tab renders, in root order. */
  const changesRepos = showAllRepos ? repos : [repoPath];

  // The repo set only changes when a folder is attached or detached, and the
  // host republishes its folder list at the same time -- so that is the signal
  // to re-enumerate rather than a poll.
  useEffect(() => {
    let cancelled = false;
    const loadRepos = async () => {
      try {
        const result = await ipc.invoke('git:list-workspace-repos', workspacePath) as
          { repos?: string[] } | undefined;
        if (!cancelled && Array.isArray(result?.repos)) setRepos(result.repos);
      } catch {
        // Non-fatal: the picker stays hidden and the panel targets the workspace.
      }
    };
    void loadRepos();
    return host.onWorkspaceEvent('workspace:folders-changed', () => { void loadRepos(); });
  }, [host, workspacePath]);

  // Extension storage can hydrate after mount, so the constructor read above
  // may have missed a persisted choice. Take it then -- unless the user has
  // already picked in this session, whose choice must win.
  const repoChoiceDirtyRef = useRef(false);
  useEffect(() => {
    const hydrateSelectedRepo = () => {
      if (repoChoiceDirtyRef.current) return;
      setSelectedRepo(host.storage.get<string>('selectedRepo') ?? null);
    };
    window.addEventListener('nimbalyst:extension-storage-hydrated', hydrateSelectedRepo);
    return () => window.removeEventListener('nimbalyst:extension-storage-hydrated', hydrateSelectedRepo);
  }, [host.storage]);

  const chooseRepo = useCallback((next: string) => {
    repoChoiceDirtyRef.current = true;
    setSelectedRepo(next);
    void host.storage.set('selectedRepo', next);
  }, [host.storage]);

  /** Read each repo's current branch, for the picker's per-repo rows. */
  const loadRepoBranches = useCallback(() => {
    if (repos.length < 2) return;
    void Promise.all(repos.map(async (repo) => {
      try {
        const result = await ipc.invoke('git:status', repo) as GitStatusResult;
        return [repo, result?.branch ?? ''] as const;
      } catch {
        return [repo, ''] as const;
      }
    })).then((entries) => {
      setBranchByRepo(Object.fromEntries(entries.filter(([, branch]) => branch)));
    });
  }, [repos]);

  const [unfilteredCommits, setUnfilteredCommits] = useState<GitCommit[]>([]);
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
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
  const [actionErrorCommand, setActionErrorCommand] = useState<string | undefined>(undefined);
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

  // Selection state - selected commit is persisted by hash via usePanelState;
  // selectedIndex is derived from the current commits list so it stays in sync
  // when commits load, are filtered, or new commits are pulled in.
  const [selectedDetail, setSelectedDetail] = useState<CommitDetail | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);

  // Detail panel resize (persisted globally so it's consistent across workspaces)
  const [detailWidth, setDetailWidth] = useState(() => host.storage.getGlobal<number>('detailWidth') ?? 340);
  const detailResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // The visible tab belongs to the project panel, while a selected commit only
  // makes sense within the repository whose log supplied it.
  const { activeTab, setActiveTab } = usePanelState(workspacePath);
  const { selectedHash, setSelectedHash } = usePanelState(repoPath);
  const commits = useMemo(
    () => filterCommits(unfilteredCommits, searchFilter),
    [unfilteredCommits, searchFilter],
  );
  // Keyed off the fetched page, not the search-filtered view, so typing in the
  // search box re-filters locally instead of refiring the lookup.
  const commitShas = useMemo(() => unfilteredCommits.map(c => c.hash), [unfilteredCommits]);
  const sessionLinks = useSessionsForCommits(commitShas);
  const selectedIndex = useMemo(() => {
    if (!selectedHash) return null;
    const idx = commits.findIndex(c => c.hash === selectedHash);
    return idx >= 0 ? idx : null;
  }, [selectedHash, commits]);
  // Reads the live hash from the module store inside the updater so functional
  // updates always see the current selection, even when called from handlers
  // whose closures are otherwise stale.
  const setSelectedIndex = useCallback(
    (next: number | null | ((prev: number | null) => number | null)) => {
      const liveHash = readSelectedHash(repoPath);
      const liveIndex = liveHash ? commits.findIndex(c => c.hash === liveHash) : -1;
      const prev = liveIndex >= 0 ? liveIndex : null;
      const resolved = typeof next === 'function' ? next(prev) : next;
      if (resolved === null || !commits[resolved]) {
        setSelectedHash(null);
      } else {
        setSelectedHash(commits[resolved].hash);
      }
    },
    [repoPath, commits, setSelectedHash],
  );
  const subscribeToGitEvents = useCallback(
    (event: string, callback: (data: unknown) => void) => host.onWorkspaceEvent(event, callback),
    [host],
  );
  // ChangesTab keys its git:status-changed subscription off this, so it has to be
  // stable -- an inline lambda re-subscribed on every render of this panel, and
  // the panel re-renders on a 1s clock while an operation runs. (#1400)
  const subscribeToWorkspaceEvents = useCallback(
    (event: string, handler: () => void) => host.onWorkspaceEvent(event, handler),
    [host],
  );
  const [changesRefreshToken, setChangesRefreshToken] = useState(0);
  const { entries: logEntries, clearLog, withLog } = useOperationLog(
    repoPath,
    subscribeToGitEvents,
  );
  const runningEntry = useMemo(
    () => [...logEntries].reverse().find(entry => entry.status === 'running'),
    [logEntries],
  );
  const observedRunningIdsRef = useRef(new Set<string>());
  const [terminalPillEntry, setTerminalPillEntry] = useState<typeof runningEntry>();
  const [operationClock, setOperationClock] = useState(Date.now());

  useEffect(() => {
    if (!runningEntry) return;
    observedRunningIdsRef.current.add(runningEntry.id);
    setOperationClock(Date.now());
    const timer = window.setInterval(() => setOperationClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runningEntry?.id]);

  useEffect(() => {
    const latest = logEntries[logEntries.length - 1];
    if (!latest || latest.status === 'running' || !observedRunningIdsRef.current.has(latest.id)) return;
    observedRunningIdsRef.current.delete(latest.id);
    setTerminalPillEntry(latest);
    if (latest.status !== 'success') return;
    const timer = window.setTimeout(() => setTerminalPillEntry(undefined), 4000);
    return () => window.clearTimeout(timer);
  }, [logEntries]);

  const statusPillEntry = runningEntry ?? terminalPillEntry;

  const runningLatestLine = useMemo(() => {
    if (!runningEntry?.output) return undefined;
    const lines = runningEntry.output.split('\n').map(line => line.trim()).filter(Boolean);
    return lines[lines.length - 1];
  }, [runningEntry?.output]);

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
  const fileMaskEnabledDirtyRef = useRef(false);
  const fileMaskInputDirtyRef = useRef(false);
  const fileMaskHistoryDirtyRef = useRef(false);
  useEffect(() => {
    const hydrateFileMaskStorage = () => {
      if (!fileMaskEnabledDirtyRef.current) {
        setFileMaskEnabled(host.storage.get<boolean>('changesFileMaskEnabled') ?? false);
      }
      if (!fileMaskInputDirtyRef.current) {
        setFileMaskInput(host.storage.get<string>('changesFileMask') ?? '');
      }
      if (!fileMaskHistoryDirtyRef.current) {
        setFileMaskHistory(host.storage.getGlobal<string[]>('changesFileMaskHistory') ?? []);
      }
    };
    hydrateFileMaskStorage();
    window.addEventListener('nimbalyst:extension-storage-hydrated', hydrateFileMaskStorage);
    return () => window.removeEventListener('nimbalyst:extension-storage-hydrated', hydrateFileMaskStorage);
  }, [host.storage]);
  const updateFileMaskEnabled = useCallback((enabled: boolean) => {
    fileMaskEnabledDirtyRef.current = true;
    setFileMaskEnabled(enabled);
    void host.storage.set('changesFileMaskEnabled', enabled);
  }, [host.storage]);
  const updateFileMaskInput = useCallback((value: string) => {
    fileMaskInputDirtyRef.current = true;
    setFileMaskInput(value);
    void host.storage.set('changesFileMask', value);
  }, [host.storage]);
  const commitFileMaskToHistory = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    fileMaskHistoryDirtyRef.current = true;
    setFileMaskHistory(prev => {
      const next = [trimmed, ...prev.filter(v => v !== trimmed)].slice(0, 10);
      void host.storage.setGlobal('changesFileMaskHistory', next);
      return next;
    });
  }, [host.storage]);
  const removeFileMaskHistoryEntry = useCallback((value: string) => {
    fileMaskHistoryDirtyRef.current = true;
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

  const showMessage = useCallback((msg: string, isError = false, command?: string) => {
    if (isError) {
      setActionError(msg);
      setActionErrorCommand(command);
      setActionMessage(null);
      // Errors persist until dismissed - do NOT auto-clear
    } else {
      setActionMessage(msg);
      setActionError(null);
      setActionErrorCommand(undefined);
      // Success messages auto-clear after 4s
      setTimeout(() => {
        setActionMessage(null);
      }, 4000);
    }
  }, []);

  const dismissError = useCallback(() => {
    setActionError(null);
    setActionErrorCommand(undefined);
  }, []);

  // The repo the panel is currently showing, readable from an async callback.
  // Every load below captures the repo it asked about and drops its answer if
  // the user has switched since -- a slow `git:log` in a big repo would
  // otherwise repaint the panel with the wrong repo's commits.
  const repoPathRef = useRef(repoPath);
  useEffect(() => {
    repoPathRef.current = repoPath;
  }, [repoPath]);

  const loadBranches = useCallback(async () => {
    const requestedRepo = repoPath;
    try {
      const result = await ipc.invoke('git:branches', requestedRepo) as GitBranchResult;
      if (repoPathRef.current !== requestedRepo) return;
      setBranches(result.branches);
      if (result.current) {
        setSelectedBranch(current => current || result.current);
      }
    } catch {
      // Non-fatal: branch selector stays empty
    }
  }, [repoPath]);

  // Ordering guards for the status snapshot. `generation` stops an older
  // `git:status` response from overwriting a newer one; `appliedRevision` does
  // the same for revisioned snapshots main pushes after an operation settles.
  const statusGenerationRef = useRef(0);
  const appliedStatusGenerationRef = useRef(0);
  const appliedStatusRevisionRef = useRef(-1);

  const applyStatus = useCallback((result: GitStatusResult) => {
    setStatus(result);
    if (result.branch) {
      setSelectedBranch(current => current || result.branch);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    const requested = ++statusGenerationRef.current;
    const requestedRepo = repoPath;
    try {
      const result = await ipc.invoke('git:status', requestedRepo) as GitStatusResult;
      if (repoPathRef.current !== requestedRepo) return;
      if (requested < appliedStatusGenerationRef.current) return;
      appliedStatusGenerationRef.current = requested;
      applyStatus(result);
    } catch {
      // Non-fatal
    }
  }, [applyStatus, repoPath]);

  const loadCommits = useCallback(async () => {
    const requestedRepo = repoPath;
    setLoading(true);
    try {
      const result = await ipc.invoke('git:log', requestedRepo, 100, {
        branch: selectedBranch || undefined,
        aheadBehind: true,
      }) as GitCommit[];

      if (repoPathRef.current !== requestedRepo) return;
      setUnfilteredCommits(result);
    } catch (err) {
      console.error('[GitLogPanel] Failed to load commits:', err);
    } finally {
      // A stale response must not clear the spinner the current request set.
      if (repoPathRef.current === requestedRepo) setLoading(false);
    }
  }, [repoPath, selectedBranch]);

  // Switching repos has to drop the previous repo's branch selection: `git:log`
  // against a branch the new repo does not have returns nothing at all.
  const previousRepoRef = useRef(repoPath);
  useEffect(() => {
    if (previousRepoRef.current === repoPath) return;
    previousRepoRef.current = repoPath;
    setSelectedBranch('');
    setStatus(null);
    setSelectedHash(null);
  }, [repoPath, setSelectedHash]);

  // Initial load
  useEffect(() => {
    loadStatus();
    loadBranches();
  }, [loadStatus, loadBranches]);

  // Reload commits when filters change
  useEffect(() => {
    if (repoPath) {
      loadCommits();
    }
  }, [loadCommits, repoPath]);

  // Auto-refresh when git HEAD changes (commits, checkouts, merges, etc.)
  // Uses PanelHost.onWorkspaceEvent which filters to the current workspace centrally.
  useEffect(() => {
    return host.onWorkspaceEvent('git:status-changed', (data) => {
      const payload = data as GitStatusChangedPayload | undefined;
      // A move in a repo this panel is not showing is not this panel's event.
      // Payloads without `repoPath` predate multi-root and are always ours.
      if (payload?.repoPath && payload.repoPath !== repoPath) return;
      // Main already computed the snapshot when it stamped a revision; taking it
      // directly is what keeps this panel and the menu-bar indicator settling on
      // the same counts instead of racing two independent reads.
      if (payload?.status) {
        if (
          payload.revision === undefined
          || payload.revision > appliedStatusRevisionRef.current
        ) {
          if (payload.revision !== undefined) {
            appliedStatusRevisionRef.current = payload.revision;
          }
          appliedStatusGenerationRef.current = ++statusGenerationRef.current;
          applyStatus(payload.status);
        }
      } else {
        loadStatus();
      }
      loadBranches();
      loadCommits();
    });
  }, [host, repoPath, applyStatus, loadStatus, loadBranches, loadCommits]);

  // The menu-bar Git indicator can ask to show running-command detail. It has no
  // handle on this panel's tab state, so it states the intent and we honour it.
  useEffect(() => {
    const handleShowOutput = (event: Event) => {
      const detail = (event as CustomEvent<GitShowOutputRequestDetail>).detail;
      if (detail?.workspacePath && detail.workspacePath !== workspacePath) return;
      setActiveTab('output');
    };
    window.addEventListener(GIT_SHOW_OUTPUT_REQUEST_EVENT, handleShowOutput);
    return () => window.removeEventListener(GIT_SHOW_OUTPUT_REQUEST_EVENT, handleShowOutput);
  }, [setActiveTab, workspacePath]);

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
        () => ipc.invoke('git:push', repoPath) as Promise<PushResult>,
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
        showMessage(result.error || 'Push failed', true, 'git push origin');
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : 'Push failed', true, 'git push origin');
    } finally {
      setActionLoading(null);
    }
  }, [repoPath, showMessage, loadStatus, loadCommits, withLog]);

  const handlePull = useCallback(async () => {
    setActionLoading('pull');
    const strategyLabel = pullStrategy === 'rebase' ? ' --rebase' : pullStrategy === 'ff-only' ? ' --ff-only' : '';
    try {
      const opts = pullStrategy === 'rebase' ? { rebase: true } : pullStrategy === 'ff-only' ? { ffOnly: true } : {};
      const result = await withLog(
        `git pull${strategyLabel} origin`,
        () => ipc.invoke('git:pull', repoPath, opts) as Promise<PullResult>,
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
        showMessage(result.error || 'Pull failed', true, `git pull${strategyLabel} origin`);
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : 'Pull failed', true, `git pull${strategyLabel} origin`);
    } finally {
      setActionLoading(null);
    }
  }, [repoPath, showMessage, loadStatus, loadCommits, pullStrategy, withLog]);

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
        () => ipc.invoke('git:fetch', repoPath) as Promise<FetchResult>,
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
        showMessage(result.error || 'Fetch failed', true, 'git fetch origin');
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : 'Fetch failed', true, 'git fetch origin');
    } finally {
      setActionLoading(null);
    }
  }, [repoPath, showMessage, loadStatus, withLog]);

  const handleRefresh = useCallback(() => {
    loadStatus();
    loadBranches();
    loadCommits();
    setChangesRefreshToken(t => t + 1);
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
        const detail = await ipc.invoke('git:commit-detail', repoPath, hash) as CommitDetail;
        setCommitDetail(detail);
      } catch {
        // non-fatal
      } finally {
        setDetailLoading(false);
      }
    }, 350);
  }, [repoPath, clearHideTimer, selectedIndex]);

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
    ipc.invoke('git:commit-detail', repoPath, hash)
      .then((d) => { if (!cancelled) setSelectedDetail(d as CommitDetail); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setSelectedLoading(false); });
    return () => { cancelled = true; };
  }, [selectedIndex, commits, repoPath]);

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
  }, [commits.length, setSelectedIndex]);

  const handleRowClick = useCallback((index: number) => {
    setSelectedIndex(i => i === index ? null : index);
    // Dismiss hover card on click
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
    setHoveredHash(null);
  }, [setSelectedIndex]);

  const remoteStatus = status ? (
    status.ahead > 0 || status.behind > 0
      ? `↑${status.ahead} ↓${status.behind}`
      : 'up to date'
  ) : '';

  const hasChanges = status?.hasUncommitted ?? false;
  const isDetachedHead = status?.branch === 'HEAD';
  const detachedHeadMessage = 'Detached HEAD: checkout a branch before pulling or pushing.';

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
              Output
              {runningEntry ? <span className="git-tab-running" /> : null}
              {logEntries.some(e => e.status === 'error') ? <span className="git-tab-dot git-tab-dot--error" /> : null}
            </button>
          </div>

          {/* Repo selector — renders nothing unless the workspace spans repos */}
          <RepoPicker
            repos={repos}
            current={repoPath}
            onChange={chooseRepo}
            branchByRepo={branchByRepo}
            onRequestBranches={loadRepoBranches}
          />

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
          {isDetachedHead && (
            <span className="git-log-remote-status diverged" title={detachedHeadMessage}>
              detached HEAD
            </span>
          )}
        </div>

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

        <div className="git-log-toolbar-actions">
          {statusPillEntry && (
            <button
              type="button"
              className={`git-operation-status-pill git-operation-status-pill--${statusPillEntry.status}`}
              onClick={() => {
                setTerminalPillEntry(undefined);
                setActiveTab('output');
              }}
              title={statusPillEntry.command}
            >
              {statusPillEntry.status === 'running' && <span className="git-output-spinner" />}
              <span className="git-operation-status-label">
                {statusPillEntry.status === 'running'
                  ? `Running ${Math.max(0, Math.floor((operationClock - statusPillEntry.timestamp.getTime()) / 1000))}s`
                  : statusPillEntry.status === 'success'
                    ? `Completed${statusPillEntry.durationMs != null ? ` in ${(statusPillEntry.durationMs / 1000).toFixed(1)}s` : ''}`
                    : `Failed${statusPillEntry.exitCode != null ? ` (exit ${statusPillEntry.exitCode})` : ''}`}
              </span>
              {statusPillEntry.status === 'running' && runningLatestLine && (
                <span className="git-operation-status-line">{runningLatestLine}</span>
              )}
            </button>
          )}
          {/* Action buttons */}
          <button
            className="git-log-action-btn"
            onClick={handlePush}
            disabled={!!actionLoading || isDetachedHead}
            title={isDetachedHead ? detachedHeadMessage : 'Push'}
          >
            {'\u2191 Push'}
          </button>
          <div className="git-log-split-btn">
            <button
              className="git-log-action-btn git-log-split-btn-main"
              onClick={handlePull}
              disabled={!!actionLoading || isDetachedHead}
              title={isDetachedHead ? detachedHeadMessage : `Pull (${pullStrategy})`}
            >
              {'\u2193 Pull'}
            </button>
            <button
              className="git-log-action-btn git-log-split-btn-arrow"
              onClick={() => setPullMenuOpen(v => !v)}
            disabled={!!actionLoading || isDetachedHead}
            title={isDetachedHead ? detachedHeadMessage : 'Pull strategy'}
            aria-label="Pull strategy"
          >
              <svg className="git-log-split-btn-chevron" aria-hidden="true" viewBox="0 0 12 12" width="12" height="12">
                <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
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
            Fetch
          </button>
          <button
            className="git-log-action-btn git-log-action-btn--refresh"
            onClick={handleRefresh}
            disabled={!!actionLoading}
            title="Refresh"
          >
            {'\u21BA'}
          </button>
          <PanelHideButton onHide={() => host.close()} />
        </div>
      </div>

      {/* Status message (visible on all tabs) */}
      <GitStatusBar
        message={actionMessage}
        error={actionError}
        errorCommand={actionErrorCommand}
        onDismissError={dismissError}
        onShowDetails={() => setActiveTab('output')}
      />

      {activeTab === 'log' && (
        <div className="git-log-search-bar">
          <svg className="git-log-search-icon" aria-hidden="true" viewBox="0 0 16 16" width="14" height="14">
            <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="m10.25 10.25 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            className="git-log-search-input"
            type="search"
            placeholder="Search commits by message, author, or hash"
            aria-label="Search commits"
            value={searchFilter}
            onChange={event => setSearchFilter(event.target.value)}
            spellCheck={false}
          />
          {searchFilter && (
            <>
              <span className="git-log-search-count">
                {commits.length} result{commits.length === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                className="git-log-search-clear"
                onClick={() => setSearchFilter('')}
                title="Clear search"
                aria-label="Clear search"
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
          workspacePath={repoPath}
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
              <div className="git-log-empty">
                {unfilteredCommits.length > 0 ? 'No commits match the search' : 'No commits found'}
              </div>
            ) : (
              <table className="git-log-table">
                <thead>
                  <tr>
                    <th className="git-log-th git-log-th--graph" />
                    <th className="git-log-th git-log-th--hash">Hash</th>
                    <th className="git-log-th git-log-th--message">Message</th>
                    <th className="git-log-th git-log-th--author">Author</th>
                    <th className="git-log-th git-log-th--session">Session</th>
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
                        <td className="git-log-td git-log-td--session">
                          {sessionLinks[commit.hash] && (
                            <button
                              type="button"
                              className="git-log-session-chip"
                              title={`Open session: ${sessionLinks[commit.hash].title || 'Untitled session'}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                openSession(sessionLinks[commit.hash].sessionId, workspacePath);
                              }}
                            >
                              {sessionLinks[commit.hash].title || 'Untitled session'}
                            </button>
                          )}
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
                workspacePath={repoPath}
                commitHash={commits[selectedIndex].hash}
                sessionLink={sessionLinks[commits[selectedIndex].hash] ?? null}
                onOpenSession={(sessionId) => openSession(sessionId, workspacePath)}
              />
            </div>
          )}
        </div>
      )}

      {activeTab === 'changes' && (
        changesRepos.length > 1 ? (
          <div className="git-changes-all-repos">
            {changesRepos.map(repo => (
              <RepoChangesSection
                key={repo}
                repoPath={repo}
                label={repoLabels(changesRepos)[repo] ?? repo}
                withLog={withLog}
                onWorkspaceEvent={subscribeToWorkspaceEvents}
                onShowOutput={() => setActiveTab('output')}
                fileMaskEnabled={fileMaskEnabled}
                fileMaskInput={fileMaskInput}
                refreshToken={changesRefreshToken}
              />
            ))}
          </div>
        ) : (
          <ChangesTab
            workspacePath={repoPath}
            withLog={withLog}
            onWorkspaceEvent={subscribeToWorkspaceEvents}
            onShowOutput={() => setActiveTab('output')}
            fileMaskEnabled={fileMaskEnabled}
            fileMaskInput={fileMaskInput}
            refreshToken={changesRefreshToken}
          />
        )
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

/**
 * One repo's working changes under the "All repositories" scope.
 *
 * Wraps the ordinary per-repo `ChangesTab` in a collapsible header rather than
 * merging every repo into one list: a commit cannot cross repos, so each repo
 * keeps its own file list, selection, and commit box. Merging them would need a
 * commit box that silently made N commits, which is the shape this round is
 * removing everywhere else.
 */
function RepoChangesSection({
  repoPath,
  label,
  withLog,
  onWorkspaceEvent,
  onShowOutput,
  fileMaskEnabled,
  fileMaskInput,
  refreshToken,
}: {
  repoPath: string;
  label: string;
} & Omit<React.ComponentProps<typeof ChangesTab>, 'workspacePath' | 'onCountChange'>) {
  const [collapsed, setCollapsed] = useState(false);
  const [count, setCount] = useState<number | null>(null);

  return (
    <div className="git-changes-repo-section">
      <button
        className="git-changes-repo-header"
        onClick={() => setCollapsed(c => !c)}
        title={repoPath}
        aria-expanded={!collapsed}
      >
        <span className="git-changes-repo-caret">{collapsed ? '▸' : '▾'}</span>
        <span className="git-changes-repo-name">{label}</span>
        {/* The count is the cue that another repo has work waiting -- without
            it a collapsed section looks the same whether it is empty or not. */}
        {count !== null && count > 0 && (
          <span className="git-changes-repo-count">{count}</span>
        )}
      </button>
      {!collapsed && (
        <ChangesTab
          workspacePath={repoPath}
          withLog={withLog}
          onWorkspaceEvent={onWorkspaceEvent}
          onShowOutput={onShowOutput}
          fileMaskEnabled={fileMaskEnabled}
          fileMaskInput={fileMaskInput}
          refreshToken={refreshToken}
          onCountChange={setCount}
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
