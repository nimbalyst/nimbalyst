/**
 * Centralized IPC listeners for session list events
 *
 * Follows the pattern from centralized-ipc-listener-architecture.md:
 * - Components NEVER subscribe to IPC events directly
 * - Central listeners update atoms
 * - Components read from atoms
 */

import { store } from '../index';
import {
  refreshSessionListAtom,
  sessionListWorkspaceAtom,
  sessionRegistryAtom,
  sessionChildrenAtom,
  sessionParentIdAtom,
} from '../atoms/sessions';
import { workstreamStateAtom } from '../atoms/workstreamState';

// Track pending refresh to debounce rapid-fire events
let pendingRefreshTimer: NodeJS.Timeout | null = null;
const DEBOUNCE_MS = 150; // Debounce rapid refreshes within 150ms

/**
 * Initialize session list IPC listeners.
 * Should be called once at app startup.
 */
export function initSessionListListeners(): () => void {
  const cleanups: Array<() => void> = [];

  // Handle session list refresh requests (e.g., from mobile sync, session creation)
  const handleRefreshRequest = (data: { workspacePath: string; sessionId?: string }) => {
    const { workspacePath } = data;

    // Only refresh if the event is for the current workspace
    const currentWorkspace = store.get(sessionListWorkspaceAtom);
    if (currentWorkspace !== workspacePath) {
      return;
    }

    // Clear any pending refresh
    if (pendingRefreshTimer) {
      clearTimeout(pendingRefreshTimer);
    }

    // Debounce: Only refresh after 150ms of no more events
    pendingRefreshTimer = setTimeout(async () => {
      pendingRefreshTimer = null;

      // Trigger atom refresh which queries database
      await store.set(refreshSessionListAtom);
    }, DEBOUNCE_MS);
  };

  cleanups.push(
    window.electronAPI.on('sessions:refresh-list', handleRefreshRequest)
  );

  // Handle targeted session metadata updates (e.g., phase/tags from MCP tools)
  // Updates the registry entry directly without a full refresh
  const handleSessionUpdated = (sessionId: string, updates: Record<string, unknown>) => {
    // console.log('[sessionListListeners] session-updated received:', sessionId, updates);
    const registry = new Map(store.get(sessionRegistryAtom));
    const meta = registry.get(sessionId);
    if (meta) {
      registry.set(sessionId, {
        ...meta,
        ...(updates.phase !== undefined && { phase: updates.phase as string }),
        ...(updates.tags !== undefined && { tags: updates.tags as string[] }),
        ...(updates.title !== undefined && { title: updates.title as string }),
        ...(updates.provider !== undefined && { provider: updates.provider as string }),
        ...(updates.model !== undefined && { model: updates.model as string }),
        ...(updates.sessionType !== undefined && {
          sessionType: updates.sessionType as 'session' | 'workstream' | 'blitz' | 'voice'
        }),
        ...(updates.agentRole !== undefined && { agentRole: updates.agentRole as 'standard' | 'meta-agent' }),
        ...(updates.createdBySessionId !== undefined && { createdBySessionId: updates.createdBySessionId as string | null }),
        ...(updates.parentSessionId !== undefined && { parentSessionId: updates.parentSessionId as string | null }),
        ...(updates.worktreeId !== undefined && { worktreeId: updates.worktreeId as string | null }),
        ...(updates.updatedAt !== undefined && { updatedAt: updates.updatedAt as number }),
        ...(updates.isArchived !== undefined && { isArchived: updates.isArchived as boolean }),
        ...(updates.isPinned !== undefined && { isPinned: updates.isPinned as boolean }),
      });
      store.set(sessionRegistryAtom, registry);
    }
  };

  cleanups.push(
    window.electronAPI.on('sessions:session-updated', handleSessionUpdated)
  );

  // Handle linked tracker item changes (from tracker_link_session, tracker_link_file, auto-linking)
  const handleLinkedTrackerChanged = (data: { sessionId: string; linkedTrackerItemIds: string[] }) => {
    const registry = new Map(store.get(sessionRegistryAtom));
    const meta = registry.get(data.sessionId);
    if (meta) {
      registry.set(data.sessionId, {
        ...meta,
        linkedTrackerItemIds: data.linkedTrackerItemIds,
      });
      store.set(sessionRegistryAtom, registry);
    }
  };

  cleanups.push(
    window.electronAPI.on('session-linked-tracker-changed', handleLinkedTrackerChanged)
  );

  // Handle worktree session creation from mobile - set workstream state so desktop groups it
  const handleWorktreeSessionCreated = (data: { sessionId: string; worktreeId: string }) => {
    store.set(workstreamStateAtom(data.sessionId), {
      type: 'worktree',
      worktreeId: data.worktreeId,
    });
  };

  cleanups.push(
    window.electronAPI.on('worktree:session-created', handleWorktreeSessionCreated)
  );

  // Handle child-session-added events from main-process flows like spawn_session.
  // The general `sessions:refresh-list` only refreshes `sessionRegistryAtom`.
  // Workstream tab strip and per-parent groupings read `sessionChildrenAtom`
  // and `workstreamStateAtom.childSessionIds`, which we have to patch so the
  // new child shows up without remounting the workstream panel.
  // Fire-and-forget: do NOT change activeChildId — the parent user shouldn't
  // have focus stolen by a sibling spawned in the background.
  const handleChildAdded = (data: {
    workspacePath: string;
    parentSessionId: string;
    childSessionId: string;
  }) => {
    const { workspacePath, parentSessionId, childSessionId } = data;

    const currentWorkspace = store.get(sessionListWorkspaceAtom);
    if (currentWorkspace !== workspacePath) {
      return;
    }

    // 1. Patch the parent's children list (deduped).
    const currentChildren = store.get(sessionChildrenAtom(parentSessionId));
    const isNewChild = !currentChildren.includes(childSessionId);
    if (isNewChild) {
      store.set(sessionChildrenAtom(parentSessionId), [...currentChildren, childSessionId]);
    }

    // 2. Tell the child who its parent is so derived atoms resolve correctly.
    store.set(sessionParentIdAtom(childSessionId), parentSessionId);

    // 3. Mirror the change into the unified workstream state so the workstream
    //    tab strip (which reads childSessionIds) sees the new child.
    const workstreamState = store.get(workstreamStateAtom(parentSessionId));
    if (!workstreamState.childSessionIds.includes(childSessionId)) {
      store.set(workstreamStateAtom(parentSessionId), {
        type: 'workstream',
        childSessionIds: [...workstreamState.childSessionIds, childSessionId],
      });
    }

    // 4. Bump the parent's childCount in the session registry. SessionHistory's
    //    left-pane workstream tree decides whether to refetch its child cache by
    //    comparing cachedChildren.length against parent.childCount, so without
    //    this bump the new child stays invisible until something else mutates
    //    the registry (or the user toggles the disclosure). Why: this listener
    //    fires before the debounced sessions:refresh-list re-queries the DB,
    //    and we cannot rely on that race winning.
    const registry = new Map(store.get(sessionRegistryAtom));
    const parentMeta = registry.get(parentSessionId);
    if (parentMeta && isNewChild) {
      registry.set(parentSessionId, {
        ...parentMeta,
        childCount: (parentMeta.childCount ?? 0) + 1,
        sessionType: parentMeta.sessionType === 'session' ? 'workstream' : parentMeta.sessionType,
      });
      store.set(sessionRegistryAtom, registry);
    }
  };

  cleanups.push(
    window.electronAPI.on('sessions:child-added', handleChildAdded)
  );

  // Cleanup function
  return () => {
    // Clear pending timer
    if (pendingRefreshTimer) {
      clearTimeout(pendingRefreshTimer);
      pendingRefreshTimer = null;
    }

    // Remove IPC listeners
    cleanups.forEach(fn => fn?.());
  };
}
