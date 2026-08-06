import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { DiffPeekPopover } from './DiffPeekPopover';
import { useDiffCache, type DiffGroup } from '../hooks/useDiffCache';
import { SessionsForFilePane } from './SessionsForFilePane';
import { GitStatusBar } from './GitStatusBar';
import {
  buildChangeRows,
  mergeWorkingChanges,
  visibleFilePaths,
  type ChangeRow,
  type WorkingChangesResult,
  type WorkingFile,
} from '../changeList';

// Access the generic Electron IPC invoke
const ipc = (window as unknown as {
  electronAPI: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
}).electronAPI;

interface ChangesTabProps {
  workspacePath: string;
  /** Callback to wrap operations with logging */
  withLog: <T>(
    command: string,
    operation: () => Promise<T>,
    opts?: {
      formatOutput?: (result: T) => string | undefined;
      isError?: (result: T) => boolean;
      getError?: (result: T) => string | undefined;
      formatSuggestion?: (result: T) => string | undefined;
    }
  ) => Promise<T>;
  onWorkspaceEvent: (event: string, handler: () => void) => (() => void);
  /** Switch to the Output tab to show operation details */
  onShowOutput: () => void;
  /** Whether the file mask is enabled (filter applied) */
  fileMaskEnabled: boolean;
  /** Comma-separated glob patterns for the file mask */
  fileMaskInput: string;
}

interface SuccessResult {
  success: boolean;
  error?: string;
  commitHash?: string;
}

const NO_COLLAPSED_DIRS: Set<string> = new Set();

// --- File mask: comma-separated globs, e.g. "*.tsx,*.ts, *.css" ---

