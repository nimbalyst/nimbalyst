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
  sessionHierarchyParentIdsAtom,
  switchSessionHierarchyWorkspaceAtom,
  sessionParentIdAtom,
  sessionStoreAtom,
  applySessionReparentedAtom,
} from '../atoms/sessions';
import { workstreamStateAtom } from '../atoms/workstreamState';
import { sessionRefMapAtom, type SessionRefMeta } from '@nimbalyst/runtime';

// Track pending refresh to debounce rapid-fire events
let pendingRefreshTimer: NodeJS.Timeout | null = null;
const DEBOUNCE_MS = 150; // Debounce rapid refreshes within 150ms
const MAX_APPLIED_VISIBILITY_AUDITS = 1_000;
const appliedVisibilityAudits = new Map<string, string>();

function rememberAppliedVisibilityAudit(
  workspacePath: string,
  auditId: string,
  targetSessionId: string,
): void {
  const key = `${workspacePath}\u0000${auditId}`;
  appliedVisibilityAudits.delete(key);
  appliedVisibilityAudits.set(key, targetSessionId);
  if (appliedVisibilityAudits.size > MAX_APPLIED_VISIBILITY_AUDITS) {
    const oldest = appliedVisibilityAudits.keys().next().value;
    if (oldest) appliedVisibilityAudits.delete(oldest);
  }
}

function hasExactWorkstreamHierarchy(sessionId: string, expectedParentId: string | null): boolean {
  const registry = store.get(sessionRegistryAtom);
  if (registry.get(sessionId)?.parentSessionId !== expectedParentId) return false;
  if (store.get(sessionParentIdAtom(sessionId)) !== expectedParentId) return false;
  const loaded = store.get(sessionStoreAtom(sessionId));
  if (loaded && loaded.parentSessionId !== expectedParentId) return false;

  const candidateIds = new Set(store.get(sessionHierarchyParentIdsAtom));
  for (const [candidateId, candidate] of registry) {
    if (candidate.sessionType === 'workstream') candidateIds.add(candidateId);
  }
  if (expectedParentId) candidateIds.add(expectedParentId);
  for (const candidateId of candidateIds) {
    const expected = candidateId === expectedParentId;
    const inChildren = store.get(sessionChildrenAtom(candidateId)).includes(sessionId);
    const inWorkstream = store.get(workstreamStateAtom(candidateId)).childSessionIds.includes(sessionId);
    if (inChildren !== expected || inWorkstream !== expected) return false;
  }
  return true;
}

/**
 * Initialize session list IPC listeners.
 * Should be called once at app startup.
 */
export function initSessionListListeners(): () => void {
  const cleanups: Array<() => void> = [];
  appliedVisibilityAudits.clear();
  let hierarchyWorkspacePath = store.get(sessionListWorkspaceAtom);
  store.set(switchSessionHierarchyWorkspaceAtom, {
    previousWorkspacePath: null,
    nextWorkspacePath: hierarchyWorkspacePath,
  });
  cleanups.push(store.sub(sessionListWorkspaceAtom, () => {
    // Applied evidence belongs to one continuously active workspace view.
    // A switch unloads that proof even if the user later returns to the path.
    appliedVisibilityAudits.clear();
    const nextWorkspacePath = store.get(sessionListWorkspaceAtom);
    store.set(switchSessionHierarchyWorkspaceAtom, {
      previousWorkspacePath: hierarchyWorkspacePath,
      nextWorkspacePath,
    });
    hierarchyWorkspacePath = nextWorkspacePath;
  }));

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
    const eventWorkspace = updates.workspacePath;
    if (
      typeof eventWorkspace === 'string' &&
      eventWorkspace !== store.get(sessionListWorkspaceAtom)
    ) {
      return;
    }
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
      if (typeof updates.visibilityAuditId === 'string' && typeof eventWorkspace === 'string') {
        const hierarchyApplied = updates.parentSessionId === undefined || hasExactWorkstreamHierarchy(
          sessionId,
          updates.parentSessionId as string | null,
        );
        if (hierarchyApplied) {
          rememberAppliedVisibilityAudit(eventWorkspace, updates.visibilityAuditId, sessionId);
        }
      }
    }
  };

  cleanups.push(
    window.electronAPI.on('sessions:session-updated', handleSessionUpdated)
  );

  const handleSessionReparented = (data: {
    workspacePath: string;
    sessionId: string;
    oldParentSessionId: string | null;
    newParentSessionId: string | null;
  }) => {
    if (data.workspacePath !== store.get(sessionListWorkspaceAtom)) return;
    store.set(applySessionReparentedAtom, {
      sessionId: data.sessionId,
      oldParentSessionId: data.oldParentSessionId,
      newParentSessionId: data.newParentSessionId,
    });
  };

  cleanups.push(
    window.electronAPI.on('sessions:session-reparented', handleSessionReparented)
  );

  // Main sends this marker after all authoritative events for one committed
  // mutation. Electron preserves send order, and the handlers above apply
  // synchronously, so acknowledging here means the matching workspace store
  // has consumed the state rather than merely having a window available.
  cleanups.push(
    window.electronAPI.on('sessions:visibility-delivery', (data: {
      auditId: string;
      workspaceId: string;
      workspacePath: string;
      targetSessionId: string;
    }) => {
      if (data.workspacePath !== store.get(sessionListWorkspaceAtom)) return;
      const key = `${data.workspacePath}\u0000${data.auditId}`;
      if (appliedVisibilityAudits.get(key) !== data.targetSessionId) return;
      void window.electronAPI.invoke('sessions:visibility-delivery-ack', {
        auditId: data.auditId,
        workspacePath: data.workspacePath,
      }).then((acknowledged) => {
        if (acknowledged === true) appliedVisibilityAudits.delete(key);
      }).catch(() => undefined);
    })
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
    const knownParents = new Set(store.get(sessionHierarchyParentIdsAtom));
    knownParents.add(parentSessionId);
    store.set(sessionHierarchyParentIdsAtom, knownParents);
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

  // Mirror the session registry into the runtime `sessionRefMapAtom` so
  // transcript `SessionReferenceChip`s (used by cross-session tool widgets and
  // bare-UUID autolinks) can resolve a session's live title/phase without
  // reaching into electron store atoms. Runs once now and on every registry
  // change.
  const mirrorSessionRefs = () => {
    const registry = store.get(sessionRegistryAtom);
    const next = new Map<string, SessionRefMeta>();
    for (const meta of registry.values()) {
      next.set(meta.id, {
        id: meta.id,
        title: meta.title,
        phase: meta.phase,
        provider: meta.provider,
        isAwaitingInput: meta.hasPendingInteractivePrompt || undefined,
      });
    }
    store.set(sessionRefMapAtom, next);
  };
  mirrorSessionRefs();
  cleanups.push(store.sub(sessionRegistryAtom, mirrorSessionRefs));

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
