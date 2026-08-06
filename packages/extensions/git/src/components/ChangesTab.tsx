import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { DiffPeekPopover } from './DiffPeekPopover';
import { useDiffCache } from '../hooks/useDiffCache';
import { SessionsForFilePane } from './SessionsForFilePane';
import { GitStatusBar } from './GitStatusBar';

// Access the generic Electron IPC invoke
const ipc = (window as unknown as {
  electronAPI: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
}).electronAPI;

interface RowKey {
  path: string;
  group: Group;
}

function rowKeysEqual(a: RowKey | null, b: RowKey | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.path === b.path && a.group === b.group;
}

interface WorkingFile {
  path: string;
  status: string; // M, A, D, ?, C
  /** Repo-root-absolute path (may differ from `path` when workspacePath is a subfolder of the repo, #124). */
  absolutePath?: string;
}

interface WorkingChangesResult {
  staged: Array<{ path: string; status: string; absolutePath?: string }>;
  unstaged: Array<{ path: string; status: string; absolutePath?: string }>;
  untracked: Array<{ path: string; absolutePath?: string }>;
  conflicted: Array<{ path: string; absolutePath?: string }>;
}

type Group = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

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

// --- Directory tree with path collapsing ---

interface DirNode {
  path: string;
  displayPath: string;
  files: WorkingFile[];
  subdirectories: Map<string, DirNode>;
}

function buildDirTree(files: WorkingFile[]): DirNode {
  const root: DirNode = { path: '', displayPath: '', files: [], subdirectories: new Map() };
  for (const file of files) {
    const parts = file.path.split('/');
    if (parts.length === 1) { root.files.push(file); continue; }
    let current = root;
    parts.slice(0, -1).forEach((part, index) => {
      const pathSoFar = parts.slice(0, index + 1).join('/');
      if (!current.subdirectories.has(part)) {
        current.subdirectories.set(part, { path: pathSoFar, displayPath: part, files: [], subdirectories: new Map() });
      }
      current = current.subdirectories.get(part)!;
    });
    current.files.push(file);
  }
  return collapseDirTree(root);
}

function collapseDirTree(node: DirNode): DirNode {
  node.subdirectories.forEach((subdir, key) => {
    node.subdirectories.set(key, collapseDirTree(subdir));
  });
  if (node.subdirectories.size === 1 && node.files.length === 0) {
    const [, child] = Array.from(node.subdirectories.entries())[0];
    return { ...child, displayPath: node.displayPath ? `${node.displayPath}/${child.displayPath}` : child.displayPath };
  }
  return node;
}