function globToRegex(glob: string): RegExp {
  // Escape regex special chars except * and ?
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Convert glob wildcards: ** -> match any path, * -> match any non-slash, ? -> single non-slash
  const pattern = escaped
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${pattern}$`, 'i');
}

function parseFileMask(mask: string): RegExp[] {
  return mask
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(globToRegex);
}

function matchesFileMask(path: string, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return true;
  const basename = path.split('/').pop() ?? path;
  return patterns.some(re => re.test(basename) || re.test(path));
}

// --- Status -> color class for filename (matches FilesEditedSidebar conventions) ---

function statusColorClass(status: string): string {
  switch (status) {
    case 'A': return 'git-changes-name--added';
    case 'D': return 'git-changes-name--deleted';
    case 'M': return 'git-changes-name--modified';
    case 'C': return 'git-changes-name--conflict';
    case '?': return 'git-changes-name--untracked';
    default: return '';
  }
}

const statusTitles: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  '?': 'Untracked',
  C: 'Conflict',
};

function Checkbox({ checked, indeterminate, onChange, disabled, label }: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  disabled?: boolean;
  label?: string;
}) {
  const state = indeterminate ? 'indeterminate' : checked ? 'checked' : 'unchecked';
  return (
    <span
      role="checkbox"
      aria-label={label}
      aria-checked={indeterminate ? 'mixed' : checked}
      tabIndex={disabled ? -1 : 0}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onChange(); }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          onChange();
        }
      }}
      className={`git-changes-checkbox git-changes-checkbox--${state}${disabled ? ' git-changes-checkbox--disabled' : ''}`}
    >
      {state === 'checked' && (
        <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
          <path d="M1 3L3 5L7 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {state === 'indeterminate' && <span className="git-changes-checkbox-dash" />}
    </span>
  );
}

function selectionState(paths: string[], selected: Set<string>): 'none' | 'some' | 'all' {
  if (paths.length === 0) return 'none';
  let count = 0;
  for (const path of paths) if (selected.has(path)) count++;
  if (count === 0) return 'none';
  return count === paths.length ? 'all' : 'some';
}

interface RowRenderOptions {
  selectable: boolean;
  selected: Set<string>;
  toggleSelected: (path: string) => void;
  bulkToggle: (paths: string[], select: boolean) => void;
  toggleDir: (path: string) => void;
  focusedPath: string | null;
  pinnedPath: string | null;
  peekedPath: string | null;
  onRowClick: (path: string, target: HTMLElement) => void;
  registerRowEl: (path: string, el: HTMLElement | null) => void;
}

function ChangeRows({ rows, opts }: { rows: ChangeRow[]; opts: RowRenderOptions }) {
  return (
    <>
      {rows.map(row => {
        const paddingLeft = 8 + row.depth * 12;

        if (row.kind === 'dir') {
          const state = opts.selectable ? selectionState(row.filePaths, opts.selected) : 'none';
          return (
            <div key={`dir:${row.path}`} className="git-changes-dir-row" style={{ paddingLeft }}>
              <button
                type="button"
                className="git-changes-row-chevron"
                onClick={() => opts.toggleDir(row.path)}
                aria-expanded={!row.collapsed}
                aria-label={`${row.collapsed ? 'Expand' : 'Collapse'} ${row.label}`}
              >
                {row.collapsed ? '▶' : '▼'}
              </button>
              <Checkbox
                checked={state === 'all'}
                indeterminate={state === 'some'}
                onChange={() => opts.bulkToggle(row.filePaths, state !== 'all')}
                disabled={!opts.selectable}
                label={row.label}
              />
              <span className="git-changes-dir-name" title={row.path}>{row.label}</span>
              <span className="git-changes-dir-badge">{row.fileCount}</span>
            </div>
          );
        }

        const name = row.path.split('/').pop() ?? row.path;
        const rowClasses = [
          'git-changes-file-row',
          opts.selectable ? '' : 'git-changes-file-row--conflict',
          opts.focusedPath === row.path ? 'git-changes-file-row--focused' : '',
          opts.pinnedPath === row.path ? 'git-changes-file-row--pinned' : '',
          opts.peekedPath === row.path ? 'git-changes-file-row--peeked' : '',
        ].filter(Boolean).join(' ');

        return (
          <div
            key={`file:${row.path}`}
            ref={(el) => opts.registerRowEl(row.path, el)}
            className={rowClasses}
            style={{ paddingLeft }}
            onClick={(e) => opts.onRowClick(row.path, e.currentTarget)}
          >
            <span className="git-changes-row-chevron" />
            <Checkbox
              checked={opts.selected.has(row.path)}
              onChange={() => opts.toggleSelected(row.path)}
              disabled={!opts.selectable}
              label={row.path}
            />
            <span className="git-changes-file-path" title={row.path}>
              {row.dirPrefix && <span className="git-changes-file-dir-prefix">{row.dirPrefix}</span>}
              <span
                className={`git-changes-file-name ${statusColorClass(row.status)}${row.status === 'D' ? ' git-changes-file-name--strike' : ''}`}
                title={statusTitles[row.status] ?? row.status}
              >
                {name}
              </span>
            </span>
            {!opts.selectable && <span className="git-changes-conflict-label">Resolve in editor</span>}
          </div>
        );
      })}
    </>
  );
}

export function ChangesTab({
  workspacePath,
  withLog,
  onWorkspaceEvent,
  onShowOutput,
  fileMaskEnabled,
  fileMaskInput,
}: ChangesTabProps) {
  // One flat list of changes: staged/unstaged/untracked are merged, since the
  // selection (not the index) is what gets committed.
  const [changes, setChanges] = useState<WorkingFile[]>([]);
  const [conflicted, setConflicted] = useState<WorkingFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationLoading, setOperationLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [commitDescription, setCommitDescription] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [changesCollapsed, setChangesCollapsed] = useState(false);
  const [conflictsCollapsed, setConflictsCollapsed] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Directories default to expanded, so only manual collapses are tracked (and
  // persisted). A directory that appears later is therefore expanded by default
  // while collapses the user made survive reloads.
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  // Diff peek / pin / focus state (by path). The popover renders for whichever of
  // pinned or peeked is set (peek wins if both are set, since peek is the more
  // recent intent).
  const [pinnedPath, setPinnedPath] = useState<string | null>(null);
  const [peekedPath, setPeekedPath] = useState<string | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  // Persisted diff peek size (shared with the git commit proposal widget via AI settings).
  const [diffPeekSize, setDiffPeekSizeState] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    ipc.invoke('ai:getSettings')
      .then((settings) => {
        if (cancelled) return;
        const size = (settings as { diffPeekSize?: { width: number; height: number } | null } | null)?.diffPeekSize;
        if (size && typeof size.width === 'number' && typeof size.height === 'number') {
          setDiffPeekSizeState(size);
        }
      })
      .catch(() => { /* not fatal */ });
    return () => { cancelled = true; };
  }, []);
  const diffPeekPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleDiffPeekResize = useCallback((size: { width: number; height: number }) => {
    setDiffPeekSizeState(size);
    if (diffPeekPersistTimerRef.current) clearTimeout(diffPeekPersistTimerRef.current);
    diffPeekPersistTimerRef.current = setTimeout(() => {
      diffPeekPersistTimerRef.current = null;
      ipc.invoke('ai:saveSettings', { diffPeekSize: size }).catch((err) => {
        console.error('[ChangesTab] Failed to persist diff peek size:', err);
      });
    }, 300);
  }, []);
  useEffect(() => {
    return () => {
      if (diffPeekPersistTimerRef.current) clearTimeout(diffPeekPersistTimerRef.current);
    };
  }, []);

  // Token bumped whenever git status changes — invalidates the diff cache.
  const [diffInvalidationToken, setDiffInvalidationToken] = useState(0);

  // Persistent map of paths -> DOM elements, for floating-ui anchoring + scroll-into-view.
  const rowElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const registerRowEl = useCallback((path: string, el: HTMLElement | null) => {
    if (el) rowElsRef.current.set(path, el);
    else rowElsRef.current.delete(path);
  }, []);

  // Sessions pane open/closed state and collapsed directories (persisted per workspace).
  const [sessionsPaneOpen, setSessionsPaneOpen] = useState(true);
  useEffect(() => {
    let cancelled = false;
    ipc.invoke('workspace:get-state', workspacePath)
      .then((state) => {
        if (cancelled) return;
        const stored = (state as {
          gitChanges?: { sessionsPaneOpen?: boolean; collapsedDirs?: string[] };
        } | null)?.gitChanges;
        if (typeof stored?.sessionsPaneOpen === 'boolean') setSessionsPaneOpen(stored.sessionsPaneOpen);
        if (Array.isArray(stored?.collapsedDirs)) setCollapsedDirs(new Set(stored.collapsedDirs));
      })
      .catch(() => { /* not fatal */ });
    return () => { cancelled = true; };
  }, [workspacePath]);

  const persistGitChangesState = useCallback((patch: Record<string, unknown>) => {
    ipc.invoke('workspace:update-state', workspacePath, { gitChanges: patch })
      .catch(() => { /* not fatal */ });
  }, [workspacePath]);

  const toggleSessionsPane = useCallback(() => {
    setSessionsPaneOpen(prev => {
      const next = !prev;
      persistGitChangesState({ sessionsPaneOpen: next });
      return next;
    });
  }, [persistGitChangesState]);

  const toggleDir = useCallback((dirPath: string) => {
    setCollapsedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath); else next.add(dirPath);
      persistGitChangesState({ collapsedDirs: Array.from(next) });
      return next;
    });
  }, [persistGitChangesState]);

  // File mask (controlled by parent panel toolbar)
  const maskPatterns = useMemo(
    () => fileMaskEnabled ? parseFileMask(fileMaskInput) : [],
    [fileMaskEnabled, fileMaskInput],
  );

  const loadChanges = useCallback(async () => {
    try {
      const result = await ipc.invoke('git:working-changes', workspacePath) as WorkingChangesResult;
      setChanges(mergeWorkingChanges(result));
      setConflicted(result.conflicted.map(f => ({ path: f.path, status: 'C' })));
      setLoadError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[ChangesTab] Failed to load changes:', message);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    loadChanges();
  }, [loadChanges]);

  useEffect(() => {
    return onWorkspaceEvent('git:status-changed', () => {
      loadChanges();
      setDiffInvalidationToken(t => t + 1);
    });
  }, [onWorkspaceEvent, loadChanges]);

  // Filtered (mask-applied) lists
  const filteredChanges = useMemo(
    () => changes.filter(f => matchesFileMask(f.path, maskPatterns)),
    [changes, maskPatterns],
  );
  const filteredConflicted = useMemo(
    () => conflicted.filter(f => matchesFileMask(f.path, maskPatterns)),
    [conflicted, maskPatterns],
  );

  // Drop selections that are no longer visible (filtered out or removed from working tree)
  useEffect(() => {
    const visible = new Set(filteredChanges.map(f => f.path));
    setSelected(prev => {
      const next = new Set<string>();
      prev.forEach(p => { if (visible.has(p)) next.add(p); });
      return next.size === prev.size ? prev : next;
    });
  }, [filteredChanges]);

  const showStatus = useCallback((text: string, isError = false) => {
    setStatusMessage({ text, isError });
    if (!isError) {
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, []);

  const runOp = useCallback(async (
    command: string,
    op: () => Promise<SuccessResult>,
    failureLabel: string,
  ): Promise<boolean> => {
    setOperationLoading(true);
    try {
      const result = await withLog(command, op, { isError: r => !r.success, getError: r => r.error });
      if (!result.success) {
        showStatus(result.error || failureLabel, true);
        return false;
      }
      await loadChanges();
      return true;
    } catch (err) {
      showStatus(err instanceof Error ? err.message : failureLabel, true);
      return false;
    } finally {
      setOperationLoading(false);
    }
  }, [withLog, showStatus, loadChanges]);

  const selectedFiles = useMemo(
    () => filteredChanges.filter(f => selected.has(f.path)),
    [filteredChanges, selected],
  );
  const selectedCount = selectedFiles.length;

  // An untracked file has no committed version, so there is nothing to discard —
  // removing it would be `git clean`, which Discard deliberately does not do.
  const discardablePaths = useMemo(
    () => selectedFiles.filter(f => f.status !== '?').map(f => f.path),
    [selectedFiles],
  );

  const handleDiscardSelected = useCallback(async () => {
    if (discardablePaths.length === 0) return;
    const count = discardablePaths.length;
    const label = count === 1 ? discardablePaths[0] : `${count} files`;
    if (!window.confirm(`Discard all changes to ${label}? This cannot be undone.`)) {
      return;
    }
    await runOp(
      `git checkout -- ${count} file${count !== 1 ? 's' : ''}`,
      () => ipc.invoke('git:discard-changes', workspacePath, discardablePaths) as Promise<SuccessResult>,
      'Failed to discard changes',
    );
  }, [discardablePaths, runOp, workspacePath]);

  const handleCommit = useCallback(async () => {
    const fullMessage = commitDescription
      ? `${commitMessage}\n\n${commitDescription}`
      : commitMessage;

    if (!fullMessage.trim()) {
      showStatus('Commit message is required', true);
      messageRef.current?.focus();
      return;
    }

    const paths = selectedFiles.map(f => f.path);
    if (paths.length === 0) {
      showStatus('Select at least one file to commit', true);
      return;
    }

    setIsCommitting(true);
    try {
      // The selected paths are staged into a temporary index by the main process,
      // so exactly these files are committed regardless of the repository's index.
      const result = await withLog(
        `git commit -m "${commitMessage}"`,
        () => ipc.invoke('git:commit', workspacePath, fullMessage, paths) as Promise<SuccessResult>,
        {
          isError: (r) => !r.success,
          getError: (r) => r.error,
          formatOutput: (r) => r.commitHash ? `Committed: ${r.commitHash}` : undefined,
        }
      );

      if (result.success) {
        setCommitMessage('');
        setCommitDescription('');
        showStatus(`Committed ${paths.length} file${paths.length !== 1 ? 's' : ''}`);
      } else {
        showStatus(result.error || 'Commit failed', true);
      }
      await loadChanges();
    } catch (err) {
      showStatus(err instanceof Error ? err.message : 'Commit failed', true);
    } finally {
      setIsCommitting(false);
    }
  }, [workspacePath, commitMessage, commitDescription, selectedFiles, loadChanges, showStatus, withLog]);

  const handleCommitWithAI = useCallback(() => {
    if (selectedFiles.length === 0) return;
    // App.tsx opens a new session seeded with a commit request for exactly these files.
    window.dispatchEvent(new CustomEvent('nimbalyst:commit-with-ai', {
      detail: {
        workspacePath,
        files: selectedFiles.map(f => ({ path: f.path, status: f.status })),
      },
    }));
  }, [selectedFiles, workspacePath]);

  const toggleSelected = useCallback((path: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const bulkToggle = useCallback((paths: string[], select: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (select) paths.forEach(p => next.add(p));
      else paths.forEach(p => next.delete(p));
      return next;
    });
  }, []);

  const totalChanges = changes.length + conflicted.length;
  const filteredTotal = filteredChanges.length + filteredConflicted.length;
  const isAnyLoading = operationLoading || isCommitting;

  const changeRows = useMemo(
    () => buildChangeRows(filteredChanges, collapsedDirs),
    [filteredChanges, collapsedDirs],
  );
  // Conflicts are few and never selectable, so they are always fully expanded.
  const conflictRows = useMemo(
    () => buildChangeRows(filteredConflicted, NO_COLLAPSED_DIRS),
    [filteredConflicted],
  );

  // Navigable rows, in display order. Derived from the rendered rows, so files
  // hidden inside a collapsed directory are never focused.
  const flatRows = useMemo(() => [
    ...(conflictsCollapsed ? [] : visibleFilePaths(conflictRows)),
    ...(changesCollapsed ? [] : visibleFilePaths(changeRows)),
  ], [conflictRows, changeRows, conflictsCollapsed, changesCollapsed]);

  // Collapsing a directory or tightening the file mask can hide the row that
  // focus, peek or pin still points at. Without this, Space/Enter act on a row
  // the user cannot see and the popover anchors to nothing.
  useEffect(() => {
    const visible = new Set(flatRows);
    setFocusedPath(prev => (prev && !visible.has(prev) ? null : prev));
    setPeekedPath(prev => (prev && !visible.has(prev) ? null : prev));
    setPinnedPath(prev => (prev && !visible.has(prev) ? null : prev));
  }, [flatRows]);

  const conflictedPaths = useMemo(
    () => new Set(filteredConflicted.map(f => f.path)),
    [filteredConflicted],
  );

  // The "active file" the popover and sessions pane display: pinned wins, then peeked, then focused.
  const activePath: string | null = pinnedPath ?? peekedPath ?? focusedPath;
  const activeFile = useMemo(
    () => activePath ? { path: activePath, group: 'changes' } : null,
    [activePath],
  );

  // Diff fetch is keyed off the popover target (peek wins over pinned for visual swap).
  const popoverPath: string | null = peekedPath ?? pinnedPath;
  const diffTarget = useMemo(() => {
    if (!popoverPath) return null;
    // 'working' is the combined HEAD-vs-working-tree diff, which is what a merged
    // row represents; conflicts still diff against the index.
    const group: DiffGroup = conflictedPaths.has(popoverPath) ? 'conflicted' : 'working';
    return { path: popoverPath, group };
  }, [popoverPath, conflictedPaths]);
  const diffState = useDiffCache(workspacePath, diffTarget, diffInvalidationToken);

  // Update anchor rect whenever the popover target changes or the row resizes.
  useEffect(() => {
    if (!popoverPath) {
      setAnchorRect(null);
      return;
    }
    const el = rowElsRef.current.get(popoverPath);
    setAnchorRect(el ? el.getBoundingClientRect() : null);
  }, [popoverPath]);

  const closePopover = useCallback(() => {
    setPeekedPath(null);
    setPinnedPath(null);
  }, []);

  const promoteToPin = useCallback(() => {
    setPeekedPath(prev => {
      if (prev) {
        setPinnedPath(prev);
        return null;
      }
      return prev;
    });
  }, []);

  const handleRowClick = useCallback((path: string, target: HTMLElement) => {
    setFocusedPath(path);
    setPeekedPath(null);
    setAnchorRect(target.getBoundingClientRect());
    setPinnedPath(prev => (prev === path ? null : path));
  }, []);

  const togglePeek = useCallback((path: string) => {
    setPeekedPath(prev => {
      if (prev === path) return null;
      const el = rowElsRef.current.get(path);
      if (el) setAnchorRect(el.getBoundingClientRect());
      return path;
    });
  }, []);

  const moveFocus = useCallback((delta: number) => {
    if (flatRows.length === 0) return;
    setFocusedPath(prev => {
      let idx = prev ? flatRows.indexOf(prev) : -1;
      if (idx === -1) idx = delta > 0 ? -1 : flatRows.length;
      const next = flatRows[Math.max(0, Math.min(flatRows.length - 1, idx + delta))];
      if (next) {
        rowElsRef.current.get(next)?.scrollIntoView({ block: 'nearest' });
      }
      return next ?? prev;
    });
  }, [flatRows]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Don't hijack typing in inputs (commit message textarea, etc.)
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === ' ') {
      if (focusedPath) {
        e.preventDefault();
        togglePeek(focusedPath);
      }
    } else if (e.key === 'Enter') {
      if (peekedPath) {
        e.preventDefault();
        promoteToPin();
      } else if (focusedPath && !pinnedPath) {
        e.preventDefault();
        const el = rowElsRef.current.get(focusedPath);
        if (el) setAnchorRect(el.getBoundingClientRect());
        setPinnedPath(focusedPath);
      }
    } else if (e.key === 'Escape') {
      if (peekedPath || pinnedPath) {
        e.preventDefault();
        closePopover();
      }
    }
  }, [focusedPath, peekedPath, pinnedPath, moveFocus, togglePeek, promoteToPin, closePopover]);

  // Open the active file in the editor (used by the popover's "Open in editor" link).
  const handleOpenInEditor = useCallback(() => {
    const target = popoverPath ?? activePath;
    if (!target) return;
    ipc.invoke('workspace:open-file', { workspacePath, filePath: target }).catch((err) => {
      console.error('[ChangesTab] workspace:open-file failed:', err);
    });
  }, [popoverPath, activePath, workspacePath]);

  if (loading) {
    return <div className="git-log-empty">Loading changes...</div>;
  }

  if (loadError) {
    return (
      <div className="git-changes-empty">
        <span className="git-changes-error-title">Failed to load changes</span>
        <span className="git-changes-empty-hint">{loadError}</span>
        <button className="git-changes-retry-btn" onClick={loadChanges}>
          Retry
        </button>
      </div>
    );
  }

  if (totalChanges === 0) {
    return (
      <div className="git-changes-empty">
        <span>No changes</span>
        <span className="git-changes-empty-hint">Working tree is clean.</span>
      </div>
    );
  }

  const allSelectionState = selectionState(filteredChanges.map(f => f.path), selected);

  const rowOptions: RowRenderOptions = {
    selectable: true,
    selected,
    toggleSelected,
    bulkToggle,
    toggleDir,
    focusedPath,
    pinnedPath,
    peekedPath,
    onRowClick: handleRowClick,
    registerRowEl,
  };

  const conflictRowOptions: RowRenderOptions = {
    ...rowOptions,
    selectable: false,
    selected: new Set(),
    toggleSelected: () => {},
    bulkToggle: () => {},
    toggleDir: () => {},
  };

  return (
    <div
      className="git-changes-tab"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="git-changes-keyhint">
        <span><kbd>↑↓</kbd> navigate</span>
        <span className="git-changes-keyhint-sep">·</span>
        <span><kbd>Space</kbd> peek</span>
        <span className="git-changes-keyhint-sep">·</span>
        <span><kbd>Enter</kbd> pin</span>
        <span className="git-changes-keyhint-sep">·</span>
        <span><kbd>Esc</kbd> close</span>
      </div>
      <GitStatusBar
        message={statusMessage && !statusMessage.isError ? statusMessage.text : null}
        error={statusMessage?.isError ? statusMessage.text : null}
        onDismissError={() => setStatusMessage(null)}
        onShowDetails={onShowOutput}
      />

      {filteredTotal === 0 && (
        <div className="git-changes-empty">
          <span>No matching files</span>
          <span className="git-changes-empty-hint">
            {totalChanges} change{totalChanges !== 1 ? 's' : ''} hidden by file mask.
          </span>
        </div>
      )}

      <div className="git-changes-body">
        <div className="git-changes-files">
          {filteredConflicted.length > 0 && (
            <div className="git-changes-group git-changes-group--conflict">
              <div
                className="git-changes-group-header git-changes-group-header--conflict"
                onClick={() => setConflictsCollapsed(v => !v)}
              >
                <span className="git-changes-group-chevron">{conflictsCollapsed ? '▶' : '▼'}</span>
                <span className="git-changes-group-label">Conflicts ({filteredConflicted.length})</span>
              </div>
              {!conflictsCollapsed && <ChangeRows rows={conflictRows} opts={conflictRowOptions} />}
            </div>
          )}

          {filteredChanges.length > 0 && (
            <div className="git-changes-group">
              <div
                className="git-changes-group-header git-changes-group-header--list"
                onClick={() => setChangesCollapsed(v => !v)}
              >
                <span className="git-changes-group-chevron">{changesCollapsed ? '▶' : '▼'}</span>
                <Checkbox
                  checked={allSelectionState === 'all'}
                  indeterminate={allSelectionState === 'some'}
                  label="Select all changes"
                  onChange={() => bulkToggle(
                    filteredChanges.map(f => f.path),
                    allSelectionState !== 'all',
                  )}
                />
                <span className="git-changes-group-label">Changes ({filteredChanges.length})</span>
                <button
                  className="git-changes-group-action git-changes-group-action--danger"
                  onClick={(e) => { e.stopPropagation(); handleDiscardSelected(); }}
                  disabled={isAnyLoading || discardablePaths.length === 0}
                  title="Discard changes to the selected tracked files"
                >
                  {discardablePaths.length > 0 ? `Discard (${discardablePaths.length})` : 'Discard'}
                </button>
              </div>
              {!changesCollapsed && <ChangeRows rows={changeRows} opts={rowOptions} />}
            </div>
          )}
        </div>

        {/* Sessions pane */}
        {sessionsPaneOpen && (
          <SessionsForFilePane
            workspacePath={workspacePath}
            activeFile={activeFile}
            onCollapse={toggleSessionsPane}
          />
        )}
        {!sessionsPaneOpen && (
          <button
            type="button"
            className="git-changes-sessions-pane-reopen"
            onClick={toggleSessionsPane}
            title="Show sessions that edited this file"
          >
            ◀
          </button>
        )}

        {/* Commit area */}
        <div className="git-changes-commit">
          <div className="git-changes-commit-label">COMMIT MESSAGE</div>
          <textarea
            ref={messageRef}
            className="git-changes-commit-input"
            placeholder="Summary (required)"
            value={commitMessage}
            onChange={e => setCommitMessage(e.target.value)}
            rows={2}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleCommit();
              }
            }}
          />
          <textarea
            className="git-changes-commit-input git-changes-commit-description"
            placeholder="Description"
            value={commitDescription}
            onChange={e => setCommitDescription(e.target.value)}
            rows={2}
          />
          <div className="git-changes-commit-actions">
            <button
              className="git-changes-commit-btn"
              onClick={handleCommit}
              disabled={isCommitting || selectedCount === 0 || !commitMessage.trim()}
            >
              {isCommitting ? 'Committing...' : `Commit (${selectedCount})`}
            </button>
            <button
              className="git-changes-commit-ai-btn"
              onClick={handleCommitWithAI}
              disabled={selectedCount === 0}
              title="Open a new session that writes the message and commits these files"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2l1.9 5.6L19.5 9.5 13.9 11.4 12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z" />
                <path d="M18.5 14.5l.85 2.15L21.5 17.5l-2.15.85L18.5 20.5l-.85-2.15L15.5 17.5l2.15-.85.85-2.15z" />
              </svg>
              Commit with AI
            </button>
          </div>
          <div className="git-changes-commit-summary">
            {selectedCount > 0
              ? `${selectedCount} file${selectedCount !== 1 ? 's' : ''} selected · committed exactly as selected`
              : 'Select files to commit'}
          </div>
        </div>
      </div>

      {diffTarget && anchorRect && (
        <DiffPeekPopover
          anchorRect={anchorRect}
          filePath={diffTarget.path}
          mode={peekedPath ? 'peek' : 'pinned'}
          diff={diffState.diff}
          isBinary={diffState.isBinary}
          loading={diffState.loading}
          error={diffState.error}
          onClose={closePopover}
          onPin={promoteToPin}
          onOpenInEditor={handleOpenInEditor}
          width={diffPeekSize?.width}
          height={diffPeekSize?.height}
          onResize={handleDiffPeekResize}
        />
      )}
    </div>
  );
}
