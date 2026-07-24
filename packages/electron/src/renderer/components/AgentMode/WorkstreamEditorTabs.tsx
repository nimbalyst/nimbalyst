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
import { TabsProvider, useTabs, useTabsActions, useTabNavigationShortcuts } from '../../contexts/TabsContext';
import { TabManager } from '../TabManager/TabManager';
import { TabContent } from '../TabContent/TabContent';
import { setSessionTabCountAtom } from '../../store';
import {
  workstreamStateAtom,
  workstreamStatesLoadedAtom,
  setWorkstreamResourcesAtom,
  trackerResourceId,
  isTrackerResourceId,
  fileResource,
  trackerResource,
  type WorkstreamResource,
} from '../../store/atoms/workstreamState';
import { fileDeletedAtomFamily } from '../../store/atoms/fileWatch';
import { shouldSkipResourceMirror } from './workstreamTabsMirror';

export interface WorkstreamEditorTabsRef {
  openFile: (filePath: string) => void;
  /** Open (or focus) a tracker item as a workstream resource tab. */
  openTracker: (trackerItemId: string) => void;
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
  onTabDoubleClick?: (tabId: string) => void; // Double-click a tab (e.g. maximize editor)
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
  onTabDoubleClick?: (tabId: string) => void;
}

const WorkstreamEditorTabsInner = forwardRef<WorkstreamEditorTabsRef, WorkstreamEditorTabsInnerProps>(
  function WorkstreamEditorTabsInner({ workstreamId, workspacePath, basePath, isActive, onSwitchToAgentMode, onOpenSessionInChat, onTabDoubleClick }, ref) {
    const { tabs, activeTabId } = useTabs();
    const tabsActions = useTabsActions();
    useTabNavigationShortcuts(isActive);
    const setTabCount = useSetAtom(setSessionTabCountAtom);
    const workstreamState = useAtomValue(workstreamStateAtom(workstreamId));
    const setWorkstreamResources = useSetAtom(setWorkstreamResourcesAtom);
    const workstreamStatesLoaded = useAtomValue(workstreamStatesLoadedAtom);
    const prevTabCountRef = useRef(tabs.length);
    // Track restore state: 'pending' -> 'restoring' -> 'done'
    const restoreStateRef = useRef<'pending' | 'restoring' | 'done'>('pending');
    // How many restore-seeded tabs have not yet materialized in TabsContext.
    // The persist effect must not mirror an empty tab set while this is > 0
    // (NIM-1680: the transient [] flips hasOpenResources false and the panel's
    // auto-collapse unmounts the strip — the just-opened tab flashes closed).
    const pendingSeedCountRef = useRef(0);

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

      // Restore from workstream state (unified source of truth). Project ALL
      // typed resources into the live TabsContext: files use their path as the
      // tab key, trackers use their `tracker://<id>` resource id. The active
      // resource id maps directly to the restored tab's path (resource id).
      const { openResources, activeResourceId } = workstreamState;
      // console.log('[WorkstreamEditorTabs] Restoring resources:', openResources.length, 'active:', activeResourceId);

      if (openResources.length > 0) {
        pendingSeedCountRef.current = openResources.length;
        for (const tab of openResources) {
          const r = tab.resource;
          const tabKey = r.kind === 'tracker' ? trackerResourceId(r.trackerItemId) : r.filePath;
          tabsActions.addTab(tabKey);
        }

        // Switch to the active resource (resource id == tab filePath key).
        if (activeResourceId) {
          const foundTab = tabsActions.findTabByPath(activeResourceId);
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

      // Seeded tabs have materialized; empty mirrors are legitimate from here.
      if (tabs.length > 0) {
        pendingSeedCountRef.current = 0;
      }
      if (
        shouldSkipResourceMirror({
          pendingSeedCount: pendingSeedCountRef.current,
          tabCount: tabs.length,
        })
      ) {
        return;
      }

      // Always sync to workstream state atom (even during restore). This
      // component projects BOTH file and tracker tabs into TabsContext, so it
      // owns the whole ordered resource set. Map each live tab back to a typed
      // resource, preserving order; the active resource id is the active tab's
      // key (file path or tracker://<id>).
      const resources: WorkstreamResource[] = tabs.map((t) =>
        t.kind === 'tracker' && t.trackerItemId
          ? trackerResource(t.trackerItemId)
          : fileResource(t.filePath)
      );
      const activeResourceId = activeTabId
        ? tabs.find((t) => t.id === activeTabId)?.filePath || null
        : null;
      // Persistence to disk is handled by the workstreamState atom (setWorkstreamResources
      // schedules a debounced workspace-state write). The debounce plus the
      // restore-effect ordering tolerate the transient empty write at mount.
      setWorkstreamResources({ workstreamId, resources, activeResourceId });
      // console.log('[WorkstreamEditorTabs] Synced workstream resources:', resources.length);
    }, [tabs, tabs.length, activeTabId, workstreamId, workspacePath, setTabCount, setWorkstreamResources]);

    // Imperative open for an already-mounted workstream. Navigation from a
    // transcript/TrackerPanel dispatches this event; the mounted workstream
    // that owns the id opens (or focuses) the tracker tab directly. This avoids
    // a reactive openResources->tabs bridge (which fights the persist path and
    // resurrects closed tabs). After mount, TabsContext is the sole authority;
    // openResources is a one-way persisted mirror written by the persist effect.
    useEffect(() => {
      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (!detail || detail.workstreamId !== workstreamId) return;
        const trackerItemId = detail.trackerItemId;
        if (typeof trackerItemId !== 'string') return;
        const key = trackerResourceId(trackerItemId);
        const existing = tabsActions.findTabByPath(key);
        if (existing) {
          tabsActions.switchTab(existing.id);
        } else {
          tabsActions.addTab(key);
        }
      };
      window.addEventListener('nimbalyst:workstream-open-tracker', handler);
      return () => window.removeEventListener('nimbalyst:workstream-open-tracker', handler);
    }, [workstreamId, tabsActions]);


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
        // Tracker tabs are not files on disk — no deletion watch.
        if (tab.kind === 'tracker' || isTrackerResourceId(filePath)) continue;
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
      const activeTab = activeTabId ? tabs.find(t => t.id === activeTabId) : undefined;
      // Only expose a real file path to plugins; tracker tabs have none.
      const activeFilePath = activeTab && activeTab.kind !== 'tracker' ? (activeTab.filePath || null) : null;
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
        openTracker: (trackerItemId: string) => {
          // Tracker tabs use `tracker://<id>` as their tab key so path-based
          // dedup focuses an already-open tracker instead of duplicating it.
          const key = trackerResourceId(trackerItemId);
          const existing = tabsActions.findTabByPath(key);
          if (existing) {
            tabsActions.switchTab(existing.id);
            return;
          }
          tabsActions.addTab(key);
        },
        hasTabs: () => tabs.length > 0,
        getActiveFilePath: () => {
          if (!activeTabId) return null;
          const activeTab = tabs.find((t) => t.id === activeTabId);
          // Tracker tabs are not files; file consumers should see null.
          if (!activeTab || activeTab.kind === 'tracker') return null;
          return activeTab.filePath || null;
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
            onTabDoubleClick={onTabDoubleClick}
          >
            <></>
          </TabManager>
        </div>
        <div className="workstream-editor-tabs-content flex-1 min-h-0 overflow-hidden">
          <TabContent
            workspaceId={basePath}
            workstreamId={workstreamId}
            onSwitchToAgentMode={onSwitchToAgentMode}
            onOpenSessionInChat={onOpenSessionInChat}
            onOpenTracker={(trackerItemId) => tabsActions.addTab(trackerResourceId(trackerItemId))}
          />
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
 * Tab state (typed resources: files + trackers) is persisted per workstream via
 * the workstreamState atom (workstreamStates workspace-state key).
 */
export const WorkstreamEditorTabs = forwardRef<WorkstreamEditorTabsRef, WorkstreamEditorTabsProps>(
  function WorkstreamEditorTabs({ workstreamId, workspacePath, basePath, isActive = true, onSwitchToAgentMode, onOpenSessionInChat, onTabDoubleClick }, ref) {
    const innerRef = useRef<WorkstreamEditorTabsRef>(null);
    // Use basePath if provided, otherwise fall back to workspacePath
    const effectiveBasePath = basePath || workspacePath;

    // Forward ref to inner component
    useImperativeHandle(ref, () => ({
      openFile: (filePath: string) => innerRef.current?.openFile(filePath),
      openTracker: (trackerItemId: string) => innerRef.current?.openTracker(trackerItemId),
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
          onTabDoubleClick={onTabDoubleClick}
        />
      </TabsProvider>
    );
  }
);

WorkstreamEditorTabs.displayName = 'WorkstreamEditorTabs';