function Checkbox({ checked, indeterminate, onChange, disabled }: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  const state = indeterminate ? 'indeterminate' : checked ? 'checked' : 'unchecked';
  return (
    <span
      role="checkbox"
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

function dirSelectionState(
  node: DirNode,
  selected: Set<string>,
  group: Group,
): 'none' | 'some' | 'all' {
  if (group === 'conflicted') return 'none';
  const paths = collectPaths(node);
  if (paths.length === 0) return 'none';
  let selectedCount = 0;
  for (const p of paths) if (selected.has(p)) selectedCount++;
  if (selectedCount === 0) return 'none';
  if (selectedCount === paths.length) return 'all';
  return 'some';
}

interface TreeRenderOptions {
  selected: Set<string>;
  toggleSelected: (path: string) => void;
  bulkToggle: (paths: string[], select: boolean) => void;
  focusedRow: RowKey | null;
  pinnedRow: RowKey | null;
  peekedRow: RowKey | null;
  onRowClick: (key: RowKey, target: HTMLElement) => void;
  registerRowEl: (key: RowKey, el: HTMLElement | null) => void;
}

function renderFileTree(
  node: DirNode,
  depth: number,
  group: Group,
  opts: TreeRenderOptions,
): React.ReactNode {
  const subdirs = Array.from(node.subdirectories.values()).sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  const sortedFiles = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
  const childDepth = node.displayPath ? depth + 1 : depth;
  const dirState = node.displayPath ? dirSelectionState(node, opts.selected, group) : 'none';
  const dirPaths = node.displayPath ? collectPaths(node) : [];
  const conflict = group === 'conflicted';
  return (
    <>
      {node.displayPath && (
        <div className="git-changes-dir-row" style={{ paddingLeft: depth * 12 + 24 }}>
          <Checkbox
            checked={dirState === 'all'}
            indeterminate={dirState === 'some'}
            onChange={() => opts.bulkToggle(dirPaths, dirState !== 'all')}
            disabled={conflict}
          />
          <span className="git-changes-dir-name">{node.displayPath}/</span>
        </div>
      )}
      {subdirs.map(sub => (
        <React.Fragment key={sub.path}>
          {renderFileTree(sub, childDepth, group, opts)}
        </React.Fragment>
      ))}
      {sortedFiles.map(file => {
        const name = file.path.split('/').pop() ?? file.path;
        const isSelected = opts.selected.has(file.path);
        const conflict = group === 'conflicted';
        const rowKey: RowKey = { path: file.path, group };
        const isFocused = rowKeysEqual(opts.focusedRow, rowKey);
        const isPinned = rowKeysEqual(opts.pinnedRow, rowKey);
        const isPeeked = rowKeysEqual(opts.peekedRow, rowKey);
        const rowClasses = [
          'git-changes-file-row',
          conflict ? 'git-changes-file-row--conflict' : '',
          isFocused ? 'git-changes-file-row--focused' : '',
          isPinned ? 'git-changes-file-row--pinned' : '',
          isPeeked ? 'git-changes-file-row--peeked' : '',
        ].filter(Boolean).join(' ');
        return (
          <div
            key={file.path}
            ref={(el) => opts.registerRowEl(rowKey, el)}
            className={rowClasses}
            style={{ paddingLeft: childDepth * 12 + 24 }}
            onClick={(e) => opts.onRowClick(rowKey, e.currentTarget)}
          >
            <Checkbox
              checked={isSelected}
              onChange={() => opts.toggleSelected(file.path)}
              disabled={conflict}
            />
            <span
              className={`git-changes-file-name ${statusColorClass(file.status)}${file.status === 'D' ? ' git-changes-file-name--strike' : ''}`}
              title={statusTitles[file.status] ?? file.status}
            >
              {name}
            </span>
            {conflict && <span className="git-changes-conflict-label">Resolve in editor</span>}
          </div>
        );
      })}
    </>
  );
}

function collectPaths(node: DirNode): string[] {
  const out: string[] = [];
  node.files.forEach(f => out.push(f.path));
  node.subdirectories.forEach(sub => out.push(...collectPaths(sub)));
  return out;
}

export function ChangesTab({
  workspacePath,
  withLog,
  onWorkspaceEvent,
  onShowOutput,
  fileMaskEnabled,
  fileMaskInput,
}: ChangesTabProps) {
  const [staged, setStaged] = useState<WorkingFile[]>([]);
  const [unstaged, setUnstaged] = useState<WorkingFile[]>([]);
  const [untracked, setUntracked] = useState<WorkingFile[]>([]);
  const [conflicted, setConflicted] = useState<WorkingFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationLoading, setOperationLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [commitDescription, setCommitDescription] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  // Per-group selection state (paths)
  const [selectedStaged, setSelectedStaged] = useState<Set<string>>(new Set());
  const [selectedUnstaged, setSelectedUnstaged] = useState<Set<string>>(new Set());
  const [selectedUntracked, setSelectedUntracked] = useState<Set<string>>(new Set());

  // Diff peek / pin / focus state. The popover renders for whichever of pinned or
  // peeked is set (peek wins if both are set, since peek is the more recent intent).
  const [pinnedRow, setPinnedRow] = useState<RowKey | null>(null);
  const [peekedRow, setPeekedRow] = useState<RowKey | null>(null);
  const [focusedRow, setFocusedRow] = useState<RowKey | null>(null);
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

  // Persistent map of row keys -> DOM elements, for floating-ui anchoring + scroll-into-view.
  const rowElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const rowKeyToString = (k: RowKey) => `${k.group}|${k.path}`;
  const registerRowEl = useCallback((key: RowKey, el: HTMLElement | null) => {
    const k = rowKeyToString(key);
    if (el) rowElsRef.current.set(k, el);
    else rowElsRef.current.delete(k);
  }, []);

  // Sessions pane open/closed state (persisted via workspace state IPC).
  const [sessionsPaneOpen, setSessionsPaneOpen] = useState(true);
  useEffect(() => {
    let cancelled = false;
    ipc.invoke('workspace:get-state', workspacePath)
      .then((state) => {
        if (cancelled) return;
        const stored = (state as { gitChanges?: { sessionsPaneOpen?: boolean } } | null)?.gitChanges?.sessionsPaneOpen;
        if (typeof stored === 'boolean') setSessionsPaneOpen(stored);
      })
      .catch(() => { /* not fatal */ });
    return () => { cancelled = true; };
  }, [workspacePath]);
  const toggleSessionsPane = useCallback(() => {
    setSessionsPaneOpen(prev => {
      const next = !prev;
      ipc.invoke('workspace:update-state', workspacePath, { gitChanges: { sessionsPaneOpen: next } })
        .catch(() => { /* not fatal */ });
      return next;
    });
  }, [workspacePath]);

  // File mask (controlled by parent panel toolbar)
  const maskPatterns = useMemo(
    () => fileMaskEnabled ? parseFileMask(fileMaskInput) : [],
    [fileMaskEnabled, fileMaskInput],
  );

  const loadChanges = useCallback(async () => {
    try {
      const result = await ipc.invoke('git:working-changes', workspacePath) as WorkingChangesResult;
      setStaged(result.staged.map(f => ({ path: f.path, status: f.status, absolutePath: f.absolutePath })));
      setUnstaged(result.unstaged.map(f => ({ path: f.path, status: f.status, absolutePath: f.absolutePath })));
      setUntracked(result.untracked.map(f => ({ path: f.path, status: '?', absolutePath: f.absolutePath })));
      setConflicted(result.conflicted.map(f => ({ path: f.path, status: 'C', absolutePath: f.absolutePath })));
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
  const filteredStaged = useMemo(() => staged.filter(f => matchesFileMask(f.path, maskPatterns)), [staged, maskPatterns]);
  const filteredUnstaged = useMemo(() => unstaged.filter(f => matchesFileMask(f.path, maskPatterns)), [unstaged, maskPatterns]);
  const filteredUntracked = useMemo(() => untracked.filter(f => matchesFileMask(f.path, maskPatterns)), [untracked, maskPatterns]);
  const filteredConflicted = useMemo(() => conflicted.filter(f => matchesFileMask(f.path, maskPatterns)), [conflicted, maskPatterns]);

  // Drop selections that are no longer visible (filtered out or removed from working tree)
  useEffect(() => {
    const visible = new Set(filteredStaged.map(f => f.path));
    setSelectedStaged(prev => {
      const next = new Set<string>();
      prev.forEach(p => { if (visible.has(p)) next.add(p); });
      return next.size === prev.size ? prev : next;
    });
  }, [filteredStaged]);
  useEffect(() => {
    const visible = new Set(filteredUnstaged.map(f => f.path));
    setSelectedUnstaged(prev => {
      const next = new Set<string>();
      prev.forEach(p => { if (visible.has(p)) next.add(p); });
      return next.size === prev.size ? prev : next;
    });
  }, [filteredUnstaged]);
  useEffect(() => {
    const visible = new Set(filteredUntracked.map(f => f.path));
    setSelectedUntracked(prev => {
      const next = new Set<string>();
      prev.forEach(p => { if (visible.has(p)) next.add(p); });
      return next.size === prev.size ? prev : next;
    });
  }, [filteredUntracked]);

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

  const stagePaths = useCallback((paths: string[]) => {
    if (paths.length === 0) return Promise.resolve(false);
    return runOp(
      `git add ${paths.length} file${paths.length !== 1 ? 's' : ''}`,
      () => ipc.invoke('git:stage', workspacePath, paths) as Promise<SuccessResult>,
      'Failed to stage files',
    );
  }, [runOp, workspacePath]);

  const unstagePaths = useCallback((paths: string[]) => {
    if (paths.length === 0) return Promise.resolve(false);
    return runOp(
      `git reset HEAD -- ${paths.length} file${paths.length !== 1 ? 's' : ''}`,
      () => ipc.invoke('git:unstage', workspacePath, paths) as Promise<SuccessResult>,
      'Failed to unstage files',
    );
  }, [runOp, workspacePath]);

  const discardPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return false;
    const label = paths.length === 1 ? paths[0] : `${paths.length} files`;
    if (!window.confirm(`Discard all changes to ${label}? This cannot be undone.`)) {
      return false;
    }
    return runOp(
      `git checkout -- ${paths.length} file${paths.length !== 1 ? 's' : ''}`,
      () => ipc.invoke('git:discard-changes', workspacePath, paths) as Promise<SuccessResult>,
      'Failed to discard changes',
    );
  }, [runOp, workspacePath]);

  // "If selection is empty, act on all visible files in the group"
  const effectivePaths = useCallback((selected: Set<string>, all: WorkingFile[]) => {
    if (selected.size === 0) return all.map(f => f.path);
    return all.filter(f => selected.has(f.path)).map(f => f.path);
  }, []);

  const handleStageGroup = useCallback(async (selected: Set<string>, all: WorkingFile[]) => {
    const paths = effectivePaths(selected, all);
    await stagePaths(paths);
  }, [effectivePaths, stagePaths]);

  const handleUnstageGroup = useCallback(async () => {
    const paths = effectivePaths(selectedStaged, filteredStaged);
    await unstagePaths(paths);
  }, [effectivePaths, selectedStaged, filteredStaged, unstagePaths]);

  const handleDiscardGroup = useCallback(async () => {
    const paths = effectivePaths(selectedUnstaged, filteredUnstaged);
    await discardPaths(paths);
  }, [effectivePaths, selectedUnstaged, filteredUnstaged, discardPaths]);

  const handleCommit = useCallback(async () => {
    const fullMessage = commitDescription
      ? `${commitMessage}\n\n${commitDescription}`
      : commitMessage;

    if (!fullMessage.trim()) {
      showStatus('Commit message is required', true);
      messageRef.current?.focus();
      return;
    }

    if (staged.length === 0) {
      showStatus('No files staged for commit', true);
      return;
    }

    setIsCommitting(true);
    try {
      const result = await withLog(
        `git commit -m "${commitMessage}"`,
        () => ipc.invoke('git:commit', workspacePath, fullMessage, []) as Promise<SuccessResult>,
        {
          isError: (r) => !r.success,
          getError: (r) => r.error,
          formatOutput: (r) => r.commitHash ? `Committed: ${r.commitHash}` : undefined,
        }
      );

      if (result.success) {
        setCommitMessage('');
        setCommitDescription('');
        showStatus(`Committed ${staged.length} file${staged.length !== 1 ? 's' : ''}`);
      } else {
        showStatus(result.error || 'Commit failed', true);
      }
      await loadChanges();
    } catch (err) {
      showStatus(err instanceof Error ? err.message : 'Commit failed', true);
    } finally {
      setIsCommitting(false);
    }
  }, [workspacePath, commitMessage, commitDescription, staged, loadChanges, showStatus, withLog]);

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  }, []);

  // Toggle helpers for group-header "select all" checkboxes
  const groupSelectionState = (selected: Set<string>, all: WorkingFile[]): 'none' | 'some' | 'all' => {
    if (all.length === 0 || selected.size === 0) return 'none';
    if (selected.size >= all.length) return 'all';
    return 'some';
  };

  const toggleAllInGroup = (
    selected: Set<string>,
    setSelected: React.Dispatch<React.SetStateAction<Set<string>>>,
    all: WorkingFile[],
  ) => {
    const state = groupSelectionState(selected, all);
    if (state === 'all') {
      setSelected(new Set());
    } else {
      setSelected(new Set(all.map(f => f.path)));
    }
  };

  const makeToggle = (setSet: React.Dispatch<React.SetStateAction<Set<string>>>) =>
    (path: string) => {
      setSet(prev => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
      });
    };

  const makeBulkToggle = (setSet: React.Dispatch<React.SetStateAction<Set<string>>>) =>
    (paths: string[], select: boolean) => {
      setSet(prev => {
        const next = new Set(prev);
        if (select) paths.forEach(p => next.add(p));
        else paths.forEach(p => next.delete(p));
        return next;
      });
    };

  const totalChanges = staged.length + unstaged.length + untracked.length + conflicted.length;
  const filteredTotal = filteredStaged.length + filteredUnstaged.length + filteredUntracked.length + filteredConflicted.length;
  const isAnyLoading = operationLoading || isCommitting;

  const stagedTree = useMemo(() => buildDirTree(filteredStaged), [filteredStaged]);
  const unstagedTree = useMemo(() => buildDirTree(filteredUnstaged), [filteredUnstaged]);
  const untrackedTree = useMemo(() => buildDirTree(filteredUntracked), [filteredUntracked]);
  const conflictedTree = useMemo(() => buildDirTree(filteredConflicted), [filteredConflicted]);

  // Flat row list (in tree-display order) for ↑/↓ keyboard navigation.
  const flatRows = useMemo(() => {
    const out: RowKey[] = [];
    const collect = (node: DirNode, group: Group) => {
      const subdirs = Array.from(node.subdirectories.values()).sort((a, b) => a.displayPath.localeCompare(b.displayPath));
      const sortedFiles = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
      for (const sub of subdirs) collect(sub, group);
      for (const f of sortedFiles) out.push({ path: f.path, group });
    };
    if (!collapsedGroups.has('conflicted') && filteredConflicted.length > 0) collect(conflictedTree, 'conflicted');
    if (!collapsedGroups.has('staged') && filteredStaged.length > 0) collect(stagedTree, 'staged');
    if (!collapsedGroups.has('unstaged') && filteredUnstaged.length > 0) collect(unstagedTree, 'unstaged');
    if (!collapsedGroups.has('untracked') && filteredUntracked.length > 0) collect(untrackedTree, 'untracked');
    return out;
  }, [stagedTree, unstagedTree, untrackedTree, conflictedTree, collapsedGroups, filteredStaged, filteredUnstaged, filteredUntracked, filteredConflicted]);

  // The "active file" the popover and sessions pane display: pinned wins, then peeked, then focused.
  const activeRow: RowKey | null = pinnedRow ?? peekedRow ?? focusedRow;

  // Diff fetch is keyed off the popover target (peek wins over pinned for visual swap).
  const popoverTarget: RowKey | null = peekedRow ?? pinnedRow;
  const diffState = useDiffCache(workspacePath, popoverTarget, diffInvalidationToken);

  const measureAnchor = useCallback((key: RowKey | null): DOMRect | null => {
    if (!key) return null;
    const el = rowElsRef.current.get(`${key.group}|${key.path}`);
    return el ? el.getBoundingClientRect() : null;
  }, []);

  // Update anchor rect whenever the popover target changes or the row resizes.
  useEffect(() => {
    if (!popoverTarget) {
      setAnchorRect(null);
      return;
    }
    setAnchorRect(measureAnchor(popoverTarget));
  }, [popoverTarget, measureAnchor]);

  const closePopover = useCallback(() => {
    setPeekedRow(null);
    setPinnedRow(null);
  }, []);

  const promoteToPin = useCallback(() => {
    setPeekedRow(prev => {
      if (prev) {
        setPinnedRow(prev);
        return null;
      }
      return prev;
    });
  }, []);

  const handleRowClick = useCallback((key: RowKey, target: HTMLElement) => {
    setFocusedRow(key);
    setPeekedRow(null);
    setAnchorRect(target.getBoundingClientRect());
    setPinnedRow(prev => (rowKeysEqual(prev, key) ? null : key));
  }, []);

  const togglePeek = useCallback((key: RowKey) => {
    setPeekedRow(prev => {
      if (rowKeysEqual(prev, key)) return null;
      const el = rowElsRef.current.get(`${key.group}|${key.path}`);
      if (el) setAnchorRect(el.getBoundingClientRect());
      return key;
    });
  }, []);

  const moveFocus = useCallback((delta: number) => {
    if (flatRows.length === 0) return;
    setFocusedRow(prev => {
      let idx = prev ? flatRows.findIndex(r => rowKeysEqual(r, prev)) : -1;
      if (idx === -1) idx = delta > 0 ? -1 : flatRows.length;
      const next = flatRows[Math.max(0, Math.min(flatRows.length - 1, idx + delta))];
      if (next) {
        const el = rowElsRef.current.get(`${next.group}|${next.path}`);
        el?.scrollIntoView({ block: 'nearest' });
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
      if (focusedRow) {
        e.preventDefault();
        togglePeek(focusedRow);
      }
    } else if (e.key === 'Enter') {
      if (peekedRow) {
        e.preventDefault();
        promoteToPin();
      } else if (focusedRow && !pinnedRow) {
        e.preventDefault();
        const el = rowElsRef.current.get(`${focusedRow.group}|${focusedRow.path}`);
        if (el) setAnchorRect(el.getBoundingClientRect());
        setPinnedRow(focusedRow);
      }
    } else if (e.key === 'Escape') {
      if (peekedRow || pinnedRow) {
        e.preventDefault();
        closePopover();
      }
    }
  }, [focusedRow, peekedRow, pinnedRow, moveFocus, togglePeek, promoteToPin, closePopover]);

  // Open the active file in the editor (used by the popover's "Open in editor" link).
  // `target.path` is repo-root-relative; resolve the matching absolutePath (joined
  // against gitRoot) so this still works when workspacePath is a subfolder of the
  // repo (#124). Falls back to the relative path if absolutePath wasn't returned.
  const handleOpenInEditor = useCallback(() => {
    const target = popoverTarget ?? activeRow;
    if (!target) return;
    const groupFiles = target.group === 'staged' ? staged
      : target.group === 'unstaged' ? unstaged
        : target.group === 'untracked' ? untracked
          : conflicted;
    const filePath = groupFiles.find(f => f.path === target.path)?.absolutePath ?? target.path;
    ipc.invoke('workspace:open-file', { workspacePath, filePath }).catch((err) => {
      console.error('[ChangesTab] workspace:open-file failed:', err);
    });
  }, [popoverTarget, activeRow, workspacePath, staged, unstaged, untracked, conflicted]);

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

  const stagedSelState = groupSelectionState(selectedStaged, filteredStaged);
  const unstagedSelState = groupSelectionState(selectedUnstaged, filteredUnstaged);
  const untrackedSelState = groupSelectionState(selectedUntracked, filteredUntracked);

  const treeOptionsFor = (
    selected: Set<string>,
    setSelected: React.Dispatch<React.SetStateAction<Set<string>>>,
  ): TreeRenderOptions => ({
    selected,
    toggleSelected: makeToggle(setSelected),
    bulkToggle: makeBulkToggle(setSelected),
    focusedRow,
    pinnedRow,
    peekedRow,
    onRowClick: handleRowClick,
    registerRowEl,
  });

  const conflictedTreeOptions: TreeRenderOptions = {
    selected: new Set(),
    toggleSelected: () => {},
    bulkToggle: () => {},
    focusedRow,
    pinnedRow,
    peekedRow,
    onRowClick: handleRowClick,
    registerRowEl,
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
          {/* Conflicted */}
          {filteredConflicted.length > 0 && (
            <div className="git-changes-group">
              <div
                className="git-changes-group-header git-changes-group-header--conflict"
                onClick={() => toggleGroup('conflicted')}
              >
                <span className="git-changes-group-chevron">{collapsedGroups.has('conflicted') ? '▶' : '▼'}</span>
                <span className="git-changes-group-label">Conflicts ({filteredConflicted.length})</span>
              </div>
              {!collapsedGroups.has('conflicted') &&
                renderFileTree(conflictedTree, 0, 'conflicted', conflictedTreeOptions)}
            </div>
          )}

          {/* Staged */}
          {filteredStaged.length > 0 && (
            <div className="git-changes-group">
              <div className="git-changes-group-header" onClick={() => toggleGroup('staged')}>
                <span className="git-changes-group-chevron">{collapsedGroups.has('staged') ? '▶' : '▼'}</span>
                <Checkbox
                  checked={stagedSelState === 'all'}
                  indeterminate={stagedSelState === 'some'}
                  onChange={() => toggleAllInGroup(selectedStaged, setSelectedStaged, filteredStaged)}
                />
                <span className="git-changes-group-label">Staged Changes ({filteredStaged.length})</span>
                <button
                  className="git-changes-group-action"
                  onClick={(e) => { e.stopPropagation(); handleUnstageGroup(); }}
                  disabled={isAnyLoading}
                >
                  {selectedStaged.size > 0 ? `Unstage Selected (${selectedStaged.size})` : 'Unstage All'}
                </button>
              </div>
              {!collapsedGroups.has('staged') &&
                renderFileTree(stagedTree, 0, 'staged', treeOptionsFor(selectedStaged, setSelectedStaged))}
            </div>
          )}

          {/* Unstaged */}
          {filteredUnstaged.length > 0 && (
            <div className="git-changes-group">
              <div className="git-changes-group-header" onClick={() => toggleGroup('unstaged')}>
                <span className="git-changes-group-chevron">{collapsedGroups.has('unstaged') ? '▶' : '▼'}</span>
                <Checkbox
                  checked={unstagedSelState === 'all'}
                  indeterminate={unstagedSelState === 'some'}
                  onChange={() => toggleAllInGroup(selectedUnstaged, setSelectedUnstaged, filteredUnstaged)}
                />
                <span className="git-changes-group-label">Changes ({filteredUnstaged.length})</span>
                <button
                  className="git-changes-group-action"
                  onClick={(e) => { e.stopPropagation(); handleStageGroup(selectedUnstaged, filteredUnstaged); }}
                  disabled={isAnyLoading}
                >
                  {selectedUnstaged.size > 0 ? `Stage Selected (${selectedUnstaged.size})` : 'Stage All'}
                </button>
                <button
                  className="git-changes-group-action git-changes-group-action--danger"
                  onClick={(e) => { e.stopPropagation(); handleDiscardGroup(); }}
                  disabled={isAnyLoading}
                  title={selectedUnstaged.size > 0 ? 'Discard selected changes' : 'Discard all unstaged changes'}
                >
                  {selectedUnstaged.size > 0 ? `Discard (${selectedUnstaged.size})` : 'Discard All'}
                </button>
              </div>
              {!collapsedGroups.has('unstaged') &&
                renderFileTree(unstagedTree, 0, 'unstaged', treeOptionsFor(selectedUnstaged, setSelectedUnstaged))}
            </div>
          )}

          {/* Untracked */}
          {filteredUntracked.length > 0 && (
            <div className="git-changes-group">
              <div className="git-changes-group-header" onClick={() => toggleGroup('untracked')}>
                <span className="git-changes-group-chevron">{collapsedGroups.has('untracked') ? '▶' : '▼'}</span>
                <Checkbox
                  checked={untrackedSelState === 'all'}
                  indeterminate={untrackedSelState === 'some'}
                  onChange={() => toggleAllInGroup(selectedUntracked, setSelectedUntracked, filteredUntracked)}
                />
                <span className="git-changes-group-label">Untracked ({filteredUntracked.length})</span>
                <button
                  className="git-changes-group-action"
                  onClick={(e) => { e.stopPropagation(); handleStageGroup(selectedUntracked, filteredUntracked); }}
                  disabled={isAnyLoading}
                >
                  {selectedUntracked.size > 0 ? `Track Selected (${selectedUntracked.size})` : 'Track All'}
                </button>
              </div>
              {!collapsedGroups.has('untracked') &&
                renderFileTree(untrackedTree, 0, 'untracked', treeOptionsFor(selectedUntracked, setSelectedUntracked))}
            </div>
          )}
        </div>

        {/* Sessions pane */}
        {sessionsPaneOpen && (
          <SessionsForFilePane
            workspacePath={workspacePath}
            activeFile={activeRow}
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
              disabled={isCommitting || staged.length === 0 || !commitMessage.trim()}
            >
              {isCommitting ? 'Committing...' : 'Commit'}
            </button>
          </div>
          <div className="git-changes-commit-summary">
            {staged.length > 0 ? `${staged.length} file${staged.length !== 1 ? 's' : ''} staged` : 'No files staged'}
          </div>
        </div>
      </div>

      {popoverTarget && anchorRect && (
        <DiffPeekPopover
          anchorRect={anchorRect}
          filePath={popoverTarget.path}
          mode={peekedRow ? 'peek' : 'pinned'}
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
