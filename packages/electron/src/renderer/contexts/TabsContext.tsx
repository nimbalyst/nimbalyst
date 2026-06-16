/**
 * TabsContext - Manages tab state outside of component tree
 *
 * This context exists to prevent re-render cascades. When tabs change,
 * only components that explicitly subscribe to tabs will re-render,
 * not the entire EditorMode tree.
 *
 * Multi-project keep-warm: persistent tab state is stored in a module-level
 * registry keyed by workspace path. When a TabsProvider for a given path
 * is mounted, unmounted, and re-mounted (e.g. when the project rail hides
 * and re-shows a project), it picks up the same slot — tabs survive the
 * remount. Providers with `disablePersistence` get a fresh ephemeral slot
 * scoped to that instance.
 */

import React, { createContext, useContext, useRef, useCallback, useSyncExternalStore, useMemo } from 'react';
import { getFileName } from '../utils/pathUtils';
import { isCollabUri } from '../utils/collabUri';
import { store as jotaiStore, editorDirtyAtom, makeEditorKey } from '@nimbalyst/runtime/store';

export interface TabData {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  isDirty: boolean;
  isPinned: boolean;
  editorState?: any;
  scrollPosition?: number;
  cursorPosition?: {
    line: number;
    column: number;
  };
  lastSaved?: Date;
  contentHash?: string;
  contentLoadedAt?: Date;
  isVirtual?: boolean;
}

interface TabsStore {
  tabs: Map<string, TabData>;
  tabOrder: string[];
  activeTabId: string | null;
  closedTabs: TabData[];
}

interface TabsContextValue {
  // Subscribe to store changes (for useSyncExternalStore)
  subscribe: (callback: () => void) => () => void;
  getSnapshot: () => TabsStore;

  // Actions (don't trigger re-renders in caller)
  addTab: (filePath: string, content?: string, switchToTab?: boolean) => string | null;
  removeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<TabData>) => void;
  togglePin: (tabId: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  findTabByPath: (filePath: string) => TabData | undefined;
  saveTabState: (tabId: string, state: Partial<TabData>) => void;
  getTabState: (tabId: string) => TabData | undefined;
  closeAllTabs: () => void;
  closeSavedTabs: () => void;
  reopenLastClosedTab: (fileSelectFn: (filePath: string) => Promise<void>) => Promise<void>;
}

const TabsContext = createContext<TabsContextValue | null>(null);

// Simple hash function for content validation
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

// ---------------------------------------------------------------------------
// Per-key state registry
// ---------------------------------------------------------------------------

/**
 * State held outside the React tree so it survives unmounts and re-mounts.
 * One slot per workspace path (persistent providers) or per ephemeral
 * provider instance (disablePersistence).
 */
interface TabsStateSlot {
  store: TabsStore;
  snapshot: TabsStore;
  listeners: Set<() => void>;
  tabIdCounter: number;
  hasRestored: boolean;
  lastSavedState: string;
  reopening: boolean;
}

function createEmptySlot(): TabsStateSlot {
  const empty: TabsStore = {
    tabs: new Map(),
    tabOrder: [],
    activeTabId: null,
    closedTabs: [],
  };
  return {
    store: empty,
    snapshot: empty,
    listeners: new Set(),
    tabIdCounter: 0,
    hasRestored: false,
    lastSavedState: '',
    reopening: false,
  };
}

const persistentSlots = new Map<string, TabsStateSlot>();

function getPersistentSlot(workspacePath: string): TabsStateSlot {
  let slot = persistentSlots.get(workspacePath);
  if (!slot) {
    slot = createEmptySlot();
    persistentSlots.set(workspacePath, slot);
  }
  return slot;
}

/**
 * Drop the persistent tabs slot for `workspacePath`. Called when the user
 * closes a project from the rail so the slot, listeners, and snapshot
 * memory are released — without this the module-level map grows
 * unbounded across long-running sessions.
 *
 * Re-opening the same workspace later allocates a fresh slot; tabs that
 * were persisted to workspace-settings still rehydrate via the normal
 * restore path.
 */
