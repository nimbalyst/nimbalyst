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
import { useNavigationDialogs } from '../../dialogs/useNavigationDialogs';
import { TabManager } from '../TabManager/TabManager';
import { TabContent } from '../TabContent/TabContent';
import { setSessionTabCountAtom } from '../../store/atoms/sessionEditors';
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
import {
  FEEDBACK_REQUEST_OPEN_EVENT,
  feedbackRequestResourceForTab,
  feedbackRequestTabUri,
  isFeedbackRequestTab,
} from '../FeedbackRequest/feedbackRequestTab';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { FilePlacementControl, FilePlacementNotice } from './FilePlacementControl';
import { agentFilePlacementAtom } from '../../store/atoms/agentFilePlacement';
import { revealWorkstreamEditorAtom } from '../../store/atoms/agentFileViewer';
import { shouldSkipResourceMirror } from './workstreamTabsMirror';
import {
  revealEditorPosition,
  type EditorRevealPosition,
} from '../TabEditor/editorRevealCommand';

export interface WorkstreamEditorTabsRef {
  /** `location` scrolls the editor to a line once it mounts. */
  openFile: (filePath: string, location?: EditorRevealPosition) => void;
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
  onBeforeMove?: () => void;
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
  onBeforeMove?: () => void;
  onTabDoubleClick?: (tabId: string) => void;
}

