import { useEffect } from 'react';
import { logger } from '../utils/logger';
import { store, editorDirtyAtom, makeEditorKey } from '@nimbalyst/runtime/store';
import { isCollabUri } from '../utils/collabUri';
import {
  collabConnectionStatusAtom,
  hasCollabUnsyncedChanges,
} from '../store/atoms/collabEditor';

interface UseWindowLifecycleProps {
  tabsRef: React.MutableRefObject<any>;
  getContentRef: React.MutableRefObject<(() => string) | null>;
  currentFilePathRef: React.MutableRefObject<string | null>;
}

/**
 * Hook to handle window lifecycle events (mount/unmount/beforeunload).
 * Saves unsaved changes when the window is closing or reloading.
 */
export function useWindowLifecycle({
  tabsRef,
  getContentRef,
  currentFilePathRef
}: UseWindowLifecycleProps) {
  useEffect(() => {
    logger.ui.info('App component mounted');

    // Save on window close/reload
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const snapshot = tabsRef.current?.getSnapshot?.();
      const tabs = snapshot
        ? snapshot.tabOrder
          .map((tabId: string) => snapshot.tabs.get(tabId))
          .filter(Boolean)
        : [];

      // Check if any tabs are dirty or have collab updates pending.
      const hasBlockingChanges = tabs.some((tab: any) => {
        if (!tab.filePath) return false;
        const editorKey = makeEditorKey(tab.filePath);
        if (store.get(editorDirtyAtom(editorKey))) {
          return true;
        }
        if (!isCollabUri(tab.filePath)) {
          return false;
        }
        const collabStatus = store.get(collabConnectionStatusAtom(tab.filePath));
        return hasCollabUnsyncedChanges(collabStatus);
      });
      const activeTab = snapshot?.activeTabId
        ? snapshot.tabs.get(snapshot.activeTabId)
        : null;
      const isActiveTabDirty = activeTab?.filePath
        ? store.get(editorDirtyAtom(makeEditorKey(activeTab.filePath)))
        : false;

      // Save current tab content first
      if (snapshot?.activeTabId && tabsRef.current?.updateTab && getContentRef.current) {
        const currentContent = getContentRef.current();
        tabsRef.current.updateTab(snapshot.activeTabId, {
          content: currentContent,
          isDirty: isActiveTabDirty
        });
      }

      if (hasBlockingChanges) {
        // console.log('[WINDOW CLOSE] Has unsaved changes');
        // This will show a dialog in Electron
        e.preventDefault();
        e.returnValue = 'You have unsaved changes. Are you sure you want to quit?';

        // Try to save current file quickly
        const currentFilePath = currentFilePathRef.current;
        if (isActiveTabDirty && getContentRef.current && currentFilePath && window.electronAPI) {
          const content = getContentRef.current();
          // Fire and forget - don't await
          // NOTE: lastSaveTime is tracked in EditorPool per-file now
          window.electronAPI.saveFile(content, currentFilePath).then(result => {
            if (result && result.success) {
              // console.log('[WINDOW CLOSE] Saved current file');
            }
          }).catch(error => {
            console.error('[WINDOW CLOSE] Failed to save:', error);
          });
        }
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      logger.ui.info('App component unmounting');
      window.removeEventListener('beforeunload', handleBeforeUnload);

      // Final save attempt on unmount
      const activeTab = tabsRef.current?.tabs?.find((t: any) => t.id === tabsRef.current?.activeTabId);
      const currentFilePath = currentFilePathRef.current;
      const isActiveTabDirty = currentFilePath
        ? store.get(editorDirtyAtom(makeEditorKey(currentFilePath)))
        : false;
      if (isActiveTabDirty && getContentRef.current && currentFilePath && window.electronAPI) {
        const content = getContentRef.current();
        window.electronAPI.saveFile(content, currentFilePath).catch(error => {
          console.error('[UNMOUNT] Failed to save:', error);
        });
      }
    };
  }, [tabsRef, getContentRef, currentFilePathRef]); // Refs don't change, so this effect runs once
}
