/**
 * Action atoms for SessionHistory.
 *
 * The SessionHistory component used to take ~13 callback props from
 * `AgentMode`. Every render of `AgentMode` produced fresh function
 * identities for those props, which forced `SessionHistory` to re-render
 * even when nothing it actually displays had changed. The component
 * compensated with a hand-rolled `React.memo` equality comparator at the
 * bottom of the file, but that is exactly the "if you need React.memo you
 * have the wrong architecture" smell from packages/electron/CLAUDE.md.
 *
 * This file replaces those callbacks with write-only Jotai action atoms.
 * The setter returned by `useSetAtom(actionAtom)` is identity-stable across
 * renders, so consumers can call them without forcing parent re-renders.
 *
 * Each action atom reads the workspace path, registry, etc. via `get(...)`
 * instead of closing over React state — so the action implementations no
 * longer change identity when component state changes either.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import {
  store,
  addSessionFullAtom,
  updateSessionStoreAtom,
  removeSessionFullAtom,
  refreshSessionListAtom,
  sessionRegistryAtom,
  sessionStoreAtom,
  setSelectedWorkstreamAtom,
  selectedWorkstreamAtom,
  setSessionDraftInputAtom,
  loadSessionChildrenAtom,
  setActiveSessionInWorkstreamAtom,
  markSessionReadAtom,
} from '../index';
import { activeWorkspacePathAtom } from '../atoms/openProjects';
import { defaultAgentModelAtom, worktreesFeatureAvailableAtom, alphaFeatureEnabledAtom } from '../atoms/appSettings';
import {
  workstreamStateAtom,
  setWorkstreamActiveChildAtom,
  setWorktreeActiveSessionAtom,
} from '../atoms/workstreamState';
import type { WorktreeCreateResult, SessionCreateResult } from '../../../shared/ipc/types';

// ============================================================
// Signal / state atoms that replace pass-through props
// ============================================================

/**
 * Tracks the most recently renamed session. SessionHistory uses this to
 * patch its internal `workstreamChildrenCache` (which holds a denormalized
 * SessionItem copy that does NOT auto-update from `sessionRegistryAtom`).
 *
 * `revision` is bumped on each rename so SessionHistory's useEffect re-fires
 * even when the same session is renamed twice with the same `id+title`.
 */
export const recentlyRenamedSessionAtom = atom<{ id: string; title: string; revision: number } | null>(null);

/**
 * Counter-style signal: SessionHistory writes (increments) when the user
 * clicks the quick-search button (Cmd+L). The owner of the actual dialog
 * (App.tsx) subscribes and opens the dialog. Used instead of an
 * `onOpenQuickSearch` callback prop chain (App -> AgentMode -> SessionHistory).
 */
export const sessionQuickOpenRequestedAtom = atom<number>(0);

/**
 * Open state for the New Blitz dialog. The dialog component itself lives in
 * AgentMode (it needs the BlitzDialog mount point); SessionHistory only
 * triggers it via an action atom.
 */
export const blitzDialogOpenAtom = atom<boolean>(false);

/**
 * Per-workspace git-repo flag. Populated by AgentMode from an IPC check on
 * workspace mount; consumed by SessionHistory and the New Worktree / New
 * Blitz action atoms to gate worktree creation.
 */
export const isGitRepoAtom = atomFamily((_workspacePath: string) => atom<boolean>(false));

// ============================================================
// Internal helpers — shared logic between several action atoms
// ============================================================

function getWorkspacePath(get: (a: any) => any): string | null {
  return get(activeWorkspacePathAtom);
}

/**
 * Open a session by id: resolves whether it's a child, root session,
 * worktree, or workstream and updates `selectedWorkstreamAtom` accordingly.
 *
 * Exported as an action atom because branchSessionActionAtom needs to call
 * it after creating a fork, and the imperative AgentMode ref API exposes
 * it to App.tsx.
 */
