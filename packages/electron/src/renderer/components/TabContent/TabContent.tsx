/**
 * TabContent - Coordinates multiple TabEditor instances
 *
 * This component manages:
 * - Rendering TabEditor for each tab
 * - Coordinating active tab
 * - Aggregating callbacks from TabEditors to parent
 * - Handling special virtual tabs (Plans, Bugs, etc.)
 *
 * CRITICAL: This component renders ONCE and manages TabEditors imperatively.
 * It must NEVER re-render or it will destroy all TabEditor state.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider as JotaiProvider, useAtomValue } from 'jotai';
import { fileSaveRequestAtom } from '../../store/atoms/appCommands';
import type { TextReplacement } from '@nimbalyst/runtime';
import type { Tab } from '../TabManager/TabManager';
import { TabEditor } from '../TabEditor/TabEditor';
import { CollaborativeTabEditor } from '../TabEditor/CollaborativeTabEditor';
import { TabEditorErrorBoundary } from '../TabEditorErrorBoundary';
import { logger } from '../../utils/logger';
import { useTabsActions, type TabData, notifyDirtyStateChange, isTrackerTabPath } from '../../contexts/TabsContext';
import { TrackerResourceEditor } from '../AgentMode/TrackerResourceEditor';
import { isCollabUri, parseCollabUri } from '../../utils/collabUri';
import {
  getCollabConfig,
  removeCollabConfig,
  resolveCollabConfigForUri,
} from '../../utils/collabDocumentOpener';
import { getPersistedCollabDocType } from '../../utils/collabOpenDocsPersistence';
import { store, editorDirtyAtom, editorHasUnacceptedChangesAtom, makeEditorKey } from '@nimbalyst/runtime/store';
import { clearMockupAnnotationsForFile, getMockupFilePath } from '../UnifiedAI/MockupAnnotationIndicator';

interface TabContentProps {
  textReplacements?: TextReplacement[];

  // Callbacks to parent
  onManualSaveReady?: (saveFunction: () => Promise<void>) => void;
  onGetContentReady?: (tabId: string, getContentFunction: () => string) => void;
  onSaveComplete?: (filePath: string) => void;
  onSaveTabByIdReady?: (saveTabById: (tabId: string) => Promise<void>) => void;

  // Document action callbacks
  onRenameDocument?: () => void;
  onSwitchToAgentMode?: (planDocumentPath?: string, sessionId?: string) => void;
  onOpenSessionInChat?: (sessionId: string) => void;

  // Tab management
  onTabClose?: (tabId: string) => void;

  // Tracker resource tabs: open another tracker item (relationship/backlink).
  // Workstream-scoped; passed by the workstream host so TabContent stays
  // workstream-agnostic.
  onOpenTracker?: (trackerItemId: string) => void;
  // Owning workstream id (when this TabContent hosts a workstream strip) — used
  // to persist per-tracker-tab content-focus state.
  workstreamId?: string;

  // Document metadata
  workspaceId?: string;
}

interface TabEditorInstance {
  root: Root;
  element: HTMLDivElement;
  tabData: TabData;
  content: string;
}

const TabContentComponent: React.FC<TabContentProps> = ({
  textReplacements,
  onManualSaveReady,
  onGetContentReady,
  onSaveComplete,
  onSaveTabByIdReady,
  onRenameDocument,
  onSwitchToAgentMode,
  onOpenSessionInChat,
  onTabClose,
  onOpenTracker,
  workstreamId,
  workspaceId,
}) => {
  // Debug: trace re-renders - THIS SHOULD ONLY LOG ONCE ON MOUNT
  // if (import.meta.env.DEV) console.log('[TabContent] render - THIS SHOULD ONLY HAPPEN ONCE');

  // Use actions only - NO subscription that causes re-renders
  const tabsActions = useTabsActions();

  // Container ref for imperative DOM updates
  const containerRef = useRef<HTMLDivElement>(null);

  // All state is in refs - NO useState allowed
  const tabInstancesRef = useRef<Map<string, TabEditorInstance>>(new Map());
  const activeTabIdRef = useRef<string | null>(null);
  const saveFunctionsRef = useRef<Map<string, () => Promise<void>>>(new Map());
  const getContentFunctionsRef = useRef<Map<string, () => string>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());
  // Placeholder elements for unloaded tabs (shown while loading)
  const placeholderElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());

  // Store props in refs so callbacks can access current values
  const propsRef = useRef({
    textReplacements,
    onManualSaveReady,
    onGetContentReady,
    onSaveComplete,
    onRenameDocument,
    onSwitchToAgentMode,
    onOpenSessionInChat,
    onTabClose,
    onOpenTracker,
    workstreamId,
    workspaceId,
  });
  propsRef.current = {
    textReplacements,
    onManualSaveReady,
    onGetContentReady,
    onSaveComplete,
    onRenameDocument,
    onSwitchToAgentMode,
    onOpenSessionInChat,
    onTabClose,
    onOpenTracker,
    workstreamId,
    workspaceId,
  };

  // Load content for a file
  const loadContent = useCallback(async (filePath: string, title?: string): Promise<string> => {
    // Tracker resources don't load from disk -- the tracker body is owned by
    // TrackerItemDetail (PGLite or collaborative Y.Doc).
    if (isTrackerTabPath(filePath)) {
      return '';
    }

    // Collaborative documents don't load from disk -- content comes via Y.Doc
    if (isCollabUri(filePath)) {
      if (!getCollabConfig(filePath)) {
        if (!propsRef.current.workspaceId) {
          logger.ui.warn('[TabContent] Cannot restore collab tab without workspace path:', filePath);
          return '';
        }
        try {
          const { documentId } = parseCollabUri(filePath);
          // Persisted documentType is the only source of truth on a cold
          // restore: the in-memory collabConfigRegistry is empty and
          // sharedDocumentsAtom hasn't synced yet. Without it, the open
          // routes a shared .excalidraw / .mockup.html Y.Doc through the
          // markdown editor and the canvas comes back blank.
          const documentType = await getPersistedCollabDocType(
            propsRef.current.workspaceId,
            documentId,
          );
          await resolveCollabConfigForUri(
            propsRef.current.workspaceId,
            filePath,
            documentId,
            title,
            documentType,
          );
        } catch (error) {
          logger.ui.error('[TabContent] Failed to resolve collab config:', error);
        }
      }
      return '';
    }

    if (filePath.startsWith('virtual://')) {
      if (!window.electronAPI?.documentService) {
        return '';
      }
      try {
        const content = await (window.electronAPI.documentService as any).loadVirtual(filePath);
        return content || '';
      } catch (error) {
        logger.ui.error(`[TabContent] Failed to load virtual document: ${filePath}`, error);
        return '';
      }
    }

    if (!window.electronAPI?.readFileContent) {
      return '';
    }

    try {
      const result = await window.electronAPI.readFileContent(filePath);
      if (result && typeof result === 'object' && 'content' in result) {
        return result.content || '';
      }
      return '';
    } catch (error) {
      logger.ui.error(`[TabContent] Failed to load content for: ${filePath}`, error);
      return '';
    }
  }, []);

  // Inject keyframes for spinner animation (once)
  const spinnerKeyframesInjectedRef = useRef(false);
  useEffect(() => {
    if (spinnerKeyframesInjectedRef.current) return;
    spinnerKeyframesInjectedRef.current = true;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes tab-spinner-spin {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }, []);

  // Create a placeholder element with loading spinner for lazy-loaded tabs
  const createPlaceholder = useCallback((tabId: string) => {
    if (!containerRef.current) return;
    if (placeholderElementsRef.current.has(tabId)) return;

    const placeholder = document.createElement('div');
    placeholder.className = 'tab-editor-placeholder';
    placeholder.dataset.tabId = tabId;
    placeholder.style.cssText = `
      height: 100%;
      display: none;
      align-items: center;
      justify-content: center;
    `;

    // Add loading spinner
    const spinner = document.createElement('div');
    spinner.className = 'tab-loading-spinner';
    spinner.style.cssText = `
      width: 24px;
      height: 24px;
      border: 2px solid var(--text-color-muted, #666);
      border-top-color: transparent;
      border-radius: 50%;
      animation: tab-spinner-spin 0.8s linear infinite;
    `;
    placeholder.appendChild(spinner);

    containerRef.current.appendChild(placeholder);
    placeholderElementsRef.current.set(tabId, placeholder);
  }, []);

  // Create a TabEditor instance imperatively
  const createTabEditor = useCallback((tab: TabData, content: string) => {
    if (!containerRef.current) return;
    if (tabInstancesRef.current.has(tab.id)) return;

    // Remove placeholder if it exists (editor is replacing it)
    const placeholder = placeholderElementsRef.current.get(tab.id);
    if (placeholder) {
      placeholder.remove();
      placeholderElementsRef.current.delete(tab.id);
    }

    const element = document.createElement('div');
    element.className = 'tab-editor-wrapper';
    element.dataset.tabId = tab.id;
    element.style.height = '100%';
    element.style.display = 'none'; // Start hidden, updateVisibility will show active
    containerRef.current.appendChild(element);

    const root = createRoot(element);

    // Tracker resource tabs render the tracker detail host, not a file editor.
    // No save/dirty/getContent wiring — the tracker owns its own persistence
    // (PGLite / collaborative Y.Doc via TrackerItemDetail).
    if (tab.kind === 'tracker' || isTrackerTabPath(tab.filePath)) {
      const trackerItemId = tab.trackerItemId ?? tab.filePath.replace(/^tracker:\/\//, '');
      root.render(
        <JotaiProvider store={store}>
          <TabEditorErrorBoundary
            filePath={tab.filePath}
            fileName={tab.fileName}
            onRetry={() => {
              removeTabEditor(tab.id);
              createTabEditor(tab, content);
            }}
            onClose={() => {
              propsRef.current.onTabClose?.(tab.id);
            }}
          >
            <TrackerResourceEditor
              trackerItemId={trackerItemId}
              workspacePath={propsRef.current.workspaceId}
              workstreamId={propsRef.current.workstreamId}
              onClose={() => propsRef.current.onTabClose?.(tab.id)}
              onOpenTracker={propsRef.current.onOpenTracker}
              onSwitchToAgentMode={
                propsRef.current.onSwitchToAgentMode
                  ? (sessionId: string) => propsRef.current.onSwitchToAgentMode?.(undefined, sessionId)
                  : undefined
              }
            />
          </TabEditorErrorBoundary>
        </JotaiProvider>
      );
      tabInstancesRef.current.set(tab.id, { root, element, tabData: tab, content });
      return;
    }

    const handleManualSaveReady = (saveFn: () => Promise<void>) => {
      saveFunctionsRef.current.set(tab.id, saveFn);
      if (tab.id === activeTabIdRef.current && propsRef.current.onManualSaveReady) {
        propsRef.current.onManualSaveReady(saveFn);
      }
    };

    const handleGetContentReady = (getContentFn: () => string) => {
      getContentFunctionsRef.current.set(tab.id, getContentFn);
      if (propsRef.current.onGetContentReady) {
        propsRef.current.onGetContentReady(tab.id, getContentFn);
      }
    };

    // Handle dirty state changes - write to Jotai atom only
    // NOTE: We do NOT call tabsActions.updateTab() here because that would
    // trigger useTabs() subscribers to re-render (the old architecture).
    // With Jotai, only TabDirtyIndicator subscribes to dirty state.
    const handleDirtyChange = (isDirty: boolean) => {
      const editorKey = makeEditorKey(tab.filePath);
      store.set(editorDirtyAtom(editorKey), isDirty);
      // Also notify the legacy subscription system (for backwards compat with save-on-close)
      notifyDirtyStateChange(tab.id, isDirty);
      // Let the main process know so personal docs sync won't overwrite an
      // editor's unsaved buffer with a remote copy (NIM-853, Layer 4).
      window.electronAPI?.send?.('editor:dirty-changed', { filePath: tab.filePath, isDirty });
    };

    // Always pass isActive={true} since visibility is controlled by the wrapper element's display style
    // The wrapper is set to display:none for inactive tabs, display:block for active
    const isActiveTab = tab.id === activeTabIdRef.current;

    // Wrap in JotaiProvider so TabEditor can subscribe to theme atom
    // (separate React roots need their own provider to access the shared store)
    const isCollab = isCollabUri(tab.filePath);
    const collabConfig = isCollab ? getCollabConfig(tab.filePath) : undefined;

    // Guard: collab tabs without config can't connect (e.g., restored from
    // workspace state after restart/HMR when the in-memory registry is empty).
    // Close the tab instead of rendering a broken TabEditor.
    if (isCollab && !collabConfig) {
      console.warn('[TabContent] Closing collab tab without config:', tab.filePath);
      element.remove();
      queueMicrotask(() => root.unmount());
      // Schedule tab close on next tick to avoid mutating during syncTabs
      setTimeout(() => propsRef.current.onTabClose?.(tab.id), 0);
      return;
    }

    root.render(
      <JotaiProvider store={store}>
        <TabEditorErrorBoundary
          filePath={tab.filePath}
          fileName={tab.fileName}
          onRetry={() => {
            // Remove and recreate on retry
            removeTabEditor(tab.id);
            createTabEditor(tab, content);
          }}
          onClose={() => {
            propsRef.current.onTabClose?.(tab.id);
          }}
        >
          {collabConfig ? (
            <CollaborativeTabEditor
              filePath={tab.filePath}
              fileName={tab.fileName}
              isActive={true}
              collabConfig={collabConfig}
              onDirtyChange={handleDirtyChange}
              onGetContentReady={handleGetContentReady}
              onManualSaveReady={handleManualSaveReady}
            />
          ) : (
            <TabEditor
              filePath={tab.filePath}
              fileName={tab.fileName}
              initialContent={content}
              isActive={true}  // Always true - wrapper controls visibility
              textReplacements={isActiveTab ? propsRef.current.textReplacements : undefined}
              onDirtyChange={handleDirtyChange}
              onSaveComplete={propsRef.current.onSaveComplete}
              onManualSaveReady={handleManualSaveReady}
              onGetContentReady={handleGetContentReady}
              onRenameDocument={propsRef.current.onRenameDocument}
              onSwitchToAgentMode={propsRef.current.onSwitchToAgentMode}
              onOpenSessionInChat={propsRef.current.onOpenSessionInChat}
              workspaceId={propsRef.current.workspaceId}
            />
          )}
        </TabEditorErrorBoundary>
      </JotaiProvider>
    );

    tabInstancesRef.current.set(tab.id, { root, element, tabData: tab, content });
  }, []);

  // Remove a TabEditor instance
  const removeTabEditor = useCallback((tabId: string) => {
    const instance = tabInstancesRef.current.get(tabId);
    if (!instance) return;

    // Save dirty editors before unmounting to prevent data loss on session switch
    const editorKey = makeEditorKey(instance.tabData.filePath);
    const isDirty = store.get(editorDirtyAtom(editorKey));
    if (isDirty) {
      const saveFn = saveFunctionsRef.current.get(tabId);
      if (saveFn) {
        saveFn().catch((err) => {
          console.error('[TabContent] Failed to save before unmount:', instance.tabData.filePath, err);
        });
      }
    }

    // Clean up Jotai atoms for this tab
    editorDirtyAtom.remove(editorKey);
    editorHasUnacceptedChangesAtom.remove(editorKey);

    // Clean up collab config registry for collaborative tabs
    if (isCollabUri(instance.tabData.filePath)) {
      removeCollabConfig(instance.tabData.filePath);
    }

    // Defer root.unmount() to avoid "synchronously unmount a root while React
    // was already rendering" warning. This callback can fire during React's
    // commit phase (via tabsActions.subscribe or useEffect cleanup), so
    // unmounting a child root synchronously races with the current render.
    // Remove the DOM element immediately to avoid visual artifacts.
    instance.element.remove();
    const root = instance.root;
    queueMicrotask(() => root.unmount());
    tabInstancesRef.current.delete(tabId);
    saveFunctionsRef.current.delete(tabId);
    getContentFunctionsRef.current.delete(tabId);
  }, []);

  // Update visibility of all tab editors and placeholders based on active tab
  const updateVisibility = useCallback(() => {
    const activeId = activeTabIdRef.current;

    // Update editor visibility
    tabInstancesRef.current.forEach((instance, tabId) => {
      const isActive = tabId === activeId;
      instance.element.style.display = isActive ? 'block' : 'none';
    });

    // Update placeholder visibility (for tabs being loaded)
    placeholderElementsRef.current.forEach((placeholder, tabId) => {
      const isActive = tabId === activeId;
      // Use flex display when active to center the spinner
      placeholder.style.display = isActive ? 'flex' : 'none';
    });

    // Update parent's save function
    if (activeId) {
      const saveFn = saveFunctionsRef.current.get(activeId);
      if (saveFn && propsRef.current.onManualSaveReady) {
        propsRef.current.onManualSaveReady(saveFn);
      }
    }
  }, []);

  // Main effect: subscribe to tab changes and manage TabEditors imperatively
  // LAZY LOADING: Only create editors for the active tab; others get placeholders
  useEffect(() => {
    const syncTabs = async () => {
      const snapshot = tabsActions.getSnapshot();
      const currentTabs = snapshot.tabOrder.map(id => snapshot.tabs.get(id)!).filter(Boolean);
      const newActiveTabId = snapshot.activeTabId;

      // Track which tabs we've seen
      const currentTabIds = new Set(currentTabs.map(t => t.id));

      // Remove editors for closed tabs
      for (const tabId of tabInstancesRef.current.keys()) {
        if (!currentTabIds.has(tabId)) {
          removeTabEditor(tabId);
        }
      }

      // Remove placeholders for closed tabs
      for (const tabId of placeholderElementsRef.current.keys()) {
        if (!currentTabIds.has(tabId)) {
          const placeholder = placeholderElementsRef.current.get(tabId);
          placeholder?.remove();
          placeholderElementsRef.current.delete(tabId);
        }
      }

      // LAZY LOADING: Only create editor for the ACTIVE tab
      // Other tabs will get editors when they become active
      for (const tab of currentTabs) {
        const isActiveTab = tab.id === newActiveTabId;
        const hasEditor = tabInstancesRef.current.has(tab.id);
        const isLoading = loadingRef.current.has(tab.id);

        // Handle file rename/move: if tab filePath changed, recreate the editor
        if (hasEditor) {
          const instance = tabInstancesRef.current.get(tab.id);
          if (instance && instance.tabData.filePath !== tab.filePath) {
            console.log(`[TabContent] Tab ${tab.id} file path changed: ${instance.tabData.filePath} -> ${tab.filePath}, recreating editor`);
            // Clean up old dirty atom
            const oldEditorKey = makeEditorKey(instance.tabData.filePath);
            store.set(editorDirtyAtom(oldEditorKey), false);
            // Get current content before destroying
            const getContentFn = getContentFunctionsRef.current.get(tab.id);
            const currentContent = getContentFn ? getContentFn() : instance.content;
            removeTabEditor(tab.id);
            createTabEditor(tab, currentContent);
          }
        }

        if (isActiveTab && !hasEditor && !isLoading) {
          // Active tab needs an editor - create placeholder while loading
          createPlaceholder(tab.id);
          loadingRef.current.add(tab.id);

          // Load content then create editor
          const content = tab.content || await loadContent(tab.filePath, tab.fileName);
          loadingRef.current.delete(tab.id);

          // Check tab still exists after async load
          const freshSnapshot = tabsActions.getSnapshot();
          if (freshSnapshot.tabs.has(tab.id)) {
            createTabEditor(tab, content);
          }
        }
        // Non-active tabs without editors: no action needed
        // They'll get an editor when they become active
      }

      // Clear mockup annotations when switching away from a mockup tab
      // This ensures the "+ mockup annotations" indicator hides when switching to another file
      const previousActiveTabId = activeTabIdRef.current;
      if (previousActiveTabId !== newActiveTabId) {
        const currentMockupPath = getMockupFilePath();
        if (currentMockupPath) {
          // Clear annotations for the mockup file we're switching away from
          clearMockupAnnotationsForFile(currentMockupPath);
        }
      }

      // Update active tab and visibility
      activeTabIdRef.current = newActiveTabId;

      // Emit onGetContentReady for the newly active tab (even if already loaded)
      // This ensures EditorMode.getContentRef stays in sync when switching tabs
      if (newActiveTabId && propsRef.current.onGetContentReady) {
        const getContentFn = getContentFunctionsRef.current.get(newActiveTabId);
        if (getContentFn) {
          propsRef.current.onGetContentReady(newActiveTabId, getContentFn);
        }
      }

      // Always update visibility after syncing tabs (editors may have been added)
      updateVisibility();
    };

    // Initial sync
    syncTabs();

    // Subscribe to changes
    const unsubscribe = tabsActions.subscribe(syncTabs);
    return unsubscribe;
  }, [tabsActions, loadContent, createTabEditor, createPlaceholder, removeTabEditor, updateVisibility]);

  // React to file-save command (Cmd+S) from the menu. The IPC subscription
  // lives in store/listeners/appCommandListeners.ts; we watch the counter and
  // dispatch a DOM event on the active tab's container element. TabEditor
  // listens for this event directly, avoiding the stale saveFunctionsRef
  // registration chain.
  const fileSaveVersion = useAtomValue(fileSaveRequestAtom);
  const fileSaveInitialVersionRef = useRef(fileSaveVersion);
  useEffect(() => {
    if (fileSaveVersion === fileSaveInitialVersionRef.current) return;
    const currentActiveTabId = activeTabIdRef.current;
    if (!currentActiveTabId) return;

    const instance = tabInstancesRef.current.get(currentActiveTabId);
    const editorContainer = instance?.element?.querySelector('.multi-editor-instance');
    if (editorContainer) {
      editorContainer.dispatchEvent(new CustomEvent('nimbalyst-save', { bubbles: false }));
      return;
    }

    const saveFn = saveFunctionsRef.current.get(currentActiveTabId);
    if (saveFn) {
      void saveFn();
    }
  }, [fileSaveVersion]);

  // Create saveTabById function and expose to parent
  const saveTabById = useCallback(async (tabId: string): Promise<void> => {
    const saveFn = saveFunctionsRef.current.get(tabId);
    if (saveFn) {
      logger.ui.info(`[TabContent] Saving tab ${tabId} before close`);
      await saveFn();
    }
  }, []);

  useEffect(() => {
    if (onSaveTabByIdReady) {
      onSaveTabByIdReady(saveTabById);
    }
  }, [onSaveTabByIdReady, saveTabById]);

  // Cleanup on unmount -- save dirty editors before destroying them
  useEffect(() => {
    return () => {
      // Save dirty editors before unmounting to prevent data loss on session switch
      tabInstancesRef.current.forEach((instance, tabId) => {
        const editorKey = makeEditorKey(instance.tabData.filePath);
        const isDirty = store.get(editorDirtyAtom(editorKey));
        if (isDirty) {
          const saveFn = saveFunctionsRef.current.get(tabId);
          if (saveFn) {
            saveFn().catch((err) => {
              console.error('[TabContent] Failed to save before unmount:', instance.tabData.filePath, err);
            });
          }
        }
      });

      // Clean up editor instances -- defer unmount to avoid React render collision
      tabInstancesRef.current.forEach((instance) => {
        instance.element.remove();
        const root = instance.root;
        queueMicrotask(() => root.unmount());
      });
      tabInstancesRef.current.clear();

      // Clean up placeholder elements
      placeholderElementsRef.current.forEach((placeholder) => {
        placeholder.remove();
      });
      placeholderElementsRef.current.clear();
    };
  }, []);

  // Render ONLY the container - TabEditors are added imperatively
  return (
    <div
      ref={containerRef}
      className="tab-content-container"
      style={{ height: '100%', overflow: 'hidden' }}
    />
  );
};

/**
 * Memoized TabContent - prevents re-renders when parent re-renders.
 * This component manages TabEditor instances imperatively and should only
 * render once on mount. All state is stored in refs.
 *
 * Custom comparison: always returns true (never re-render) because:
 * 1. All props are stored in propsRef and accessed via current value
 * 2. Tab syncing happens via useTabsActions subscription, not props
 * 3. workspaceId is only needed on mount for initial setup
 */
export const TabContent = React.memo(TabContentComponent, () => true);