export function pruneTabsSlot(workspacePath: string): void {
  const slot = persistentSlots.get(workspacePath);
  if (!slot) return;
  slot.listeners.clear();
  persistentSlots.delete(workspacePath);
}

/** Test seam: snapshot the live persistent slot map size. */
export function getPersistentTabsSlotCount(): number {
  return persistentSlots.size;
}

interface TabsProviderProps {
  children: React.ReactNode;
  workspacePath: string | null;
  onTabClose?: (tab: TabData) => void;
  getNavigationState?: () => any;
  /** If true, tabs are not persisted to/restored from workspace state. Useful for session-specific editors. */
  disablePersistence?: boolean;
}

export function TabsProvider({
  children,
  workspacePath,
  onTabClose,
  getNavigationState,
  disablePersistence = false
}: TabsProviderProps) {
  // Resolve the state slot for this provider. Persistent providers share a
  // slot per workspacePath so the rail can hide/reshow a project without
  // losing tabs. Ephemeral providers (disablePersistence) get a fresh slot
  // bound to this React instance via ref.
  const ephemeralSlotRef = useRef<TabsStateSlot | null>(null);
  const slot = useMemo<TabsStateSlot>(() => {
    if (disablePersistence || !workspacePath) {
      if (!ephemeralSlotRef.current) {
        ephemeralSlotRef.current = createEmptySlot();
      }
      return ephemeralSlotRef.current;
    }
    return getPersistentSlot(workspacePath);
  }, [disablePersistence, workspacePath]);

  // Mirror to a ref so callbacks always see the latest slot without needing
  // to be re-created (and without forcing a re-render on every consumer).
  const slotRef = useRef(slot);
  slotRef.current = slot;

  const onTabCloseRef = useRef(onTabClose);
  const getNavigationStateRef = useRef(getNavigationState);
  onTabCloseRef.current = onTabClose;
  getNavigationStateRef.current = getNavigationState;

  const MAX_CLOSED_TAB_HISTORY = 10;

  // Notify all subscribers - creates a new snapshot so useSyncExternalStore detects the change
  const notify = useCallback(() => {
    const s = slotRef.current;
    s.snapshot = {
      tabs: new Map(s.store.tabs),
      tabOrder: [...s.store.tabOrder],
      activeTabId: s.store.activeTabId,
      closedTabs: [...s.store.closedTabs]
    };
    s.listeners.forEach(listener => listener());
  }, []);

  // Subscribe function for useSyncExternalStore.
  // Depends on `slot` so consumers re-subscribe when the workspace switches —
  // otherwise listeners stay attached to the previous workspace's slot and
  // never fire for the new one (TabBar froze on the prior project's
  // activeTabId, breadcrumb/editor showed the real file).
  const subscribe = useCallback((callback: () => void) => {
    slot.listeners.add(callback);
    return () => {
      slot.listeners.delete(callback);
    };
  }, [slot]);

  // Get current snapshot - returns the immutable snapshot.
  // Identity changes with `slot` so useSyncExternalStore detects the
  // workspace switch and re-renders consumers against the new slot.
  const getSnapshot = useCallback(() => slot.snapshot, [slot]);

  // Generate unique tab ID
  const generateTabId = useCallback((): string => {
    const s = slotRef.current;
    s.tabIdCounter += 1;
    return `tab-${Date.now()}-${s.tabIdCounter}`;
  }, []);

  // Remove a tab
  const removeTab = useCallback((tabId: string): void => {
    const store = slotRef.current.store;
    const tab = store.tabs.get(tabId);
    if (!tab) return;

    // Add to closed tabs history
    store.closedTabs = [tab, ...store.closedTabs].slice(0, MAX_CLOSED_TAB_HISTORY);

    // Call onTabClose callback
    onTabCloseRef.current?.(tab);

    // Get the index BEFORE removing from tabOrder
    const currentIndex = store.tabOrder.indexOf(tabId);

    // Remove from tabs
    store.tabs.delete(tabId);
    store.tabOrder = store.tabOrder.filter(id => id !== tabId);

    // Stop watching file (skip virtual and collaborative documents)
    if (window.electronAPI && !tab.filePath.startsWith('virtual://') && !isCollabUri(tab.filePath)) {
      window.electronAPI.invoke('stop-watching-file', tab.filePath).catch(() => {});
      // Closing drops any unsaved buffer, so clear the dirty flag in main; this
      // lets personal docs sync flush a deferred remote write (NIM-853, Layer 4).
      window.electronAPI.send?.('editor:dirty-changed', { filePath: tab.filePath, isDirty: false });
    }

    // Update active tab if needed
    if (store.activeTabId === tabId) {
      if (store.tabOrder.length > 0) {
        // Select the tab at the same index, or the last tab if we were at the end
        const newIndex = Math.min(currentIndex, store.tabOrder.length - 1);
        store.activeTabId = store.tabOrder[newIndex] || null;
      } else {
        store.activeTabId = null;
      }
    }

    notify();
  }, [notify]);

  // Add a tab
  const addTab = useCallback((filePath: string, content: string = '', switchToTab: boolean = true): string | null => {
    const store = slotRef.current.store;

    // Check if tab already exists
    const existingTab = Array.from(store.tabs.values()).find(tab => tab.filePath === filePath);
    if (existingTab) {
      if (switchToTab && store.activeTabId !== existingTab.id) {
        store.activeTabId = existingTab.id;
        notify();
      }
      return existingTab.id;
    }

    const tabId = generateTabId();
    const fileName = getFileName(filePath);

    const newTab: TabData = {
      id: tabId,
      filePath,
      fileName,
      content,
      isDirty: false,
      isPinned: false,
      isVirtual: filePath.startsWith('virtual://'),
      contentHash: simpleHash(content),
      contentLoadedAt: new Date()
    };

    store.tabs.set(tabId, newTab);

    // Add new tabs to the end of the tab order
    store.tabOrder.push(tabId);

    if (switchToTab) {
      store.activeTabId = tabId;
    }

    // Start watching filesystem-backed files only.
    if (window.electronAPI && !filePath.startsWith('virtual://') && !isCollabUri(filePath)) {
      window.electronAPI.invoke('start-watching-file', filePath).catch(() => {});
    }

    notify();

    return tabId;
  }, [generateTabId, notify]);

  // Switch to a tab
  const switchTab = useCallback((tabId: string): void => {
    const store = slotRef.current.store;
    if (!store.tabs.has(tabId) || store.activeTabId === tabId) return;

    store.activeTabId = tabId;
    notify();
  }, [notify]);

  // Update a tab
  // Only notifies subscribers if structural changes occurred (filePath, fileName changed)
  // Metadata changes (isDirty, lastSaved, content) don't trigger re-renders
  const updateTab = useCallback((tabId: string, updates: Partial<TabData>): void => {
    const store = slotRef.current.store;
    const tab = store.tabs.get(tabId);
    if (!tab) return;

    // Check if this is a structural change that affects rendering
    const isStructuralChange =
      updates.filePath !== undefined && updates.filePath !== tab.filePath ||
      updates.fileName !== undefined && updates.fileName !== tab.fileName;

    store.tabs.set(tabId, { ...tab, ...updates });

    // Only notify for structural changes - metadata changes don't need re-renders
    if (isStructuralChange) {
      notify();
    }
  }, [notify]);

  // Toggle pin status
  const togglePin = useCallback((tabId: string): void => {
    const store = slotRef.current.store;
    const tab = store.tabs.get(tabId);
    if (!tab) return;

    const newIsPinned = !tab.isPinned;
    store.tabs.set(tabId, { ...tab, isPinned: newIsPinned });

    // Reorder tabs
    const currentIndex = store.tabOrder.indexOf(tabId);
    if (currentIndex === -1) return;

    const newOrder = [...store.tabOrder];
    newOrder.splice(currentIndex, 1);

    if (newIsPinned) {
      let insertIndex = 0;
      for (let i = 0; i < newOrder.length; i++) {
        const t = store.tabs.get(newOrder[i]);
        if (t?.isPinned) {
          insertIndex = i + 1;
        } else {
          break;
        }
      }
      newOrder.splice(insertIndex, 0, tabId);
    } else {
      let insertIndex = newOrder.length;
      for (let i = 0; i < newOrder.length; i++) {
        const t = store.tabs.get(newOrder[i]);
        if (!t?.isPinned) {
          insertIndex = i;
          break;
        }
      }
      newOrder.splice(insertIndex, 0, tabId);
    }

    store.tabOrder = newOrder;
    notify();
  }, [notify]);

  // Reorder tabs
  const reorderTabs = useCallback((fromIndex: number, toIndex: number): void => {
    const store = slotRef.current.store;
    if (fromIndex === toIndex) return;

    const newOrder = [...store.tabOrder];
    const [movedTab] = newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, movedTab);

    store.tabOrder = newOrder;
    notify();
  }, [notify]);

  // Find tab by path
  const findTabByPath = useCallback((filePath: string): TabData | undefined => {
    return Array.from(slotRef.current.store.tabs.values()).find(tab => tab.filePath === filePath);
  }, []);

  // Save tab state
  const saveTabState = useCallback((tabId: string, state: Partial<TabData>): void => {
    updateTab(tabId, state);
  }, [updateTab]);

  // Get tab state
  const getTabState = useCallback((tabId: string): TabData | undefined => {
    return slotRef.current.store.tabs.get(tabId);
  }, []);

  // Close all tabs
  const closeAllTabs = useCallback((): void => {
    const store = slotRef.current.store;
    Array.from(store.tabs.keys()).forEach(tabId => {
      removeTab(tabId);
    });
  }, [removeTab]);

  // Close saved tabs (checks Jotai atoms for dirty state - source of truth)
  const closeSavedTabs = useCallback((): void => {
    const store = slotRef.current.store;
    Array.from(store.tabs.values())
      .filter(tab => {
        const editorKey = makeEditorKey(tab.filePath);
        const isDirty = jotaiStore.get(editorDirtyAtom(editorKey));
        return !isDirty;
      })
      .forEach(tab => removeTab(tab.id));
  }, [removeTab]);

  // Reopen last closed tab
  const reopenLastClosedTab = useCallback(async (fileSelectFn: (filePath: string) => Promise<void>): Promise<void> => {
    const slotState = slotRef.current;
    if (slotState.reopening) return;

    const store = slotState.store;
    if (store.closedTabs.length === 0) return;

    slotState.reopening = true;

    try {
      let newClosedTabs = [...store.closedTabs];
      let i = 0;

      while (i < newClosedTabs.length) {
        const candidateTab = newClosedTabs[i];
        const existingTab = Array.from(store.tabs.values()).find(tab => tab.filePath === candidateTab.filePath);

        if (!existingTab) {
          try {
            if (isCollabUri(candidateTab.filePath)) {
              const reopenedTabId = addTab(candidateTab.filePath, '', true);
              if (reopenedTabId) {
                updateTab(reopenedTabId, {
                  fileName: candidateTab.fileName,
                  isPinned: candidateTab.isPinned,
                  isVirtual: candidateTab.isVirtual,
                });
              }
            } else {
              await fileSelectFn(candidateTab.filePath);
            }
            newClosedTabs = newClosedTabs.slice(i + 1);
            store.closedTabs = newClosedTabs;
            notify();
            return;
          } catch {
            newClosedTabs.splice(i, 1);
            continue;
          }
        }
        i++;
      }

      if (newClosedTabs.length !== store.closedTabs.length) {
        store.closedTabs = newClosedTabs;
        notify();
      }
    } finally {
      slotState.reopening = false;
    }
  }, [addTab, notify, updateTab]);

  // Restore tabs from storage on mount
  React.useEffect(() => {
    if (disablePersistence || !workspacePath || !window.electronAPI?.invoke) return;

    const slotState = slotRef.current;
    // Only restore once per slot — keeps tabs alive when the rail re-shows
    // a workspace whose TabsProvider was previously unmounted.
    if (slotState.hasRestored) return;

    const timer = setTimeout(async () => {
      try {
        const workspaceState = await window.electronAPI!.invoke('workspace:get-state', workspacePath);
        const savedState = workspaceState?.tabs;

        if (savedState?.tabs?.length > 0) {
          slotState.hasRestored = true;

          const store = slotState.store;
          const restoredTabs = new Map<string, TabData>();
          const restoredOrder: string[] = [];

          for (const tabData of savedState.tabs) {
            restoredTabs.set(tabData.id, {
              ...tabData,
              content: '',
              lastSaved: tabData.lastSaved ? new Date(tabData.lastSaved) : undefined,
              contentHash: undefined,
              contentLoadedAt: undefined
            });
            restoredOrder.push(tabData.id);
          }

          store.tabs = restoredTabs;
          store.tabOrder = restoredOrder;

          if (savedState.closedTabs?.length > 0) {
            store.closedTabs = savedState.closedTabs.map((tabData: any) => ({
              ...tabData,
              content: '',
              lastSaved: tabData.lastSaved ? new Date(tabData.lastSaved) : undefined,
              contentHash: undefined,
              contentLoadedAt: undefined
            }));
          }

          // Start watching restored filesystem-backed tabs only.
          if (window.electronAPI) {
            for (const tab of restoredTabs.values()) {
              if (!tab.filePath.startsWith('virtual://') && !isCollabUri(tab.filePath)) {
                window.electronAPI.invoke('start-watching-file', tab.filePath).catch(() => {});
              }
            }
          }

          if (savedState.activeTabId && restoredTabs.has(savedState.activeTabId)) {
            store.activeTabId = savedState.activeTabId;
          }

          notify();
        }
      } catch (error) {
        console.error('[TABS] Failed to restore tab state:', error);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [disablePersistence, workspacePath, notify]);

  // Save tabs to storage when they change
  React.useEffect(() => {
    if (disablePersistence || !workspacePath || !window.electronAPI?.invoke) return;

    const saveState = async () => {
      const slotState = slotRef.current;
      const store = slotState.store;

      if (!slotState.hasRestored && store.tabs.size === 0) return;

      const tabsArray = store.tabOrder
        .map(id => store.tabs.get(id))
        .filter((tab): tab is TabData => tab !== undefined)
        .map(tab => ({
          id: tab.id,
          filePath: tab.filePath,
          fileName: tab.fileName,
          isDirty: tab.isDirty,
          isPinned: tab.isPinned,
          isVirtual: tab.isVirtual,
          lastSaved: tab.lastSaved?.toISOString()
        }));

      const closedTabsArray = store.closedTabs.map(tab => ({
        id: tab.id,
        filePath: tab.filePath,
        fileName: tab.fileName,
        isDirty: tab.isDirty,
        isPinned: tab.isPinned,
        isVirtual: tab.isVirtual,
        lastSaved: tab.lastSaved?.toISOString()
      }));

      const navigationState = getNavigationStateRef.current?.();

      const stateToSave = {
        tabs: tabsArray,
        activeTabId: store.activeTabId,
        tabOrder: store.tabOrder,
        closedTabs: closedTabsArray,
        navigationState
      };

      const stateString = JSON.stringify(stateToSave);
      if (stateString !== slotState.lastSavedState) {
        try {
          await window.electronAPI!.invoke('workspace:update-state', workspacePath, {
            tabs: stateToSave,
            navigationHistory: stateToSave.navigationState
          });
          slotState.lastSavedState = stateString;
        } catch (error) {
          console.error('[TABS] Failed to save tab state:', error);
        }
      }
    };

    // Subscribe to changes for saving
    const unsubscribe = subscribe(() => {
      if (slotRef.current.store.tabs.size > 0) {
        saveState();
      }
    });

    // Also save periodically
    const interval = setInterval(saveState, 30000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [disablePersistence, workspacePath, subscribe]);

  const contextValue: TabsContextValue = {
    subscribe,
    getSnapshot,
    addTab,
    removeTab,
    switchTab,
    updateTab,
    togglePin,
    reorderTabs,
    findTabByPath,
    saveTabState,
    getTabState,
    closeAllTabs,
    closeSavedTabs,
    reopenLastClosedTab
  };

  return (
    <TabsContext.Provider value={contextValue}>
      {children}
    </TabsContext.Provider>
  );
}

// Hook to get tabs data (subscribes to changes)
export function useTabs() {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error('useTabs must be used within a TabsProvider');
  }

  const store = useSyncExternalStore(
    context.subscribe,
    context.getSnapshot
  );

  // Memoize derived values to prevent unnecessary re-renders
  const tabs = useMemo(
    () => store.tabOrder.map(id => store.tabs.get(id)!).filter(Boolean),
    [store.tabOrder, store.tabs]
  );

  const activeTab = useMemo(
    () => store.activeTabId ? store.tabs.get(store.activeTabId) || null : null,
    [store.activeTabId, store.tabs]
  );

  return {
    tabs,
    activeTab,
    activeTabId: store.activeTabId,
    addTab: context.addTab,
    removeTab: context.removeTab,
    switchTab: context.switchTab,
    updateTab: context.updateTab,
    togglePin: context.togglePin,
    reorderTabs: context.reorderTabs,
    findTabByPath: context.findTabByPath,
    saveTabState: context.saveTabState,
    getTabState: context.getTabState,
    closeAllTabs: context.closeAllTabs,
    closeSavedTabs: context.closeSavedTabs,
    reopenLastClosedTab: context.reopenLastClosedTab
  };
}

// Hook to get ONLY tab actions (doesn't subscribe to changes - no re-renders)
export function useTabsActions() {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error('useTabsActions must be used within a TabsProvider');
  }

  return {
    addTab: context.addTab,
    removeTab: context.removeTab,
    switchTab: context.switchTab,
    updateTab: context.updateTab,
    togglePin: context.togglePin,
    reorderTabs: context.reorderTabs,
    findTabByPath: context.findTabByPath,
    saveTabState: context.saveTabState,
    getTabState: context.getTabState,
    closeAllTabs: context.closeAllTabs,
    closeSavedTabs: context.closeSavedTabs,
    reopenLastClosedTab: context.reopenLastClosedTab,
    // Also expose getSnapshot for components that need to read state imperatively
    getSnapshot: context.getSnapshot,
    // Expose subscribe for components that need custom subscription logic
    subscribe: context.subscribe
  };
}

// Hook to check if there's an active tab (minimal subscription for conditional rendering)
export function useHasActiveTab(): boolean {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error('useHasActiveTab must be used within a TabsProvider');
  }

  const store = useSyncExternalStore(
    context.subscribe,
    context.getSnapshot
  );

  return store.activeTabId !== null;
}

// Dirty state subscription system - allows individual tabs to subscribe to their dirty state
// without causing the entire tab bar to re-render
const dirtyStateListeners = new Map<string, Set<(isDirty: boolean) => void>>();

export function subscribeToDirtyState(tabId: string, callback: (isDirty: boolean) => void): () => void {
  if (!dirtyStateListeners.has(tabId)) {
    dirtyStateListeners.set(tabId, new Set());
  }
  dirtyStateListeners.get(tabId)!.add(callback);

  return () => {
    const listeners = dirtyStateListeners.get(tabId);
    if (listeners) {
      listeners.delete(callback);
      if (listeners.size === 0) {
        dirtyStateListeners.delete(tabId);
      }
    }
  };
}

export function notifyDirtyStateChange(tabId: string, isDirty: boolean): void {
  const listeners = dirtyStateListeners.get(tabId);
  if (listeners) {
    listeners.forEach(callback => callback(isDirty));
  }
}

// Hook to subscribe to a specific tab's dirty state
export function useTabDirtyState(tabId: string, initialDirty: boolean = false): boolean {
  const [isDirty, setIsDirty] = React.useState(initialDirty);

  React.useEffect(() => {
    const unsubscribe = subscribeToDirtyState(tabId, setIsDirty);
    return unsubscribe;
  }, [tabId]);

  return isDirty;
}
