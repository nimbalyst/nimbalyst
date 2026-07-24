import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { CollapsibleGroup } from './CollapsibleGroup';
import { WorktreeBaseBranchPicker } from './WorktreeBaseBranchPicker';
import { SessionListItem } from './SessionListItem';
import { WorkstreamGroup } from './WorkstreamGroup';
import { BlitzGroup } from './BlitzGroup';
import { SuperLoopGroup } from './SuperLoopGroup';
import { MetaAgentGroup } from './MetaAgentGroup';
import { NewSuperLoopDialog } from './NewSuperLoopDialog';
import { ArchiveProgress } from './ArchiveProgress';
import { IndexBuildDialog } from './IndexBuildDialog';
import { ArchiveWorktreeDialog } from '../AgentMode/ArchiveWorktreeDialog';
import { useArchiveWorktreeDialog } from '../../hooks/useArchiveWorktreeDialog';
import { getTimeGroupKey, TimeGroupKey } from '../../utils/dateFormatting';
import { getFileName } from '../../utils/pathUtils';
import { KeyboardShortcuts, getShortcutDisplay } from '../../../shared/KeyboardShortcuts';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  sessionListRootAtom,
  sessionListLoadingAtom,
  showArchivedSessionsAtom,
  refreshSessionListAtom,
  updateSessionStoreAtom,
  removeSessionFullAtom,
  sessionRegistryAtom,
  viewModeAtom,
  setViewModeAtom,
  worktreeActiveSessionAtom,
  addSessionFullAtom,
  type SessionMeta,
} from '../../store';
import { alphaFeatureEnabledAtom, worktreesFeatureAvailableAtom } from '../../store/atoms/appSettings';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { activeSessionIdAtom as globalActiveSessionIdAtom } from '../../store/atoms/sessions';
import { collapsedGroupsAtom, sortOrderAtom, setCollapsedGroupsAtom, setSortOrderAtom } from '../../store/atoms/agentMode';
import {
  isGitRepoAtom,
  recentlyRenamedSessionAtom,
  selectSessionActionAtom,
  selectChildSessionActionAtom,
  deleteSessionActionAtom,
  archiveSessionActionAtom,
  renameSessionActionAtom,
  branchSessionActionAtom,
  createNewSessionActionAtom,
  createNewWorktreeSessionActionAtom,
  addSessionToWorktreeActionAtom,
  openNewBlitzDialogActionAtom,
  requestSessionQuickOpenActionAtom,
} from '../../store/actions/sessionHistoryActions';
import { worktreeDisplayNameUpdateAtom } from '../../store/atoms/worktrees';
import { blitzCreatedAtom, blitzDisplayNameUpdateAtom } from '../../store/atoms/blitz';
import { superLoopListAtom, upsertSuperLoopAtom, removeSuperLoopAtom } from '../../store/atoms/superLoop';
import { useSuperLoopDialog } from '../../hooks/useSuperLoop';
import { workspaceSessionTurnActivityAtom } from '../../store/atoms/sessionActivity';
import { sessionKanbanTagsAtom } from '../../store/atoms/sessionKanban';
import {
  isWorkstreamParentSession,
  matchesSessionListTag,
  SESSION_LIST_VIRTUAL_TAGS,
  sessionListTagFilterAtom,
  VIRTUAL_TAG_WORKSTREAMS,
  VIRTUAL_TAG_WORKTREE,
} from '../../store/atoms/sessionListFilter';
import type { SuperLoop } from '../../../shared/types/superLoop';
import { store } from '@nimbalyst/runtime/store';
import { createMetaAgentSession } from '../../utils/metaAgentUtils';
import { HelpTooltip } from '../../help';
import { AlphaBadge } from '../common/AlphaBadge';
import { defaultAgentModelAtom } from '../../store/atoms/appSettings';
import { usePostHog } from 'posthog-js/react';
import { WorkspaceSummaryHeader, generateWorkspaceAccentColor } from '../WorkspaceSummaryHeader';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import './SessionHistory.css';

// SessionItem is the shared SessionMeta type from the store atoms.
type SessionItem = SessionMeta;

interface WorktreeData {
  id: string;
  name: string;
  displayName?: string;
  path: string;
  branch: string;
  base_branch?: string;
  createdAt?: number;
  isPinned?: boolean; // Whether this worktree is pinned to the top
  isArchived?: boolean; // Whether this worktree is archived
}

interface BlitzData {
  id: string;
  prompt: string;
  displayName?: string;
  isPinned?: boolean;
  isArchived?: boolean;
  createdAt?: number;
}

interface WorktreeWithStatus extends WorktreeData {
  gitStatus?: {
    ahead?: number;
    behind?: number;
    uncommitted?: boolean;
  };
}

type UnifiedListItem =
  | { type: 'session'; session: SessionItem; timestamp: number; rank: number; isWorktreeSession?: boolean }
  | { type: 'workstream'; session: SessionItem; sessions: SessionItem[]; timestamp: number; rank: number }
  | { type: 'worktree'; worktreeId: string; sessions: SessionItem[]; timestamp: number; rank: number }
  | { type: 'blitz'; blitzId: string; worktrees: { worktreeId: string; sessions: SessionItem[] }[]; timestamp: number; rank: number }
  | { type: 'superLoop'; loop: SuperLoop; timestamp: number; rank: number }
  | { type: 'metaAgent'; metaSession: SessionItem; childSessions: SessionItem[]; timestamp: number; rank: number };

// Search filter options for content search
type SearchTimeRange = '7d' | '30d' | '90d' | 'all';
type SearchDirection = 'all' | 'input' | 'output';

interface SearchFilters {
  timeRange: SearchTimeRange;
  direction: SearchDirection;
}

const ORDER_THROTTLE_MS = 3000;

const DEFAULT_SEARCH_FILTERS: SearchFilters = {
  timeRange: '30d',  // Default to last 30 days for performance
  direction: 'all',
};

const TIME_RANGE_LABELS: Record<SearchTimeRange, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  'all': 'All time',
};

const DIRECTION_LABELS: Record<SearchDirection, string> = {
  'all': 'All messages',
  'input': 'User prompts only',
  'output': 'Assistant only',
};

function getLiveSessionOrderTimestamp(
  session: Pick<SessionItem, 'id' | 'createdAt' | 'updatedAt'>,
  options: {
    sortBy: 'updated' | 'created';
    mode: 'chat' | 'agent';
    turnActivity: Map<string, number>;
  }
): number {
  const { sortBy, mode, turnActivity } = options;
  if (sortBy === 'created') {
    return session.createdAt;
  }
  if (mode === 'agent') {
    const turnBoundaryTimestamp = turnActivity.get(session.id);
    if (turnBoundaryTimestamp !== undefined) {
      return turnBoundaryTimestamp;
    }
  }
  return session.updatedAt || session.createdAt;
}

function mapsHaveSameKeys(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) {
    if (!b.has(key)) return false;
  }
  return true;
}

