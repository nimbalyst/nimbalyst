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
import { store } from '@nimbalyst/runtime/store';
import {
  multiProjectModeAtom,
  openProjectsAtom,
  activeWorkspacePathAtom,
  closeOpenProjectAtom,
} from '../store/atoms/openProjects';
import { prRemoteAtom } from '../store/atoms/pullRequests';
import { developerModeAtom } from '../store/atoms/appSettings';
import { sessionLaunchPopupRequestAtom, trackerQuickCreateRequestAtom } from '../store/atoms/appCommands';
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

  // Shared active-mode action used by both Cmd/Ctrl+B and WindowTopBar.
  toggleActiveLeftPane: () => void;

  // Opens history for the document focused in the current content mode.
  openHistoryForCurrentDocument: () => void;

  // True when a fullscreen extension panel is covering the content modes.
  isFullscreenPanelActive: boolean;

  // True when the active project belongs to an organization, mirroring the
  // gutter's gating: without one there is no Org mode to switch to.
  orgModeAvailable: boolean;

  // Clears the active fullscreen extension panel (mirrors the gutter's
  // onExtensionPanelChange(null) so mode-switch shortcuts actually surface).
  exitFullscreenPanel: () => void;

}

/**
 * Hook that manages global keyboard shortcuts for the application.
 *
 * Handles:
 * - Cmd+E: Switch to Files mode (or toggle sidebar if already in Files mode)
 * - Cmd+K: Switch to Agent mode (or toggle session history if already in Agent mode)
 * - Cmd+Y: Open history dialog (Files mode only)
 * - Cmd+T: Switch to Tracker mode (or toggle its sidebar if already in Tracker mode)
 * - Cmd+Alt+M: Switch to Org mode (or toggle its sidebar if already in Org mode)
 * - Cmd+Alt+W: Create new worktree session
 * - Ctrl+`: Toggle Terminal panel
 */
const isMac = navigator.platform.startsWith('Mac');

export function isSessionLaunchPopupShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  macPlatform = isMac,
): boolean {
  const isAppModifier = macPlatform ? event.metaKey : event.ctrlKey;
  return isAppModifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n';
}

export function isTrackerQuickCreateShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  macPlatform = isMac,
): boolean {
  const isAppModifier = macPlatform ? event.metaKey : event.ctrlKey;
  return isAppModifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'i';
}

export function isToggleSidebarShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  macPlatform = isMac,
): boolean {
  const isAppModifier = macPlatform ? event.metaKey : event.ctrlKey;
  return isAppModifier
    && !event.shiftKey
    && !event.altKey
    && event.key.toLowerCase() === 'b';
}

/**
 * True when the keystroke landed inside a rich-text surface, where Cmd/Ctrl+B
 * means bold. This listener runs in the capture phase, so without this check it
 * preventDefaults the keystroke before Lexical's own root-element handler ever
 * sees it and the editor can never bold anything.
 *
 * Plain inputs, textareas and Monaco (which types into a hidden textarea) are
 * not editable regions, so the sidebar shortcut still applies there — matching
 * VS Code's Cmd+B in code.
 */
export function isRichTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  // jsdom never sets isContentEditable, so fall back to the nearest declared
  // editing host — which is also how a target nested inside the editor matches.
  const host = target.closest<HTMLElement>('[contenteditable]');
  return host !== null && host.getAttribute('contenteditable') !== 'false';
}