export const openSessionInTabActionAtom = atom(null, async (get, set, sessionId: string) => {
  const workspacePath = getWorkspacePath(get);
  if (!workspacePath || typeof window === 'undefined' || !window.electronAPI) return;

  try {
    const result = await window.electronAPI.invoke('sessions:list', workspacePath, { includeArchived: false });
    if (!result.success) throw new Error('Failed to load session list');

    const sessionListItem = result.sessions.find((s: any) => s.id === sessionId);

    const registry = get(sessionRegistryAtom);
    if (sessionListItem && !registry.has(sessionId)) {
      set(addSessionFullAtom, {
        id: sessionListItem.id,
        title: sessionListItem.title || 'Untitled Session',
        createdAt: sessionListItem.createdAt,
        updatedAt: sessionListItem.updatedAt,
        provider: sessionListItem.provider || 'claude-code',
        model: sessionListItem.model,
        sessionType: sessionListItem.sessionType || 'session',
        messageCount: sessionListItem.messageCount || 0,
        workspaceId: workspacePath,
        isArchived: sessionListItem.isArchived || false,
        isPinned: sessionListItem.isPinned || false,
        worktreeId: sessionListItem.worktreeId || null,
        parentSessionId: sessionListItem.parentSessionId || null,
        childCount: sessionListItem.childCount || 0,
        uncommittedCount: sessionListItem.uncommittedCount || 0,
      });
      if (sessionListItem.worktreeId) {
        set(workstreamStateAtom(sessionId), {
          type: 'worktree',
          worktreeId: sessionListItem.worktreeId,
        });
      }
    }

    if (sessionListItem?.parentSessionId) {
      await set(loadSessionChildrenAtom, {
        parentSessionId: sessionListItem.parentSessionId,
        workspacePath,
      });
      set(setActiveSessionInWorkstreamAtom, {
        workstreamId: sessionListItem.parentSessionId,
        sessionId,
      });
      const parentState = get(workstreamStateAtom(sessionListItem.parentSessionId));
      const parentType = parentState.type === 'worktree' ? 'worktree'
        : parentState.type === 'workstream' ? 'workstream'
        : 'session';
      set(setSelectedWorkstreamAtom, {
        workspacePath,
        selection: { type: parentType, id: sessionListItem.parentSessionId },
      });
    } else {
      const state = get(workstreamStateAtom(sessionId));
      const type = state.type === 'worktree' ? 'worktree'
        : state.type === 'workstream' ? 'workstream'
        : 'session';
      set(setSelectedWorkstreamAtom, {
        workspacePath,
        selection: { type, id: sessionId },
      });
    }
  } catch (error) {
    console.error('[sessionHistoryActions] Failed to open session:', error);
    set(setSelectedWorkstreamAtom, {
      workspacePath,
      selection: { type: 'session', id: sessionId },
    });
  }
});

// ============================================================
// Action atoms — these replace the callback props
// ============================================================

/**
 * Select a child session within a workstream or worktree.
 */
export const selectChildSessionActionAtom = atom(
  null,
  async (get, set, payload: { childSessionId: string; parentId: string; parentType: 'workstream' | 'worktree' }) => {
    const { childSessionId, parentId, parentType } = payload;
    const workspacePath = getWorkspacePath(get);
    if (!workspacePath) return;

    if (parentType === 'worktree') {
      set(setWorktreeActiveSessionAtom, { worktreeId: parentId, sessionId: childSessionId });
      set(setActiveSessionInWorkstreamAtom, { workstreamId: parentId, sessionId: childSessionId });
      set(setSelectedWorkstreamAtom, {
        workspacePath,
        selection: { type: 'session', id: childSessionId },
      });
    } else {
      await set(loadSessionChildrenAtom, { parentSessionId: parentId, workspacePath });
      set(setWorkstreamActiveChildAtom, { workstreamId: parentId, childId: childSessionId });
      set(markSessionReadAtom, childSessionId);
      set(setSelectedWorkstreamAtom, {
        workspacePath,
        selection: { type: parentType, id: parentId },
      });
    }
  },
);

