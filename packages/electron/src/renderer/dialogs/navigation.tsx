/**
 * Navigation Dialog Registration
 *
 * Single tabbed dialog combining Files, In Files, Sessions, Prompts, and
 * Projects search. Opened with an initialTab; the global shortcuts each map
 * to one tab and also jump tabs while the dialog is open.
 */

import React from 'react';
import { registerDialog } from '../contexts/DialogContext';
import type { DialogConfig } from '../contexts/DialogContext.types';
import { UnifiedQuickOpen, type UnifiedQuickOpenTab } from '../components/UnifiedQuickOpen';
import { DIALOG_IDS } from './registry';

export interface UnifiedQuickOpenData {
  workspacePath: string;
  initialTab?: UnifiedQuickOpenTab;
  currentFilePath?: string | null;
  onFileSelect: (filePath: string) => void;
  onFolderSelect?: (folderPath: string) => void;
  onSessionSelect: (sessionId: string) => void;
  onPromptSelect: (sessionId: string, messageTimestamp?: number) => void;
}

function UnifiedQuickOpenWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: UnifiedQuickOpenData;
}) {
  return (
    <UnifiedQuickOpen
      isOpen={isOpen}
      onClose={onClose}
      workspacePath={data.workspacePath}
      currentFilePath={data.currentFilePath}
      initialTab={data.initialTab}
      onFileSelect={(filePath) => {
        data.onFileSelect(filePath);
        onClose();
      }}
      onFolderSelect={data.onFolderSelect}
      onSessionSelect={(sessionId) => {
        data.onSessionSelect(sessionId);
        onClose();
      }}
      onPromptSelect={(sessionId, ts) => {
        data.onPromptSelect(sessionId, ts);
        onClose();
      }}
    />
  );
}

export function registerNavigationDialogs() {
  registerDialog<UnifiedQuickOpenData>({
    id: DIALOG_IDS.UNIFIED_QUICK_OPEN,
    group: 'navigation',
    component: UnifiedQuickOpenWrapper as DialogConfig<UnifiedQuickOpenData>['component'],
    priority: 100,
  });
}
