/**
 * useUIState - Manages UI-only state (dialogs, panels, theme, etc.)
 */

import { useState } from 'react';
import type { ConfigTheme } from '@nimbalyst/runtime';

interface UIState {
  theme: ConfigTheme;
  sidebarWidth: number;
  isQuickOpenVisible: boolean;
  isNewFileDialogOpen: boolean;
  isAIChatCollapsed: boolean;
  aiChatWidth: number;
  isHistoryDialogOpen: boolean;
  isApiKeyDialogOpen: boolean;
  currentAISessionId: string | null;
  diffError: { isOpen: boolean; title: string; message: string; details?: any };
}

interface UIActions {
  setTheme: (theme: ConfigTheme) => void;
  setSidebarWidth: (width: number) => void;
  setIsQuickOpenVisible: (visible: boolean) => void;
  setIsNewFileDialogOpen: (open: boolean) => void;
  setIsAIChatCollapsed: (collapsed: boolean) => void;
  setAIChatWidth: (width: number) => void;
  setIsHistoryDialogOpen: (open: boolean) => void;
  setIsApiKeyDialogOpen: (open: boolean) => void;
  setCurrentAISessionId: (id: string | null) => void;
  setDiffError: (error: { isOpen: boolean; title: string; message: string; details?: any }) => void;
}

export function useUIState(): [UIState, UIActions] {
  const [theme, setTheme] = useState<ConfigTheme>(() => {
    const savedTheme = localStorage.getItem('theme');
    return (savedTheme as ConfigTheme) || 'light';
  });
  const [sidebarWidth, setSidebarWidth] = useState<number>(250);
  const [isQuickOpenVisible, setIsQuickOpenVisible] = useState(false);
  const [isNewFileDialogOpen, setIsNewFileDialogOpen] = useState(false);
  const [isAIChatCollapsed, setIsAIChatCollapsed] = useState(false);
  const [aiChatWidth, setAIChatWidth] = useState<number>(350);
  const [isHistoryDialogOpen, setIsHistoryDialogOpen] = useState(false);
  const [isApiKeyDialogOpen, setIsApiKeyDialogOpen] = useState(false);
  const [currentAISessionId, setCurrentAISessionId] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<{ isOpen: boolean; title: string; message: string; details?: any }>({
    isOpen: false,
    title: '',
    message: '',
  });

  const state: UIState = {
    theme,
    sidebarWidth,
    isQuickOpenVisible,
    isNewFileDialogOpen,
    isAIChatCollapsed,
    aiChatWidth,
    isHistoryDialogOpen,
    isApiKeyDialogOpen,
    currentAISessionId,
    diffError,
  };

  const actions: UIActions = {
    setTheme,
    setSidebarWidth,
    setIsQuickOpenVisible,
    setIsNewFileDialogOpen,
    setIsAIChatCollapsed,
    setAIChatWidth,
    setIsHistoryDialogOpen,
    setIsApiKeyDialogOpen,
    setCurrentAISessionId,
    setDiffError,
  };

  return [state, actions];
}