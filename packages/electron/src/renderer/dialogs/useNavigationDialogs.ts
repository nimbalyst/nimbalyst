/**
 * Hook for opening the unified navigation dialog with proper typing.
 *
 * The five legacy quick-open dialogs have been collapsed into one tabbed
 * dialog. Each opener picks the initial tab; while the dialog is open the
 * five global shortcuts (⌘O, ⌘⇧F, ⌘L, ⌘⇧L, ⌘⇧P) jump between tabs.
 */

import { useCallback } from 'react';
import { useDialog } from '../contexts/DialogContext';
import { DIALOG_IDS } from './registry';
import type { UnifiedQuickOpenData } from './navigation';
import type { UnifiedQuickOpenTab } from '../components/UnifiedQuickOpen';

export interface UseNavigationDialogsReturn {
  openUnifiedQuickOpen: (data: UnifiedQuickOpenData) => void;
  openQuickOpen: (data: Omit<UnifiedQuickOpenData, 'initialTab'>) => void;
  openInFiles: (data: Omit<UnifiedQuickOpenData, 'initialTab'>) => void;
  openSessionQuickOpen: (data: Omit<UnifiedQuickOpenData, 'initialTab'>) => void;
  openPromptQuickOpen: (data: Omit<UnifiedQuickOpenData, 'initialTab'>) => void;
  openProjectQuickOpen: (data: Omit<UnifiedQuickOpenData, 'initialTab'>) => void;
  closeNavigationDialogs: () => void;
}

export function useNavigationDialogs(): UseNavigationDialogsReturn {
  const { open, close, activeDialogs } = useDialog();

  const openWithTab = useCallback(
    (initialTab: UnifiedQuickOpenTab) =>
      (data: Omit<UnifiedQuickOpenData, 'initialTab'>) => {
        open(DIALOG_IDS.UNIFIED_QUICK_OPEN, { ...data, initialTab });
      },
    [open],
  );

  const openUnifiedQuickOpen = useCallback(
    (data: UnifiedQuickOpenData) => {
      open(DIALOG_IDS.UNIFIED_QUICK_OPEN, data);
    },
    [open],
  );

  const closeNavigationDialogs = useCallback(() => {
    if (activeDialogs.includes(DIALOG_IDS.UNIFIED_QUICK_OPEN)) {
      close(DIALOG_IDS.UNIFIED_QUICK_OPEN);
    }
  }, [close, activeDialogs]);

  return {
    openUnifiedQuickOpen,
    openQuickOpen: openWithTab('files'),
    openInFiles: openWithTab('in-files'),
    openSessionQuickOpen: openWithTab('sessions'),
    openPromptQuickOpen: openWithTab('prompts'),
    openProjectQuickOpen: openWithTab('projects'),
    closeNavigationDialogs,
  };
}