export function useKeyboardShortcuts({
  activeMode,
  workspaceMode,
  setActiveMode,
  activeModeStateRef,
  editorModeRef,
  agentModeRef,
  toggleAgentCollapsed,
  toggleActiveLeftPane,
  openHistoryForCurrentDocument,
  isFullscreenPanelActive,
  exitFullscreenPanel,
  orgModeAvailable,
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

      // Cmd/Ctrl+Shift+N opens (or toggles) the new-session composer without
      // changing the active content mode. Electron's menu accelerator owns the
      // normal desktop path; this renderer handler keeps the shortcut working
      // in surfaces where the menu event is not delivered.
      if (workspaceMode && isSessionLaunchPopupShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        store.set(sessionLaunchPopupRequestAtom, (version) => version + 1);
        return;
      }

      // Cmd/Ctrl+Shift+I opens (or toggles) the tracker quick-create popup from
      // anywhere, without changing the active content mode.
      if (workspaceMode && isTrackerQuickCreateShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        store.set(trackerQuickCreateRequestAtom, (version) => version + 1);
        return;
      }

      // Cmd/Ctrl+B toggles the active left pane, except inside a rich-text
      // editor where it is bold.
      if (workspaceMode && isToggleSidebarShortcut(e) && !isRichTextEditingTarget(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        toggleActiveLeftPane();
        return;
      }

      // Cmd+E for Files mode (toggle sidebar if already in files mode)
      if (isAppModifier && e.key === 'e') {
        e.preventDefault();
        e.stopPropagation();

        if (workspaceMode) {
          if (isFullscreenPanelActive) {
            // A fullscreen extension panel is covering the modes -- exit it and
            // surface Files mode rather than toggling an unseen sidebar.
            exitFullscreenPanel();
            setActiveMode('files');
          } else if (activeMode === 'files') {
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
          if (isFullscreenPanelActive) {
            exitFullscreenPanel();
            setActiveMode('agent');
          } else if (activeMode === 'agent') {
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
          openHistoryForCurrentDocument();
        }
      }

      // Cmd+T for Tracker mode (toggle the sidebar if already in tracker mode)
      if (workspaceMode && isAppModifier && !e.shiftKey && !e.altKey && e.key === 't') {
        // Quick Track owns Cmd+T while it is open. This listener runs in the
        // capture phase, before the popup's React handler can preventDefault,
        // so arbitrate on the popup marker instead of the event state.
        if (document.querySelector('.tracker-quick-create-popup')) return;
        e.preventDefault();
        if (isFullscreenPanelActive) {
          exitFullscreenPanel();
          setActiveMode('tracker');
        } else if (activeMode === 'tracker') {
          toggleActiveLeftPane();
        } else {
          setActiveMode('tracker');
        }
      }

      // Cmd+D to switch to Shared Documents (Collab) mode
      if (workspaceMode && isAppModifier && !e.shiftKey && !e.altKey && e.key === 'd') {
        e.preventDefault();
        e.stopPropagation();
        if (isFullscreenPanelActive) exitFullscreenPanel();
        setActiveMode('collab');
      }
      // Cmd+Alt+M to switch to Org mode (toggle its sidebar if already there),
      // only when the project belongs to an organization.
      // `code` as well as `key`: with Option held, macOS rewrites the character
      // (Option+M is "µ"), so the letter alone is not enough to match on.
      if (workspaceMode && orgModeAvailable && isAppModifier && e.altKey && !e.shiftKey
          && (e.key.toLowerCase() === 'm' || e.code === 'KeyM')) {
        e.preventDefault();
        e.stopPropagation();
        if (isFullscreenPanelActive) {
          exitFullscreenPanel();
          setActiveMode('org');
        } else if (activeMode === 'org') {
          toggleActiveLeftPane();
        } else {
          setActiveMode('org');
        }
      }
      // Cmd+U to switch to PR Review mode (only when the active workspace has a
      // GitHub remote, mirroring the gutter button's visibility).
      if (workspaceMode && developerMode && isAppModifier && !e.shiftKey && !e.altKey && e.key === 'u') {
        const prRemote = store.get(prRemoteAtom);
        if (prRemote && prRemote.workspacePath === store.get(activeWorkspacePathAtom)) {
          e.preventDefault();
          e.stopPropagation();
          if (isFullscreenPanelActive) exitFullscreenPanel();
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
      // Cmd+Shift+K for Kanban view (switch to agent mode + kanban, or toggle if already there).
      // With Shift held the browser reports the uppercase letter, so a lowercase
      // `key` match never fires (#1415).
      if (workspaceMode && isAppModifier && e.shiftKey
          && (e.code === 'KeyK' || e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        e.stopPropagation();

        const setViewMode = (mode: 'list' | 'kanban') => store.set(setViewModeAtom, mode);
        const currentViewMode = store.get(viewModeAtom);

        if (isFullscreenPanelActive) {
          // Exit the fullscreen panel and surface the agent kanban view.
          exitFullscreenPanel();
          posthog.capture('session_view_mode_switched', { fromMode: currentViewMode, toMode: 'kanban' });
          setViewMode('kanban');
          setActiveMode('agent');
        } else if (activeMode === 'agent') {
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

      // Cmd+Alt+W (Mac) or Ctrl+Alt+W (Windows) to create new worktree session.
      // `code` as well as `key`: with Option held, macOS rewrites the character
      // (Option+W is "∑"), so the letter alone is not enough to match on.
      if (workspaceMode && isAppModifier && e.altKey
          && (e.key.toLowerCase() === 'w' || e.code === 'KeyW')) {
        e.preventDefault();
        e.stopPropagation();

        if (isFullscreenPanelActive) exitFullscreenPanel();

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
              if (isFullscreenPanelActive) exitFullscreenPanel();
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
    toggleActiveLeftPane,
    openHistoryForCurrentDocument,
    toggleTerminalPanel,
    closeTerminalPanel,
    developerMode,
    isFullscreenPanelActive,
    exitFullscreenPanel,
    orgModeAvailable,
  ]);
}
