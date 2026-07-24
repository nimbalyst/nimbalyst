import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NavigationHistoryService } from '../NavigationHistoryService';
import { BrowserWindow, ipcMain } from 'electron';

// Mock Electron modules
vi.mock('electron', () => ({
  BrowserWindow: {
    fromId: vi.fn(),
    fromWebContents: vi.fn()
  },
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn()
  }
}));

describe('NavigationHistoryService', () => {
  let service: NavigationHistoryService;
  let mockWindow: any;

  beforeEach(() => {
    service = new NavigationHistoryService();

    // Create mock window
    mockWindow = {
      id: 1,
      webContents: {
        send: vi.fn()
      }
    };

    // Setup mock returns
    (BrowserWindow.fromId as any).mockReturnValue(mockWindow);
  });

  describe('recordNavigation', () => {
    it('should record navigation entries', () => {
      service.recordNavigation(1, 'tab-1');
      service.recordNavigation(1, 'tab-2');
      service.recordNavigation(1, 'tab-3');

      const state = service.getNavigationState(1);
      expect(state).toBeDefined();
      expect(state!.history).toHaveLength(3);
      expect(state!.currentIndex).toBe(2);
      expect(state!.history[0].tabId).toBe('tab-1');
      expect(state!.history[1].tabId).toBe('tab-2');
      expect(state!.history[2].tabId).toBe('tab-3');
    });

    it('should not add duplicate consecutive entries', () => {
      service.recordNavigation(1, 'tab-1');
      service.recordNavigation(1, 'tab-1');
      service.recordNavigation(1, 'tab-1');

      const state = service.getNavigationState(1);
      expect(state!.history).toHaveLength(1);
      expect(state!.history[0].tabId).toBe('tab-1');
    });

    it('should truncate forward history when navigating from middle', () => {
      service.recordNavigation(1, 'tab-1');
      service.recordNavigation(1, 'tab-2');
      service.recordNavigation(1, 'tab-3');

      // Go back twice
      service.goBack(1);
      service.goBack(1);

      // Navigate to new tab from middle of history
      service.recordNavigation(1, 'tab-4');

      const state = service.getNavigationState(1);
      expect(state!.history).toHaveLength(2);
      expect(state!.history[0].tabId).toBe('tab-1');
      expect(state!.history[1].tabId).toBe('tab-4');
      expect(state!.currentIndex).toBe(1);
    });

    it('should enforce maximum history size', () => {
      // Add 55 entries (more than max 50)
      for (let i = 0; i < 55; i++) {
        service.recordNavigation(1, `tab-${i}`);
      }

      const state = service.getNavigationState(1);
      expect(state!.history).toHaveLength(50);
      expect(state!.history[0].tabId).toBe('tab-5'); // First 5 should be dropped
      expect(state!.history[49].tabId).toBe('tab-54'); // Last should be most recent
    });
  });

  describe('navigation controls', () => {
    beforeEach(() => {
      service.recordNavigation(1, 'tab-1');
      service.recordNavigation(1, 'tab-2');
      service.recordNavigation(1, 'tab-3');
    });

    it('should correctly report canGoBack', () => {
      expect(service.canGoBack(1)).toBe(true);

      service.goBack(1);
      expect(service.canGoBack(1)).toBe(true);

      service.goBack(1);
      expect(service.canGoBack(1)).toBe(false); // At beginning
    });

    it('should correctly report canGoForward', () => {
      expect(service.canGoForward(1)).toBe(false); // At end

      service.goBack(1);
      expect(service.canGoForward(1)).toBe(true);

      service.goBack(1);
      expect(service.canGoForward(1)).toBe(true);
    });

    it('should navigate backward correctly', () => {
      const tabId = service.goBack(1);
      expect(tabId).toBe('tab-2');

      const state = service.getNavigationState(1);
      expect(state!.currentIndex).toBe(1);
    });

    it('should navigate forward correctly', () => {
      service.goBack(1);
      service.goBack(1);

      const tabId = service.goForward(1);
      expect(tabId).toBe('tab-2');

      const state = service.getNavigationState(1);
      expect(state!.currentIndex).toBe(1);
    });

    it('should send IPC events when navigating', () => {
      service.goBack(1);

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('navigation:switch-tab', 'tab-2');
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('navigation:state-changed', {
        canGoBack: true,
        canGoForward: true
      });
    });

    it('should not navigate past boundaries', () => {
      // Try to go forward when already at end
      const forward = service.goForward(1);
      expect(forward).toBeNull();

      // Go to beginning
      service.goBack(1);
      service.goBack(1);

      // Try to go back when at beginning
      const back = service.goBack(1);
      expect(back).toBeNull();
    });
  });

  describe('state persistence', () => {
    it('should save navigation state', () => {
      service.recordNavigation(1, 'tab-1');
      service.recordNavigation(1, 'tab-2');
      service.recordNavigation(1, 'tab-3');
      service.goBack(1);

      const saved = service.saveNavigationState(1);
      expect(saved).toBeDefined();
      expect(saved!.history).toHaveLength(3);
      expect(saved!.currentIndex).toBe(1);
    });

    it('should restore navigation state', () => {
      const stateToRestore = {
        history: [
          { tabId: 'restored-1', timestamp: Date.now() },
          { tabId: 'restored-2', timestamp: Date.now() },
          { tabId: 'restored-3', timestamp: Date.now() }
        ],
        currentIndex: 1
      };

      service.restoreNavigationState(2, stateToRestore);

      const state = service.getNavigationState(2);
      expect(state).toBeDefined();
      expect(state!.history).toHaveLength(3);
      expect(state!.currentIndex).toBe(1);
      expect(state!.history[0].tabId).toBe('restored-1');
    });

    it('should clean up window state on removal', () => {
      service.recordNavigation(1, 'tab-1');
      expect(service.getNavigationState(1)).toBeDefined();

      service.removeWindow(1);
      expect(service.getNavigationState(1)).toBeNull();
    });
  });

  describe('multiple windows', () => {
    it('should maintain separate history for each window', () => {
      // Window 1
      service.recordNavigation(1, 'window1-tab1');
      service.recordNavigation(1, 'window1-tab2');

      // Window 2
      service.recordNavigation(2, 'window2-tab1');
      service.recordNavigation(2, 'window2-tab2');
      service.recordNavigation(2, 'window2-tab3');

      const state1 = service.getNavigationState(1);
      const state2 = service.getNavigationState(2);

      expect(state1!.history).toHaveLength(2);
      expect(state2!.history).toHaveLength(3);

      expect(state1!.history[0].tabId).toBe('window1-tab1');
      expect(state2!.history[0].tabId).toBe('window2-tab1');
    });
  });
});