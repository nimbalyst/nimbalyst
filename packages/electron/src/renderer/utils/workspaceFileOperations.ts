/**
 * Workspace file operations
 *
 * Extracts handleWorkspaceFileSelect logic from App.tsx
 */

import { errorNotificationService } from '../services/ErrorNotificationService';

const LOG_CONFIG = {
  WORKSPACE_FILE_SELECT: false,
};

interface FileSelectOptions {
  filePath: string;
  currentFilePath: string | null;
  tabs: any;
  isInitializedRef: React.MutableRefObject<boolean>;
  isCurrent?: () => boolean;
}

export async function handleWorkspaceFileSelect(options: FileSelectOptions): Promise<boolean> {
  const {
    filePath,
    currentFilePath,
    tabs,
    isInitializedRef,
    isCurrent = () => true,
  } = options;

  // NOTE: autoSaveCancellationRef removed - EditorContainer handles all autosave now

  if (!window.electronAPI || !isCurrent()) return false;

  if (LOG_CONFIG.WORKSPACE_FILE_SELECT) console.log('[WORKSPACE_FILE_SELECT] Selecting file:', filePath);

  const activeTabId = tabs.activeTabId;
  const activeFilePath = tabs.activeTab
    ? tabs.activeTab.filePath
    : currentFilePath;

  if (activeFilePath === filePath) {
    const existingTab = tabs.findTabByPath(filePath);
    if (existingTab) {
      // BUGFIX: Check if the tab is actually in the visible tabs array (tabs.tabs)
      // There can be a state corruption where a tab exists in the Map but not in tabOrder
      const isInVisibleTabs = tabs.tabs?.some((t: any) => t.id === existingTab.id);
      if (!isInVisibleTabs) {
        // State corruption detected - fall through to re-open the file
        // This will trigger addTab which will repair the tabOrder
      } else {
        if (LOG_CONFIG.WORKSPACE_FILE_SELECT) console.log('[WORKSPACE_FILE_SELECT] File already active, ensuring tab focus');
        tabs.switchTab(existingTab.id);
        return true;
      }
    }
    // activeFilePath matches but tab not visible - fall through to open normally
  }

  // NOTE: No need to manually save here - EditorContainer handles save-on-tab-switch
  // When we call tabs.switchTab() or tabs.addTab() below, it triggers onTabChange,
  // which triggers EditorContainer's visibility useEffect, which saves dirty tabs before hiding.

  // If tabs are enabled, check if file is already open in a tab
  const existingTab2 = tabs.findTabByPath(filePath);
  if (existingTab2) {
    // BUGFIX: Same check as above - verify tab is actually in visible tabs array
    const isInVisibleTabs2 = tabs.tabs?.some((t: any) => t.id === existingTab2.id);
    if (isInVisibleTabs2) {
      if (LOG_CONFIG.WORKSPACE_FILE_SELECT) console.log('[WORKSPACE_FILE_SELECT] File already open in tab, switching');
      tabs.switchTab(existingTab2.id);
      return true;
    }
    // Tab exists in Map but not in tabOrder - fall through to load fresh
    // addTab will repair the state by adding the tab to tabOrder
  }

  // Virtual (fileless) tabs have no disk content to switch to; open them
  // directly. A custom editor registered for the matching `virtual://…` prefix
  // renders them (e.g. the Browser extension's browser session editor).
  if (filePath.startsWith('virtual://')) {
    const tabId = tabs.addTab(filePath, '');
    if (!tabId) {
      console.error('[TABS] Failed to add virtual tab:', filePath);
      errorNotificationService.showError('Cannot open file', filePath);
    }
    return Boolean(tabId);
  }

  try {
    const result = await window.electronAPI.switchWorkspaceFile(filePath);
    if (!isCurrent()) return false;
    if (!result) {
      console.error('[WORKSPACE_FILE_SELECT] switchWorkspaceFile returned null for:', filePath);
      console.error('[WORKSPACE_FILE_SELECT] This could mean the file does not exist or failed to load');
      errorNotificationService.showError('Cannot open file', filePath);
      return false;
    }

    // Handle error response from main process
    if ('error' in result) {
      errorNotificationService.showWarning('Cannot Open File', (result as { error: string }).error, { duration: 5000 });
      return false;
    }

    // Now result is the success type
    const fileResult = result as { filePath: string; content: string };
    if (LOG_CONFIG.WORKSPACE_FILE_SELECT) console.log('[WORKSPACE_FILE_SELECT] File loaded successfully');

    // Add a new tab - onTabChange will handle all state updates
    console.log('[TABS] Adding tab for file:', fileResult.filePath);
    const tabId = tabs.addTab(fileResult.filePath, fileResult.content);
    if (!tabId) {
      console.error('[TABS] Failed to add tab for file:', fileResult.filePath);
      console.error('[TABS] This should not happen - tabs should be unlimited');
      errorNotificationService.showError('Cannot open file', fileResult.filePath);
      return false;
    } else {
      console.log('[TABS] Added tab with ID:', tabId);
      // State updates (contentRef, currentFilePath, etc.) will be handled by onTabChange callback
    }

    // Add to recent files
    if (window.electronAPI?.addToWorkspaceRecentFiles) {
      window.electronAPI.addToWorkspaceRecentFiles(filePath);
    }

    // Create automatic snapshot when switching to file
    if (window.electronAPI.history) {
      try {
        // Check if we have previous snapshots
        const snapshots = await window.electronAPI.history.listSnapshots(fileResult.filePath);
        if (snapshots.length === 0) {
          // First time opening this file, create initial snapshot
          await window.electronAPI.history.createSnapshot(
            fileResult.filePath,
            fileResult.content,
            'auto',
            'Initial file open'
          );
        } else {
          // Check if content changed since last snapshot
          const latestSnapshot = snapshots[0]; // Assuming sorted by timestamp desc
          const lastContent = await window.electronAPI.history.loadSnapshot(
            fileResult.filePath,
            latestSnapshot.timestamp
          );
          if (lastContent !== fileResult.content) {
            // Content actually changed, create snapshot
            await window.electronAPI.history.createSnapshot(
              fileResult.filePath,
              fileResult.content,
              'auto',
              'File changed externally'
            );
          }
        }
      } catch (error) {
        console.error('Failed to create automatic snapshot:', error);
      }
    }
    return true;
  } catch (error) {
    console.error('Failed to switch workspace file:', error);
    if (isCurrent()) errorNotificationService.showError('Cannot open file', error instanceof Error ? error.message : filePath);
    return false;
  }
}
