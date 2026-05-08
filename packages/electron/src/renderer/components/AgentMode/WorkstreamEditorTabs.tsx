/**
 * WorkstreamEditorTabs - File editor tabs at the workstream level.
 *
 * This component manages open files for the entire workstream (not per-session).
 * Files edited by any session in the workstream appear here.
 *
 * Uses TabsProvider + TabManager + TabContent pattern like SessionEditorArea,
 * but scoped to the workstream rather than a single session.
 *
 * Tab state is persisted to workspace state using a custom key per workstream.
 */

import React, { useCallback, useRef, forwardRef, useImperativeHandle, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { TabsProvider, useTabs, useTabsActions } from '../../contexts/TabsContext';
import { TabManager } from '../TabManager/TabManager';
import { TabContent } from '../TabContent/TabContent';
import { setSessionTabCountAtom } from '../../store';
import { workstreamStateAtom, workstreamStatesLoadedAtom } from '../../store/atoms/workstreamState';
import { fileDeletedAtomFamily } from '../../store/atoms/fileWatch';

// Current tab state - always kept up to date for sync flush on unmount
const currentTabState = new Map<string, {
  workspacePath: string;
  tabs: Array<{ filePath: string; id: string }>;
  activeTabId: string | null;
}>();

// Debounce timer for persisting tabs
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Actually perform the persist to workspace state.
 */
async function doPersist(workstreamId: string): Promise<void> {
  const data = currentTabState.get(workstreamId);
  if (!data) return;

  persistTimers.delete(workstreamId);

  try {
    const workspaceState = await window.electronAPI.invoke('workspace:get-state', data.workspacePath);
    const existingStates = workspaceState?.workstreamEditorStates ?? {};

    await window.electronAPI.invoke('workspace:update-state', data.workspacePath, {
      workstreamEditorStates: {
        ...existingStates,
        [workstreamId]: {
          openTabs: data.tabs.map(t => ({
            filePath: t.filePath,
            isActive: t.id === data.activeTabId,
          })),
        },
      },
    });
    // console.log('[WorkstreamEditorTabs] Persisted to workspace state:', workstreamId, data.tabs.length, 'tabs');
  } catch (err) {
    console.error('[WorkstreamEditorTabs] Failed to persist tabs:', err);
  }
}

/**
 * Update current tab state and schedule persist to workspace state.
 * Debounced to avoid excessive IPC calls.
 */
function updateTabState(
  workstreamId: string,
  workspacePath: string,
  tabs: Array<{ filePath: string; id: string }>,
  activeTabId: string | null
): void {
  // Always keep current state up to date (for sync flush on unmount)
  currentTabState.set(workstreamId, { workspacePath, tabs, activeTabId });

  // Clear existing timer
  const existingTimer = persistTimers.get(workstreamId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Schedule persistence to workspace state
  const timer = setTimeout(() => doPersist(workstreamId), 500);
  persistTimers.set(workstreamId, timer);
}

/**
 * Flush current tab state to sessionStorage synchronously on unmount.
 * This ensures tabs are available immediately when switching back.
 */
function flushToSessionStorage(workstreamId: string): void {
  // Cancel any pending async persist
  const existingTimer = persistTimers.get(workstreamId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    persistTimers.delete(workstreamId);
  }

  const data = currentTabState.get(workstreamId);
  if (!data || data.tabs.length === 0) {
    // console.log('[WorkstreamEditorTabs] Nothing to flush for:', workstreamId);
    return;
  }

  // Store in sessionStorage synchronously
  const key = `workstream-tabs-${workstreamId}`;
  const value = JSON.stringify({
    openTabs: data.tabs.map(t => ({
      filePath: t.filePath,
      isActive: t.id === data.activeTabId,
    })),
  });
  sessionStorage.setItem(key, value);
  // console.log('[WorkstreamEditorTabs] Flushed to sessionStorage:', workstreamId, data.tabs.length, 'tabs');

  // Fire async persist with the data BEFORE deleting from currentTabState
  // This ensures workspace state also gets updated
  const dataCopy = { ...data };
  currentTabState.delete(workstreamId);

  // Persist to workspace state asynchronously (won't block unmount)
  (async () => {
    try {
      const workspaceState = await window.electronAPI.invoke('workspace:get-state', dataCopy.workspacePath);
      const existingStates = workspaceState?.workstreamEditorStates ?? {};

      await window.electronAPI.invoke('workspace:update-state', dataCopy.workspacePath, {
        workstreamEditorStates: {
          ...existingStates,
          [workstreamId]: {
            openTabs: dataCopy.tabs.map(t => ({
              filePath: t.filePath,
              isActive: t.id === dataCopy.activeTabId,
            })),
          },
        },
      });
      // console.log('[WorkstreamEditorTabs] Async persisted on unmount:', workstreamId);
    } catch (err) {
      console.error('[WorkstreamEditorTabs] Failed to persist on unmount:', err);
    }
  })();
}

/**
 * Load persisted workstream tabs.
 * First checks sessionStorage (sync backup), then workspace state.
 */
async function loadWorkstreamTabs(
  workstreamId: string,
  workspacePath: string
): Promise<{ filePath: string; isActive: boolean }[] | null> {
  // First check sessionStorage (synchronous backup from flush)
  const sessionKey = `workstream-tabs-${workstreamId}`;
  const sessionData = sessionStorage.getItem(sessionKey);
  if (sessionData) {
    try {
      const parsed = JSON.parse(sessionData);
      if (parsed?.openTabs?.length > 0) {
        // console.log('[WorkstreamEditorTabs] Loaded from sessionStorage:', workstreamId);
        // Clear it after loading so workspace state takes over next time
        sessionStorage.removeItem(sessionKey);
        return parsed.openTabs;
      }
    } catch (e) {
      console.error('[WorkstreamEditorTabs] Failed to parse sessionStorage:', e);
    }
  }

  // Fall back to workspace state
  try {
    const workspaceState = await window.electronAPI.invoke('workspace:get-state', workspacePath);
    const saved = workspaceState?.workstreamEditorStates?.[workstreamId];
    if (saved?.openTabs) {
      // console.log('[WorkstreamEditorTabs] Loaded from workspace state:', workstreamId);
      return saved.openTabs;
    }
  } catch (err) {
    console.error('[WorkstreamEditorTabs] Failed to load tabs:', err);
  }
  return null;
}

export interface WorkstreamEditorTabsRef {
  openFile: (filePath: string) => void;
  hasTabs: () => boolean;
  getActiveFilePath: () => string | null;
  closeActiveTab: () => void;
  /** Get the active tab's full data including content */
  getActiveTab: () => { filePath: string; content: string } | null;
}

interface WorkstreamEditorTabsProps {
  workstreamId: string;
  workspacePath: string;
  basePath?: string; // Optional base path for file operations (defaults to workspacePath). Used for worktrees.
  isActive?: boolean;
  onSwitchToAgentMode?: (planDocumentPath?: string, sessionId?: string) => void;
  onOpenSessionInChat?: (sessionId: string) => void;
}

/**
 * Inner component that uses TabsContext.
 * Must be wrapped in TabsProvider.
 */
interface WorkstreamEditorTabsInnerProps {
  workstreamId: string;
  workspacePath: string;
  basePath: string; // Base path for TabContent (workspacePath or worktreePath)
  isActive: boolean;
  onSwitchToAgentMode?: (planDocumentPath?: string, sessionId?: string) => void;
  onOpenSessionInChat?: (sessionId: string) => void;
}

const WorkstreamEditorTabsInner = forwardRef<WorkstreamEditorTabsRef, WorkstreamEditorTabsInnerProps>(
  function WorkstreamEditorTabsInner({ workstreamId, workspacePath, basePath, isActive, onSwitchToAgentMode, onOpenSessionInChat }, ref) {
    const { tabs, activeTabId } = useTabs();
    const tabsActions = useTabsActions();
    const setTabCount = useSetAtom(setSessionTabCountAtom);
    const workstreamState = useAtomValue(workstreamStateAtom(workstreamId));
    const setWorkstreamState = useSetAtom(workstreamStateAtom(workstreamId));
    const workstreamStatesLoaded = useAtomValue(workstreamStatesLoadedAtom);
    const prevTabCountRef = useRef(tabs.length);
    // Track restore state: 'pending' -> 'restoring' -> 'done'
    const restoreStateRef = useRef<'pending' | 'restoring' | 'done'>('pending');
    // Defense-in-depth: only allow `[]` writes to disk after we've observed
    // a non-empty tab state at least once. This prevents data loss on the
    // failure paths the `workstreamStatesLoaded` gate doesn't fully cover:
    //   1) `loadWorkstreamStates` IPC throws and the catch block flips the
    //      loaded flag to true with an empty map - the gate passes, restore
    //      reads empty, transitions to 'done', and persist writes [] over
    //      the saved tabs.
    //   2) The per-workstream `loadWorkstreamState(id)` call (fired async by
    //      `AgentWorkstreamPanel`) loses the race against this component's
    //      mount when the global flag is already true from a prior bulk load.
    // Until we see at least one tab in scope, treat an empty `tabs` array as
    // "load not complete" and skip the IPC write. New workstreams legitimately
    // have nothing to save until the user opens a file, so the deferred write
    // is harmless there.
    const hasEverHadTabsRef = useRef(false);

    // Restore tabs from workstream state on mount.
    // Wait for workstream states to finish loading from IPC before reading
    // openFilePaths. Without this gate the restore effect can read the
    // initial empty default, mark itself done, and let the persist effect
    // overwrite the saved tab list with []. See nimbalyst#169.
    useEffect(() => {
      if (restoreStateRef.current !== 'pending') {
        // console.log('[WorkstreamEditorTabs] Skipping restore, state:', restoreStateRef.current);
        return;
      }
      if (!workstreamStatesLoaded) {
        // Hydration from disk hasn't finished yet. Don't read openFilePaths
        // until it has, otherwise we restore 0 tabs and trigger the persist
        // effect to overwrite the saved list with [].
        return;
      }
      restoreStateRef.current = 'restoring';
      // console.log('[WorkstreamEditorTabs] Starting restore for workstream:', workstreamId);

      // Restore from workstream state (unified source of truth)
      const { openFilePaths, activeFilePath } = workstreamState;
      // console.log('[WorkstreamEditorTabs] Restoring from workstream state:', openFilePaths.length, 'files, active:', activeFilePath);

      if (openFilePaths.length > 0) {
        // Add all tabs
        for (const filePath of openFilePaths) {
          // console.log('[WorkstreamEditorTabs] Adding tab:', filePath);
          tabsActions.addTab(filePath);
        }

        // Switch to the active tab
        if (activeFilePath) {
          const foundTab = tabsActions.findTabByPath(activeFilePath);
          if (foundTab) {
            tabsActions.switchTab(foundTab.id);
          }
        }
      }

      // Mark restore complete - now we can persist changes
      restoreStateRef.current = 'done';
      // console.log('[WorkstreamEditorTabs] Restore complete');
    }, [workstreamId, workstreamState, tabsActions, workstreamStatesLoaded]);

    // Sync tab count to Jotai atom and persist tabs when they change
    useEffect(() => {
      // console.log('[WorkstreamEditorTabs] Persist effect running, tabs:', tabs.length, 'restoreState:', restoreStateRef.current);

      if (tabs.length !== prevTabCountRef.current) {
        prevTabCountRef.current = tabs.length;
        setTabCount({ sessionId: workstreamId, count: tabs.length });
      }

      // Always sync to workstream state atom (even during restore)
      const activeFilePath = activeTabId ? tabs.find(t => t.id === activeTabId)?.filePath || null : null;
      setWorkstreamState({
        openFilePaths: tabs.map(t => t.filePath),
        activeFilePath,
      });
      // console.log('[WorkstreamEditorTabs] Synced workstream state:', tabs.length, 'tabs');

      // Latch: once we observe non-empty tabs, all subsequent writes are
      // legitimate user edits (including closing all tabs). Before that
      // first observation, treat empty as "not yet hydrated" and skip IPC.
      if (tabs.length > 0) {
        hasEverHadTabsRef.current = true;
      }

      // Only persist to IPC after restore is complete to avoid overwriting saved state
      if (restoreStateRef.current === 'done') {
        if (tabs.length === 0 && !hasEverHadTabsRef.current) {
          // Skip the first empty write so a load failure or post-bulk on-demand
          // load race can't clobber the saved tab list. The user opening any
          // tab flips the latch and unblocks future writes.
          return;
        }
        // console.log('[WorkstreamEditorTabs] Persisting tabs to workspace state:', tabs.map(t => t.filePath), 'active:', activeTabId);
        updateTabState(workstreamId, workspacePath, tabs, activeTabId);
      } else {
        // console.log('[WorkstreamEditorTabs] Skipping IPC persist (still restoring), state:', restoreStateRef.current);
      }
    }, [tabs, tabs.length, activeTabId, workstreamId, workspacePath, setTabCount, setWorkstreamState]);

    // Flush pending persist on unmount to ensure tabs are saved before switching workstreams
    useEffect(() => {
      return () => {
        // console.log('[WorkstreamEditorTabs] Unmounting, flushing persist for:', workstreamId);
        flushToSessionStorage(workstreamId);
      };
    }, [workstreamId]);

    // Subscribe to file-deletion atoms for every currently-open tab path so
    // the workstream tab is closed when a file is deleted on disk. Without
    // this, the workstream tab survives, autosave fires from a stale buffer,
    // and the AI-recreated content can be silently overwritten.
    useEffect(() => {
      if (tabs.length === 0) return;
      const cleanups: Array<() => void> = [];
      for (const tab of tabs) {
        const filePath = tab.filePath;
        if (!filePath) continue;
        const deletedAtom = fileDeletedAtomFamily(filePath);
        const initial = store.get(deletedAtom);
        const unsub = store.sub(deletedAtom, () => {
          if (store.get(deletedAtom) === initial) return;
          // Close the tab in this workstream
          const stillOpen = tabsActions.findTabByPath(filePath);
          if (stillOpen) {
            tabsActions.removeTab(stillOpen.id);
          }
        });
        cleanups.push(unsub);
      }
      return () => {
        cleanups.forEach((c) => c());
      };
    }, [tabs, tabsActions]);

    // Expose current document path and workspace path to window for plugins (e.g., MockupPlatformService)
    // This mirrors what EditorMode does, but for workstream editor tabs
    // basePath can be either workspacePath (main project) or worktreePath (for worktree sessions)
    useEffect(() => {
      const activeFilePath = activeTabId ? tabs.find(t => t.id === activeTabId)?.filePath || null : null;
      (window as any).__currentDocumentPath = activeFilePath;
      (window as any).__workspacePath = basePath;
      // Also set the legacy property for compatibility
      (window as any).workspacePath = basePath;
    }, [activeTabId, tabs, basePath]);

    // Expose methods via ref
    useImperativeHandle(
      ref,
      () => ({
        openFile: (filePath: string) => {
          // Check if tab already exists
          const existing = tabsActions.findTabByPath(filePath);
          if (existing) {
            tabsActions.switchTab(existing.id);
            return;
          }

          // Add new tab
          tabsActions.addTab(filePath);
          // Workstream state will be synced via the tabs useEffect
        },
        hasTabs: () => tabs.length > 0,
        getActiveFilePath: () => {
          if (!activeTabId) return null;
          const activeTab = tabs.find((t) => t.id === activeTabId);
          return activeTab?.filePath || null;
        },
        closeActiveTab: () => {
          if (activeTabId) {
            tabsActions.removeTab(activeTabId);
          }
        },
        getActiveTab: () => {
          if (!activeTabId) return null;
          const tabState = tabsActions.getTabState(activeTabId);
          if (!tabState) return null;
          return {
            filePath: tabState.filePath,
            content: tabState.content || '',
          };
        },
      }),
      [tabs, activeTabId, tabsActions]
    );

    const handleTabClose = useCallback((tabId: string) => {
      tabsActions.removeTab(tabId);
    }, [tabsActions]);

    const handleNewTab = useCallback(() => {
      // No-op for now - files are opened via file clicks
    }, []);

    // Don't render anything if no tabs
    if (tabs.length === 0) {
      return null;
    }

    return (
      <div className="workstream-editor-tabs flex flex-col h-full overflow-hidden">
        <div className="workstream-editor-header shrink-0">
          <TabManager
            onTabClose={handleTabClose}
            onNewTab={handleNewTab}
            hideTabBar={false}
            isActive={isActive}
          >
            <></>
          </TabManager>
        </div>
        <div className="workstream-editor-tabs-content flex-1 min-h-0 overflow-hidden">
          <TabContent workspaceId={basePath} onSwitchToAgentMode={onSwitchToAgentMode} onOpenSessionInChat={onOpenSessionInChat} />
        </div>
      </div>
    );
  }
);

/**
 * WorkstreamEditorTabs - wraps inner component with TabsProvider.
 *
 * Each workstream gets its own TabsProvider context, isolating file tabs
 * from the main workspace tabs.
 *
 * Tab state is persisted to workstreamEditorStates in workspace state.
 */
export const WorkstreamEditorTabs = forwardRef<WorkstreamEditorTabsRef, WorkstreamEditorTabsProps>(
  function WorkstreamEditorTabs({ workstreamId, workspacePath, basePath, isActive = true, onSwitchToAgentMode, onOpenSessionInChat }, ref) {
    const innerRef = useRef<WorkstreamEditorTabsRef>(null);
    // Use basePath if provided, otherwise fall back to workspacePath
    const effectiveBasePath = basePath || workspacePath;

    // Forward ref to inner component
    useImperativeHandle(ref, () => ({
      openFile: (filePath: string) => innerRef.current?.openFile(filePath),
      hasTabs: () => innerRef.current?.hasTabs() ?? false,
      getActiveFilePath: () => innerRef.current?.getActiveFilePath() ?? null,
      closeActiveTab: () => innerRef.current?.closeActiveTab(),
      getActiveTab: () => innerRef.current?.getActiveTab() ?? null,
    }), []);

    return (
      <TabsProvider workspacePath={effectiveBasePath} disablePersistence>
        <WorkstreamEditorTabsInner
          ref={innerRef}
          workstreamId={workstreamId}
          workspacePath={workspacePath}
          basePath={effectiveBasePath}
          isActive={isActive}
          onSwitchToAgentMode={onSwitchToAgentMode}
          onOpenSessionInChat={onOpenSessionInChat}
        />
      </TabsProvider>
    );
  }
);

WorkstreamEditorTabs.displayName = 'WorkstreamEditorTabs';