/**
 * Select a root session (or redirect to its parent workstream for non-worktree children).
 */
export const selectSessionActionAtom = atom(null, async (get, set, sessionId: string) => {
  const workspacePath = getWorkspacePath(get);
  if (!workspacePath) return;

  const registry = get(sessionRegistryAtom);
  const sessionMeta = registry.get(sessionId);

  if (sessionMeta?.parentSessionId) {
    if (sessionMeta.worktreeId) {
      const state = get(workstreamStateAtom(sessionId));
      if (state.type !== 'worktree') {
        set(workstreamStateAtom(sessionId), {
          type: 'worktree',
          worktreeId: sessionMeta.worktreeId,
        });
      }
      set(setWorktreeActiveSessionAtom, {
        worktreeId: sessionMeta.worktreeId,
        sessionId,
      });
      set(setSelectedWorkstreamAtom, {
        workspacePath,
        selection: { type: 'worktree', id: sessionId },
      });
      return;
    }

    await set(selectChildSessionActionAtom, {
      childSessionId: sessionId,
      parentId: sessionMeta.parentSessionId,
      parentType: 'workstream',
    });
    return;
  }

  const state = get(workstreamStateAtom(sessionId));
  const type = state.type === 'worktree' ? 'worktree'
    : state.type === 'workstream' ? 'workstream'
    : 'session';

  const sessionData = get(sessionStoreAtom(sessionId));
  if (sessionData?.worktreeId) {
    set(setWorktreeActiveSessionAtom, {
      worktreeId: sessionData.worktreeId,
      sessionId,
    });
  }

  set(setSelectedWorkstreamAtom, {
    workspacePath,
    selection: { type, id: sessionId },
  });
});

/**
 * Delete a session via IPC and clear selection if it was selected.
 */
export const deleteSessionActionAtom = atom(null, async (get, set, sessionId: string) => {
  const workspacePath = getWorkspacePath(get);
  if (!workspacePath || typeof window === 'undefined' || !window.electronAPI) return;

  try {
    const result = await window.electronAPI.invoke('sessions:delete', sessionId);
    if (result.success) {
      set(removeSessionFullAtom, sessionId);
      const selected = get(selectedWorkstreamAtom(workspacePath));
      if (selected?.id === sessionId) {
        set(setSelectedWorkstreamAtom, { workspacePath, selection: null });
      }
    } else {
      console.error('[sessionHistoryActions] Failed to delete session:', result.error);
      errorNotificationService.showError('Failed to delete session', result.error || 'Unknown error');
    }
  } catch (err) {
    console.error('[sessionHistoryActions] Error deleting session:', err);
    errorNotificationService.showError('Failed to delete session', String(err));
  }
});

/**
 * Archive a session via IPC and clear selection if it was selected.
 */
export const archiveSessionActionAtom = atom(null, async (get, set, sessionId: string) => {
  const workspacePath = getWorkspacePath(get);
  if (!workspacePath || typeof window === 'undefined' || !window.electronAPI) return;

  try {
    const result = await window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived: true });
    if (result.success) {
      set(updateSessionStoreAtom, { sessionId, updates: { isArchived: true } });
      const selected = get(selectedWorkstreamAtom(workspacePath));
      if (selected?.id === sessionId) {
        set(setSelectedWorkstreamAtom, { workspacePath, selection: null });
      }
    } else {
      console.error('[sessionHistoryActions] Failed to archive session:', result.error);
    }
  } catch (err) {
    console.error('[sessionHistoryActions] Error archiving session:', err);
  }
});

/**
 * Rename a session via IPC, update the store, and broadcast a "recently
 * renamed" signal so SessionHistory's `workstreamChildrenCache` can patch
 * the cached SessionItem copy.
 */
