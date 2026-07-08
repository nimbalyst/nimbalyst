/**
 * NavigationDialogKeyboardHandler
 *
 * Wires the five global quick-open shortcuts to the unified dialog. Each
 * shortcut opens the dialog landing on its own tab. While the dialog is
 * already open, the UnifiedQuickOpen component handles re-firing the same
 * shortcut to jump tabs (so we don't need to intercept here).
 */

import React, { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useNavigationDialogs } from '../dialogs';
import { openNavigationDialogRequestAtom } from '../store/atoms/appCommands';
import type { UnifiedQuickOpenData } from '../dialogs/navigation';
import type { UnifiedQuickOpenTab } from './UnifiedQuickOpen';

const isMac = navigator.platform.startsWith('Mac');

interface NavigationDialogKeyboardHandlerProps {
  workspaceMode: boolean;
  workspacePath: string | null;
  currentFilePath: string | null;
  onFileSelect: (filePath: string) => void;
  onFolderSelect?: (folderPath: string) => void;
  onSessionSelect: (sessionId: string) => void;
  onPromptSelect: (sessionId: string, messageTimestamp?: number) => void;
  /** Document context for AgentCommandPalette */
  documentContext: { content?: string; filePath?: string };
}

export function NavigationDialogKeyboardHandler({
  workspaceMode,
  workspacePath,
  currentFilePath,
  onFileSelect,
  onFolderSelect,
  onSessionSelect,
  onPromptSelect,
  documentContext: _documentContext,
}: NavigationDialogKeyboardHandlerProps) {
  const { openUnifiedQuickOpen } = useNavigationDialogs();

  const propsRef = useRef({
    workspaceMode,
    workspacePath,
    currentFilePath,
    onFileSelect,
    onFolderSelect,
    onSessionSelect,
    onPromptSelect,
  });
  useEffect(() => {
    propsRef.current = {
      workspaceMode,
      workspacePath,
      currentFilePath,
      onFileSelect,
      onFolderSelect,
      onSessionSelect,
      onPromptSelect,
    };
  });

  const openRef = useRef(openUnifiedQuickOpen);
  useEffect(() => {
    openRef.current = openUnifiedQuickOpen;
  });

  // Build the data payload from the latest props.
  const buildData = (initialTab: UnifiedQuickOpenTab): UnifiedQuickOpenData | null => {
    const p = propsRef.current;
    if (!p.workspaceMode || !p.workspacePath) return null;
    return {
      workspacePath: p.workspacePath,
      currentFilePath: p.currentFilePath,
      initialTab,
      onFileSelect: p.onFileSelect,
      onFolderSelect: p.onFolderSelect,
      onSessionSelect: p.onSessionSelect,
      onPromptSelect: p.onPromptSelect,
    };
  };

  // Global shortcut handler. We intentionally do NOT preventDefault when the
  // dialog is already open — UnifiedQuickOpen has its own capture handler
  // that intercepts these to jump tabs.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // If the unified dialog is already mounted, let it handle the shortcut.
      if (document.querySelector('[data-testid="unified-quick-open"]')) return;

      const isAppModifier = isMac ? e.metaKey : e.ctrlKey;
      if (!isAppModifier) return;

      let initialTab: UnifiedQuickOpenTab | null = null;
      if (e.shiftKey && (e.key === 'P' || e.key === 'p')) initialTab = 'projects';
      else if (e.shiftKey && (e.key === 'F' || e.key === 'f')) initialTab = 'in-files';
      else if (e.shiftKey && (e.key === 'L' || e.key === 'l')) initialTab = 'prompts';
      else if (e.shiftKey && (e.key === 'O' || e.key === 'o')) initialTab = 'search';
      else if (!e.shiftKey && e.key === 'o') initialTab = 'files';
      else if (!e.shiftKey && e.key === 'l') initialTab = 'sessions';

      if (!initialTab) return;

      const data = buildData(initialTab);
      if (!data) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      openRef.current(data);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  // Menu-triggered opens (from main process)
  const openNavigationDialogRequest = useAtomValue(openNavigationDialogRequestAtom);
  useEffect(() => {
    if (!openNavigationDialogRequest) return;
    const dialogId = openNavigationDialogRequest.dialogId;

    let initialTab: UnifiedQuickOpenTab;
    switch (dialogId) {
      case 'project-quick-open':
        initialTab = 'projects';
        break;
      case 'session-quick-open':
        initialTab = 'sessions';
        break;
      case 'prompt-quick-open':
        initialTab = 'prompts';
        break;
      case 'content-search':
        initialTab = 'in-files';
        break;
      case 'global-search':
        initialTab = 'search';
        break;
      case 'quick-open':
      default:
        initialTab = 'files';
        break;
    }

    const data = buildData(initialTab);
    if (data) openRef.current(data);
  }, [openNavigationDialogRequest]);

  return null;
}