function mapsHaveEqualEntries(a: Map<string, number>, b: Map<string, number>): boolean {
  if (!mapsHaveSameKeys(a, b)) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

function compareNumbersDesc(a: number, b: number): number {
  return b - a;
}

function compareNumbersAsc(a: number, b: number): number {
  return a - b;
}

/**
 * SessionHistory takes no props. All inputs come from Jotai atoms:
 *   - `activeWorkspacePathAtom` for the current workspace
 *   - `globalActiveSessionIdAtom` for the selected session
 *   - `collapsedGroupsAtom` / `sortOrderAtom` for user preferences
 *   - `isGitRepoAtom(workspacePath)` for the New Worktree button
 *   - `recentlyRenamedSessionAtom` for the rename-cache patch signal
 *   - The action atoms in `sessionHistoryActions.ts` for every handler
 *
 * `mode` defaults to `'agent'`. The previous chat-mode discriminator is no
 * longer wired through this component (the chat surface lives elsewhere
 * now); we keep the constant for code paths that still branch on it.
 */
const SessionHistoryComponent: React.FC = () => {
  const workspacePath = useAtomValue(activeWorkspacePathAtom) ?? '';
  const activeSessionId = useAtomValue(globalActiveSessionIdAtom);
  const collapsedGroups = useAtomValue(collapsedGroupsAtom);
  const controlledSortOrder = useAtomValue(sortOrderAtom);
  const setCollapsedGroupsAction = useSetAtom(setCollapsedGroupsAtom);
  const setSortOrderAction = useSetAtom(setSortOrderAtom);
  const onCollapsedGroupsChange = setCollapsedGroupsAction;
  const onSortOrderChange = setSortOrderAction;
  const isGitRepo = useAtomValue(isGitRepoAtom(workspacePath));
  const isWorktreesFeatureAvailable = useAtomValue(worktreesFeatureAvailableAtom);
  const isBlitzAlphaAvailable = useAtomValue(alphaFeatureEnabledAtom('blitz'));

  const renamedSession = useAtomValue(recentlyRenamedSessionAtom);
  // Workstream rename / update signals are not currently broadcast through
  // atoms; the relevant effects below treat null as "no patch needed".
  // `as ... | null` cast keeps the union type so TypeScript doesn't narrow
  // away the property accesses inside the (always-skipped) effect bodies.
  const renamedWorktree = null as { worktreeId: string; displayName: string } | null;
  const updatedSession = null as { id: string; timestamp: number } | null;
  const refreshTrigger = undefined as number | undefined;
  const loadedSessionIds: string[] = [];
  const mode: 'chat' | 'agent' = 'agent';

  // Action-atom setters. `useSetAtom` returns identity-stable setters so
  // these can be passed to children or used in effect deps without
  // creating churn.
  const dispatchSelectSession = useSetAtom(selectSessionActionAtom);
  const dispatchSelectChildSession = useSetAtom(selectChildSessionActionAtom);
  const dispatchDeleteSession = useSetAtom(deleteSessionActionAtom);
  const dispatchArchiveSession = useSetAtom(archiveSessionActionAtom);
  const dispatchRenameSession = useSetAtom(renameSessionActionAtom);
  const dispatchBranchSession = useSetAtom(branchSessionActionAtom);
  const dispatchCreateNewSession = useSetAtom(createNewSessionActionAtom);
  const dispatchCreateNewWorktreeSession = useSetAtom(createNewWorktreeSessionActionAtom);
  const dispatchAddSessionToWorktree = useSetAtom(addSessionToWorktreeActionAtom);
  const dispatchOpenNewBlitzDialog = useSetAtom(openNewBlitzDialogActionAtom);
  const dispatchRequestQuickOpen = useSetAtom(requestSessionQuickOpenActionAtom);

  // Adapter callbacks for the existing rendering code that still expects
  // single-arg / multi-arg shapes from the old prop interface.
  //
  // The explicit `: Type | undefined` annotations preserve the optional
  // shape the JSX below was written against (`{onSessionDelete && ...}`,
  // `onSessionRename ? () => ... : undefined`, etc.). Without them
  // TypeScript would narrow these to "always defined" and flag every
  // existing guard as a tautology (TS2774).
  const onSessionSelect: ((sessionId: string) => void) | undefined = useCallback((sessionId: string) => {
    void dispatchSelectSession(sessionId);
  }, [dispatchSelectSession]);
  const onChildSessionSelect: ((childSessionId: string, parentId: string, parentType: 'workstream' | 'worktree') => void) | undefined = useCallback(
    (childSessionId: string, parentId: string, parentType: 'workstream' | 'worktree') => {
      void dispatchSelectChildSession({ childSessionId, parentId, parentType });
    },
    [dispatchSelectChildSession],
  );
  const onSessionDelete: ((sessionId: string) => void) | undefined = useCallback((sessionId: string) => {
    void dispatchDeleteSession(sessionId);
  }, [dispatchDeleteSession]);
  const onSessionArchive: ((sessionId: string) => void) | undefined = useCallback((sessionId: string) => {
    void dispatchArchiveSession(sessionId);
  }, [dispatchArchiveSession]);
  const onSessionRename: ((sessionId: string, newName: string) => void) | undefined = useCallback((sessionId: string, newName: string) => {
    void dispatchRenameSession({ sessionId, newName });
  }, [dispatchRenameSession]);
  const onSessionBranch: ((sessionId: string) => void) | undefined = useCallback((sessionId: string) => {
    void dispatchBranchSession(sessionId);
  }, [dispatchBranchSession]);
  const onNewSession: (() => void) | undefined = useCallback(() => {
    void dispatchCreateNewSession(undefined);
  }, [dispatchCreateNewSession]);
  const onNewWorktreeSession: ((options?: { baseBranch?: string; name?: string }) => void | Promise<void>) | undefined = isWorktreesFeatureAvailable
    ? async (options?: { baseBranch?: string; name?: string }) => {
        await dispatchCreateNewWorktreeSession(options);
      }
    : undefined;
  const onAddSessionToWorktree: ((worktreeId: string) => void) | undefined = isWorktreesFeatureAvailable
    ? (worktreeId: string) => { void dispatchAddSessionToWorktree(worktreeId); }
    : undefined;
  const onNewBlitz: (() => void) | undefined = isBlitzAlphaAvailable
    ? () => { void dispatchOpenNewBlitzDialog(); }
    : undefined;
  const onOpenQuickSearch: (() => void) | undefined = useCallback(() => {
    dispatchRequestQuickOpen();
  }, [dispatchRequestQuickOpen]);

  // The following ex-props are no longer wired (the chat-mode surface and
  // terminal/import buttons live elsewhere). Local placeholders keep the
  // rendered code below typecheckable without re-introducing prop drilling.
  // `as ... | undefined` casts preserve the union so the existing
  // `onCallback && onCallback()` guards in the JSX still type-check.
  const onNewTerminal = undefined as (() => void) | undefined;
  const onAddTerminalToWorktree = undefined as ((worktreeId: string) => void) | undefined;
  const onWorktreeFilesMode = undefined as ((worktreeId: string) => void) | undefined;
  const onWorktreeChangesMode = undefined as ((worktreeId: string) => void) | undefined;
  const onImportSessions = undefined as (() => void) | undefined;

  // === Atom subscriptions for session list ===
  // Use sessionListRootAtom to only show root sessions (not children of workstreams)
  const allSessionsFromAtom = useAtomValue(sessionListRootAtom);
  const atomLoading = useAtomValue(sessionListLoadingAtom);
  const showArchivedAtom = useAtomValue(showArchivedSessionsAtom);
  const setShowArchivedAtom = useSetAtom(showArchivedSessionsAtom);
  const refreshSessions = useSetAtom(refreshSessionListAtom);
  const updateSessionStore = useSetAtom(updateSessionStoreAtom);
  const removeSessionFromAtom = useSetAtom(removeSessionFullAtom);

  const isSuperLoopsAlphaEnabled = useAtomValue(alphaFeatureEnabledAtom('super-loops'));
  // Super Loops is gated by its alpha feature alone (like Meta Agent), not by
  // developer mode. The worktree it creates still requires a git repo, which is
  // enforced on the New Super Loop button (disabled when !isGitRepo).
  const isSuperLoopsAvailable = isSuperLoopsAlphaEnabled;
  const isMetaAgentEnabled = useAtomValue(alphaFeatureEnabledAtom('meta-agent'));

  // === Super Loop state ===
  const superLoops = useAtomValue(superLoopListAtom);
  const upsertSuperLoop = useSetAtom(upsertSuperLoopAtom);
  const removeSuperLoop = useSetAtom(removeSuperLoopAtom);
  const { openDialog: openSuperLoopDialog } = useSuperLoopDialog();

  // === Meta-agent session creation ===
  const defaultAgentModel = useAtomValue(defaultAgentModelAtom);
  const addSession = useSetAtom(addSessionFullAtom);

  const handleNewMetaAgent = useCallback(async () => {
    try {
      const result = await createMetaAgentSession(workspacePath, defaultAgentModel);
      if (result) {
        const now = Date.now();
        addSession({
          id: result.id,
          title: 'Meta Agent',
          createdAt: now,
          updatedAt: now,
          provider: result.provider,
          model: defaultAgentModel,
          sessionType: 'session',
          agentRole: 'meta-agent',
          messageCount: 0,
          workspaceId: workspacePath,
          isArchived: false,
          isPinned: false,
          parentSessionId: null,
          worktreeId: null,
          childCount: 0,
          uncommittedCount: 0,
        });
        onSessionSelect(result.id);
      }
    } catch (error) {
      console.error('[SessionHistory] Failed to create meta-agent session:', error);
    }
  }, [defaultAgentModel, workspacePath, onSessionSelect, addSession]);

  // Get the session registry to look up parent session IDs
  const sessionRegistry = useAtomValue(sessionRegistryAtom);
  const workspaceTurnActivity = useAtomValue(workspaceSessionTurnActivityAtom(workspacePath));

  // Get the parent session ID of the active session (if it's a child)
  const activeSessionParentId = activeSessionId
    ? sessionRegistry.get(activeSessionId)?.parentSessionId ?? null
    : null;

  // Use atom sessions directly - no conversion needed
  const allSessions = allSessionsFromAtom;

  // Count of sessions matching the iOS project list definition: same workspace,
  // not archived, not workstream/blitz containers. iOS counts all sessions (incl.
  // children), so we count from the registry rather than from sessionListRootAtom
  // which only contains roots + blitz children. We reuse the existing
  // `sessionRegistry` subscription above instead of subscribing twice — a
  // second `useAtomValue(sessionRegistryAtom)` here used to be one of the
  // identity-churn surfaces flagged in the render trace.
  const iosMatchCount = useMemo(() => {
    let count = 0;
    for (const s of sessionRegistry.values()) {
      if (s.workspaceId !== workspacePath) continue;
      if (s.isArchived) continue;
      if (s.sessionType === 'workstream' || s.sessionType === 'blitz') continue;
      count++;
    }
    return count;
  }, [sessionRegistry, workspacePath]);

  const [sessions, setSessions] = useState<SessionItem[]>([]); // Filtered sessions to display
  const loading = atomLoading && allSessions.length === 0; // Only show loading on initial load
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // Use controlled sort order from props if provided, otherwise use internal state
  const [internalSortOrder, setInternalSortOrder] = useState<'updated' | 'created'>('updated');
  const sortBy = controlledSortOrder ?? internalSortOrder;
  const setSortBy = onSortOrderChange ?? setInternalSortOrder;
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const newDropdownMenu = useFloatingMenu({ placement: 'bottom-end', offsetPx: 4 });
  const [worktreeBaseBranchPickerOpen, setWorktreeBaseBranchPickerOpen] = useState(false);
  const [contentSearchTriggered, setContentSearchTriggered] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  // Use atom for showArchived state
  const showArchived = showArchivedAtom;
  const setShowArchived = setShowArchivedAtom;
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set()); // Format: "blitz:id", "worktree:id", "workstream:id", "superloop:id", "meta-agent:id"
  const lastSelectedIdRef = useRef<string | null>(null); // For shift+click range selection
  const [worktreeCache, setWorktreeCache] = useState<Map<string, WorktreeWithStatus>>(new Map()); // Cache worktree data
  const [workstreamChildrenCache, setWorkstreamChildrenCache] = useState<Map<string, SessionItem[]>>(new Map()); // Cache workstream children
  const [blitzCache, setBlitzCache] = useState<Map<string, BlitzData>>(new Map()); // Cache blitz data
  const pendingWorkstreamChildrenFetchesRef = useRef<Set<string>>(new Set());
  // Mirrors `workstreamChildrenCache` so the workstream-children fetch
  // effect below can read the current cache without putting it in deps
  // (which previously formed a self-trigger loop: setCache -> dep change ->
  // effect re-runs -> setCache -> ...).
  const workstreamChildrenCacheRef = useRef(workstreamChildrenCache);
  useEffect(() => {
    workstreamChildrenCacheRef.current = workstreamChildrenCache;
  }, [workstreamChildrenCache]);
  const orderThrottleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orderLastCommittedAtRef = useRef(0);
  const orderPendingMapRef = useRef<Map<string, number> | null>(null);
  const orderStrategyKeyRef = useRef(`${mode}:${sortBy}`);
  // Same pattern for the throttled display order map; the throttle effect
  // both writes this state and needs to read the latest value for an
  // equality check. Without the ref it re-fires every time it commits.
  const displayOrderTimestampMapRef = useRef<Map<string, number>>(new Map());

  // View mode persisted via agentMode atoms
  const viewMode = useAtomValue(viewModeAtom);
  const setViewMode = useSetAtom(setViewModeAtom);
  const posthog = usePostHog();

  // FTS index build dialog state
  const [showIndexDialog, setShowIndexDialog] = useState(false);
  const [indexMessageCount, setIndexMessageCount] = useState(0);

  const [isIndexBuilding, setIsIndexBuilding] = useState(false);
  const [pendingSearchQuery, setPendingSearchQuery] = useState<string | null>(null); // Query to run after index build
  const [searchFilters, setSearchFilters] = useState<SearchFilters>(DEFAULT_SEARCH_FILTERS);
  const [showSearchFilters, setShowSearchFilters] = useState(false);
  const searchFiltersRef = useRef<HTMLDivElement>(null);

  // Tag filter state (parity with Kanban tag picker; session-only, no persistence)
  const allWorkspaceTags = useAtomValue(sessionKanbanTagsAtom);
  const tagFilter = useAtomValue(sessionListTagFilterAtom);
  const setTagFilter = useSetAtom(sessionListTagFilterAtom);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [highlightedTagIndex, setHighlightedTagIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const tagDropdownRef = useRef<HTMLDivElement>(null);
  const searchTrackDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tags available for selection: exclude already-active tags, optionally narrow by typed query.
  // Virtual tags match structural session groups and are not persisted on sessions.
  const filteredTagOptions = useMemo(() => {
    const activeSet = new Set(tagFilter.tags);
    const q = tagQuery.toLowerCase();
    const virtuals: { name: string; count: number }[] = [];
    if (!activeSet.has(VIRTUAL_TAG_WORKTREE)) {
      let worktreeCount = 0;
      for (const s of allSessions) if (s.worktreeId) worktreeCount++;
      if (worktreeCount > 0) {
        virtuals.push({ name: VIRTUAL_TAG_WORKTREE, count: worktreeCount });
      }
    }
    if (!activeSet.has(VIRTUAL_TAG_WORKSTREAMS)) {
      let workstreamCount = 0;
      for (const s of allSessions) if (isWorkstreamParentSession(s)) workstreamCount++;
      if (workstreamCount > 0) {
        virtuals.push({ name: VIRTUAL_TAG_WORKSTREAMS, count: workstreamCount });
      }
    }
    const real = allWorkspaceTags.filter(
      t => !activeSet.has(t.name) && !SESSION_LIST_VIRTUAL_TAGS.has(t.name),
    );
    return [...virtuals, ...real].filter(
      t => !q || t.name.toLowerCase().includes(q),
    );
  }, [allWorkspaceTags, allSessions, tagFilter.tags, tagQuery]);

  const addTagFilter = useCallback((tag: string) => {
    if (!tagFilter.tags.includes(tag)) {
      const next = [...tagFilter.tags, tag];
      setTagFilter({ tags: next });
      posthog?.capture('session_list_filter_applied', {
        filterType: 'tag',
        activeTagCount: next.length,
      });
    }
    setTagQuery('');
    setShowTagDropdown(false);
    setHighlightedTagIndex(0);
  }, [tagFilter, setTagFilter, posthog]);

  const removeTagFilter = useCallback((tag: string) => {
    setTagFilter({ tags: tagFilter.tags.filter(t => t !== tag) });
  }, [tagFilter, setTagFilter]);

  // Archive worktree dialog hook
  const {
    dialogState: archiveWorktreeDialogState,
    showDialog: showArchiveWorktreeDialog,
    closeDialog: closeArchiveWorktreeDialog,
    confirmArchive: confirmArchiveWorktree,
  } = useArchiveWorktreeDialog();

  // Bulk archive dialog state (for multi-select worktree archive)
  const [bulkArchiveState, setBulkArchiveState] = useState<{
    worktreeIds: string[];
    regularSessionIds: string[];
    blitzIds: string[];
    superLoopIds: string[];
    workstreamIds: string[];
    totalWorktreeCount: number; // Total affected worktrees (including from blitzes/superloops)
    hasUncommittedChanges: boolean;
    uncommittedFileCount: number;
    uncommittedWorktreeCount: number;
    hasUnmergedChanges: boolean;
    unmergedCommitCount: number;
    unmergedWorktreeCount: number;
  } | null>(null);

  // Track scroll position to restore after refresh
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null);
  const scrollContainerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node;
    setScrollContainerEl(node);
  }, []);
  const scrollPositionRef = useRef<number>(0);

  // Save scroll position on scroll
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      scrollPositionRef.current = container.scrollTop;
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Extract workspace name from path
  const workspaceName = getFileName(workspacePath) || 'Workspace';
  const workspaceColor = generateWorkspaceAccentColor(workspacePath);
  const useThrottledTurnOrdering = mode === 'agent' && sortBy === 'updated';
  const liveOrderTimestampMap = useMemo(() => {
    const timestamps = new Map<string, number>();
    for (const session of sessionRegistry.values()) {
      timestamps.set(session.id, getLiveSessionOrderTimestamp(session, {
        sortBy,
        mode,
        turnActivity: workspaceTurnActivity,
      }));
    }
    return timestamps;
  }, [sessionRegistry, sortBy, mode, workspaceTurnActivity]);
  const [displayOrderTimestampMap, setDisplayOrderTimestampMapState] = useState<Map<string, number>>(() => {
    // Initialize ref to mirror state from the start so the throttle effect
    // can compare without an initial null window.
    displayOrderTimestampMapRef.current = liveOrderTimestampMap;
    return liveOrderTimestampMap;
  });
  // Wrapper that keeps the ref in sync. The throttle effect below reads
  // the ref instead of subscribing to `displayOrderTimestampMap` so it
  // does not re-fire every time it commits its own state.
  const setDisplayOrderTimestampMap = useCallback((next: Map<string, number>) => {
    displayOrderTimestampMapRef.current = next;
    setDisplayOrderTimestampMapState(next);
  }, []);
  const [displayOrderRankMap, setDisplayOrderRankMap] = useState<Map<string, number>>(() => {
    const rankedSessions = Array.from(sessionRegistry.values())
      .sort((a, b) => {
        const timestampDiff = compareNumbersDesc(
          liveOrderTimestampMap.get(a.id) ?? 0,
          liveOrderTimestampMap.get(b.id) ?? 0,
        );
        if (timestampDiff !== 0) return timestampDiff;
        const createdDiff = compareNumbersDesc(a.createdAt, b.createdAt);
        if (createdDiff !== 0) return createdDiff;
        return a.id.localeCompare(b.id);
      });
    return new Map(rankedSessions.map((session, index) => [session.id, index]));
  });
  const buildCommittedRankMap = useCallback((nextMap: Map<string, number>) => {
    const rankedSessions = Array.from(sessionRegistry.values())
      .sort((a, b) => {
        const timestampDiff = compareNumbersDesc(
          nextMap.get(a.id) ?? 0,
          nextMap.get(b.id) ?? 0,
        );
        if (timestampDiff !== 0) return timestampDiff;

        const previousRankA = displayOrderRankMap.get(a.id);
        const previousRankB = displayOrderRankMap.get(b.id);
        if (previousRankA !== undefined && previousRankB !== undefined && previousRankA !== previousRankB) {
          return compareNumbersAsc(previousRankA, previousRankB);
        }

        const createdDiff = compareNumbersDesc(a.createdAt, b.createdAt);
        if (createdDiff !== 0) return createdDiff;

        return a.id.localeCompare(b.id);
      });
    return new Map(rankedSessions.map((session, index) => [session.id, index]));
  }, [sessionRegistry, displayOrderRankMap]);
  const getDisplayedOrderTimestamp = useCallback((session: Pick<SessionItem, 'id' | 'createdAt' | 'updatedAt'>) => {
    const liveTimestamp = getLiveSessionOrderTimestamp(session, {
      sortBy,
      mode,
      turnActivity: workspaceTurnActivity,
    });
    if (!useThrottledTurnOrdering) {
      return liveTimestamp;
    }
    return displayOrderTimestampMap.get(session.id) ?? liveTimestamp;
  }, [sortBy, mode, workspaceTurnActivity, useThrottledTurnOrdering, displayOrderTimestampMap]);
  const getDisplayedOrderRank = useCallback((sessionId: string) => {
    return displayOrderRankMap.get(sessionId) ?? Number.MAX_SAFE_INTEGER;
  }, [displayOrderRankMap]);
  const compareSessionOrder = useCallback((
    a: Pick<SessionItem, 'id' | 'createdAt' | 'updatedAt'>,
    b: Pick<SessionItem, 'id' | 'createdAt' | 'updatedAt'>
  ) => {
    const timestampDiff = compareNumbersDesc(
      getDisplayedOrderTimestamp(a),
      getDisplayedOrderTimestamp(b),
    );
    if (timestampDiff !== 0) return timestampDiff;

    const rankDiff = compareNumbersAsc(
      getDisplayedOrderRank(a.id),
      getDisplayedOrderRank(b.id),
    );
    if (rankDiff !== 0) return rankDiff;

    const createdDiff = compareNumbersDesc(a.createdAt, b.createdAt);
    if (createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  }, [getDisplayedOrderRank, getDisplayedOrderTimestamp]);
  const compareUnifiedItems = useCallback((a: UnifiedListItem, b: UnifiedListItem) => {
    const timestampDiff = compareNumbersDesc(a.timestamp, b.timestamp);
    if (timestampDiff !== 0) return timestampDiff;
    const rankDiff = compareNumbersAsc(a.rank, b.rank);
    if (rankDiff !== 0) return rankDiff;
    return a.type.localeCompare(b.type);
  }, []);

  // Load all sessions - now just triggers atom refresh
  // The atom handles IPC calls and state updates
  const loadAllSessions = useCallback(async () => {
    setError(null);
    try {
      await refreshSessions();
      // Restore scroll position after update
      requestAnimationFrame(() => {
        if (scrollContainerRef.current && scrollPositionRef.current > 0) {
          scrollContainerRef.current.scrollTop = scrollPositionRef.current;
        }
      });
    } catch (err) {
      console.error('[SessionHistory] Failed to load sessions:', err);
      setError('Failed to load sessions');
    }
  }, [refreshSessions]);

  // Execute the actual search query
  const executeSearch = useCallback(async (query: string, filters: SearchFilters = searchFilters) => {
    try {
      setIsSearching(true);
      setError(null);

      const result = await window.electronAPI.invoke('sessions:search', workspacePath, query.trim(), {
        includeArchived: showArchived,
        timeRange: filters.timeRange,
        direction: filters.direction,
      });

      if (result.success && Array.isArray(result.sessions)) {
        let searchResults: SessionItem[] = result.sessions.map((s: any) => ({
          id: s.id,
          title: s.title || 'Untitled Session',
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          provider: s.provider || 'claude',
          model: s.model,
          sessionType: s.sessionType || 'session',
          messageCount: s.messageCount || 0,
          isArchived: s.isArchived || false,
          isPinned: s.isPinned || false,
          worktreeId: s.worktreeId || null,
          childCount: s.childCount || 0,
          uncommittedCount: s.uncommittedCount || 0,
          parentSessionId: s.parentSessionId || null,
          workspaceId: s.workspaceId || workspacePath,
        }));

        // Filter out worktree sessions in non-agent mode
        if (mode !== 'agent') {
          searchResults = searchResults.filter((session: SessionItem) => !session.worktreeId);
        }

        setSessions(searchResults);
      }
    } catch (err) {
      console.error('[SessionHistory] Failed to search sessions:', err);
      setError('Failed to search sessions');
    } finally {
      setIsSearching(false);
    }
  }, [workspacePath, showArchived, mode, searchFilters]);

  // Search message content in database (heavy operation)
  // Checks if FTS index exists and prompts user to build if needed for large databases
  const searchMessageContent = useCallback(async (query: string) => {
    try {
      // Check FTS index status before searching
      const { indexExists, messageCount } = await window.electronAPI.ai.getFtsIndexStatus(workspacePath);

      // If index doesn't exist and database is large, prompt user to build
      if (!indexExists && messageCount > 5000) {
        setIndexMessageCount(messageCount);
        setPendingSearchQuery(query);
        setShowIndexDialog(true);
        return;
      }

      // Otherwise proceed with search
      await executeSearch(query);
    } catch (err) {
      console.error('[SessionHistory] Failed to search sessions:', err);
      setError('Failed to search sessions');
    }
  }, [workspacePath, executeSearch]);

  // Load all sessions on mount and when refreshTrigger or showArchived changes
  useEffect(() => {
    loadAllSessions();
  }, [loadAllSessions, refreshTrigger, showArchived]);

  // Update uncommittedCount for affected sessions when commits are detected
  // This is more efficient than refreshing all sessions
  useEffect(() => {
    if (!workspacePath) return;

    const unsubscribe = window.electronAPI?.git?.onCommitDetected?.(
      async (data: { workspacePath: string; committedFiles: string[] }) => {
        if (data.workspacePath !== workspacePath) return;

        // Find which sessions owned the committed files and get their new counts
        try {
          const result = await window.electronAPI.invoke(
            'sessions:get-uncommitted-counts',
            workspacePath
          );
          if (result.success && result.counts) {
            const counts = result.counts as Record<string, number>;

            // Update session atoms with new counts (for root sessions)
            for (const [sessionId, count] of Object.entries(counts)) {
              updateSessionStore({ sessionId, updates: { uncommittedCount: count } });
            }

            // Also update workstream children cache
            setWorkstreamChildrenCache(prev => {
              const updated = new Map(prev);
              for (const [parentId, children] of prev.entries()) {
                const updatedChildren = children.map(child => ({
                  ...child,
                  uncommittedCount: counts[child.id] ?? child.uncommittedCount ?? 0,
                }));
                updated.set(parentId, updatedChildren);
              }
              return updated;
            });
          }
        } catch (error) {
          console.error('[SessionHistory] Failed to update uncommitted counts:', error);
        }
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [workspacePath, updateSessionStore]);

  // Session list refresh is now handled by centralized listener in sessionListListeners.ts
  // Components just read from sessionListAtom which updates automatically

  // Client-side title filtering (instant, no database query)
  // Note: Archived session filtering is handled by sessionListRootAtom based on showArchivedSessionsAtom
  useEffect(() => {
    // Reset content search trigger when query changes
    setContentSearchTriggered(false);

    // Filter out sessions that belong to worktrees (they're shown in WorktreeGroup instead)
    // But keep standalone worktree sessions that should appear as WorktreeSingle
    const sessionsToFilter = allSessions;

    const activeTags = tagFilter.tags;
    const hasTagFilter = activeTags.length > 0;
    const titleQuery = searchQuery.trim().toLowerCase();
    const hasTitleQuery = titleQuery.length > 0;

    if (!hasTitleQuery && !hasTagFilter) {
      // No filters - show all sessions (filtered by mode)
      setSessions([...sessionsToFilter].sort(compareSessionOrder));
      return;
    }

    // Filter sessions by title (case-insensitive) AND tags (OR within tags).
    const filtered = sessionsToFilter.filter(session => {
      if (hasTitleQuery && !(session.title ?? '').toLowerCase().includes(titleQuery)) {
        return false;
      }
      if (hasTagFilter) {
        const matchesAny = activeTags.some(t => matchesSessionListTag(session, t, sessionRegistry));
        if (!matchesAny) return false;
      }
      return true;
    });
    setSessions(filtered.sort(compareSessionOrder));
  }, [searchQuery, tagFilter.tags, allSessions, mode, compareSessionOrder, sessionRegistry]);

  useEffect(() => {
    const commitOrderMap = (nextMap: Map<string, number>) => {
      orderPendingMapRef.current = null;
      orderLastCommittedAtRef.current = Date.now();
      setDisplayOrderTimestampMap(nextMap);
      setDisplayOrderRankMap(buildCommittedRankMap(nextMap));
    };
    const strategyKey = `${mode}:${sortBy}`;
    const strategyChanged = orderStrategyKeyRef.current !== strategyKey;
    orderStrategyKeyRef.current = strategyKey;

    if (!useThrottledTurnOrdering) {
      if (orderThrottleTimerRef.current) {
        clearTimeout(orderThrottleTimerRef.current);
        orderThrottleTimerRef.current = null;
      }
      // Guard the commit the same way the throttled path does below (#924).
      // `commitOrderMap` sets `displayOrderRankMap`, and `buildCommittedRankMap`
      // — which depends on that state and is in this effect's deps — gets a new
      // identity on every commit, re-running this effect. Without an equality
      // check that is an unconditional setState → dep-change → setState loop
      // (React #185), which crashed the app whenever sortOrder was 'created'.
      const currentDisplayMap = displayOrderTimestampMapRef.current;
      if (!mapsHaveEqualEntries(currentDisplayMap, liveOrderTimestampMap)) {
        commitOrderMap(liveOrderTimestampMap);
      }
      return;
    }

    // Read current display map from the ref so we don't subscribe to it
    // (the effect commits the map below, and resubscribing would form a
    // self-trigger loop).
    const currentDisplayMap = displayOrderTimestampMapRef.current;
    if (mapsHaveEqualEntries(currentDisplayMap, liveOrderTimestampMap)) {
      return;
    }

    if (strategyChanged) {
      if (orderThrottleTimerRef.current) {
        clearTimeout(orderThrottleTimerRef.current);
        orderThrottleTimerRef.current = null;
      }
      commitOrderMap(liveOrderTimestampMap);
      return;
    }

    // Membership changes should be reflected immediately. The throttle is only
    // for reshuffling the existing visible items during bursts of session activity.
    if (!mapsHaveSameKeys(currentDisplayMap, liveOrderTimestampMap)) {
      if (orderThrottleTimerRef.current) {
        clearTimeout(orderThrottleTimerRef.current);
        orderThrottleTimerRef.current = null;
      }
      commitOrderMap(liveOrderTimestampMap);
      return;
    }

    const now = Date.now();
    const elapsed = now - orderLastCommittedAtRef.current;
    if (orderLastCommittedAtRef.current === 0 || elapsed >= ORDER_THROTTLE_MS) {
      if (orderThrottleTimerRef.current) {
        clearTimeout(orderThrottleTimerRef.current);
        orderThrottleTimerRef.current = null;
      }
      commitOrderMap(liveOrderTimestampMap);
      return;
    }

    orderPendingMapRef.current = liveOrderTimestampMap;
    if (!orderThrottleTimerRef.current) {
      orderThrottleTimerRef.current = setTimeout(() => {
        orderThrottleTimerRef.current = null;
        const pendingMap = orderPendingMapRef.current;
        if (pendingMap) {
          commitOrderMap(pendingMap);
        }
      }, ORDER_THROTTLE_MS - elapsed);
    }
    // NOTE: deliberately omitting `displayOrderTimestampMap` from deps —
    // we read it via `displayOrderTimestampMapRef` and writing to state
    // would otherwise re-trigger this effect on every commit.
  }, [buildCommittedRankMap, liveOrderTimestampMap, useThrottledTurnOrdering, mode, sortBy]);

  useEffect(() => {
    return () => {
      if (orderThrottleTimerRef.current) {
        clearTimeout(orderThrottleTimerRef.current);
        orderThrottleTimerRef.current = null;
      }
    };
  }, []);

  // Auto-select first session when there's no active session
  // This ensures a session is always selected when switching to Agent mode
  useEffect(() => {
    if (!activeSessionId && sessions.length > 0 && onSessionSelect) {
      // Small delay to ensure AgentMode is fully mounted
      const timer = setTimeout(() => {
        // console.log('[SessionHistory] Auto-selecting first session:', sessions[0].id);
        onSessionSelect(sessions[0].id);
      }, 100);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [activeSessionId, sessions, onSessionSelect]);

  // Function to trigger content search (database query for message content)
  const searchMessageContents = useCallback(() => {
    if (!searchQuery.trim() || contentSearchTriggered) {
      return; // Don't search if already triggered or no query
    }
    setContentSearchTriggered(true);
    searchMessageContent(searchQuery);
  }, [searchQuery, contentSearchTriggered, searchMessageContent]);

  // Close search filters dropdown on click outside
  useEffect(() => {
    if (!showSearchFilters) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (searchFiltersRef.current && !searchFiltersRef.current.contains(event.target as Node)) {
        setShowSearchFilters(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSearchFilters]);

  // Close tag dropdown on click outside
  useEffect(() => {
    if (!showTagDropdown) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const inDropdown = tagDropdownRef.current?.contains(target);
      const inInput = searchInputRef.current?.contains(target);
      if (!inDropdown && !inInput) {
        setShowTagDropdown(false);
        setTagQuery('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showTagDropdown]);

  // Clean up search-track debounce timer on unmount
  useEffect(() => () => {
    if (searchTrackDebounceRef.current) clearTimeout(searchTrackDebounceRef.current);
  }, []);

  // Handle user choosing to build FTS index
  const handleBuildIndex = useCallback(async () => {
    setIsIndexBuilding(true);
    try {
      const result = await window.electronAPI.ai.buildFtsIndex();
      if (result.success) {
        // console.log('[SessionHistory] FTS index built successfully');
        // Run the pending search now that index is built
        if (pendingSearchQuery) {
          await executeSearch(pendingSearchQuery);
        }
      } else {
        console.error('[SessionHistory] Failed to build FTS index:', result.error);
        setError('Failed to build search index');
      }
    } catch (err) {
      console.error('[SessionHistory] Failed to build FTS index:', err);
      setError('Failed to build search index');
    } finally {
      setIsIndexBuilding(false);
      setShowIndexDialog(false);
      setPendingSearchQuery(null);
    }
  }, [pendingSearchQuery, executeSearch]);

  // Handle user skipping index build
  const handleSkipIndex = useCallback(async () => {
    setShowIndexDialog(false);
    // Still run the search, just slower
    if (pendingSearchQuery) {
      await executeSearch(pendingSearchQuery);
    }
    setPendingSearchQuery(null);
  }, [pendingSearchQuery, executeSearch]);

  // Note: Visual indicators (processing, unread, pending) are now applied in the
  // allSessions useMemo above, which depends on the status props. The filtering
  // effect updates `sessions` whenever `allSessions` changes, so no separate
  // effect is needed.

  // Update session title when renamed (efficient update without database reload)
  useEffect(() => {
    if (renamedSession) {
      setSessions(prevSessions => prevSessions.map(session => {
        if (session.id === renamedSession.id) {
          return { ...session, title: renamedSession.title };
        }
        return session;
      }));

      // Also update workstream children cache if this is a child session
      // This ensures renamed children show updated names immediately
      setWorkstreamChildrenCache(prev => {
        const updated = new Map(prev);
        let cacheUpdated = false;

        for (const [parentId, children] of prev.entries()) {
          const childIndex = children.findIndex(c => c.id === renamedSession.id);
          if (childIndex !== -1) {
            const updatedChildren = [...children];
            updatedChildren[childIndex] = {
              ...updatedChildren[childIndex],
              title: renamedSession.title
            };
            updated.set(parentId, updatedChildren);
            cacheUpdated = true;
            break;
          }
        }

        return cacheUpdated ? updated : prev;
      });
    }
  }, [renamedSession]);

  // Update worktree display name when first session in worktree is named
  useEffect(() => {
    if (renamedWorktree) {
      setWorktreeCache(prev => {
        const existing = prev.get(renamedWorktree.worktreeId);
        if (existing) {
          const updated = new Map(prev);
          updated.set(renamedWorktree.worktreeId, {
            ...existing,
            displayName: renamedWorktree.displayName
          });
          return updated;
        }
        return prev;
      });
    }
  }, [renamedWorktree]);

  // React to worktree display-name updates broadcast by main. The IPC event
  // is handled centrally in store/listeners/worktreeListeners.ts which writes
  // worktreeDisplayNameUpdateAtom; we merge the update into our local cache
  // when the worktree is one we know about, skipping the initial-mount value.
  const worktreeDisplayNameUpdate = useAtomValue(worktreeDisplayNameUpdateAtom);
  const initialWorktreeDisplayNameUpdateRef = useRef(worktreeDisplayNameUpdate);
  useEffect(() => {
    if (!workspacePath) return;
    if (worktreeDisplayNameUpdate === initialWorktreeDisplayNameUpdateRef.current) return;
    if (!worktreeDisplayNameUpdate) return;
    const { worktreeId, displayName } = worktreeDisplayNameUpdate.payload;
    setWorktreeCache(prev => {
      const existing = prev.get(worktreeId);
      if (!existing) return prev;
      const updated = new Map(prev);
      updated.set(worktreeId, { ...existing, displayName });
      return updated;
    });
  }, [worktreeDisplayNameUpdate, workspacePath]);

  // React to blitz display-name updates broadcast by main. The IPC event is
  // handled centrally in store/listeners/blitzListeners.ts which writes
  // blitzDisplayNameUpdateAtom; we merge the update into our local cache when
  // the blitz is one we know about, skipping the initial-mount value.
  const blitzDisplayNameUpdate = useAtomValue(blitzDisplayNameUpdateAtom);
  const initialBlitzDisplayNameUpdateRef = useRef(blitzDisplayNameUpdate);
  useEffect(() => {
    if (!workspacePath) return;
    if (blitzDisplayNameUpdate === initialBlitzDisplayNameUpdateRef.current) return;
    if (!blitzDisplayNameUpdate) return;
    const { blitzId, displayName } = blitzDisplayNameUpdate.payload;
    setBlitzCache(prev => {
      const existing = prev.get(blitzId);
      if (!existing) return prev;
      const updated = new Map(prev);
      updated.set(blitzId, { ...existing, displayName });
      return updated;
    });
  }, [blitzDisplayNameUpdate, workspacePath]);

  // Update session timestamp when updated (efficient update without database reload)
  useEffect(() => {
    if (updatedSession) {
      setSessions(prevSessions => prevSessions.map(session => {
        if (session.id === updatedSession.id) {
          return { ...session, updatedAt: updatedSession.timestamp };
        }
        return session;
      }));
    }
  }, [updatedSession]);

  const handleToggleGroup = (groupName: string) => {
    if (collapsedGroups.includes(groupName)) {
      onCollapsedGroupsChange(collapsedGroups.filter(g => g !== groupName));
    } else {
      onCollapsedGroupsChange([...collapsedGroups, groupName]);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (onSessionDelete) {
      onSessionDelete(sessionId);
      // Reload sessions after delete
      await loadAllSessions();
    }
  };

  const handleArchiveSession = async (sessionId: string) => {
    // The IPC handler at packages/electron/src/main/ipc/SessionHandlers.ts:472
    // returns `{success: true}` on the happy path and `{success: false, error}`
    // on validation/DB failures (e.g. session-provider-switch guard, session
    // not found, store write failure). We previously only caught throws,
    // which meant a returned `{success: false}` envelope still produced the
    // optimistic UI removal even though the DB write didn't happen — the
    // session reappeared on next refresh and the user saw "Archive does
    // nothing" with no clue why. See #282.
    try {
      const result = await window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived: true });
      if (result && typeof result === 'object' && result.success === false) {
        const message = (result.error && String(result.error)) || 'The backend rejected the archive request.';
        errorNotificationService.showError('Failed to archive session', message);
        console.error('[SessionHistory] Archive rejected by backend:', message);
        return;
      }
      // Update atom state immediately for instant feedback (optimistic update)
      // If not showing archived, this effectively removes it from view
      updateSessionStore({ sessionId, updates: { isArchived: true } });
      // Also remove from filtered list for immediate feedback
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      // Notify parent to close the tab if open
      if (onSessionArchive) {
        onSessionArchive(sessionId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errorNotificationService.showError('Failed to archive session', message);
      console.error('[SessionHistory] Failed to archive session:', err);
    }
  };

  const getMetaAgentGroupSessionIds = useCallback((metaSessionId: string) => {
    return [
      metaSessionId,
      ...sessions
        .filter(session => session.createdBySessionId === metaSessionId)
        .map(session => session.id),
    ];
  }, [sessions]);

  const handleArchiveMetaAgentSession = useCallback(async (metaSessionId: string) => {
    const sessionIds = getMetaAgentGroupSessionIds(metaSessionId);
    try {
      const results = await Promise.all(
        sessionIds.map(sessionId => window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived: true }))
      );
      // Same rejection-surfacing as handleArchiveSession: if any per-session
      // archive came back `{success: false}`, surface it rather than silently
      // proceeding with the optimistic UI update. See #282.
      const failures = results
        .map((r, i) => ({ r, sessionId: sessionIds[i] }))
        .filter(({ r }) => r && typeof r === 'object' && r.success === false);
      if (failures.length > 0) {
        const message = failures
          .map(({ r, sessionId }) => `${sessionId}: ${(r && r.error && String(r.error)) || 'rejected'}`)
          .join('\n');
        errorNotificationService.showError(
          `Failed to archive meta-agent session (${failures.length} of ${sessionIds.length} rejected)`,
          message,
        );
        console.error('[SessionHistory] Meta-agent archive rejected by backend:', failures);
        return;
      }
      sessionIds.forEach(sessionId => {
        updateSessionStore({ sessionId, updates: { isArchived: true } });
        onSessionArchive?.(sessionId);
      });
      setSessions(prev => prev.filter(session => !sessionIds.includes(session.id)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errorNotificationService.showError('Failed to archive meta-agent session', message);
      console.error('[SessionHistory] Failed to archive meta-agent session:', err);
    }
  }, [getMetaAgentGroupSessionIds, onSessionArchive, updateSessionStore]);

  // Clean up UI state after a worktree archive (used by both auto-archive and dialog confirm paths)
  const cleanupAfterWorktreeArchive = useCallback((worktreeId: string) => {
    const worktreeSessions = allSessions.filter(s => s.worktreeId === worktreeId);
    worktreeSessions.forEach(session => {
      removeSessionFromAtom(session.id);
    });
    setSessions(prev => prev.filter(s => s.worktreeId !== worktreeId));
    worktreeSessions.forEach(session => {
      if (onSessionArchive) {
        onSessionArchive(session.id);
      }
    });
    setWorktreeCache(prev => {
      const newCache = new Map(prev);
      newCache.delete(worktreeId);
      return newCache;
    });
    const superLoop = superLoops.find(loop => loop.worktreeId === worktreeId);
    if (superLoop) {
      removeSuperLoop(superLoop.id);
    }
  }, [allSessions, removeSessionFromAtom, onSessionArchive, superLoops, removeSuperLoop]);

  // Archive worktree: auto-archives if clean, otherwise shows confirmation dialog
  const handleArchiveWorktree = async (worktreeId: string) => {
    // Get worktree info from cache
    const worktreeData = worktreeCache.get(worktreeId);
    const worktreeName = worktreeData?.displayName || worktreeData?.name || worktreeData?.path?.split('/').pop() || 'worktree';
    const worktreePath = worktreeData?.path || '';

    const autoArchived = await showArchiveWorktreeDialog({
      worktreeId,
      worktreeName,
      worktreePath,
      workspacePath,
    });

    if (autoArchived) {
      cleanupAfterWorktreeArchive(worktreeId);
    }
  };

  const handleCleanGitignored = useCallback(async (worktreeId: string) => {
    const worktreeData = worktreeCache.get(worktreeId);
    if (!worktreeData?.path) return;

    const worktreeName = worktreeData.displayName || worktreeData.name || 'worktree';

    try {
      const preview = await window.electronAPI.worktreeListGitignored(worktreeData.path);
      if (!preview.success || preview.count === 0) return;

      const confirmed = window.confirm(
        `Remove ${preview.count} gitignored ${preview.count === 1 ? 'item' : 'items'} from "${worktreeName}"?\n\nThis includes files like node_modules and build artifacts that can be regenerated.`
      );
      if (!confirmed) return;

      const result = await window.electronAPI.worktreeCleanGitignored(worktreeData.path);
      if (result.success) {
        window.alert(`Removed ${result.count} gitignored ${result.count === 1 ? 'item' : 'items'} from "${worktreeName}".`);
      } else {
        console.error('[SessionHistory] Failed to clean gitignored files:', result.error);
        window.alert(`Failed to clean gitignored files: ${result.error}`);
      }
    } catch (error) {
      console.error('[SessionHistory] Failed to clean gitignored files:', error);
    }
  }, [worktreeCache]);

  // Handle archive confirmation from the dialog
  const handleConfirmArchiveWorktree = useCallback(async () => {
    if (!archiveWorktreeDialogState) return;

    const worktreeId = archiveWorktreeDialogState.worktreeId;

    await confirmArchiveWorktree(workspacePath, () => {
      cleanupAfterWorktreeArchive(worktreeId);
    });
  }, [archiveWorktreeDialogState, workspacePath, confirmArchiveWorktree, cleanupAfterWorktreeArchive]);

  const handleUnarchiveSession = async (sessionId: string) => {
    try {
      await window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived: false });
      // Update atom state immediately for instant feedback (optimistic update)
      updateSessionStore({ sessionId, updates: { isArchived: false } });
      // Also update filtered list for immediate feedback
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, isArchived: false } : s));
    } catch (err) {
      console.error('[SessionHistory] Failed to unarchive session:', err);
    }
  };

  const handleUnarchiveMetaAgentSession = useCallback(async (metaSessionId: string) => {
    const sessionIds = getMetaAgentGroupSessionIds(metaSessionId);
    try {
      await Promise.all(
        sessionIds.map(sessionId => window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived: false }))
      );
      sessionIds.forEach(sessionId => {
        updateSessionStore({ sessionId, updates: { isArchived: false } });
      });
      setSessions(prev => prev.map(session => (
        sessionIds.includes(session.id)
          ? { ...session, isArchived: false }
          : session
      )));
    } catch (err) {
      console.error('[SessionHistory] Failed to unarchive meta-agent session:', err);
    }
  }, [getMetaAgentGroupSessionIds, updateSessionStore]);

  const handleDeleteMetaAgentSession = useCallback(async (metaSessionId: string) => {
    if (!onSessionDelete) return;

    const sessionIds = getMetaAgentGroupSessionIds(metaSessionId);
    const childSessionIds = sessionIds.filter(sessionId => sessionId !== metaSessionId);

    for (const sessionId of childSessionIds) {
      await onSessionDelete(sessionId);
    }
    await onSessionDelete(metaSessionId);
    await loadAllSessions();
  }, [getMetaAgentGroupSessionIds, loadAllSessions, onSessionDelete]);

  const toggleShowArchived = async () => {
    const newValue = !showArchived;
    setShowArchived(newValue);
    // Need to refresh from database since archived sessions may not be loaded yet
    // Pass the new value explicitly to avoid race condition with atom update
    await refreshSessions(newValue);
  };

  // Clear selection when clicking elsewhere
  const clearSelection = useCallback(() => {
    setSelectedSessionIds(new Set());
    setSelectedGroupIds(new Set());
    lastSelectedIdRef.current = null;
  }, []);

  // Refs for shift-click range selection. Using refs instead of state means handleSessionClick
  // has a stable identity and memoized child components won't hold stale references.
  const visualOrderRef = useRef<string[]>([]);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // Handle session click with multi-select support
  // Stable callback: reads all volatile state from refs so memoized children never hold a stale reference.
  const handleSessionClick = useCallback((sessionId: string, e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => {
    const isMetaKey = e.metaKey || e.ctrlKey;
    const isShiftKey = e.shiftKey;

    if (isMetaKey) {
      // Cmd/Ctrl+click: toggle selection
      const currentActiveId = activeSessionIdRef.current;
      setSelectedSessionIds(prev => {
        const next = new Set(prev);
        if (prev.size === 0 && currentActiveId && currentActiveId !== sessionId) {
          next.add(currentActiveId);
        }
        if (next.has(sessionId)) {
          next.delete(sessionId);
        } else {
          next.add(sessionId);
        }
        return next;
      });
      lastSelectedIdRef.current = sessionId;
    } else if (isShiftKey) {
      // Shift+click: range selection
      const anchorId = lastSelectedIdRef.current || activeSessionIdRef.current;
      if (anchorId) {
        const ids = visualOrderRef.current;
        const anchorIndex = ids.indexOf(anchorId);
        const currentIndex = ids.indexOf(sessionId);

        // console.log(`[SessionHistory] shift-click debug: anchor=${anchorId.slice(0, 8)} (${lastSelectedIdRef.current ? 'lastSelectedId' : 'activeSessionId'}) anchorIdx=${anchorIndex} target=${sessionId.slice(0, 8)} targetIdx=${currentIndex} totalIds=${ids.length} range=${anchorIndex !== -1 && currentIndex !== -1 ? Math.abs(currentIndex - anchorIndex) + 1 : 'N/A'}`);

        if (anchorIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(anchorIndex, currentIndex);
          const end = Math.max(anchorIndex, currentIndex);
          const rangeIds = ids.slice(start, end + 1);

          setSelectedSessionIds(new Set(rangeIds));
          lastSelectedIdRef.current = sessionId;
        }
      } else {
        setSelectedSessionIds(new Set([sessionId]));
        lastSelectedIdRef.current = sessionId;
      }
    } else {
      // Regular click: clear multi-selection and navigate to session.
      setSelectedSessionIds(new Set());
      setSelectedGroupIds(new Set());
      lastSelectedIdRef.current = sessionId;
      onSessionSelect(sessionId);
    }
  }, [onSessionSelect]);

  // Determine the group key that the currently active session belongs to.
  // Used to auto-include the "focused" group when starting multi-select from empty.
  const activeGroupKey = useMemo(() => {
    if (!activeSessionId) return null;
    const activeSession = allSessions.find(s => s.id === activeSessionId);
    if (!activeSession) return null;

    if (activeSession.worktreeId) {
      // Check if this worktree belongs to a blitz by looking at ALL sessions in the worktree
      // (the active session itself may not have parentSessionId, e.g. a later session in the worktree)
      const blitzParentId = allSessions.find(
        s => s.worktreeId === activeSession.worktreeId && s.parentSessionId && blitzCache.has(s.parentSessionId)
      )?.parentSessionId;
      if (blitzParentId) {
        return `blitz:${blitzParentId}`;
      }

      // Super loop
      const superLoop = superLoops.find(l => l.worktreeId === activeSession.worktreeId);
      if (superLoop) {
        return `superloop:${superLoop.id}`;
      }

      // Multi-session worktree group (single-session worktrees are flat items, not groups)
      const siblingCount = sessions.filter(s => s.worktreeId === activeSession.worktreeId).length;
      if (siblingCount > 1) {
        return `worktree:${activeSession.worktreeId}`;
      }
    }

    // Non-worktree blitz child (e.g. analysis sessions without worktreeId)
    if (activeSession.parentSessionId && blitzCache.has(activeSession.parentSessionId)) {
      return `blitz:${activeSession.parentSessionId}`;
    }

    // Meta-agent session or child of meta-agent
    if (activeSession.agentRole === 'meta-agent') {
      return `meta-agent:${activeSession.id}`;
    }
    if (activeSession.createdBySessionId) {
      const parentSession = allSessions.find(s => s.id === activeSession.createdBySessionId);
      if (parentSession?.agentRole === 'meta-agent') {
        return `meta-agent:${parentSession.id}`;
      }
    }

    // Workstream (has children, no worktreeId)
    if (!activeSession.worktreeId && (activeSession.childCount ?? 0) > 0) {
      return `workstream:${activeSession.id}`;
    }

    return null;
  }, [activeSessionId, allSessions, blitzCache, superLoops, sessions]);

  // Handle Cmd+click on group headers (blitz, worktree, workstream, superloop)
  const handleGroupMultiSelect = useCallback((groupKey: string) => {
    setSelectedGroupIds(prev => {
      const next = new Set(prev);
      // When starting multi-select from empty, include the currently active group
      // so the user doesn't lose the visually-highlighted active group from the selection
      if (prev.size === 0 && activeGroupKey && activeGroupKey !== groupKey) {
        next.add(activeGroupKey);
      }
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }, [activeGroupKey]);

  // Perform the actual bulk archive (called directly or after dialog confirmation)
  const performBulkArchive = useCallback(async (params: {
    worktreeIds: string[];
    regularSessionIds: string[];
    blitzIds: string[];
    superLoopIds: string[];
    workstreamIds: string[];
  }) => {
    const { worktreeIds, regularSessionIds, blitzIds, superLoopIds, workstreamIds } = params;

    // Archive blitz groups via blitz:archive
    for (const blitzId of blitzIds) {
      try {
        // Find all worktrees belonging to this blitz
        const blitzWorktreeIds = new Set<string>();
        for (const session of allSessions) {
          if (session.parentSessionId === blitzId && session.worktreeId) {
            blitzWorktreeIds.add(session.worktreeId);
          }
        }

        await window.electronAPI.invoke('blitz:archive', blitzId, workspacePath);

        // Optimistic UI cleanup
        const allBlitzWorktreeSessions = allSessions.filter(
          s => s.worktreeId && blitzWorktreeIds.has(s.worktreeId)
        );
        allBlitzWorktreeSessions.forEach(session => removeSessionFromAtom(session.id));
        removeSessionFromAtom(blitzId);
        setSessions(prev => prev.filter(s =>
          s.id !== blitzId && s.parentSessionId !== blitzId && !(s.worktreeId && blitzWorktreeIds.has(s.worktreeId))
        ));
        allBlitzWorktreeSessions.forEach(session => {
          if (onSessionArchive) onSessionArchive(session.id);
        });
        setWorktreeCache(prev => {
          const newCache = new Map(prev);
          for (const wId of blitzWorktreeIds) newCache.delete(wId);
          return newCache;
        });
        for (const wId of blitzWorktreeIds) {
          const superLoop = superLoops.find(loop => loop.worktreeId === wId);
          if (superLoop) removeSuperLoop(superLoop.id);
        }
        setBlitzCache(prev => {
          const updated = new Map(prev);
          const blitz = updated.get(blitzId);
          if (blitz) updated.set(blitzId, { ...blitz, isArchived: true });
          return updated;
        });
      } catch (error) {
        console.error('[SessionHistory] Failed to archive blitz:', error);
      }
    }

    // Archive super loops via worktree:archive (they own a dedicated worktree)
    for (const loopId of superLoopIds) {
      const loop = superLoops.find(l => l.id === loopId);
      if (loop) {
        try {
          const result = await window.electronAPI.worktreeArchive(loop.worktreeId, workspacePath);
          if (result.success) {
            cleanupAfterWorktreeArchive(loop.worktreeId);
          }
        } catch (error) {
          console.error('[SessionHistory] Failed to archive super loop:', error);
        }
      }
    }

    // Archive worktree sessions via worktree:archive (proper cleanup path)
    for (const worktreeId of worktreeIds) {
      try {
        const result = await window.electronAPI.worktreeArchive(worktreeId, workspacePath);
        if (result.success) {
          cleanupAfterWorktreeArchive(worktreeId);
        } else {
          console.error('[SessionHistory] Failed to archive worktree:', result.error);
        }
      } catch (error) {
        console.error('[SessionHistory] Failed to archive worktree:', error);
      }
    }

    // Archive workstream sessions and regular sessions via metadata update
    const allSessionIds = [...regularSessionIds, ...workstreamIds];
    if (allSessionIds.length > 0) {
      const promises = allSessionIds.map(id =>
        window.electronAPI.invoke('sessions:update-metadata', id, { isArchived: true })
      );
      await Promise.all(promises);
      allSessionIds.forEach(id => {
        updateSessionStore({ sessionId: id, updates: { isArchived: true } });
      });
      setSessions(prev => prev.filter(s => !allSessionIds.includes(s.id)));
      if (onSessionArchive) {
        allSessionIds.forEach(id => onSessionArchive(id));
      }
    }

    clearSelection();
  }, [workspacePath, cleanupAfterWorktreeArchive, updateSessionStore, onSessionArchive, clearSelection, allSessions, removeSessionFromAtom, superLoops, removeSuperLoop]);

  // Collect all worktree IDs from selected items (sessions, groups, blitzes, super loops)
  const collectAllWorktreeIds = useCallback((params: {
    worktreeIds: string[];
    blitzIds: string[];
    superLoopIds: string[];
  }): string[] => {
    const allIds = new Set(params.worktreeIds);

    // Blitzes have child worktrees
    for (const blitzId of params.blitzIds) {
      for (const session of allSessions) {
        if (session.parentSessionId === blitzId && session.worktreeId) {
          allIds.add(session.worktreeId);
        }
      }
    }

    // Super loops own a dedicated worktree
    for (const loopId of params.superLoopIds) {
      const loop = superLoops.find(l => l.id === loopId);
      if (loop) {
        allIds.add(loop.worktreeId);
      }
    }

    return Array.from(allIds);
  }, [allSessions, superLoops]);

  // Bulk archive all selected items (sessions + groups)
  const handleBulkArchive = async () => {
    const selectedSessions = sessions.filter(s => selectedSessionIds.has(s.id));

    // Separate worktree and regular sessions from selectedSessionIds
    const worktreeIds = new Set<string>();
    const regularSessionIds: string[] = [];

    for (const session of selectedSessions) {
      if (session.worktreeId) {
        worktreeIds.add(session.worktreeId);
      } else {
        regularSessionIds.push(session.id);
      }
    }

    // Collect group IDs by type from selectedGroupIds
    const blitzIds: string[] = [];
    const superLoopIds: string[] = [];
    const workstreamIds: string[] = [];
    const groupWorktreeIds: string[] = [];

    for (const key of selectedGroupIds) {
      const [type, id] = key.split(':');
      switch (type) {
        case 'blitz': blitzIds.push(id); break;
        case 'superloop': superLoopIds.push(id); break;
        case 'workstream': workstreamIds.push(id); break;
        case 'worktree': groupWorktreeIds.push(id); break;
      }
    }

    // Merge worktree IDs from sessions and from group selection
    for (const id of groupWorktreeIds) {
      worktreeIds.add(id);
    }

    const archiveParams = {
      worktreeIds: Array.from(worktreeIds),
      regularSessionIds,
      blitzIds,
      superLoopIds,
      workstreamIds,
    };

    // Collect all worktree IDs that will be archived (including from blitzes and super loops)
    const allWorktreeIds = collectAllWorktreeIds(archiveParams);

    // If no worktrees involved, archive directly without worktree status check
    if (allWorktreeIds.length === 0) {
      await performBulkArchive(archiveParams);
      return;
    }

    // Fetch status for each worktree to check for warnings
    const worktreeStatuses = await Promise.all(
      allWorktreeIds.map(async worktreeId => {
        const worktreeData = worktreeCache.get(worktreeId);
        if (!worktreeData?.path) {
          return { worktreeId, clean: true, hasUncommittedChanges: false, uncommittedFileCount: 0, hasUnmergedChanges: false, unmergedCommitCount: 0 };
        }

        try {
          const result = await window.electronAPI.worktreeGetStatus(worktreeData.path, { fetchFirst: true });
          if (result.success && result.status) {
            const isMerged = result.status.isMerged ?? false;
            const hasUncommitted = result.status.hasUncommittedChanges;
            const hasUnmerged = !isMerged;
            return {
              worktreeId,
              clean: !hasUncommitted && !hasUnmerged,
              hasUncommittedChanges: hasUncommitted,
              uncommittedFileCount: result.status.modifiedFileCount || 0,
              hasUnmergedChanges: hasUnmerged,
              unmergedCommitCount: result.status.uniqueCommitsAhead ?? result.status.commitsAhead ?? 0,
            };
          }
        } catch (error) {
          console.error('[SessionHistory] Failed to get worktree status:', error);
        }

        // Conservative: treat as dirty on error so dialog shows
        return { worktreeId, clean: false, hasUncommittedChanges: false, uncommittedFileCount: 0, hasUnmergedChanges: true, unmergedCommitCount: 0 };
      })
    );

    const dirtyWorktrees = worktreeStatuses.filter(s => !s.clean);

    if (dirtyWorktrees.length === 0) {
      // All clean, auto-archive without dialog
      await performBulkArchive(archiveParams);
      return;
    }

    // Aggregate warnings and show one dialog
    const totalUncommittedFiles = worktreeStatuses.reduce((sum, s) => sum + s.uncommittedFileCount, 0);
    const uncommittedCount = worktreeStatuses.filter(s => s.hasUncommittedChanges).length;
    const totalUnmergedCommits = worktreeStatuses.reduce((sum, s) => sum + s.unmergedCommitCount, 0);
    const unmergedCount = worktreeStatuses.filter(s => s.hasUnmergedChanges).length;

    setBulkArchiveState({
      ...archiveParams,
      totalWorktreeCount: allWorktreeIds.length,
      hasUncommittedChanges: uncommittedCount > 0,
      uncommittedFileCount: totalUncommittedFiles,
      uncommittedWorktreeCount: uncommittedCount,
      hasUnmergedChanges: unmergedCount > 0,
      unmergedCommitCount: totalUnmergedCommits,
      unmergedWorktreeCount: unmergedCount,
    });
  };

  // Handle confirmation from bulk archive dialog
  const handleConfirmBulkArchive = useCallback(async () => {
    if (!bulkArchiveState) return;
    const { hasUncommittedChanges: _, uncommittedFileCount: _1, uncommittedWorktreeCount: _2,
            hasUnmergedChanges: _3, unmergedCommitCount: _4, unmergedWorktreeCount: _5,
            totalWorktreeCount: _6, ...archiveParams } = bulkArchiveState;
    await performBulkArchive(archiveParams);
    setBulkArchiveState(null);
  }, [bulkArchiveState, performBulkArchive]);

  const handleCancelBulkArchive = useCallback(() => {
    setBulkArchiveState(null);
  }, []);

  // Bulk unarchive selected sessions
  const handleBulkUnarchive = async () => {
    const promises = Array.from(selectedSessionIds).map(sessionId =>
      window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived: false })
    );
    await Promise.all(promises);
    // Update atom state for each unarchived session
    selectedSessionIds.forEach(sessionId => {
      updateSessionStore({ sessionId, updates: { isArchived: false } });
    });
    setSessions(prev => prev.map(s => selectedSessionIds.has(s.id) ? { ...s, isArchived: false } : s));
    clearSelection();
  };

  // Bulk delete selected sessions
  const handleBulkDelete = async () => {
    if (!onSessionDelete) return;

    const count = selectedSessionIds.size;
    const confirmed = window.confirm(`Are you sure you want to permanently delete ${count} session${count > 1 ? 's' : ''}? This cannot be undone.`);
    if (!confirmed) return;

    for (const sessionId of selectedSessionIds) {
      await onSessionDelete(sessionId);
    }
    await loadAllSessions();
    clearSelection();
  };

  // Toggle pin status for a session
  const handleSessionPinToggle = useCallback(async (sessionId: string, isPinned: boolean) => {
    try {
      await window.electronAPI.invoke('sessions:update-pinned', sessionId, isPinned);
      // Update atom state (optimistic update)
      updateSessionStore({ sessionId, updates: { isPinned } });
      // Also update filtered list for immediate feedback
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, isPinned } : s));
    } catch (error) {
      console.error('[SessionHistory] Failed to toggle session pin:', error);
    }
  }, [updateSessionStore]);

  // Toggle pin status for a worktree
  const handleWorktreePinToggle = useCallback(async (worktreeId: string, isPinned: boolean) => {
    try {
      await window.electronAPI.invoke('worktree:update-pinned', worktreeId, isPinned);
      // Update worktree cache
      setWorktreeCache(prev => {
        const updated = new Map(prev);
        const worktree = updated.get(worktreeId);
        if (worktree) {
          updated.set(worktreeId, { ...worktree, isPinned });
        }
        return updated;
      });
    } catch (error) {
      console.error('[SessionHistory] Failed to toggle worktree pin:', error);
    }
  }, []);

  // Rename a worktree
  const handleWorktreeRename = useCallback(async (worktreeId: string, newName: string) => {
    try {
      await window.electronAPI.invoke('worktree:update-display-name', worktreeId, newName);
      // Update worktree cache
      setWorktreeCache(prev => {
        const updated = new Map(prev);
        const worktree = updated.get(worktreeId);
        if (worktree) {
          updated.set(worktreeId, { ...worktree, displayName: newName });
        }
        return updated;
      });
    } catch (error) {
      console.error('[SessionHistory] Failed to rename worktree:', error);
    }
  }, []);

  // Rename a blitz
  const handleBlitzRename = useCallback(async (blitzId: string, newName: string) => {
    try {
      await window.electronAPI.invoke('blitz:update-display-name', blitzId, newName);
      setBlitzCache(prev => {
        const updated = new Map(prev);
        const blitz = updated.get(blitzId);
        if (blitz) {
          updated.set(blitzId, { ...blitz, displayName: newName });
        }
        return updated;
      });
    } catch (error) {
      console.error('[SessionHistory] Failed to rename blitz:', error);
    }
  }, []);

  // Toggle pin status for a blitz
  const handleBlitzPinToggle = useCallback(async (blitzId: string, isPinned: boolean) => {
    try {
      await window.electronAPI.invoke('blitz:update-pinned', blitzId, isPinned);
      setBlitzCache(prev => {
        const updated = new Map(prev);
        const blitz = updated.get(blitzId);
        if (blitz) {
          updated.set(blitzId, { ...blitz, isPinned });
        }
        return updated;
      });
    } catch (error) {
      console.error('[SessionHistory] Failed to toggle blitz pin:', error);
    }
  }, []);

  // Archive a blitz and all its worktrees
  const handleBlitzArchive = useCallback(async (blitzId: string) => {
    try {
      // Find all worktrees and sessions belonging to this blitz
      const blitzWorktreeIds = new Set<string>();
      const blitzSessions: typeof allSessions = [];
      for (const session of allSessions) {
        if (session.parentSessionId === blitzId) {
          blitzSessions.push(session);
          if (session.worktreeId) {
            blitzWorktreeIds.add(session.worktreeId);
          }
        }
      }

      await window.electronAPI.invoke('blitz:archive', blitzId, workspacePath);

      // Also find sessions that live on blitz worktrees but aren't direct blitz children
      // (e.g., sessions manually added to a blitz worktree later)
      const allBlitzWorktreeSessions = allSessions.filter(
        s => s.worktreeId && blitzWorktreeIds.has(s.worktreeId)
      );

      // Optimistic UI updates - remove all sessions on blitz worktrees from atom state
      allBlitzWorktreeSessions.forEach(session => {
        removeSessionFromAtom(session.id);
      });
      // Also remove the blitz session itself from the atom
      removeSessionFromAtom(blitzId);
      // Remove from filtered list
      setSessions(prev => prev.filter(s =>
        s.parentSessionId !== blitzId && !(s.worktreeId && blitzWorktreeIds.has(s.worktreeId))
      ));

      // Notify parent to close tabs for archived sessions
      allBlitzWorktreeSessions.forEach(session => {
        if (onSessionArchive) {
          onSessionArchive(session.id);
        }
      });

      // Remove worktrees from cache
      setWorktreeCache(prev => {
        const newCache = new Map(prev);
        for (const worktreeId of blitzWorktreeIds) {
          newCache.delete(worktreeId);
        }
        return newCache;
      });

      // Clean up any super loops tied to these worktrees
      for (const worktreeId of blitzWorktreeIds) {
        const superLoop = superLoops.find(loop => loop.worktreeId === worktreeId);
        if (superLoop) {
          removeSuperLoop(superLoop.id);
        }
      }

      // Update blitz cache
      setBlitzCache(prev => {
        const updated = new Map(prev);
        const blitz = updated.get(blitzId);
        if (blitz) {
          updated.set(blitzId, { ...blitz, isArchived: true });
        }
        return updated;
      });
    } catch (error) {
      console.error('[SessionHistory] Failed to archive blitz:', error);
    }
  }, [workspacePath, allSessions, removeSessionFromAtom, onSessionArchive, superLoops, removeSuperLoop]);

  // Archive all worktrees in a blitz except the one to keep
  const handleArchiveOtherBlitzWorktrees = useCallback(async (blitzId: string, keepWorktreeId: string) => {
    try {
      // Find worktree IDs belonging to this blitz from sessions with parentSessionId === blitzId
      const blitzWorktreeIds = new Set<string>();
      for (const session of sessions) {
        if (session.parentSessionId === blitzId && session.worktreeId && session.worktreeId !== keepWorktreeId) {
          const worktreeData = worktreeCache.get(session.worktreeId);
          if (!worktreeData?.isArchived) {
            blitzWorktreeIds.add(session.worktreeId);
          }
        }
      }

      // Archive each one
      for (const worktreeId of blitzWorktreeIds) {
        await window.electronAPI.worktreeArchive(worktreeId, workspacePath);
      }

      // Update worktree cache to mark them as archived
      setWorktreeCache(prev => {
        const updated = new Map(prev);
        for (const worktreeId of blitzWorktreeIds) {
          const wt = updated.get(worktreeId);
          if (wt) {
            updated.set(worktreeId, { ...wt, isArchived: true });
          }
        }
        return updated;
      });
    } catch (error) {
      console.error('[SessionHistory] Failed to archive other blitz worktrees:', error);
    }
  }, [sessions, worktreeCache, workspacePath]);

  // Super Loop handlers
  const handleSuperLoopUpdate = useCallback(async (
    loopId: string,
    updates: { title?: string; isArchived?: boolean; isPinned?: boolean }
  ) => {
    try {
      const result = await window.electronAPI.invoke('super-loop:update', loopId, updates);
      if (result.success && result.loop) {
        upsertSuperLoop(result.loop);
      }
    } catch (error) {
      console.error('[SessionHistory] Failed to update super loop:', error);
    }
  }, [upsertSuperLoop]);

  const handleSuperLoopArchive = useCallback(async (loop: SuperLoop) => {
    // Super loops own a dedicated worktree - archive via the worktree archive dialog
    // which queues deletion of the actual git worktree
    try {
      const result = await window.electronAPI.invoke('worktree:get', loop.worktreeId);
      if (!result.success || !result.worktree) {
        console.error('[SessionHistory] Failed to get worktree for super loop:', result.error);
        return;
      }
      const wt = result.worktree;
      const autoArchived = await showArchiveWorktreeDialog({
        worktreeId: wt.id,
        worktreeName: wt.displayName || wt.name || wt.path?.split('/').pop() || 'worktree',
        worktreePath: wt.path,
        workspacePath,
      });
      if (autoArchived) {
        cleanupAfterWorktreeArchive(wt.id);
      }
    } catch (error) {
      console.error('[SessionHistory] Failed to archive super loop:', error);
    }
  }, [showArchiveWorktreeDialog, workspacePath, cleanupAfterWorktreeArchive]);

  const handleSuperLoopRename = useCallback((loopId: string, newName: string) => {
    handleSuperLoopUpdate(loopId, { title: newName });
  }, [handleSuperLoopUpdate]);

  const handleSuperLoopPinToggle = useCallback((loopId: string, isPinned: boolean) => {
    handleSuperLoopUpdate(loopId, { isPinned });
  }, [handleSuperLoopUpdate]);

  const toggleSortDropdown = () => {
    setSortDropdownOpen(!sortDropdownOpen);
  };

  const selectSortOption = (option: 'updated' | 'created') => {
    setSortBy(option);
    setSortDropdownOpen(false);
  };

  const toggleNewDropdown = () => {
    newDropdownMenu.setIsOpen(!newDropdownMenu.isOpen);
  };

  // Open the worktree picker modal. It drives creation by calling
  // onNewWorktreeSession({ baseBranch, name }).
  const openWorktreeBaseBranchPicker = useCallback(() => {
    if (!isGitRepo || !onNewWorktreeSession) return;
    newDropdownMenu.setIsOpen(false);
    setWorktreeBaseBranchPickerOpen(true);
  }, [isGitRepo, onNewWorktreeSession, newDropdownMenu]);

  // Handle new button click - if only one option available, trigger it directly
  const handleNewButtonClick = () => {
    // Count the atom-gated alpha items (Meta Agent, Super Loop) alongside the
    // prop callbacks so enabling an alpha feature opens the dropdown instead of
    // firing New Session directly. Without this, standard mode never shows the
    // menu even when alpha options are available.
    const availableOptions = [
      onNewSession,
      onNewWorktreeSession,
      onNewBlitz,
      onNewTerminal,
      isSuperLoopsAvailable || null,
      isMetaAgentEnabled || null,
    ].filter(Boolean);
    if (availableOptions.length === 1) {
      // Only one option available, trigger it directly. `onNewSession` is
      // always defined (it dispatches the create-new-session action atom),
      // so it wins by default; the worktree/terminal branches stay for the
      // future case where `onNewSession` is gated.
      onNewSession();
    } else {
      // Multiple options, show dropdown
      toggleNewDropdown();
    }
  };

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (sortDropdownOpen && !target.closest('.session-history-sort-dropdown')) {
        setSortDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [sortDropdownOpen]);

  // Group worktree sessions by worktreeId and compute worktree timestamps
  const worktreeGroupsData = useMemo(() => {
    const groups = new Map<string, { sessions: SessionItem[]; timestamp: number }>();
    for (const session of sessions) {
      if (session.worktreeId) {
        const existing = groups.get(session.worktreeId);
        if (existing) {
          existing.sessions.push(session);
          // For 'updated', track the latest session update. For 'created', we'll use worktree.createdAt later
          if (sortBy === 'updated') {
            const sessionTimestamp = getDisplayedOrderTimestamp(session);
            existing.timestamp = Math.max(existing.timestamp, sessionTimestamp);
          }
        } else {
          // Initial timestamp (will be replaced with worktree.createdAt for 'created' sort)
          const initialTimestamp = sortBy === 'updated' ? getDisplayedOrderTimestamp(session) : 0;
          groups.set(session.worktreeId, { sessions: [session], timestamp: initialTimestamp });
        }
      }
    }

    // Include child sessions of worktree-group members that don't have a worktreeId themselves.
    // This handles the case where a worktree session is also a workstream parent (has children
    // created via mobile/sync with parentSessionId but no worktreeId). Without this, those
    // children are invisible - filtered out of the root list by parentSessionId, but not
    // included in any worktree group by worktreeId.
    const worktreeSessionIds = new Set<string>();
    for (const [, group] of groups) {
      for (const s of group.sessions) {
        worktreeSessionIds.add(s.id);
      }
    }
    for (const child of sessionRegistry.values()) {
      if (child.parentSessionId && worktreeSessionIds.has(child.parentSessionId) && !child.worktreeId) {
        // Find which worktree group the parent belongs to
        const parent = sessions.find(s => s.id === child.parentSessionId);
        if (parent?.worktreeId) {
          const group = groups.get(parent.worktreeId);
          if (group) {
            group.sessions.push(child);
            if (sortBy === 'updated') {
              const childTimestamp = getDisplayedOrderTimestamp(child);
              group.timestamp = Math.max(group.timestamp, childTimestamp);
            }
          }
        }
      }
    }

    return groups;
  }, [sessions, sortBy, sessionRegistry, getDisplayedOrderTimestamp]);

  // Get all worktree IDs for batch fetching
  const sortedWorktreeIds = useMemo(() => {
    return Array.from(worktreeGroupsData.keys());
  }, [worktreeGroupsData]);

  // Build unified time-grouped data with both sessions and worktrees interleaved
  const groupedItems = useMemo(() => {
    const timestampField = sortBy === 'updated' ? 'updatedAt' : 'createdAt';
    const items: UnifiedListItem[] = [];
    const pinnedItems: UnifiedListItem[] = [];
    const metaAgentItems: UnifiedListItem[] = [];

    // Identify meta-agent sessions and their child sessions
    const metaAgentSessionIds = new Set<string>();
    const metaAgentChildSessionIds = new Set<string>();
    if (isMetaAgentEnabled) {
      for (const session of sessions) {
        if (session.agentRole === 'meta-agent') {
          metaAgentSessionIds.add(session.id);
        }
      }
      // Collect children (sessions created by meta-agent sessions)
      for (const session of sessions) {
        if (session.createdBySessionId && metaAgentSessionIds.has(session.createdBySessionId)) {
          metaAgentChildSessionIds.add(session.id);
        }
      }
      // Build meta-agent group items (always at top)
      for (const session of sessions) {
        if (session.agentRole === 'meta-agent') {
          const childSessions = sessions
            .filter(s => s.createdBySessionId === session.id)
            .sort(compareSessionOrder);
          const latestChildTimestamp = childSessions.length > 0
            ? Math.max(...childSessions.map(s => getDisplayedOrderTimestamp(s)))
            : 0;
          const rank = Math.min(
            getDisplayedOrderRank(session.id),
            ...childSessions.map(s => getDisplayedOrderRank(s.id)),
          );
          const timestamp = Math.max(
            timestampField === 'updatedAt' ? getDisplayedOrderTimestamp(session) : session.createdAt,
            latestChildTimestamp
          );
          metaAgentItems.push({
            type: 'metaAgent' as const,
            metaSession: session,
            childSessions,
            timestamp,
            rank,
          });
        }
      }
      // Sort meta-agent items by timestamp (newest first)
      metaAgentItems.sort(compareUnifiedItems);
    }

    // Add regular sessions and workstreams (those without worktreeId)
    for (const session of sessions) {
      // Skip blitz sessions - they're rendered via BlitzGroup, not as individual items
      if (session.sessionType === 'blitz') continue;
      // Skip meta-agent sessions and their children - they're rendered via MetaAgentGroup
      if (metaAgentSessionIds.has(session.id) || metaAgentChildSessionIds.has(session.id)) continue;

      if (!session.worktreeId) {
        // Typed workstream containers remain structural even when empty.
        const isWorkstream = isWorkstreamParentSession(session);
        if (isWorkstream) {
          // Create workstream item with cached children (or empty array if not loaded yet)
          const cachedChildren = workstreamChildrenCache.get(session.id) || [];

          // For workstreams, use the maximum updatedAt from all children for sorting
          // This ensures workstreams appear based on their most recent activity
          let timestamp: number;
          if (timestampField === 'updatedAt' && cachedChildren.length > 0) {
            timestamp = Math.max(...cachedChildren.map(child => getDisplayedOrderTimestamp(child)));
          } else {
            timestamp = timestampField === 'updatedAt' ? getDisplayedOrderTimestamp(session) : session.createdAt;
          }

          const rank = Math.min(
            getDisplayedOrderRank(session.id),
            ...cachedChildren.map(child => getDisplayedOrderRank(child.id)),
          );
          const item = { type: 'workstream' as const, session, sessions: cachedChildren, timestamp, rank };

          if (session.isPinned) {
            pinnedItems.push(item);
          } else {
            items.push(item);
          }
        } else {
          const timestamp = timestampField === 'updatedAt' ? getDisplayedOrderTimestamp(session) : session.createdAt;
          // Regular session
          const item = { type: 'session' as const, session, timestamp, rank: getDisplayedOrderRank(session.id) };

          if (session.isPinned) {
            pinnedItems.push(item);
          } else {
            items.push(item);
          }
        }
      }
    }

    // Exclude worktrees that belong to Super Loops - those are rendered via SuperLoopGroup
    const superLoopWorktreeIds = new Set(superLoops.map(loop => loop.worktreeId));

    // Group blitz worktrees by blitz parent session ID, keep standalone worktrees separate
    const blitzWorktrees = new Map<string, { worktreeId: string; sessions: SessionItem[] }[]>();
    const standaloneWorktrees: [string, { sessions: SessionItem[]; timestamp: number }][] = [];

    for (const [worktreeId, data] of worktreeGroupsData) {
      // Skip worktrees that belong to Super Loops
      if (superLoopWorktreeIds.has(worktreeId)) {
        continue;
      }

      // Skip worktrees whose sessions are all meta-agent children
      if (metaAgentChildSessionIds.size > 0 && data.sessions.every(s => metaAgentChildSessionIds.has(s.id))) {
        continue;
      }

      // Check if any session in this worktree has a parentSessionId pointing to a blitz session
      const blitzParentId = data.sessions.find(s => s.parentSessionId && blitzCache.has(s.parentSessionId))?.parentSessionId;
      if (blitzParentId) {
        // This worktree belongs to a blitz
        const existing = blitzWorktrees.get(blitzParentId) || [];
        existing.push({ worktreeId, sessions: data.sessions });
        blitzWorktrees.set(blitzParentId, existing);
      } else {
        standaloneWorktrees.push([worktreeId, data]);
      }
    }

    // Also pick up blitz children that have no worktreeId (e.g., analysis sessions)
    for (const session of sessions) {
      if (session.sessionType === 'blitz') continue; // Skip blitz parent
      if (session.worktreeId) continue; // Already handled via worktreeGroupsData
      if (!session.parentSessionId) continue;
      if (!blitzCache.has(session.parentSessionId)) continue;

      const blitzId = session.parentSessionId;
      const existing = blitzWorktrees.get(blitzId) || [];
      existing.push({ worktreeId: `analysis-${session.id}`, sessions: [session] });
      blitzWorktrees.set(blitzId, existing);
    }

    // Sort blitz worktrees by creation time (oldest first) for stable ordering
    for (const worktrees of blitzWorktrees.values()) {
      worktrees.sort((a, b) => {
        const aMin = Math.min(...a.sessions.map(s => s.createdAt));
        const bMin = Math.min(...b.sessions.map(s => s.createdAt));
        return aMin - bMin;
      });
    }

    // Add blitz groups (skip archived blitzes when not showing archived)
    for (const [blitzId, worktrees] of blitzWorktrees) {
      const blitzData = blitzCache.get(blitzId);
      if (!showArchived && blitzData?.isArchived) continue;

      // Use the most recent session timestamp for the blitz group
      const allSessions = worktrees.flatMap(w => w.sessions);
      let timestamp = Math.max(...allSessions.map(s =>
        timestampField === 'updatedAt' ? getDisplayedOrderTimestamp(s) : s.createdAt
      ));
      if (sortBy === 'created' && blitzData?.createdAt) {
        timestamp = blitzData.createdAt;
      }

      const rank = Math.min(...allSessions.map(s => getDisplayedOrderRank(s.id)));
      const item = { type: 'blitz' as const, blitzId, worktrees, timestamp, rank };

      if (blitzData?.isPinned) {
        pinnedItems.push(item);
      } else {
        items.push(item);
      }
    }

    // Add standalone worktree groups as single items (only if they have 2+ sessions)
    // Single-session worktrees are displayed as flat session items
    for (const [worktreeId, data] of standaloneWorktrees) {
      if (data.sessions.length === 1) {
        // Single session in worktree - display as a regular session item (flat, not grouped)
        // but with the worktree icon to indicate it's a worktree session
        const session = data.sessions[0];
        const timestamp = timestampField === 'updatedAt' ? getDisplayedOrderTimestamp(session) : session.createdAt;
        const item = {
          type: 'session' as const,
          session,
          timestamp,
          rank: getDisplayedOrderRank(session.id),
          isWorktreeSession: true
        };

        if (session.isPinned) {
          pinnedItems.push(item);
        } else {
          items.push(item);
        }
      } else {
        // Multiple sessions in worktree - display as a worktree group hierarchy
        // For 'created' sort, use the worktree's actual creation time, not the latest session time
        let timestamp = data.timestamp;
        if (sortBy === 'created') {
          const worktreeData = worktreeCache.get(worktreeId);
          timestamp = worktreeData?.createdAt || 0;
        }
        const rank = Math.min(...data.sessions.map(s => getDisplayedOrderRank(s.id)));
        const item = { type: 'worktree' as const, worktreeId, sessions: data.sessions, timestamp, rank };

        const worktreeData = worktreeCache.get(worktreeId);
        if (worktreeData?.isPinned) {
          pinnedItems.push(item);
        } else {
          items.push(item);
        }
      }
    }

    // Add Super Loops as grouped items
    for (const loop of superLoops) {
      const timestamp = timestampField === 'updatedAt' ? loop.updatedAt : loop.createdAt;
      const loopSessions = worktreeGroupsData.get(loop.worktreeId)?.sessions ?? [];
      const rank = loopSessions.length > 0
        ? Math.min(...loopSessions.map(session => getDisplayedOrderRank(session.id)))
        : Number.MAX_SAFE_INTEGER;
      const item = { type: 'superLoop' as const, loop, timestamp, rank };
      if (loop.isPinned) {
        pinnedItems.push(item);
      } else {
        items.push(item);
      }
    }

    // Group non-pinned items into time buckets
    const groups: Record<TimeGroupKey, UnifiedListItem[]> = {
      'Today': [],
      'Yesterday': [],
      'This Week': [],
      'Last Week': [],
      'This Month': [],
      'Last Month': [],
      'Older': []
    };

    for (const item of items) {
      const groupKey = getTimeGroupKey(item.timestamp);
      groups[groupKey].push(item);
    }

    // Sort items within each group by timestamp (newest first)
    for (const groupKey of Object.keys(groups) as TimeGroupKey[]) {
      groups[groupKey].sort(compareUnifiedItems);
    }

    // Sort pinned items by timestamp (newest first)
    pinnedItems.sort(compareUnifiedItems);

    // Build the result with meta-agent items always first
    const result: Record<string, UnifiedListItem[]> = {};

    // Meta-agent sessions always appear at the very top
    if (metaAgentItems.length > 0) {
      result['Meta Agent'] = metaAgentItems;
    }

    // If we have pinned items, add them as a "Pinned" group
    if (pinnedItems.length > 0) {
      result['Pinned'] = pinnedItems;
    }

    // Add time-based groups
    for (const [groupKey, groupItems] of Object.entries(groups)) {
      if (groupItems.length > 0) {
        result[groupKey] = groupItems;
      }
    }

    return result as Record<TimeGroupKey | 'Pinned' | 'Meta Agent', UnifiedListItem[]>;
  }, [sessions, worktreeGroupsData, sortBy, worktreeCache, workstreamChildrenCache, blitzCache, superLoops, showArchived, isMetaAgentEnabled, getDisplayedOrderRank, getDisplayedOrderTimestamp, compareSessionOrder, compareUnifiedItems]);

  const groupKeys = Object.keys(groupedItems) as (TimeGroupKey | 'Pinned' | 'Meta Agent')[];

  // Flatten groups and their visible items into a single array for Virtuoso.
  // Group headers are included as items; collapsed groups omit their children.
  type FlatVirtuosoItem =
    | { kind: 'group-header'; groupKey: string; itemCount: number; isExpanded: boolean }
    | { kind: 'item'; groupKey: string; item: UnifiedListItem };

  const flatVirtuosoItems = useMemo(() => {
    const flat: FlatVirtuosoItem[] = [];
    for (const groupKey of groupKeys) {
      const items = groupedItems[groupKey];
      const isExpanded = !collapsedGroups.includes(groupKey);
      flat.push({ kind: 'group-header', groupKey, itemCount: items.length, isExpanded });
      if (isExpanded) {
        for (const item of items) {
          flat.push({ kind: 'item', groupKey, item });
        }
      }
    }
    return flat;
  }, [groupKeys, groupedItems, collapsedGroups]);

  // Keep visual order ref in sync with the flattened list for shift-click range selection.
  // Must include ALL visible session IDs in exact visual order -- including sessions nested
  // inside worktree, workstream, blitz, superLoop, and metaAgent groups.
  visualOrderRef.current = useMemo(() => {
    const ids: string[] = [];
    for (const entry of flatVirtuosoItems) {
      if (entry.kind !== 'item') continue;
      const item = entry.item;
      switch (item.type) {
        case 'session':
          ids.push(item.session.id);
          break;
        case 'workstream':
          // Workstream header session + its children
          ids.push(item.session.id);
          for (const child of item.sessions) ids.push(child.id);
          break;
        case 'worktree':
          for (const s of item.sessions) ids.push(s.id);
          break;
        case 'blitz':
          for (const wt of item.worktrees) {
            for (const s of wt.sessions) ids.push(s.id);
          }
          break;
        case 'superLoop': {
          // SuperLoop wraps a worktree -- get its sessions from worktreeGroupsData
          const loopSessions = worktreeGroupsData.get(item.loop.worktreeId);
          if (loopSessions) {
            for (const s of loopSessions.sessions) ids.push(s.id);
          }
          break;
        }
        case 'metaAgent':
          ids.push(item.metaSession.id);
          for (const child of item.childSessions) ids.push(child.id);
          break;
      }
    }
    // console.log('[SessionHistory] visualOrderRef updated:', ids.length, 'session IDs (from', flatVirtuosoItems.filter(e => e.kind === 'item').length, 'items). First 5:', ids.slice(0, 5).map(id => id.slice(0, 8)));
    return ids;
  }, [flatVirtuosoItems, worktreeGroupsData]);

  // Ref for Virtuoso to support scroll-to-active
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Batch fetch all worktree data when sortedWorktreeIds changes (prevents N+1 query problem)
  useEffect(() => {
    const missingWorktreeIds = sortedWorktreeIds.filter(id => !worktreeCache.has(id));

    if (missingWorktreeIds.length === 0) {
      return;
    }

    const fetchBatch = async () => {
      try {
        const result = await window.electronAPI.invoke('worktree:get-batch', missingWorktreeIds);

        if (result.success && result.worktrees) {
          // Update cache with all fetched worktrees at once
          setWorktreeCache(prev => {
            const updated = new Map(prev);
            for (const [worktreeId, worktreeData] of Object.entries(result.worktrees)) {
              updated.set(worktreeId, worktreeData as WorktreeWithStatus);
            }
            return updated;
          });
        }
      } catch (err) {
        console.error('[SessionHistory] Failed to batch fetch worktrees:', err);
      }
    };

    fetchBatch();
  }, [sortedWorktreeIds, worktreeCache]);

  // Fetch blitz sessions (ai_sessions with session_type='blitz') for this workspace
  const fetchBlitzes = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const result = await window.electronAPI.invoke('blitz:list', workspacePath);
      if (result.success && result.blitzes) {
        setBlitzCache(prev => {
          const updated = new Map(prev);
          for (const blitz of result.blitzes) {
            updated.set(blitz.id, {
              id: blitz.id,
              prompt: blitz.prompt,
              displayName: blitz.displayName,
              isPinned: blitz.isPinned,
              isArchived: blitz.isArchived,
              createdAt: blitz.createdAt,
            });
          }
          return updated;
        });
      }
    } catch (err) {
      console.error('[SessionHistory] Failed to fetch blitzes:', err);
    }
  }, [workspacePath]);

  // Initial fetch on workspace change.
  useEffect(() => {
    if (!workspacePath) return;
    fetchBlitzes();
  }, [workspacePath, fetchBlitzes]);

  // Re-fetch when a `blitz:created` event arrives for this workspace. The
  // IPC event is handled centrally in store/listeners/blitzListeners.ts which
  // writes blitzCreatedAtom; we skip the initial-mount value so we don't
  // double-fetch alongside the effect above.
  const blitzCreated = useAtomValue(blitzCreatedAtom);
  const initialBlitzCreatedRef = useRef(blitzCreated);
  useEffect(() => {
    if (!workspacePath) return;
    if (blitzCreated === initialBlitzCreatedRef.current) return;
    if (!blitzCreated || blitzCreated.payload.workspacePath !== workspacePath) return;
    fetchBlitzes();
  }, [blitzCreated, workspacePath, fetchBlitzes]);

  // Fetch children for expanded workstreams.
  //
  // No `isMounted` short-circuit on purpose: pendingWorkstreamChildrenFetchesRef
  // already dedupes concurrent fetches for the same sessionId, and setState
  // on an actually-unmounted component is a no-op in React 18+.
  //
  // We deliberately do NOT subscribe to `sessionRegistry` or
  // `workstreamChildrenCache` in this effect's deps. Both atoms / state
  // values churn frequently from unrelated activity (streamed messages,
  // status indicators) and putting them in deps formed a self-trigger
  // loop: setCache -> dep change -> effect re-runs -> set... etc.
  //
  // Instead we read them via refs (`workstreamChildrenCacheRef`) and
  // `store.get(sessionRegistryAtom)`. The effect now only re-runs on
  // structural changes -- when the workstream `sessions` list, the
  // `collapsedGroups` user preference, the workspace, or the archive
  // filter change -- which is what actually matters for "do we need to
  // fetch more children right now".
  useEffect(() => {
    const cache = workstreamChildrenCacheRef.current;
    const registrySnapshot = store.get(sessionRegistryAtom);

    const workstreamChildrenNeedRefresh = (session: SessionItem) => {
      const cachedChildren = cache.get(session.id);
      if (!cachedChildren) {
        return true;
      }

      // Only refetch on STRUCTURAL changes (add/remove child, or a child we
      // cached is no longer in the registry). updatedAt/title/isArchived/etc
      // churn on every streamed message via sessions:refresh-list, which used
      // to make this comparison flap forever during an active session and
      // burn the renderer at 100% CPU. Field updates for existing children
      // already propagate via sessions:session-updated -> sessionRegistryAtom
      // patch -- the UI reads those directly via per-id atoms, it doesn't
      // need our cached SessionItem copy to also be up to date.
      if (cachedChildren.length !== (session.childCount ?? 0)) {
        return true;
      }

      for (const child of cachedChildren) {
        if (!registrySnapshot.has(child.id)) {
          return true;
        }
      }

      return false;
    };

    // Find workstream sessions that are expanded
    const workstreamSessionsNeedingFetch = sessions.filter(s =>
      !s.worktreeId &&
      (s.childCount ?? 0) > 0 &&
      !collapsedGroups.includes(`workstream:${s.id}`) &&
      !pendingWorkstreamChildrenFetchesRef.current.has(s.id) &&
      workstreamChildrenNeedRefresh(s)
    );

    if (workstreamSessionsNeedingFetch.length === 0) {
      return;
    }

    const fetchChildren = async () => {
      const sessionIds = workstreamSessionsNeedingFetch.map(session => session.id);
      sessionIds.forEach(sessionId => pendingWorkstreamChildrenFetchesRef.current.add(sessionId));

      try {
        const results = await Promise.all(
          workstreamSessionsNeedingFetch.map(async (session) => {
            try {
              const result = await window.electronAPI.invoke(
                'sessions:list-children',
                session.id,
                workspacePath,
                { includeArchived: showArchived }
              );
              if (!result.success || !Array.isArray(result.children)) {
                return null;
              }

              const children: SessionItem[] = result.children.map((c: any) => ({
                id: c.id,
                title: c.title || 'Untitled Session',
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
                provider: c.provider || 'claude',
                model: c.model,
                sessionType: c.sessionType || 'session',
                mode: c.mode || null,
                messageCount: c.messageCount || 0,
                workspaceId: workspacePath,
                isArchived: c.isArchived || false,
                isPinned: c.isPinned || false,
                worktreeId: c.worktreeId || null,
                parentSessionId: c.parentSessionId || null,
                childCount: c.childCount || 0,
                uncommittedCount: c.uncommittedCount || 0,
                // Metadata fields for TrackerPanel and kanban
                ...(c.phase && { phase: c.phase }),
                ...(c.tags && { tags: c.tags }),
                ...(c.linkedTrackerItemIds && { linkedTrackerItemIds: c.linkedTrackerItemIds }),
              }));

              return { sessionId: session.id, children };
            } catch (err) {
              console.error(`[SessionHistory] Failed to fetch children for workstream ${session.id}:`, err);
              return null;
            }
          })
        );

        const successfulResults = results.filter((result): result is { sessionId: string; children: SessionItem[] } => result !== null);
        if (successfulResults.length === 0) {
          return;
        }

        setWorkstreamChildrenCache(prev => {
          const updated = new Map(prev);
          for (const result of successfulResults) {
            updated.set(result.sessionId, result.children);
          }
          return updated;
        });

        // Only mutate the registry atom for children that are genuinely
        // missing. The other paths (sessions:list, session-updated) already
        // keep existing entries in sync, and unconditionally re-setting the
        // atom Map every fetch makes every subscriber re-render -- which
        // brought the renderer back into a re-render loop here.
        const currentRegistry = store.get(sessionRegistryAtom);
        let nextRegistry: Map<string, SessionMeta> | null = null;
        for (const result of successfulResults) {
          for (const child of result.children) {
            if (!currentRegistry.has(child.id)) {
              if (!nextRegistry) nextRegistry = new Map(currentRegistry);
              nextRegistry.set(child.id, child);
            }
          }
        }
        if (nextRegistry) {
          store.set(sessionRegistryAtom, nextRegistry);
        }
      } finally {
        sessionIds.forEach(sessionId => pendingWorkstreamChildrenFetchesRef.current.delete(sessionId));
      }
    };

    fetchChildren();
    // NOTE: `workstreamChildrenCache` and `sessionRegistry` are intentionally
    // omitted from deps — they're read via refs / store.get inside the
    // effect. Including them caused a self-trigger loop (this effect both
    // sets the cache and writes the registry atom).
  }, [sessions, collapsedGroups, workspacePath, showArchived]);

  if (loading) {
    return (
      <div className="session-history flex flex-col h-full bg-[var(--nim-bg)] overflow-hidden">
        <div className="workspace-color-accent h-[3px] w-full opacity-90 shrink-0" style={{ backgroundColor: workspaceColor }} />
        <WorkspaceSummaryHeader
          workspacePath={workspacePath}
          workspaceName={workspaceName}
          showAccent={false}
          actions={
            <>
            {onOpenQuickSearch && (
              <HelpTooltip testId="session-quick-search-button">
                <button
                  className="session-history-search-button flex items-center justify-center p-1.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-colors duration-150 shrink-0 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] active:bg-[var(--nim-bg-tertiary)] [&_svg]:block"
                  data-testid="session-quick-search-button"
                  onClick={onOpenQuickSearch}
                  aria-label="Search sessions"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </button>
              </HelpTooltip>
            )}
            {onImportSessions && (
              <button
                className="session-history-import-button flex items-center justify-center p-1.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-colors duration-150 shrink-0 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] active:bg-[var(--nim-bg-tertiary)] [&_svg]:block"
                data-testid="import-sessions-button"
                onClick={onImportSessions}
                title="Import Claude Agent sessions"
                aria-label="Import sessions"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M13.5 8.5V12.5C13.5 13.0523 13.0523 13.5 12.5 13.5H3.5C2.94772 13.5 2.5 13.0523 2.5 12.5V8.5M8 2.5V10.5M8 10.5L5.5 8M8 10.5L10.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}
            {(
              <div className="session-history-new-dropdown relative z-10">
                <button
                  ref={newDropdownMenu.refs.setReference}
                  className="session-history-new-button flex items-center justify-center p-1.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-colors duration-150 shrink-0 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] active:bg-[var(--nim-bg-tertiary)] [&_svg]:block"
                  data-testid="new-dropdown-button"
                  onClick={handleNewButtonClick}
                  title="Create new..."
                  aria-label="Create new session, worktree, or terminal"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            )}
            </>
          }
        />
        <div className="session-history-section-label px-3 py-1.5 text-[11px] font-semibold text-[var(--nim-text-faint)] uppercase tracking-wider border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shrink-0">Agent Sessions</div>
        <div className="session-history-search px-3 py-2 border-b border-[var(--nim-border)] shrink-0 relative">
          <input
            type="text"
            className="session-history-search-input nim-input w-full pl-3 pr-9 py-2 text-[13px] text-[var(--nim-text)] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded outline-none transition-colors duration-150 placeholder:text-[var(--nim-text-faint)] focus:border-[var(--nim-primary)] focus:bg-[var(--nim-bg)]"
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search sessions"
          />
          {searchQuery && (
            <button
              type="button"
              className="session-history-search-clear absolute right-5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded text-[var(--nim-text-muted)] bg-transparent border-none cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              title="Clear search"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </div>
        <div className="session-history-filters flex items-center px-3 py-2 border-b border-[var(--nim-border)] gap-1.5 shrink-0">
          <div className="session-history-sort-dropdown ml-auto relative">
            <button
              className="session-history-sort-button flex items-center justify-center px-1.5 py-1 text-xs rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text-muted)] cursor-pointer transition-all duration-150 outline-none hover:bg-[var(--nim-bg-tertiary)] hover:border-[var(--nim-primary)] hover:text-[var(--nim-text)] [&_svg]:block"
              onClick={toggleSortDropdown}
              title={`Sorted by: ${sortBy === 'updated' ? 'Last Updated' : 'Created'}`}
              aria-label="Sort sessions"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 2V14M8 14L4 10M8 14L12 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {sortDropdownOpen && (
              <div className="session-history-sort-menu absolute top-[calc(100%+4px)] right-0 min-w-[140px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded overflow-hidden z-[100] shadow-[0_4px_12px_rgba(0,0,0,0.15)]">
                <button
                  className={`session-history-sort-option flex items-center justify-between w-full px-3 py-2 text-[13px] border-none text-[var(--nim-text)] cursor-pointer transition-colors duration-150 text-left gap-2 hover:bg-[var(--nim-bg-hover)] [&>span]:flex-1 [&_svg]:shrink-0 [&_svg]:text-[var(--nim-primary)] ${sortBy === 'updated' ? 'bg-[var(--nim-bg-selected)] font-medium' : ''}`}
                  onClick={() => selectSortOption('updated')}
                >
                  <span>Last Updated</span>
                  {sortBy === 'updated' && (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </button>
                <button
                  className={`session-history-sort-option flex items-center justify-between w-full px-3 py-2 text-[13px] border-none text-[var(--nim-text)] cursor-pointer transition-colors duration-150 text-left gap-2 hover:bg-[var(--nim-bg-hover)] [&>span]:flex-1 [&_svg]:shrink-0 [&_svg]:text-[var(--nim-primary)] ${sortBy === 'created' ? 'bg-[var(--nim-bg-selected)] font-medium' : ''}`}
                  onClick={() => selectSortOption('created')}
                >
                  <span>Created</span>
                  {sortBy === 'created' && (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="session-history-loading flex flex-col items-center justify-center px-4 py-8 text-center text-[var(--nim-text-faint)] text-[13px]">
          <span>Searching sessions...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="session-history flex flex-col h-full bg-[var(--nim-bg)] overflow-hidden">
        <div className="workspace-color-accent h-[3px] w-full opacity-90 shrink-0" style={{ backgroundColor: workspaceColor }} />
        <WorkspaceSummaryHeader
          workspacePath={workspacePath}
          workspaceName={workspaceName}
          showAccent={false}
          actions={
            <>
            {(
              <div className="session-history-new-dropdown relative z-10">
                <button
                  ref={newDropdownMenu.refs.setReference}
                  className="session-history-new-button flex items-center justify-center p-1.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-colors duration-150 shrink-0 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] active:bg-[var(--nim-bg-tertiary)] [&_svg]:block"
                  data-testid="new-dropdown-button"
                  onClick={handleNewButtonClick}
                  title="Create new..."
                  aria-label="Create new session, worktree, or terminal"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            )}
            </>
          }
        />
        <div className="session-history-section-label px-3 py-1.5 text-[11px] font-semibold text-[var(--nim-text-faint)] uppercase tracking-wider border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shrink-0">Agent Sessions</div>
        <div className="session-history-error flex flex-col items-center justify-center px-4 py-8 text-center text-[var(--nim-error)] text-[13px]">
          <span>{error}</span>
        </div>
      </div>
    );
  }

  // Check if we have an active search query
  const hasSearchQuery = searchQuery.trim().length > 0;
  const hasTagFilter = tagFilter.tags.length > 0;

  // Pre-render the "new session / worktree / terminal / blitz" dropdown so that
  // both the empty-state early-return AND the main return can mount it. Before
  // #306 this JSX lived only inside the main return; clicking the + button when
  // all sessions were archived (so the empty-state branch fired) opened the
  // dropdown state but the JSX never rendered, and the user saw nothing happen
  // unless they used Ctrl+N. Rendering the menu through FloatingPortal keeps the
  // placement stable across either return path while escaping clipped ancestors.
  const newDropdownPortal = newDropdownMenu.isOpen && (
    <FloatingPortal>
      <div
        ref={newDropdownMenu.refs.setFloating}
        className="session-history-new-menu min-w-40 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded overflow-hidden z-[1000] shadow-[0_4px_12px_rgba(0,0,0,0.15)] whitespace-nowrap"
        style={newDropdownMenu.floatingStyles}
        {...newDropdownMenu.getFloatingProps()}
      >
      {onNewSession && (
        <button
          className="session-history-new-option flex items-center w-full px-3 py-2 text-[13px] bg-transparent border-none text-[var(--nim-text)] cursor-pointer transition-colors duration-150 text-left gap-2 hover:bg-[var(--nim-bg-hover)] [&_svg]:shrink-0 [&_svg]:text-[var(--nim-text-muted)] [&>span]:flex-1"
          data-testid="new-session-button"
          onClick={() => { onNewSession(); newDropdownMenu.setIsOpen(false); }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <span>New Session</span>
          <span className="session-history-new-option-shortcut flex-none text-[11px] text-[var(--nim-text-muted)] opacity-70">{getShortcutDisplay(KeyboardShortcuts.file.newSession)}</span>
        </button>
      )}
      {onNewWorktreeSession && (
        <button
          className={`session-history-new-option flex items-center w-full px-3 py-2 text-[13px] bg-transparent border-none text-[var(--nim-text)] cursor-pointer transition-colors duration-150 text-left gap-2 hover:bg-[var(--nim-bg-hover)] [&_svg]:shrink-0 [&_svg]:text-[var(--nim-text-muted)] [&>span]:flex-1 ${!isGitRepo ? 'opacity-50 cursor-not-allowed hover:bg-transparent' : ''}`}
          data-testid="new-worktree-session-button"
          onClick={() => { if (isGitRepo) { openWorktreeBaseBranchPicker(); } }}
          disabled={!isGitRepo}
          title={!isGitRepo ? 'Worktrees require a git repository' : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M5 13v-2.5a1.5 1.5 0 0 1 1.5-1.5h3"/>
            <path d="M9.5 9V4.5"/>
            <circle cx="5" cy="4.5" r="1.5"/>
            <circle cx="9.5" cy="4.5" r="1.5"/>
            <path d="M5 6v2.5a1.5 1.5 0 0 0 1.5 1.5"/>
            <path d="M12 7v4M10 9h4"/>
          </svg>
          <span>New Worktree</span>
          <span className="session-history-new-option-shortcut flex-none text-[11px] text-[var(--nim-text-muted)] opacity-70">{getShortcutDisplay(KeyboardShortcuts.window.newWorktree)}</span>
        </button>
      )}
      {onNewBlitz && (
        <button
          className={`session-history-new-option flex items-center w-full px-3 py-2 text-[13px] bg-transparent border-none text-[var(--nim-text)] cursor-pointer transition-colors duration-150 text-left gap-2 hover:bg-[var(--nim-bg-hover)] [&_svg]:shrink-0 [&_svg]:text-[var(--nim-text-muted)] ${!isGitRepo ? 'opacity-50 cursor-not-allowed hover:bg-transparent' : ''}`}
          data-testid="new-blitz-button"
          onClick={() => { if (isGitRepo) { onNewBlitz(); newDropdownMenu.setIsOpen(false); } }}
          disabled={!isGitRepo}
          title={!isGitRepo ? 'Blitz requires a git repository' : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 2L4 9h4l-1 5 5-7H8l1-5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="flex-1">New Blitz</span>
          <AlphaBadge size="xs" />
        </button>
      )}
      {onNewTerminal && (
        <button
          className="session-history-new-option flex items-center w-full px-3 py-2 text-[13px] bg-transparent border-none text-[var(--nim-text)] cursor-pointer transition-colors duration-150 text-left gap-2 hover:bg-[var(--nim-bg-hover)] [&_svg]:shrink-0 [&_svg]:text-[var(--nim-text-muted)] [&>span]:flex-1"
          data-testid="new-terminal-button"
          onClick={() => { onNewTerminal(); newDropdownMenu.setIsOpen(false); }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 5L7 9L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9 13H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <span>New Terminal</span>
        </button>
      )}
      {isSuperLoopsAvailable && (
        <button
          className={`session-history-new-option flex items-center w-full px-3 py-2 text-[13px] bg-transparent border-none text-[var(--nim-text)] cursor-pointer transition-colors duration-150 text-left gap-2 hover:bg-[var(--nim-bg-hover)] [&_svg]:shrink-0 [&_svg]:text-[var(--nim-text-muted)] ${!isGitRepo ? 'opacity-50 cursor-not-allowed hover:bg-transparent' : ''}`}
          data-testid="new-super-loop-button"
          onClick={() => { if (isGitRepo) { openSuperLoopDialog(); newDropdownMenu.setIsOpen(false); } }}
          disabled={!isGitRepo}
          title={!isGitRepo ? 'Super Loops require a git repository' : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M13 5.5H9.5M13 5.5L10.5 3M13 5.5L10.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M3 10.5H6.5M3 10.5L5.5 8M3 10.5L5.5 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="flex-1">New Super Loop</span>
          <AlphaBadge size="xs" />
        </button>
      )}
      {isMetaAgentEnabled && (
        <button
          className="session-history-new-option flex items-center w-full px-3 py-2 text-[13px] bg-transparent border-none text-[var(--nim-text)] cursor-pointer transition-colors duration-150 text-left gap-2 hover:bg-[var(--nim-bg-hover)] [&_svg]:shrink-0 [&_svg]:text-[var(--nim-text-muted)]"
          data-testid="new-meta-agent-button"
          onClick={() => { void handleNewMetaAgent(); newDropdownMenu.setIsOpen(false); }}
        >
          <MaterialSymbol icon="hub" size={14} />
          <span className="flex-1">New Meta Agent</span>
          <AlphaBadge size="xs" />
        </button>
      )}
      </div>
    </FloatingPortal>
  );

  const worktreeBaseBranchPickerPortal = onNewWorktreeSession && (
    <WorktreeBaseBranchPicker
      isOpen={worktreeBaseBranchPickerOpen}
      workspacePath={workspacePath}
      onCreate={async ({ baseBranch, name }) => {
        // Await the parent's create handler so the picker can keep its
        // submitting state until creation actually resolves (and surface
        // any error inline without losing the user's input).
        await onNewWorktreeSession({ baseBranch, name });
        setWorktreeBaseBranchPickerOpen(false);
      }}
      onCancel={() => setWorktreeBaseBranchPickerOpen(false)}
    />
  );

  if (sessions.length === 0 && !hasSearchQuery && !hasTagFilter) {
    // No sessions at all - show simple empty state without search.
    // When a search or tag filter is active we fall through to the main render so
    // the search input and tag chips stay mounted -- otherwise the user can't
    // clear a filter that hides every session (e.g. after archiving the last
    // session with the filtered tag). See GitHub #470 / NIM-675.
    return (
      <div className="session-history flex flex-col h-full bg-[var(--nim-bg)] overflow-hidden">
        <div className="workspace-color-accent h-[3px] w-full opacity-90 shrink-0" style={{ backgroundColor: workspaceColor }} />
        <WorkspaceSummaryHeader
          workspacePath={workspacePath}
          workspaceName={workspaceName}
          showAccent={false}
          actions={
            <>
              {onImportSessions && (
                <button
                  className="session-history-import-button flex items-center justify-center p-1.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-colors duration-150 shrink-0 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] active:bg-[var(--nim-bg-tertiary)] [&_svg]:block"
                  data-testid="import-sessions-button"
                  onClick={onImportSessions}
                  title="Import Claude Agent sessions"
                  aria-label="Import sessions"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M13.5 8.5V12.5C13.5 13.0523 13.0523 13.5 12.5 13.5H3.5C2.94772 13.5 2.5 13.0523 2.5 12.5V8.5M8 2.5V10.5M8 10.5L5.5 8M8 10.5L10.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              )}
              {(
                <div className="session-history-new-dropdown relative z-10">
                  <button
                    ref={newDropdownMenu.refs.setReference}
                    className="session-history-new-button flex items-center justify-center p-1.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-colors duration-150 shrink-0 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] active:bg-[var(--nim-bg-tertiary)] [&_svg]:block"
                    data-testid="new-dropdown-button"
                    onClick={handleNewButtonClick}
                    title="Create new..."
                    aria-label="Create new session or worktree"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                  </button>
                </div>
              )}
              {onNewTerminal && (
                <button
                  className="session-history-new-terminal-button flex items-center justify-center p-1.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-colors duration-150 shrink-0 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] active:bg-[var(--nim-bg-tertiary)] [&_svg]:block"
                  data-testid="new-terminal-button"
                  onClick={() => onNewTerminal()}
                  title="New terminal"
                  aria-label="Create new terminal"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 5L7 9L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M9 13H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </button>
              )}
            </>
          }
        />
        <div className="session-history-section-label px-3 py-1.5 text-[11px] font-semibold text-[var(--nim-text-faint)] uppercase tracking-wider border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shrink-0">Agent Sessions</div>
        <div className="session-history-empty flex flex-col items-center justify-center px-4 py-8 text-center text-[var(--nim-text-faint)] text-[13px]">
          <p className="my-1">No sessions yet</p>
          <p className="session-history-empty-hint my-1 text-xs text-[var(--nim-text-faint)]">
            Create a new session to get started
          </p>
        </div>
        {/* Mount the new-session dropdown here too. Without this, clicking +
            in the empty state opens the dropdown state but the JSX is missing
            from this return path - the previous render site was only in the
            main return below. See #306. */}
        {newDropdownPortal}
        {worktreeBaseBranchPickerPortal}
      </div>
    );
  }

  return (
    <div className="session-history flex flex-col h-full bg-[var(--nim-bg)] overflow-hidden">
      <div className="workspace-color-accent h-[3px] w-full opacity-90 shrink-0" style={{ backgroundColor: workspaceColor }} />
      <WorkspaceSummaryHeader
        workspacePath={workspacePath}
        workspaceName={workspaceName}
        showAccent={false}
        actions={
          <>
          <HelpTooltip testId="session-kanban-button">
            <button
              className={`flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold rounded border cursor-pointer transition-all duration-150 shrink-0 ${viewMode === 'kanban' ? 'bg-[var(--nim-primary)] border-[var(--nim-primary)] text-white hover:opacity-90' : 'bg-[var(--nim-bg-secondary)] border-[var(--nim-border)] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] hover:text-[var(--nim-text)]'}`}
              data-testid="session-kanban-button"
              onClick={() => {
                const newMode = viewMode === 'kanban' ? 'list' : 'kanban';
                posthog?.capture('session_view_mode_switched', {
                  fromMode: viewMode,
                  toMode: newMode,
                });
                setViewMode(newMode);
              }}
              aria-label={viewMode === 'kanban' ? 'Switch to list view' : 'Switch to kanban view'}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1.5" y="2" width="3.5" height="12" rx="0.75" stroke="currentColor" strokeWidth="1.25"/>
                <rect x="6.25" y="2" width="3.5" height="8" rx="0.75" stroke="currentColor" strokeWidth="1.25"/>
                <rect x="11" y="2" width="3.5" height="10" rx="0.75" stroke="currentColor" strokeWidth="1.25"/>
              </svg>
              Kanban
            </button>
          </HelpTooltip>
          {onOpenQuickSearch && (
            <HelpTooltip testId="session-quick-search-button">
              <button
                className="session-history-search-button flex items-center justify-center p-1.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-colors duration-150 shrink-0 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] active:bg-[var(--nim-bg-tertiary)] [&_svg]:block"
                data-testid="session-quick-search-button"
                onClick={onOpenQuickSearch}
                aria-label="Search sessions"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </HelpTooltip>
          )}
          {onImportSessions && (
            <button
              className="session-history-import-button flex items-center justify-center p-1.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-colors duration-150 shrink-0 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] active:bg-[var(--nim-bg-tertiary)] [&_svg]:block"
              data-testid="import-sessions-button"
              onClick={onImportSessions}
              title="Import Claude Agent sessions"
              aria-label="Import sessions"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M13.5 8.5V12.5C13.5 13.0523 13.0523 13.5 12.5 13.5H3.5C2.94772 13.5 2.5 13.0523 2.5 12.5V8.5M8 2.5V10.5M8 10.5L5.5 8M8 10.5L10.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
          {(
            <div className="session-history-new-dropdown relative z-10">
              <button
                ref={newDropdownMenu.refs.setReference}
                className="session-history-new-button flex items-center justify-center p-1.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[var(--nim-text)] cursor-pointer transition-colors duration-150 shrink-0 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] active:bg-[var(--nim-bg-tertiary)] [&_svg]:block"
                data-testid="new-dropdown-button"
                onClick={handleNewButtonClick}
                title="Create new..."
                aria-label="Create new session, worktree, or terminal"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          )}
          </>
        }
      />
      <div className="session-history-section-label px-3 py-1.5 text-[11px] font-semibold text-[var(--nim-text-faint)] uppercase tracking-wider border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shrink-0">Agent Sessions</div>
      <div className="session-history-search px-3 py-2 border-b border-[var(--nim-border)] shrink-0 relative z-10">
        <input
          ref={searchInputRef}
          type="text"
          className="session-history-search-input nim-input w-full px-3 py-2 pr-14 text-[13px] text-[var(--nim-text)] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded outline-none transition-colors duration-150 placeholder:text-[var(--nim-text-faint)] focus:border-[var(--nim-primary)] focus:bg-[var(--nim-bg)]"
          placeholder="Search or type # to filter by tag..."
          value={showTagDropdown
            ? (searchQuery ? searchQuery + ' ' : '') + '#' + tagQuery
            : searchQuery}
          onChange={(e) => {
            const value = e.target.value;
            const hashIndex = value.lastIndexOf('#');
            if (hashIndex >= 0) {
              // Tag-picker mode: text before the last '#' is the title search,
              // text after it is the tag query.
              setSearchQuery(value.slice(0, hashIndex).trim());
              setTagQuery(value.slice(hashIndex + 1));
              setShowTagDropdown(true);
              setHighlightedTagIndex(0);
            } else {
              setSearchQuery(value);
              setShowTagDropdown(false);
              setTagQuery('');
              // Debounced posthog tracking for search-mode filters
              if (searchTrackDebounceRef.current) clearTimeout(searchTrackDebounceRef.current);
              if (value.trim()) {
                searchTrackDebounceRef.current = setTimeout(() => {
                  posthog?.capture('session_list_filter_applied', {
                    filterType: 'search',
                    activeTagCount: tagFilter.tags.length,
                  });
                }, 1000);
              }
            }
          }}
          onKeyDown={(e) => {
            if (showTagDropdown) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlightedTagIndex(i => Math.min(i + 1, filteredTagOptions.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlightedTagIndex(i => Math.max(i - 1, 0));
              } else if (e.key === 'Enter' || e.key === 'Tab') {
                if (filteredTagOptions.length > 0) {
                  e.preventDefault();
                  addTagFilter(filteredTagOptions[highlightedTagIndex].name);
                }
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setShowTagDropdown(false);
                setTagQuery('');
              } else if (e.key === 'Backspace' && tagQuery.length === 0) {
                // Backspace at empty tag query closes tag mode rather than nuking the title text
                e.preventDefault();
                setShowTagDropdown(false);
              }
              return;
            }
            if (e.key === 'Tab' && searchQuery && !contentSearchTriggered) {
              e.preventDefault();
              searchMessageContents();
            } else if (e.key === 'Backspace' && searchQuery.length === 0 && tagFilter.tags.length > 0) {
              // Backspace on empty input pops the most recent tag chip
              e.preventDefault();
              removeTagFilter(tagFilter.tags[tagFilter.tags.length - 1]);
            }
          }}
          onFocus={() => {
            if (tagQuery) setShowTagDropdown(true);
          }}
          aria-label="Search sessions or filter by tag"
        />
        {(searchQuery || tagFilter.tags.length > 0 || showTagDropdown) && (
          <button
            type="button"
            className="session-history-search-clear absolute right-5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded text-[var(--nim-text-muted)] bg-transparent border-none cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
            onClick={() => {
              setSearchQuery('');
              setTagQuery('');
              setShowTagDropdown(false);
              if (tagFilter.tags.length > 0) setTagFilter({ tags: [] });
            }}
            aria-label="Clear search and tag filters"
            title="Clear search and tag filters"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        )}
        {/* Tag typeahead dropdown */}
        {showTagDropdown && (
          <div
            ref={tagDropdownRef}
            className="session-history-tag-dropdown absolute left-3 right-3 top-full mt-1 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded shadow-lg z-[100] max-h-[220px] overflow-y-auto"
            data-testid="session-list-tag-dropdown"
          >
            {filteredTagOptions.length > 0 ? (
              filteredTagOptions.slice(0, 15).map((tag, i) => (
                <button
                  key={tag.name}
                  type="button"
                  className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center justify-between cursor-pointer transition-colors ${
                    i === highlightedTagIndex
                      ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)]'
                      : 'text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-tertiary)]'
                  }`}
                  onMouseEnter={() => setHighlightedTagIndex(i)}
                  onClick={() => addTagFilter(tag.name)}
                >
                  <span>#{tag.name}</span>
                  <span className="text-[var(--nim-text-faint)] text-[11px] tabular-nums">{tag.count}</span>
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-[12px] text-[var(--nim-text-faint)] italic">
                {tagQuery ? 'No matching tags' : 'No tags in this workspace yet'}
              </div>
            )}
          </div>
        )}
        {isSearching && (
          <div className="session-history-search-status absolute right-12 top-1/2 -translate-y-1/2 text-xs text-[var(--nim-text-faint)] pointer-events-none">
            {contentSearchTriggered ? 'Searching messages...' : 'Searching...'}
          </div>
        )}
        {!isSearching && searchQuery && !contentSearchTriggered && (
          <button
            className="session-history-content-search-hint absolute right-12 top-1/2 -translate-y-1/2 text-xs text-[var(--nim-text-muted)] bg-transparent border-none cursor-pointer flex items-center gap-1 px-2 py-1 rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-primary)]"
            onClick={searchMessageContents}
            title="Press Tab to search message contents"
          >
            ⇥ Search contents
          </button>
        )}
        {/* Search filters dropdown - only visible when content search is active */}
        {contentSearchTriggered && searchQuery && (
          <div className="absolute right-12 top-1/2 -translate-y-1/2" ref={searchFiltersRef}>
            <button
              className={`flex items-center justify-center w-5 h-5 rounded transition-all duration-150 ${
                showSearchFilters || searchFilters.timeRange !== '30d' || searchFilters.direction !== 'all'
                  ? 'bg-[var(--nim-primary)] text-white'
                  : 'text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]'
              }`}
              onClick={() => setShowSearchFilters(!showSearchFilters)}
              title="Search filters"
              aria-label="Search filters"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
            {showSearchFilters && (
              <div className="absolute right-0 top-full mt-1 z-[100] min-w-[160px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg shadow-lg overflow-hidden">
                <div className="px-3 py-2 text-xs font-medium text-[var(--nim-text-muted)] border-b border-[var(--nim-border)]">
                  Time Range
                </div>
                {(Object.entries(TIME_RANGE_LABELS) as [SearchTimeRange, string][]).map(([value, label]) => (
                  <button
                    key={value}
                    className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                      searchFilters.timeRange === value
                        ? 'bg-[var(--nim-bg-selected)] text-[var(--nim-primary)]'
                        : 'text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
                    }`}
                    onClick={() => {
                      const newFilters = { ...searchFilters, timeRange: value };
                      setSearchFilters(newFilters);
                      executeSearch(searchQuery, newFilters);
                    }}
                  >
                    {label}
                    {searchFilters.timeRange === value && <span className="float-right">✓</span>}
                  </button>
                ))}
                <div className="px-3 py-2 text-xs font-medium text-[var(--nim-text-muted)] border-t border-b border-[var(--nim-border)]">
                  Message Type
                </div>
                {(Object.entries(DIRECTION_LABELS) as [SearchDirection, string][]).map(([value, label]) => (
                  <button
                    key={value}
                    className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                      searchFilters.direction === value
                        ? 'bg-[var(--nim-bg-selected)] text-[var(--nim-primary)]'
                        : 'text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
                    }`}
                    onClick={() => {
                      const newFilters = { ...searchFilters, direction: value };
                      setSearchFilters(newFilters);
                      executeSearch(searchQuery, newFilters);
                    }}
                  >
                    {label}
                    {searchFilters.direction === value && <span className="float-right">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {/* Active tag filter chips - wraps below the input when present */}
        {tagFilter.tags.length > 0 && (
          <div
            className="session-history-tag-chips flex flex-wrap gap-1 mt-2"
            data-testid="session-list-tag-chips"
          >
            {tagFilter.tags.map(tag => (
              <button
                key={tag}
                type="button"
                className="session-history-tag-chip flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border cursor-pointer bg-blue-400/[0.12] border-blue-400/30 text-blue-400 hover:bg-blue-400/[0.18]"
                onClick={() => removeTagFilter(tag)}
                title={`Remove #${tag} filter`}
                data-testid={`session-list-tag-chip-${tag}`}
              >
                #{tag}
                <MaterialSymbol icon="close" size={12} />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="session-history-filters flex items-center px-3 py-2 border-b border-[var(--nim-border)] gap-1.5 shrink-0">
        <button
          className={`session-history-archive-filter flex items-center justify-center px-1.5 py-1 text-xs rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text-faint)] cursor-pointer transition-all duration-150 outline-none hover:bg-[var(--nim-bg-tertiary)] hover:border-[var(--nim-primary)] hover:text-[var(--nim-text)] [&_svg]:block ${showArchived ? 'bg-[var(--nim-primary)] border-[var(--nim-primary)] text-white hover:opacity-90' : ''}`}
          onClick={toggleShowArchived}
          title={showArchived ? 'Hide archived sessions' : 'Show archived sessions'}
          aria-label={showArchived ? 'Hide archived sessions' : 'Show archived sessions'}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 5h12M4 5v8a1 1 0 001 1h6a1 1 0 001-1V5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M6 8h4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
          </svg>
        </button>
        {(() => {
          const hasFilter = searchQuery.trim().length > 0 || tagFilter.tags.length > 0;
          const visibleCount = sessions.length;
          const totalLabel = `${iosMatchCount} non-archived session${iosMatchCount === 1 ? '' : 's'} in this workspace (matches the iOS project list count)`;
          const title = hasFilter
            ? `${visibleCount} of ${iosMatchCount} visible after current filters -- ${totalLabel}`
            : totalLabel;
          return (
            <span
              className="session-history-match-count text-[11px] text-[var(--nim-text-faint)] tabular-nums"
              title={title}
              data-testid="session-list-match-count"
            >
              {hasFilter
                ? `${visibleCount} of ${iosMatchCount} session${iosMatchCount === 1 ? '' : 's'}`
                : `${iosMatchCount} session${iosMatchCount === 1 ? '' : 's'}`}
            </span>
          );
        })()}
        <div className="session-history-sort-dropdown ml-auto relative">
          <button
            className="session-history-sort-button flex items-center justify-center px-1.5 py-1 text-xs rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text-muted)] cursor-pointer transition-all duration-150 outline-none hover:bg-[var(--nim-bg-tertiary)] hover:border-[var(--nim-primary)] hover:text-[var(--nim-text)] [&_svg]:block"
            onClick={toggleSortDropdown}
            title={`Sorted by: ${sortBy === 'updated' ? 'Last Updated' : 'Created'}`}
            aria-label="Sort sessions"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8 2V14M8 14L4 10M8 14L12 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {sortDropdownOpen && (
            <div className="session-history-sort-menu absolute top-[calc(100%+4px)] right-0 min-w-[140px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded overflow-hidden z-[100] shadow-[0_4px_12px_rgba(0,0,0,0.15)]">
              <button
                className={`session-history-sort-option flex items-center justify-between w-full px-3 py-2 text-[13px] border-none text-[var(--nim-text)] cursor-pointer transition-colors duration-150 text-left gap-2 hover:bg-[var(--nim-bg-hover)] [&>span]:flex-1 [&_svg]:shrink-0 [&_svg]:text-[var(--nim-primary)] ${sortBy === 'updated' ? 'bg-[var(--nim-bg-selected)] font-medium' : ''}`}
                onClick={() => selectSortOption('updated')}
              >
                <span>Last Updated</span>
                {sortBy === 'updated' && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
              <button
                className={`session-history-sort-option flex items-center justify-between w-full px-3 py-2 text-[13px] border-none text-[var(--nim-text)] cursor-pointer transition-colors duration-150 text-left gap-2 hover:bg-[var(--nim-bg-hover)] [&>span]:flex-1 [&_svg]:shrink-0 [&_svg]:text-[var(--nim-primary)] ${sortBy === 'created' ? 'bg-[var(--nim-bg-selected)] font-medium' : ''}`}
                onClick={() => selectSortOption('created')}
              >
                <span>Created</span>
                {sortBy === 'created' && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
      {(selectedSessionIds.size > 0 || selectedGroupIds.size > 0) && (
        <div className="session-history-bulk-actions flex items-center justify-between px-3 py-2 bg-[var(--nim-bg-selected)] border-b border-[var(--nim-border)] gap-2">
          <span className="session-history-bulk-count text-xs font-medium text-[var(--nim-text)]">{selectedSessionIds.size + selectedGroupIds.size} selected</span>
          <div className="session-history-bulk-buttons flex gap-1.5">
            {showArchived ? (
              <button className="session-history-bulk-button flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] cursor-pointer transition-all duration-150 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] [&_svg]:shrink-0" onClick={handleBulkUnarchive} title="Unarchive selected">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M2 5h12M4 5v8a1 1 0 001 1h6a1 1 0 001-1V5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M8 11V7M6 9l2-2 2 2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Unarchive
              </button>
            ) : (
              <button className="session-history-bulk-button flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] cursor-pointer transition-all duration-150 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] [&_svg]:shrink-0" onClick={handleBulkArchive} title="Archive selected">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M2 5h12M4 5v8a1 1 0 001 1h6a1 1 0 001-1V5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M8 7v4M6 9l2 2 2-2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Archive
              </button>
            )}
            {(
              <button className="session-history-bulk-button flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-error)] cursor-pointer transition-all duration-150 hover:bg-[var(--nim-error)] hover:border-[var(--nim-error)] hover:text-white [&_svg]:shrink-0" onClick={handleBulkDelete} title="Delete selected">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M2 4h12M5.333 4V2.667A.667.667 0 016 2h4a.667.667 0 01.667.667V4M12.667 4v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Delete
              </button>
            )}
            <button className="session-history-bulk-button flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] cursor-pointer transition-all duration-150 hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] [&_svg]:shrink-0" onClick={clearSelection} title="Clear selection">
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="session-history-list nim-scrollbar flex-1 overflow-y-auto overflow-x-hidden py-2 scroll-smooth" ref={scrollContainerCallbackRef}>
        {groupKeys.length === 0 && (hasSearchQuery || hasTagFilter) ? (
          // No results for the active search/tag filter - offer a clear affordance
          <div className="session-history-empty flex flex-col items-center justify-center px-4 py-8 text-center text-[var(--nim-text-faint)] text-[13px]">
            <p className="my-1">No matching sessions found</p>
            <p className="session-history-empty-hint my-1 text-xs text-[var(--nim-text-faint)]">
              {hasSearchQuery && hasTagFilter ? 'Adjust your search or ' : hasSearchQuery ? 'Try a different search term or ' : 'Remove the active tag filter or '}
              <button
                className="session-history-clear-search-link bg-transparent border-none text-[var(--nim-primary)] cursor-pointer underline p-0 text-inherit font-inherit hover:opacity-80"
                onClick={() => {
                  setSearchQuery('');
                  if (hasTagFilter) setTagFilter({ tags: [] });
                }}
                type="button"
              >
                {hasSearchQuery && hasTagFilter ? 'clear search and tags' : hasSearchQuery ? 'clear search' : 'clear tag filter'}
              </button>
            </p>
          </div>
        ) : (
          /* Virtualized list view - flat Virtuoso list with group headers as items */
          flatVirtuosoItems.length > 0 && scrollContainerEl ? (
            <Virtuoso
              ref={virtuosoRef}
              customScrollParent={scrollContainerEl}
              totalCount={flatVirtuosoItems.length}
              overscan={400}
              itemContent={(index) => {
                const entry = flatVirtuosoItems[index];
                if (entry.kind === 'group-header') {
                  // Render inline group header (same markup as CollapsibleGroup)
                  return (
                    <div className="collapsible-group mb-1">
                      <button
                        className="collapsible-group-header flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-xs font-semibold text-nim-muted text-left transition-colors duration-150 hover:bg-nim-hover"
                        onClick={() => handleToggleGroup(entry.groupKey)}
                        aria-expanded={entry.isExpanded}
                        aria-label={`${entry.groupKey} group, ${entry.isExpanded ? 'expanded' : 'collapsed'}`}
                      >
                        <MaterialSymbol
                          icon="chevron_right"
                          size={12}
                          className={`collapsible-group-chevron shrink-0 text-nim-faint transition-transform duration-200 ${entry.isExpanded ? 'rotate-90' : ''}`}
                        />
                        <span className="collapsible-group-title flex-1 overflow-hidden text-ellipsis whitespace-nowrap uppercase tracking-wide">{entry.groupKey}</span>
                        <span className="collapsible-group-count shrink-0 text-[0.625rem] text-nim-faint font-normal">{entry.itemCount}</span>
                      </button>
                    </div>
                  );
                }

                // Render the appropriate item type
                const item = entry.item;
                if (item.type === 'blitz') {
                  const blitzData = blitzCache.get(item.blitzId);
                  const isBlitzExpanded = !collapsedGroups.includes(`blitz:${item.blitzId}`);
                  const allSessionIds = item.worktrees.flatMap(w => w.sessions.map(s => s.id));
                  const isBlitzActive = allSessionIds.includes(activeSessionId || '');

                  return (
                    <BlitzGroup
                      blitzId={item.blitzId}
                      title={blitzData?.displayName || (blitzData?.prompt ? blitzData.prompt.slice(0, 60) + (blitzData.prompt.length > 60 ? '...' : '') : 'Loading...')}
                      isExpanded={isBlitzExpanded}
                      isActive={isBlitzActive}
                      isPinned={blitzData?.isPinned}
                      isArchived={blitzData?.isArchived}
                      isSelected={selectedGroupIds.has(`blitz:${item.blitzId}`)}
                      onToggle={() => handleToggleGroup(`blitz:${item.blitzId}`)}
                      onMultiSelect={() => handleGroupMultiSelect(`blitz:${item.blitzId}`)}
                      worktrees={item.worktrees.map(w => ({
                        worktreeId: w.worktreeId,
                        sessions: w.sessions,
                        worktreeData: worktreeCache.get(w.worktreeId),
                      }))}
                      activeSessionId={activeSessionId}
                      onSessionSelect={handleSessionClick}
                      worktreeCache={worktreeCache}
                      collapsedGroups={collapsedGroups}
                      onToggleWorktreeGroup={handleToggleGroup}
                      onBlitzRename={handleBlitzRename}
                      onBlitzPinToggle={handleBlitzPinToggle}
                      onBlitzArchive={handleBlitzArchive}
                      onArchiveOtherWorktrees={handleArchiveOtherBlitzWorktrees}
                      onWorktreeRename={handleWorktreeRename}
                      onWorktreeArchive={handleArchiveWorktree}
                      onWorktreeCleanGitignored={handleCleanGitignored}
                      onSessionRename={onSessionRename}
                    />
                  );
                }
                if (item.type === 'worktree') {
                  const worktreeData = worktreeCache.get(item.worktreeId);
                  const isWorktreeExpanded = !collapsedGroups.includes(`worktree:${item.worktreeId}`);

                  return (
                    <WorkstreamGroup
                      type="worktree"
                      id={item.worktreeId}
                      title={worktreeData?.displayName || worktreeData?.name || 'Loading...'}
                      isExpanded={isWorktreeExpanded}
                      isActive={item.sessions.some(s => s.id === activeSessionId)}
                      isSelected={selectedGroupIds.has(`worktree:${item.worktreeId}`)}
                      onToggle={() => handleToggleGroup(`worktree:${item.worktreeId}`)}
                      onMultiSelect={() => handleGroupMultiSelect(`worktree:${item.worktreeId}`)}
                      onSelect={() => {
                        clearSelection();
                        const lastActiveSessionId = store.get(worktreeActiveSessionAtom(item.worktreeId));
                        const sessionToSelect = lastActiveSessionId
                          ? item.sessions.find(s => s.id === lastActiveSessionId)
                          : null;
                        const targetSession = sessionToSelect || item.sessions[0];
                        if (targetSession) {
                          lastSelectedIdRef.current = targetSession.id;
                          onSessionSelect(targetSession.id);
                        }
                      }}
                      sessions={item.sessions}
                      sortBy={sortBy}
                      activeSessionId={activeSessionId}
                      onSessionSelect={handleSessionClick}
                      onChildSessionSelect={onChildSessionSelect}
                      onSessionDelete={handleDeleteSession}
                      onSessionArchive={handleArchiveSession}
                      onSessionUnarchive={handleUnarchiveSession}
                      onSessionPinToggle={handleSessionPinToggle}
                      onSessionRename={onSessionRename}
                      onSessionBranch={onSessionBranch}
                      worktree={worktreeData || { id: item.worktreeId, name: 'Loading...', path: '', branch: '' }}
                      gitStatus={worktreeData?.gitStatus}
                      onWorktreePinToggle={handleWorktreePinToggle}
                      onWorktreeArchive={handleArchiveWorktree}
                      onWorktreeRename={handleWorktreeRename}
                      onWorktreeCleanGitignored={handleCleanGitignored}
                      onFilesMode={onWorktreeFilesMode}
                      onChangesMode={onWorktreeChangesMode}
                      onAddSession={onAddSessionToWorktree}
                      onAddTerminal={onAddTerminalToWorktree}
                    />
                  );
                }
                if (item.type === 'workstream') {
                  const session = item.session;
                  const isWorkstreamExpanded = !collapsedGroups.includes(`workstream:${session.id}`);
                  const isWorkstreamActive = session.id === activeSessionId ||
                                             (activeSessionParentId === session.id);

                  return (
                    <WorkstreamGroup
                      type="workstream"
                      id={session.id}
                      title={session.title || 'Untitled Workstream'}
                      isExpanded={isWorkstreamExpanded}
                      isActive={isWorkstreamActive}
                      isSelected={selectedGroupIds.has(`workstream:${session.id}`)}
                      onToggle={() => handleToggleGroup(`workstream:${session.id}`)}
                      onMultiSelect={() => handleGroupMultiSelect(`workstream:${session.id}`)}
                      onSelect={() => { clearSelection(); lastSelectedIdRef.current = session.id; onSessionSelect(session.id); }}
                      sessions={item.sessions}
                      sortBy={sortBy}
                      activeSessionId={activeSessionId}
                      onSessionSelect={handleSessionClick}
                      onChildSessionSelect={onChildSessionSelect}
                      onSessionDelete={handleDeleteSession}
                      onSessionArchive={handleArchiveSession}
                      onSessionUnarchive={handleUnarchiveSession}
                      onSessionPinToggle={handleSessionPinToggle}
                      onSessionRename={onSessionRename}
                      onSessionBranch={onSessionBranch}
                      provider={session.provider}
                      isPinned={session.isPinned}
                      isArchived={session.isArchived}
                      childCount={session.childCount}
                      projectPath={session.workspaceId}
                      onWorkstreamArchive={handleArchiveSession}
                      onWorkstreamPinToggle={handleSessionPinToggle}
                    />
                  );
                }
                if (item.type === 'metaAgent') {
                  const isMetaExpanded = !collapsedGroups.includes(`meta-agent:${item.metaSession.id}`);
                  const isMetaActive = item.metaSession.id === activeSessionId
                    || item.childSessions.some(s => s.id === activeSessionId);

                  return (
                    <MetaAgentGroup
                      metaSession={item.metaSession}
                      childSessions={item.childSessions}
                      isExpanded={isMetaExpanded}
                      isActive={isMetaActive}
                      isSelected={selectedGroupIds.has(`meta-agent:${item.metaSession.id}`)}
                      onToggle={() => handleToggleGroup(`meta-agent:${item.metaSession.id}`)}
                      onMultiSelect={() => handleGroupMultiSelect(`meta-agent:${item.metaSession.id}`)}
                      activeSessionId={activeSessionId}
                      onSessionSelect={handleSessionClick}
                      onSessionArchive={handleArchiveSession}
                      onSessionUnarchive={handleUnarchiveSession}
                      onSessionDelete={handleDeleteSession}
                      onMetaSessionArchive={handleArchiveMetaAgentSession}
                      onMetaSessionUnarchive={handleUnarchiveMetaAgentSession}
                      onMetaSessionDelete={handleDeleteMetaAgentSession}
                      onSessionPinToggle={handleSessionPinToggle}
                      onSessionBranch={onSessionBranch}
                      onWorktreeArchive={handleArchiveWorktree}
                    />
                  );
                }
                if (item.type === 'superLoop') {
                  const isSuperExpanded = !collapsedGroups.includes(`super-loop:${item.loop.id}`);
                  const superWorktreeSessions = worktreeGroupsData.get(item.loop.worktreeId);
                  const isSuperActive = superWorktreeSessions
                    ? superWorktreeSessions.sessions.some(s => s.id === activeSessionId)
                    : false;

                  return (
                    <SuperLoopGroup
                      loopId={item.loop.id}
                      loop={item.loop}
                      isExpanded={isSuperExpanded}
                      isActive={isSuperActive}
                      isSelected={selectedGroupIds.has(`superloop:${item.loop.id}`)}
                      onToggle={() => handleToggleGroup(`super-loop:${item.loop.id}`)}
                      onMultiSelect={() => handleGroupMultiSelect(`superloop:${item.loop.id}`)}
                      activeSessionId={activeSessionId}
                      onSessionSelect={handleSessionClick}
                      onArchive={() => handleSuperLoopArchive(item.loop)}
                      onRename={(newName) => handleSuperLoopRename(item.loop.id, newName)}
                      onPinToggle={(isPinned) => handleSuperLoopPinToggle(item.loop.id, isPinned)}
                    />
                  );
                }
                // Regular session
                const session = item.session;
                return (
                  <SessionListItem
                    id={session.id}
                    title={session.title || 'Untitled Session'}
                    createdAt={session.createdAt}
                    updatedAt={session.updatedAt}
                    isActive={session.id === activeSessionId}
                    isLoaded={loadedSessionIds.includes(session.id)}
                    isArchived={session.isArchived}
                    isPinned={session.isPinned}
                    isSelected={selectedSessionIds.has(session.id)}
                    selectedCount={selectedSessionIds.has(session.id) ? selectedSessionIds.size : 1}
                    sortBy={sortBy}
                    onClick={(e) => handleSessionClick(session.id, e)}
                    onDelete={() => handleDeleteSession(session.id)}
                    onArchive={selectedSessionIds.size > 1 && selectedSessionIds.has(session.id)
                      ? handleBulkArchive
                      : item.isWorktreeSession && session.worktreeId
                        ? () => handleArchiveWorktree(session.worktreeId!)
                        : () => handleArchiveSession(session.id)}
                    onUnarchive={() => handleUnarchiveSession(session.id)}
                    onRename={(newName: string) => onSessionRename(session.id, newName)}
                    onPinToggle={(isPinned) => handleSessionPinToggle(session.id, isPinned)}
                    onBranch={() => onSessionBranch(session.id)}
                    provider={session.provider}
                    model={session.model}
                    messageCount={session.messageCount}
                    sessionType={session.sessionType}
                    isWorkstream={false}
                    isWorktreeSession={item.isWorktreeSession}
                    parentSessionId={session.parentSessionId}
                    projectPath={session.workspaceId}
                    uncommittedCount={session.uncommittedCount}
                    branchedAt={session.branchedAt}
                    phase={session.phase}
                  />
                );
              }}
            />
          ) : null
        )}
      </div>

      <ArchiveProgress />
      <IndexBuildDialog
        isOpen={showIndexDialog}
        messageCount={indexMessageCount}
        isBuilding={isIndexBuilding}
        onBuild={handleBuildIndex}
        onSkip={handleSkipIndex}
      />

      {/* Archive worktree confirmation dialog (single) */}
      {archiveWorktreeDialogState && (
        <ArchiveWorktreeDialog
          worktreeName={archiveWorktreeDialogState.worktreeName}
          onArchive={handleConfirmArchiveWorktree}
          onKeep={closeArchiveWorktreeDialog}
          hasUncommittedChanges={archiveWorktreeDialogState.hasUncommittedChanges}
          uncommittedFileCount={archiveWorktreeDialogState.uncommittedFileCount}
          hasUnmergedChanges={archiveWorktreeDialogState.hasUnmergedChanges}
          unmergedCommitCount={archiveWorktreeDialogState.unmergedCommitCount}
        />
      )}

      {/* Bulk archive worktree confirmation dialog */}
      {bulkArchiveState && (
        <ArchiveWorktreeDialog
          worktreeCount={bulkArchiveState.totalWorktreeCount}
          worktreeName={bulkArchiveState.totalWorktreeCount === 1 && bulkArchiveState.worktreeIds.length === 1
            ? (worktreeCache.get(bulkArchiveState.worktreeIds[0])?.displayName
              || worktreeCache.get(bulkArchiveState.worktreeIds[0])?.name
              || 'worktree')
            : undefined}
          onArchive={handleConfirmBulkArchive}
          onKeep={handleCancelBulkArchive}
          hasUncommittedChanges={bulkArchiveState.hasUncommittedChanges}
          uncommittedFileCount={bulkArchiveState.uncommittedFileCount}
          uncommittedWorktreeCount={bulkArchiveState.uncommittedWorktreeCount}
          hasUnmergedChanges={bulkArchiveState.hasUnmergedChanges}
          unmergedCommitCount={bulkArchiveState.unmergedCommitCount}
          unmergedWorktreeCount={bulkArchiveState.unmergedWorktreeCount}
        />
      )}

      {/* New Super Loop dialog */}
      <NewSuperLoopDialog workspacePath={workspacePath} />

      {/* New dropdown menu - extracted to `newDropdownPortal` above so the
          empty-state early-return can also mount it. See #306. */}
      {newDropdownPortal}
      {worktreeBaseBranchPickerPortal}
    </div>
  );
};

// SessionHistory has no props — all state comes from atoms — so there's
// nothing for a React.memo equality function to compare. The previous
// hand-rolled memo comparator (workspacePath/activeSessionId/sortOrder/...
// equality checks) was exactly the "if you need React.memo you have the
// wrong architecture" smell from packages/electron/CLAUDE.md.
export const SessionHistory = SessionHistoryComponent;