export const renameSessionActionAtom = atom(
  null,
  async (get, set, payload: { sessionId: string; newName: string }) => {
    const { sessionId, newName } = payload;
    if (typeof window === 'undefined' || !window.electronAPI) return;

    try {
      const result = await window.electronAPI.invoke('sessions:update-metadata', sessionId, { title: newName });
      if (result.success) {
        set(updateSessionStoreAtom, {
          sessionId,
          updates: { title: newName, updatedAt: Date.now() },
        });
        const prev = get(recentlyRenamedSessionAtom);
        set(recentlyRenamedSessionAtom, {
          id: sessionId,
          title: newName,
          revision: (prev?.revision ?? 0) + 1,
        });
      } else {
        console.error('[sessionHistoryActions] Failed to rename session:', result.error);
      }
    } catch (err) {
      console.error('[sessionHistoryActions] Error renaming session:', err);
    }
  },
);

/**
 * Branch a session: create a fork at the current message and open the new branch.
 */
export const branchSessionActionAtom = atom(null, async (get, set, params: string | { sessionId: string; branchPointMessageId?: number }) => {
  const sessionId = typeof params === 'string' ? params : params.sessionId;
  const branchPointMessageId = typeof params === 'string' ? undefined : params.branchPointMessageId;
  const workspacePath = getWorkspacePath(get);
  if (!workspacePath || typeof window === 'undefined' || !window.electronAPI) return;

  try {
    const result = await window.electronAPI.invoke('sessions:branch', {
      parentSessionId: sessionId,
      branchPointMessageId,
      workspacePath,
    });

    if (result.success && result.session) {
      set(refreshSessionListAtom);
      await set(openSessionInTabActionAtom, result.session.id);
    } else {
      console.error('[sessionHistoryActions] Failed to branch session:', result.error);
      errorNotificationService.showError('Failed to branch conversation', result.error || 'Unknown error');
    }
  } catch (err) {
    console.error('[sessionHistoryActions] Error branching session:', err);
    errorNotificationService.showError('Failed to branch conversation', String(err));
  }
});

/**
 * Create a new (non-worktree) session.
 *
 * Returns the new session id (or undefined). Accepts an optional initial
 * draft string which is persisted via `setSessionDraftInputAtom` before the
 * session is selected, so the AIInput is pre-populated when the session
 * component mounts.
 */
export const createNewSessionActionAtom = atom(
  null,
  async (get, set, initialDraft?: string): Promise<string | undefined> => {
    const workspacePath = getWorkspacePath(get);
    if (!workspacePath || typeof window === 'undefined' || !window.electronAPI) return undefined;

    const defaultModel = get(defaultAgentModelAtom);

    try {
      const sessionId = crypto.randomUUID();
      const parsedModel = defaultModel ? ModelIdentifier.tryParse(defaultModel) : null;
      const provider = parsedModel?.provider || 'claude-code';
      const result = await window.electronAPI.invoke('sessions:create', {
        session: {
          id: sessionId,
          provider,
          model: defaultModel,
          title: 'New Session',
        },
        workspaceId: workspacePath,
      });

      if (result.success && result.id) {
        set(addSessionFullAtom, {
          id: result.id,
          title: 'New Session',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          provider,
          model: defaultModel,
          sessionType: 'session',
          messageCount: 0,
          workspaceId: workspacePath,
          isArchived: false,
          isPinned: false,
          parentSessionId: null,
          worktreeId: null,
          childCount: 0,
          uncommittedCount: 0,
        });

        if (initialDraft) {
          set(setSessionDraftInputAtom, {
            sessionId: result.id,
            draftInput: initialDraft,
            workspacePath,
            persist: true,
          });
        }

        set(setSelectedWorkstreamAtom, {
          workspacePath,
          selection: { type: 'session', id: result.id },
        });

        return result.id;
      }
    } catch (error) {
      console.error('[sessionHistoryActions] Failed to create session:', error);
    }
    return undefined;
  },
);

/**
 * Create a new worktree + session. Gated by `worktreesFeatureAvailableAtom`
 * and the per-workspace `isGitRepoAtom`.
 */
