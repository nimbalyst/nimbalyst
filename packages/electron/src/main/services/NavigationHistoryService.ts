import { BrowserWindow } from 'electron';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { windowStates } from '../window/WindowManager';

export interface NavigationEntry {
  tabId: string;
  timestamp: number;
}

export interface NavigationState {
  history: NavigationEntry[];
  currentIndex: number;
}

export class NavigationHistoryService {
  private static readonly MAX_HISTORY_SIZE = 50;
  private navigationStates = new Map<number, NavigationState>();

  constructor() {
    this.setupIpcHandlers();
  }

  private setupIpcHandlers() {
    safeOn('navigation:tab-changed', (event, tabId: string) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return;

      this.recordNavigation(window.id, tabId);
    });

    safeHandle('navigation:can-go-back', (event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return false;

      return this.canGoBack(window.id);
    });

    safeHandle('navigation:can-go-forward', (event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return false;

      return this.canGoForward(window.id);
    });

    safeHandle('navigation:go-back', (event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return null;

      return this.goBack(window.id);
    });

    safeHandle('navigation:go-forward', (event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return null;

      return this.goForward(window.id);
    });

    safeHandle('navigation:get-history', (event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return null;

      return this.getNavigationState(window.id);
    });
  }

  private getOrCreateState(windowId: number): NavigationState {
    if (!this.navigationStates.has(windowId)) {
      this.navigationStates.set(windowId, {
        history: [],
        currentIndex: -1
      });
    }
    return this.navigationStates.get(windowId)!;
  }

  recordNavigation(windowId: number, tabId: string) {
    const state = this.getOrCreateState(windowId);

    // If we're navigating from the middle of history, truncate forward history
    if (state.currentIndex < state.history.length - 1) {
      state.history = state.history.slice(0, state.currentIndex + 1);
    }

    // Don't add duplicate consecutive entries
    if (state.history.length > 0 &&
        state.history[state.history.length - 1].tabId === tabId) {
      return;
    }

    // Add new entry
    const entry: NavigationEntry = {
      tabId,
      timestamp: Date.now()
    };

    state.history.push(entry);

    // Enforce max history size
    if (state.history.length > NavigationHistoryService.MAX_HISTORY_SIZE) {
      state.history = state.history.slice(-NavigationHistoryService.MAX_HISTORY_SIZE);
    }

    state.currentIndex = state.history.length - 1;

    // Notify renderer about navigation state change
    const window = BrowserWindow.fromId(windowId);
    if (window) {
      window.webContents.send('navigation:state-changed', {
        canGoBack: this.canGoBack(windowId),
        canGoForward: this.canGoForward(windowId)
      });
    }
  }

  canGoBack(windowId: number): boolean {
    const state = this.navigationStates.get(windowId);
    if (!state) return false;
    return state.currentIndex > 0;
  }

  canGoForward(windowId: number): boolean {
    const state = this.navigationStates.get(windowId);
    if (!state) return false;
    return state.currentIndex < state.history.length - 1;
  }

  goBack(windowId: number): string | null {
    const state = this.navigationStates.get(windowId);
    if (!state || !this.canGoBack(windowId)) return null;

    state.currentIndex--;
    const entry = state.history[state.currentIndex];

    // Notify renderer to switch to the tab
    const window = BrowserWindow.fromId(windowId);
    if (window) {
      window.webContents.send('navigation:switch-tab', entry.tabId);
      window.webContents.send('navigation:state-changed', {
        canGoBack: this.canGoBack(windowId),
        canGoForward: this.canGoForward(windowId)
      });
    }

    return entry.tabId;
  }

  goForward(windowId: number): string | null {
    const state = this.navigationStates.get(windowId);
    if (!state || !this.canGoForward(windowId)) return null;

    state.currentIndex++;
    const entry = state.history[state.currentIndex];

    // Notify renderer to switch to the tab
    const window = BrowserWindow.fromId(windowId);
    if (window) {
      window.webContents.send('navigation:switch-tab', entry.tabId);
      window.webContents.send('navigation:state-changed', {
        canGoBack: this.canGoBack(windowId),
        canGoForward: this.canGoForward(windowId)
      });
    }

    return entry.tabId;
  }

  getNavigationState(windowId: number): NavigationState | null {
    return this.navigationStates.get(windowId) || null;
  }

  // Save navigation state for persistence
  saveNavigationState(windowId: number): NavigationState | null {
    const state = this.navigationStates.get(windowId);
    if (!state) return null;

    // Return a copy to avoid mutations
    return {
      history: [...state.history],
      currentIndex: state.currentIndex
    };
  }

  // Restore navigation state from persistence
  restoreNavigationState(windowId: number, state: NavigationState) {
    // Defensive: handle malformed/old persisted state that may be missing history array
    if (!state || !Array.isArray(state.history)) {
      this.navigationStates.set(windowId, {
        history: [],
        currentIndex: -1
      });
      return;
    }
    this.navigationStates.set(windowId, {
      history: [...state.history],
      currentIndex: state.currentIndex ?? -1
    });
  }

  // Clean up when window is closed
  removeWindow(windowId: number) {
    this.navigationStates.delete(windowId);
  }
}

// Export singleton instance
export const navigationHistoryService = new NavigationHistoryService();