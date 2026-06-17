import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { ContentMode } from '../types/WindowModeTypes';
import type { AgentModeRef } from '../components/AgentMode';
import {
  toggleTerminalPanelAtom,
  closeTerminalPanelAtom,
  toggleCliTerminalDrawerAtom,
} from '../store/atoms/terminals';
import { activeSessionIdAtom, sessionProviderAtom } from '../store/atoms/sessions';
import { setViewModeAtom, viewModeAtom } from '../store/atoms/agentMode';
import { historyDialogFileAtom } from '../store';
import { store } from '@nimbalyst/runtime/store';
import {
  multiProjectModeAtom,
  openProjectsAtom,
  activeWorkspacePathAtom,
  closeOpenProjectAtom,
} from '../store/atoms/openProjects';
import { prRemoteAtom } from '../store/atoms/pullRequests';
import { developerModeAtom } from '../store/atoms/appSettings';
import posthog from 'posthog-js';

interface KeyboardShortcutsOptions {
  // Mode state
  activeMode: ContentMode;
  workspaceMode: boolean;

  // Mode setters
  setActiveMode: (mode: ContentMode) => void;

  // Ref for accessing current mode in callbacks
  activeModeStateRef: React.RefObject<ContentMode>;

  // EditorMode ref for file operations
  editorModeRef: React.RefObject<{
    toggleSidebarCollapsed: () => void;
    openHistoryDialog: () => void;
  } | null>;

  // AgentMode ref for worktree operations
  agentModeRef: React.RefObject<AgentModeRef | null>;

  // Agent mode toggle
  toggleAgentCollapsed: () => void;

}

/**
 * Hook that manages global keyboard shortcuts for the application.
 *
 * Handles:
 * - Cmd+E: Switch to Files mode (or toggle sidebar if already in Files mode)
 * - Cmd+K: Switch to Agent mode (or toggle session history if already in Agent mode)
 * - Cmd+Y: Open history dialog (Files mode only)
 * - Cmd+T: Switch to Tracker mode
 * - Cmd+Alt+W: Create new worktree session
 * - Ctrl+`: Toggle Terminal panel
 */
const isMac = navigator.platform.startsWith('Mac');

