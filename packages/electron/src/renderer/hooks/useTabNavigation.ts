import { useEffect, useCallback, useRef } from 'react';

interface NavigationEntry {
  tabId: string;
  timestamp: number;
}

interface UseTabNavigationOptions {
  enabled?: boolean;
  tabs: any[];
  activeTabId: string | null;
  switchTab: (tabId: string, fromNavigation?: boolean) => void;
}

const MAX_HISTORY_SIZE = 50;

export function useTabNavigation(options: UseTabNavigationOptions) {
  const { enabled = true, tabs, activeTabId, switchTab } = options;

  // Navigation history stored in the renderer
  const historyRef = useRef<NavigationEntry[]>([]);
  const currentIndexRef = useRef<number>(-1);
  const isNavigatingRef = useRef<boolean>(false);
  const hasRestoredRef = useRef<boolean>(false);

  // Record navigation when active tab changes
  useEffect(() => {
    if (!enabled || !activeTabId || isNavigatingRef.current) return;

    const history = historyRef.current;
    const currentIndex = currentIndexRef.current;

    // If we're navigating from the middle of history, truncate forward history
    if (currentIndex < history.length - 1) {
      historyRef.current = history.slice(0, currentIndex + 1);
    }

    // Don't add duplicate consecutive entries
    if (history.length > 0 && history[history.length - 1].tabId === activeTabId) {
      return;
    }

    // Add new entry
    const entry: NavigationEntry = {
      tabId: activeTabId,
      timestamp: Date.now()
    };

    historyRef.current.push(entry);

    // Enforce max history size
    if (historyRef.current.length > MAX_HISTORY_SIZE) {
      historyRef.current = historyRef.current.slice(-MAX_HISTORY_SIZE);
    }

    currentIndexRef.current = historyRef.current.length - 1;
  }, [enabled, activeTabId]);

  const goBack = useCallback(() => {
    const history = historyRef.current;
    const currentIndex = currentIndexRef.current;

    if (currentIndex <= 0) {
      return;
    }

    isNavigatingRef.current = true;
    currentIndexRef.current = currentIndex - 1;
    const entry = history[currentIndexRef.current];
    switchTab(entry.tabId, true);

    // Reset navigation flag after a brief delay
    setTimeout(() => {
      isNavigatingRef.current = false;
    }, 100);
  }, [switchTab]);

  const goForward = useCallback(() => {
    const history = historyRef.current;
    const currentIndex = currentIndexRef.current;

    if (currentIndex >= history.length - 1) {
      return;
    }

    isNavigatingRef.current = true;
    currentIndexRef.current = currentIndex + 1;
    const entry = history[currentIndexRef.current];
    switchTab(entry.tabId, true);

    // Reset navigation flag after a brief delay
    setTimeout(() => {
      isNavigatingRef.current = false;
    }, 100);
  }, [switchTab]);

  // NOTE: IPC navigation commands (Cmd+[, Cmd+]) are now handled by App.tsx
  // using unified cross-mode navigation history. This hook no longer listens
  // for 'navigation:go-back' and 'navigation:go-forward' IPC events.

  // NOTE: Mouse back/forward buttons are also handled by App.tsx unified navigation.
  // See App.tsx for the centralized navigation handlers.

  // NOTE: Keyboard shortcuts are NOT handled here anymore. They're handled via:
  // 1. Electron menu accelerators (Meta+Alt+Left/Right) -> sends 'next-tab'/'previous-tab' IPC events
  // 2. App.tsx receives these IPC events and routes them with mode awareness
  // This hook is only used for browser-based navigation history (back/forward menu items)

  // Export current navigation state for external saving
  const getNavigationState = useCallback(() => {
    return {
      history: historyRef.current,
      currentIndex: currentIndexRef.current
    };
  }, []);

  // Import navigation state from external source
  const setNavigationState = useCallback((state: { history: NavigationEntry[], currentIndex: number } | undefined) => {
    if (state && state.history && state.history.length > 0) {
      historyRef.current = state.history;
      currentIndexRef.current = state.currentIndex ?? state.history.length - 1;

      // Validate that current index is within bounds
      if (currentIndexRef.current >= historyRef.current.length) {
        currentIndexRef.current = historyRef.current.length - 1;
      }
      if (currentIndexRef.current < 0) {
        currentIndexRef.current = 0;
      }
    }
    hasRestoredRef.current = true;
  }, []);

  return {
    goBack,
    goForward,
    canGoBack: () => currentIndexRef.current > 0,
    canGoForward: () => currentIndexRef.current < historyRef.current.length - 1,
    getNavigationState,
    setNavigationState
  };
}