export const createNewWorktreeSessionActionAtom = atom(
  null,
  async (get, set, options?: { baseBranch?: string; name?: string }) => {
    const workspacePath = getWorkspacePath(get);
    if (!workspacePath || typeof window === 'undefined' || !window.electronAPI) return;

    if (!get(worktreesFeatureAvailableAtom)) return;
    if (!get(isGitRepoAtom(workspacePath))) return;

    const defaultModel = get(defaultAgentModelAtom);

    try {
      const ipcOptions = options?.baseBranch || options?.name ? options : undefined;
      const worktreeResult: WorktreeCreateResult = await window.electronAPI.invoke(
        'worktree:create',
        workspacePath,
        ipcOptions,
      );
      if (!worktreeResult.success || !worktreeResult.worktree) {
        throw new Error(worktreeResult.error || 'Failed to create worktree');
      }

      const worktree = worktreeResult.worktree;
      const sessionId = crypto.randomUUID();
      const parsedModel = defaultModel ? ModelIdentifier.tryParse(defaultModel) : null;
      const provider = parsedModel?.provider || 'claude-code';
      const result: SessionCreateResult = await window.electronAPI.invoke('sessions:create', {
        session: {
          id: sessionId,
          provider,
          model: defaultModel,
          title: `Worktree: ${worktree.name}`,
          worktreeId: worktree.id,
        },
        workspaceId: workspacePath,
      });

      if (result.success && result.id) {
        set(addSessionFullAtom, {
          id: result.id,
          title: `Worktree: ${worktree.name}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          provider,
          model: defaultModel,
          sessionType: 'session',
          messageCount: 0,
          workspaceId: workspacePath,
          isArchived: false,
          isPinned: false,
          parentSessionId: null,
          worktreeId: worktree.id,
          childCount: 0,
          uncommittedCount: 0,
        });
        set(workstreamStateAtom(result.id), {
          type: 'worktree',
          worktreeId: worktree.id,
        });
        set(setSelectedWorkstreamAtom, {
          workspacePath,
          selection: { type: 'worktree', id: result.id },
        });
      }
    } catch (error) {
      console.error('[sessionHistoryActions] Failed to create worktree session:', error);
      throw error;
    }
  },
);

/**
 * Internal: create a session inside an existing worktree. Returns the new
 * session id, throws on failure. Used by `addSessionToWorktreeActionAtom`
 * and by AgentMode's plan-mode integration (which still needs a typed
 * return value).
 */
export const createWorktreeSessionCoreActionAtom = atom(
  null,
  async (get, set, worktreeId: string): Promise<string | null> => {
    const workspacePath = getWorkspacePath(get);
    if (!workspacePath || typeof window === 'undefined' || !window.electronAPI) return null;

    const defaultModel = get(defaultAgentModelAtom);
    const worktreeResult = await window.electronAPI.invoke('worktree:get', worktreeId);
    if (!worktreeResult?.worktree) throw new Error('Worktree not found');

    const worktree = worktreeResult.worktree;
    const sessionId = crypto.randomUUID();
    const parsedModel = defaultModel ? ModelIdentifier.tryParse(defaultModel) : null;
    const provider = parsedModel?.provider || 'claude-code';
    const result = await window.electronAPI.invoke('sessions:create', {
      session: {
        id: sessionId,
        provider,
        model: defaultModel,
        title: 'New Session',
        worktreeId: worktree.id,
      },
      workspaceId: workspacePath,
    });

    if (result.success && result.id) {
      set(addSessionFullAtom, {
        id: result.id,
        title: 'New Session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provider,
        model: defaultModel,
        sessionType: 'session',
        messageCount: 0,
        workspaceId: workspacePath,
        isArchived: false,
        isPinned: false,
        parentSessionId: null,
        worktreeId: worktree.id,
        childCount: 0,
        uncommittedCount: 0,
      });
      set(workstreamStateAtom(result.id), {
        type: 'worktree',
        worktreeId: worktree.id,
      });
      set(setSelectedWorkstreamAtom, {
        workspacePath,
        selection: { type: 'worktree', id: result.id },
      });
      return result.id;
    }

    throw new Error(result.error || 'Failed to create session');
  },
);

/**
 * Public: add a session to an existing worktree. Swallows errors into a
 * user-visible notification (the SessionHistory kebab menu can't handle
 * thrown promises).
 */
export const addSessionToWorktreeActionAtom = atom(null, async (_get, set, worktreeId: string) => {
  try {
    await set(createWorktreeSessionCoreActionAtom, worktreeId);
  } catch (error) {
    errorNotificationService.showError(
      'Failed to Create Session',
      error instanceof Error ? error.message : 'An unexpected error occurred while adding a session to the worktree.',
      { duration: 5000 },
    );
  }
});

/**
 * Select an existing worktree's session, or create one when the worktree has
 * none yet, then return the selected session id. Used by the PR review
 * "Open in Worktree" flow: opening a PR worktree must land the user on a live
 * session, not the empty agent state. Idempotent — repeated
 * opens of the same worktree reuse its earliest session instead of piling up.
 */
export const openWorktreeSessionActionAtom = atom(
  null,
  async (get, set, worktreeId: string): Promise<string | null> => {
    const workspacePath = getWorkspacePath(get);
    if (!workspacePath) return null;

    const registry = get(sessionRegistryAtom);
    const existing = Array.from(registry.values())
      .filter((s) => s.worktreeId === worktreeId && !s.isArchived)
      .sort((a, b) => a.createdAt - b.createdAt)[0];

    if (existing) {
      set(setSelectedWorkstreamAtom, {
        workspacePath,
        selection: { type: 'worktree', id: existing.id },
      });
      return existing.id;
    }

    return await set(createWorktreeSessionCoreActionAtom, worktreeId);
  },
);

/**
 * Open the New Blitz dialog. Gated by the blitz alpha feature and the
 * per-workspace git-repo flag.
 */
export const openNewBlitzDialogActionAtom = atom(null, (get, set) => {
  const workspacePath = getWorkspacePath(get);
  if (!workspacePath) return;
  if (!get(alphaFeatureEnabledAtom('blitz'))) return;
  if (!get(isGitRepoAtom(workspacePath))) return;
  set(blitzDialogOpenAtom, true);
});

/**
 * Request that the session quick-open dialog be opened. Owner: App.tsx,
 * which subscribes to `sessionQuickOpenRequestedAtom` and opens the
 * underlying dialog via its dialog ref. Used in place of an
 * `onOpenQuickSearch` callback chain.
 */
export const requestSessionQuickOpenActionAtom = atom(null, (get, set) => {
  set(sessionQuickOpenRequestedAtom, get(sessionQuickOpenRequestedAtom) + 1);
});

// ============================================================
// Direct store helpers
//
// A few callers (the imperative AgentMode ref API, listener effects in
// AgentMode for tray/tip/deep-link triggers) want to invoke these actions
// outside of a component render. The helpers below let them dispatch via
// the module-level `store` without grabbing a setter inside a hook.
// ============================================================

export function dispatchCreateNewSession(initialDraft?: string): Promise<string | undefined> {
  return store.set(createNewSessionActionAtom, initialDraft) as Promise<string | undefined>;
}

export function dispatchCreateNewWorktreeSession(
  options?: { baseBranch?: string; name?: string },
): Promise<void> {
  return store.set(createNewWorktreeSessionActionAtom, options) as Promise<void>;
}

export function dispatchOpenSessionInTab(sessionId: string): Promise<void> {
  return store.set(openSessionInTabActionAtom, sessionId) as Promise<void>;
}

export function dispatchCreateWorktreeSessionCore(worktreeId: string): Promise<string | null> {
  return store.set(createWorktreeSessionCoreActionAtom, worktreeId) as Promise<string | null>;
}

export function dispatchOpenWorktreeSession(worktreeId: string): Promise<string | null> {
  return store.set(openWorktreeSessionActionAtom, worktreeId) as Promise<string | null>;
}