const WorkstreamEditorTabsInner = forwardRef<WorkstreamEditorTabsRef, WorkstreamEditorTabsInnerProps>(
  function WorkstreamEditorTabsInner({ workstreamId, workspacePath, basePath, isActive, onSwitchToAgentMode, onOpenSessionInChat, onTabDoubleClick, onBeforeMove }, ref) {
    const { tabs, activeTabId } = useTabs();
    const filePlacement = useAtomValue(agentFilePlacementAtom);
    const revealEditor = useSetAtom(revealWorkstreamEditorAtom);
    const { openQuickOpen } = useNavigationDialogs();
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
      // typed resources into the live TabsContext keyed by resource id: a file
      // path, a `tracker://<id>`, or a feedback request's tab uri. The active
      // resource id maps directly to the restored tab's path (resource id).
      const { openResources, activeResourceId } = workstreamState;
      // console.log('[WorkstreamEditorTabs] Restoring resources:', openResources.length, 'active:', activeResourceId);

      if (openResources.length > 0) {
        pendingSeedCountRef.current = openResources.length;
        for (const tab of openResources) {
          tabsActions.addTab(tab.resource.resourceId);
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
      if (restoreStateRef.current === 'pending') return;
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
      // component projects every kind of tab into TabsContext, so it owns the
      // whole ordered resource set. Map each live tab back to a typed resource,
      // preserving order; the active resource id is the active tab's key (file
      // path, tracker://<id>, or a feedback request's tab uri). Typing the
      // feedback request rather than letting it fall through as a file is what
      // keeps the tab uri out of the workstream's "current file".
      const resources: WorkstreamResource[] = tabs.map((t) =>
        t.kind === 'tracker' && t.trackerItemId
          ? trackerResource(t.trackerItemId)
          : (feedbackRequestResourceForTab(t.filePath) ?? fileResource(t.filePath))
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
        e.preventDefault();
        revealEditor(workstreamId);
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
    }, [workstreamId, tabsActions, revealEditor]);

    // Same imperative open for a feedback request's results, and for the same
    // reason: the author comes back to a request long after the turn that sent
    // it, so it is a tab rather than a message. An open that arrives while this
    // strip is unmounted takes the other path — it seeds the workstream's
    // resources and the restore above projects it.
    useEffect(() => {
      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (!detail || detail.workstreamId !== workstreamId) return;
        if (typeof detail.orgId !== 'string' || typeof detail.requestId !== 'string') return;
        e.preventDefault();
        revealEditor(workstreamId);
        const key = feedbackRequestTabUri({
          orgId: detail.orgId,
          requestId: detail.requestId,
        });
        const existing = tabsActions.findTabByPath(key);
        if (existing) tabsActions.switchTab(existing.id);
        else tabsActions.addTab(key);
      };
      window.addEventListener(FEEDBACK_REQUEST_OPEN_EVENT, handler);
      return () => window.removeEventListener(FEEDBACK_REQUEST_OPEN_EVENT, handler);
    }, [workstreamId, tabsActions, revealEditor]);


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
        // Tracker and feedback-request tabs are not files on disk — no deletion watch.
        if (tab.kind === 'tracker' || isTrackerResourceId(filePath)) continue;
        if (isFeedbackRequestTab(filePath)) continue;
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

    // Expose current document path and workspace path to window for plugins (e.g., EmbedFrame)
    // This mirrors what EditorMode does, but for workstream editor tabs
    // basePath can be either workspacePath (main project) or worktreePath (for worktree sessions)
    useEffect(() => {
      if (!isActive) return;
      const activeTab = activeTabId ? tabs.find(t => t.id === activeTabId) : undefined;
      // Only expose a real file path to plugins; tracker and feedback-request
      // tabs have none.
      const activeFilePath = activeTab
        && activeTab.kind !== 'tracker'
        && !isFeedbackRequestTab(activeTab.filePath)
        ? (activeTab.filePath || null)
        : null;
      (window as any).__currentDocumentPath = activeFilePath;
      (window as any).__workspacePath = basePath;
      // Also set the legacy property for compatibility
      (window as any).workspacePath = basePath;
    }, [activeTabId, tabs, basePath, isActive]);

    // Expose methods via ref
    useImperativeHandle(
      ref,
      () => ({
        openFile: (filePath: string, location?: EditorRevealPosition) => {
          // Check if tab already exists
          const existing = tabsActions.findTabByPath(filePath);
          if (existing) {
            tabsActions.switchTab(existing.id);
          } else {
            // Add new tab
            tabsActions.addTab(filePath);
            // Workstream state will be synced via the tabs useEffect
          }

          // Queued either way: the registry replays it when the editor for this
          // path registers, so an already-open tab and a fresh one behave alike.
          if (location) {
            revealEditorPosition(filePath, location);
          }
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
          // Tracker and feedback-request tabs are not files; file consumers
          // should see null.
          if (!activeTab || activeTab.kind === 'tracker') return null;
          if (isFeedbackRequestTab(activeTab.filePath)) return null;
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

    const handleOpenFile = () => {
      openQuickOpen({
        workspacePath: basePath,
        onFileSelect: (filePath) => {
          tabsActions.addTab(filePath);
          revealEditor(workstreamId);
        },
        onSessionSelect: (sessionId) => onOpenSessionInChat?.(sessionId),
        onPromptSelect: (sessionId) => onOpenSessionInChat?.(sessionId),
      });
    };

    return (
      <div className="workstream-editor-tabs relative flex flex-col h-full overflow-hidden">
        {filePlacement === 'right' && <div className="workstream-file-viewer-heading flex items-center gap-2 px-3 h-8 shrink-0 border-b border-nim text-xs text-nim-muted">
          <MaterialSymbol icon="description" size={16} /> File viewer
          {tabs.length > 0 && <button type="button" className="ml-auto cursor-pointer hover:text-nim" title="Maximize or restore file viewer" onClick={() => onTabDoubleClick?.(activeTabId ?? '')}><MaterialSymbol icon="fullscreen" size={16} /></button>}
        </div>}
        <div className="workstream-editor-header flex items-center shrink-0 border-b border-nim">
          <div className="flex-1 min-w-0">
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
          <FilePlacementControl workstreamId={workstreamId} onBeforeMove={onBeforeMove} />
        </div>
        {tabs.length === 0 && <div className="workstream-file-viewer-empty flex-1 flex flex-col items-center justify-center gap-3 p-4 text-center text-sm text-nim-muted">
          <span>Open a file to view it here</span>
          <button type="button" className="rounded border border-nim px-3 py-1.5 cursor-pointer hover:bg-nim-hover text-nim" onClick={handleOpenFile}>Open file…</button>
        </div>}
        <FilePlacementNotice />
        <div className="workstream-editor-tabs-content flex-1 min-h-0 overflow-hidden" style={{ display: tabs.length ? undefined : 'none' }}>
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
  function WorkstreamEditorTabs({ workstreamId, workspacePath, basePath, isActive = true, onSwitchToAgentMode, onOpenSessionInChat, onTabDoubleClick, onBeforeMove }, ref) {
    const innerRef = useRef<WorkstreamEditorTabsRef>(null);
    // Use basePath if provided, otherwise fall back to workspacePath
    const effectiveBasePath = basePath || workspacePath;

    // Forward ref to inner component
    useImperativeHandle(ref, () => ({
      openFile: (filePath: string, location?: EditorRevealPosition) => innerRef.current?.openFile(filePath, location),
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
          onBeforeMove={onBeforeMove}
        />
      </TabsProvider>
    );
  }
);

WorkstreamEditorTabs.displayName = 'WorkstreamEditorTabs';