export function useKeyboardShortcuts({
  activeMode,
  workspaceMode,
  setActiveMode,
  activeModeStateRef,
  editorModeRef,
  agentModeRef,
  toggleAgentCollapsed,
}: KeyboardShortcutsOptions): void {
  // Terminal panel atoms
  const toggleTerminalPanel = useSetAtom(toggleTerminalPanelAtom);
  const closeTerminalPanel = useSetAtom(closeTerminalPanelAtom);
  const developerMode = useAtomValue(developerModeAtom);

  // Track if worktree creation is pending after mode switch
  const pendingWorktreeCreationRef = useRef(false);

  // When agentModeRef becomes available and worktree creation is pending, execute it
  useEffect(() => {
    if (pendingWorktreeCreationRef.current && agentModeRef.current && activeMode === 'agent') {
      pendingWorktreeCreationRef.current = false;
      void agentModeRef.current.createNewWorktreeSession().catch(() => {
        // Swallowed: AgentMode already logs the error; keyboard shortcut
        // has no UI to display it.
      });
    }
  }, [agentModeRef, activeMode]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      // On macOS, app shortcuts use Command (metaKey). On Windows/Linux, they use Ctrl.
      const isAppModifier = isMac ? e.metaKey : e.ctrlKey;

      // Cmd+E for Files mode (toggle sidebar if already in files mode)
      if (isAppModifier && e.key === 'e') {
        e.preventDefault();
        e.stopPropagation();

        if (workspaceMode) {
          if (activeMode === 'files') {
            editorModeRef.current?.toggleSidebarCollapsed();
          } else {
            setActiveMode('files');
          }
        }
      }

      // Cmd+K for Agent mode (toggle session history if already in agent mode)
      // This is a global shortcut, but should be preempted if another component handles it
      if (isAppModifier && e.key === 'k' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();

        if (workspaceMode) {
          if (activeMode === 'agent') {
            toggleAgentCollapsed();
          } else {
            setActiveMode('agent');
          }
        }
      }

      // Cmd+Y for history dialog (works in any mode that has an active file)
      if (isAppModifier && e.key === 'y') {
        e.preventDefault();
        if (workspaceMode) {
          // __currentDocumentPath is maintained by both EditorMode (FilesMode) and
          // WorkstreamEditorTabs (AgentMode), so it tracks whichever file is active.
          const activeFilePath = (window as unknown as { __currentDocumentPath?: string | null }).__currentDocumentPath;
          if (activeFilePath) {
            store.set(historyDialogFileAtom, activeFilePath);
          }
        }
      }

      // Cmd+T to switch to Tracker mode
      if (workspaceMode && isAppModifier && !e.shiftKey && !e.altKey && e.key === 't') {
        e.preventDefault();
        setActiveMode('tracker');
      }

      // Cmd+D to switch to Shared Documents (Collab) mode
      if (workspaceMode && isAppModifier && !e.shiftKey && !e.altKey && e.key === 'd') {
        e.preventDefault();
        e.stopPropagation();
        setActiveMode('collab');
      }
      // Cmd+U to switch to PR Review mode (only when the active workspace has a
      // GitHub remote, mirroring the gutter button's visibility).
      if (workspaceMode && developerMode && isAppModifier && !e.shiftKey && !e.altKey && e.key === 'u') {
        const prRemote = store.get(prRemoteAtom);
        if (prRemote && prRemote.workspacePath === store.get(activeWorkspacePathAtom)) {
          e.preventDefault();
          e.stopPropagation();
          setActiveMode('pr-review');
        }
      }
      // Ctrl+` for Terminal panel (Ctrl on all platforms, matching VS Code)
      if (workspaceMode && e.code === 'Backquote' && !e.shiftKey && !e.altKey &&
          e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        toggleTerminalPanel();
      }
      // Ctrl+Shift+` toggles the CLI raw-terminal drawer for the active
      // claude-code-cli session (NIM-820).
      if (workspaceMode && e.code === 'Backquote' && e.shiftKey && !e.altKey &&
          e.ctrlKey && !e.metaKey) {
        const activeSessionId = store.get(activeSessionIdAtom);
        if (activeSessionId && store.get(sessionProviderAtom(activeSessionId)) === 'claude-code-cli') {
          e.preventDefault();
          e.stopPropagation();
          store.set(toggleCliTerminalDrawerAtom, activeSessionId);
        }
      }
      // Cmd+Shift+K for Kanban view (switch to agent mode + kanban, or toggle if already there)
      if (workspaceMode && isAppModifier && e.shiftKey && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();

        const setViewMode = (mode: 'list' | 'kanban') => store.set(setViewModeAtom, mode);
        const currentViewMode = store.get(viewModeAtom);

        if (activeMode === 'agent') {
          // Toggle kanban on/off
          const newMode = currentViewMode === 'kanban' ? 'list' : 'kanban';
          posthog.capture('session_view_mode_switched', {
            fromMode: currentViewMode,
            toMode: newMode,
          });
          setViewMode(newMode);
        } else {
          // Switch to agent mode and set kanban view
          posthog.capture('session_view_mode_switched', {
            fromMode: currentViewMode,
            toMode: 'kanban',
          });
          setViewMode('kanban');
          setActiveMode('agent');
        }
      }

      // Cmd+Alt+W (Mac) or Ctrl+Alt+W (Windows) to create new worktree session
      if (workspaceMode && isAppModifier && e.altKey && e.key === 'w') {
        e.preventDefault();
        e.stopPropagation();

        // If in agent mode and ref is available, create worktree directly
        if (activeMode === 'agent' && agentModeRef.current) {
          void agentModeRef.current.createNewWorktreeSession().catch(() => {
            // Swallowed: AgentMode already logs the error; keyboard
            // shortcut has no UI to display it.
          });
        } else {
          // Switch to agent mode first, then create worktree when ref becomes available
          pendingWorktreeCreationRef.current = true;
          setActiveMode('agent');
        }
      }

      // Multi-project rail shortcuts (only when rail is enabled).
      // Cmd/Ctrl+1..9 activates the Nth open project (1-indexed).
      // Cmd/Ctrl+Shift+W closes the active project from the rail.
      const isMultiProject = store.get(multiProjectModeAtom);
      if (workspaceMode && isMultiProject && isAppModifier && !e.altKey) {
        if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          const idx = parseInt(e.key, 10) - 1;
          const projects = store.get(openProjectsAtom);
          const target = projects[idx];
          if (target) {
            const currentActive = store.get(activeWorkspacePathAtom);
            if (target.path !== currentActive) {
              store.set(activeWorkspacePathAtom, target.path);
              window.electronAPI?.invoke?.('workspace:set-active', { workspacePath: target.path }).catch(() => {});
            }
          }
        }

        if (e.shiftKey && e.key === 'W') {
          e.preventDefault();
          e.stopPropagation();
          const activePath = store.get(activeWorkspacePathAtom);
          const projects = store.get(openProjectsAtom);
          if (activePath) {
            const wasLast = projects.length <= 1;
            store.set(closeOpenProjectAtom, activePath);
            window.electronAPI?.invoke?.('workspace:unregister-additional', { workspacePath: activePath }).catch(() => {});
            if (wasLast) {
              window.electronAPI?.invoke?.('workspace:close-rail-window').catch(() => {});
            }
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [
    activeMode,
    workspaceMode,
    setActiveMode,
    activeModeStateRef,
    editorModeRef,
    agentModeRef,
    toggleAgentCollapsed,
    toggleTerminalPanel,
    closeTerminalPanel,
    developerMode,
  ]);
}
