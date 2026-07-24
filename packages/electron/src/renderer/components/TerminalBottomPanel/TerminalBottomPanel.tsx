/**
 * TerminalBottomPanel - Slide-up bottom panel for terminal tabs
 *
 * Similar to TrackerBottomPanel but contains multiple terminal instances
 * in a tabbed interface. Terminals are stored in a dedicated terminal store
 * separate from AI sessions.
 *
 * Uses Jotai atoms for all state: terminal list, active terminal, panel
 * visibility, and panel height. No props needed for panel state.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { TerminalPanel } from '../Terminal/TerminalPanel';
import { TerminalTab } from './TerminalTab';
import { usePostHog } from 'posthog-js/react';
import {
  terminalListAtom,
  activeTerminalIdAtom,
  terminalPanelVisibleAtom,
  terminalPanelHeightAtom,
  terminalPanelHydratedAtom,
  closeTerminalPanelAtom,
  loadTerminals,
  setActiveTerminal,
  removeTerminalFromList,
  initTerminalListeners,
  setTerminalCommandRunning,
  terminalCommandRunningAtom,
  type TerminalInstance,
} from '../../store/atoms/terminals';
import { selectedWorkstreamAtom, sessionWorktreeIdAtom } from '../../store/atoms/sessions';

interface TerminalBottomPanelProps {
  workspacePath: string;
  minHeight?: number;
  maxHeight?: number;
}

/**
 * Wrapper component that subscribes to command running state for a terminal
 * This isolates re-renders to just the affected tab when running state changes
 */
interface TerminalTabWrapperProps {
  terminal: TerminalInstance;
  isActive: boolean;
  isActiveWorktree: boolean;
  terminalIndex: number;
  terminalCount: number;
  onSelect: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onCloseToRight: () => void;
}

const TerminalTabWrapper: React.FC<TerminalTabWrapperProps> = ({
  terminal,
  isActiveWorktree,
  ...props
}) => {
  const isCommandRunning = useAtomValue(terminalCommandRunningAtom(terminal.id));

  return (
    <TerminalTab
      terminal={terminal}
      isCommandRunning={isCommandRunning}
      isActiveWorktree={isActiveWorktree}
      {...props}
    />
  );
};

export const TerminalBottomPanel: React.FC<TerminalBottomPanelProps> = ({
  workspacePath,
  minHeight = 150,
  maxHeight = 600,
}) => {
  // Panel state from Jotai atoms
  const visible = useAtomValue(terminalPanelVisibleAtom);
  const height = useAtomValue(terminalPanelHeightAtom);
  const panelStateHydrated = useAtomValue(terminalPanelHydratedAtom);
  const closePanel = useSetAtom(closeTerminalPanelAtom);

  // Terminal list state from Jotai atoms
  const terminals = useAtomValue(terminalListAtom);
  const activeTerminalId = useAtomValue(activeTerminalIdAtom);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartY = useRef<number>(0);
  const resizeStartHeight = useRef<number>(0);
  const posthog = usePostHog();

  // Get the currently viewed worktree ID from the selected workstream
  const selectedWorkstream = useAtomValue(selectedWorkstreamAtom(workspacePath));
  const selectedSessionWorktreeId = useAtomValue(
    sessionWorktreeIdAtom(selectedWorkstream?.id ?? '')
  );
  // The active worktree is the worktree ID of the currently viewed session
  // This is used to highlight terminal tabs that belong to the viewed worktree
  const activeWorktreeId = selectedWorkstream?.type === 'worktree'
    ? selectedSessionWorktreeId
    : null;

  // Load terminals and set up IPC listeners on mount
  useEffect(() => {
    // Initial load
    loadTerminals(workspacePath);

    // Listen for external terminal creation (e.g., from worktree button)
    const handleTerminalCreated = (event: Event) => {
      const customEvent = event as CustomEvent<{ terminalId: string }>;
      if (customEvent.detail?.terminalId) {
        loadTerminals(workspacePath);
      }
    };

    window.addEventListener('terminal:created', handleTerminalCreated);

    // Set up IPC listeners for terminal list changes
    const cleanupListeners = initTerminalListeners(workspacePath);

    // Listen for command running state changes
    const unsubscribeCommandRunning = window.electronAPI.terminal.onCommandRunning?.((data) => {
      setTerminalCommandRunning(data.terminalId, data.isRunning);
    });

    return () => {
      window.removeEventListener('terminal:created', handleTerminalCreated);
      cleanupListeners();
      unsubscribeCommandRunning?.();
    };
  }, [workspacePath]);

  // Track analytics and persist visibility when panel visibility changes
  useEffect(() => {
    if (!panelStateHydrated) return;
    if (visible && posthog) {
      posthog.capture('terminal_panel_opened', {
        terminalCount: terminals.length,
      });
    }
    // Persist visibility state per-workspace
    window.electronAPI.terminal.setPanelVisible(workspacePath, visible);
  }, [visible, workspacePath, posthog, terminals.length, panelStateHydrated]);

  // Create new terminal
  const handleCreateTerminal = useCallback(async () => {
    try {
      const result = await window.electronAPI.terminal.create(workspacePath, {
        cwd: workspacePath,
        title: `Terminal ${terminals.length + 1}`,
        source: 'panel',
      });

      if (result.success && result.instance) {
        // Reload from backend to get the new terminal
        await loadTerminals(workspacePath);
      }
    } catch (error: unknown) {
      console.error('[TerminalBottomPanel] Failed to create terminal:', error);
    }
  }, [workspacePath, terminals.length]);

  // Switch to terminal tab
  const handleSelectTerminal = useCallback(async (terminalId: string) => {
    setActiveTerminal(terminalId);
    await window.electronAPI.terminal.setActive(workspacePath, terminalId);
  }, [workspacePath]);

  // Close terminal tab
  const handleCloseTerminal = useCallback(async (terminalId: string) => {
    try {
      await window.electronAPI.terminal.delete(workspacePath, terminalId);

      // Optimistically remove from atom
      removeTerminalFromList(terminalId);

      // If we closed the active terminal, the atom helper updates active too
      const currentActive = store.get(activeTerminalIdAtom);
      if (currentActive) {
        await window.electronAPI.terminal.setActive(workspacePath, currentActive);
      }
    } catch (error: unknown) {
      console.error('[TerminalBottomPanel] Failed to close terminal:', error);
    }
  }, [workspacePath]);

  // Helper to delete multiple terminals in parallel
  const deleteTerminals = useCallback(async (terminalIds: string[]): Promise<void> => {
    // Optimistically remove all from atom state first
    for (const id of terminalIds) {
      removeTerminalFromList(id);
    }

    // Then delete from backend in parallel
    await Promise.all(
      terminalIds.map(id =>
        window.electronAPI.terminal.delete(workspacePath, id).catch((err: unknown) => {
          console.error(`[TerminalBottomPanel] Failed to delete terminal ${id}:`, err);
        })
      )
    );
  }, [workspacePath]);

  // Close all terminals except the specified one
  const handleCloseOthers = useCallback(async (terminalId: string) => {
    try {
      const terminalIds = terminals.filter(t => t.id !== terminalId).map(t => t.id);
      await deleteTerminals(terminalIds);

      setActiveTerminal(terminalId);
      await window.electronAPI.terminal.setActive(workspacePath, terminalId);
    } catch (error: unknown) {
      console.error('[TerminalBottomPanel] Failed to close other terminals:', error);
    }
  }, [workspacePath, terminals, deleteTerminals]);

  // Close all terminals
  const handleCloseAll = useCallback(async () => {
    try {
      const terminalIds = terminals.map(t => t.id);
      await deleteTerminals(terminalIds);

      setActiveTerminal(undefined);
      await window.electronAPI.terminal.setActive(workspacePath, undefined);
    } catch (error: unknown) {
      console.error('[TerminalBottomPanel] Failed to close all terminals:', error);
    }
  }, [workspacePath, terminals, deleteTerminals]);

  // Close terminals to the right of the specified one
  const handleCloseToRight = useCallback(async (terminalId: string) => {
    try {
      const terminalIndex = terminals.findIndex(t => t.id === terminalId);
      if (terminalIndex === -1) return;

      const terminalIds = terminals.slice(terminalIndex + 1).map(t => t.id);
      await deleteTerminals(terminalIds);

      // If active terminal was to the right, switch to the clicked one
      const activeIndex = terminals.findIndex(t => t.id === activeTerminalId);
      if (activeIndex > terminalIndex) {
        setActiveTerminal(terminalId);
        await window.electronAPI.terminal.setActive(workspacePath, terminalId);
      }
    } catch (error: unknown) {
      console.error('[TerminalBottomPanel] Failed to close terminals to the right:', error);
    }
  }, [workspacePath, terminals, activeTerminalId, deleteTerminals]);

  // Close panel
  const handleClose = useCallback(() => {
    closePanel();
  }, [closePanel]);

  // Resize handling
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartY.current = e.clientY;
    resizeStartHeight.current = height;
  }, [height]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing) return;

    const deltaY = resizeStartY.current - e.clientY;
    const newHeight = Math.min(
      Math.max(resizeStartHeight.current + deltaY, minHeight),
      maxHeight
    );
    store.set(terminalPanelHeightAtom, newHeight);
  }, [isResizing, minHeight, maxHeight]);

  const handleMouseUp = useCallback(() => {
    if (isResizing) {
      setIsResizing(false);
      // Persist height per-workspace
      window.electronAPI.terminal.setPanelHeight(workspacePath, height);
    }
  }, [isResizing, height, workspacePath]);

  // Add/remove resize listeners
  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
    }
    return undefined;
  }, [isResizing, handleMouseMove, handleMouseUp]);

  // Handle terminal exit
  const handleTerminalExit = useCallback((terminalId: string, exitCode: number) => {
    // Update terminal metadata or show indicator
    console.log(`[TerminalBottomPanel] Terminal ${terminalId} exited with code ${exitCode}`);
  }, []);

  return (
    <div
      className="terminal-bottom-panel-container relative shrink-0 flex flex-col border-t-2 border-[var(--nim-border)]"
      style={{ height: visible ? `${height}px` : '0px', display: visible ? 'flex' : 'none' }}
    >
      <div
        className="terminal-bottom-panel-resize-handle absolute top-0 left-0 right-0 h-1 cursor-ns-resize z-10 bg-transparent hover:bg-[var(--nim-primary)]"
        onMouseDown={handleMouseDown}
      />
      <div className="terminal-bottom-panel flex flex-col h-full bg-[var(--nim-bg)] overflow-hidden">
        <div className="terminal-bottom-panel-header flex items-center justify-between h-8 px-1.5 bg-[var(--nim-bg-secondary)] border-b border-[var(--nim-border)] shrink-0">
          <div className="terminal-bottom-panel-tabs flex gap-0.5 items-center overflow-x-auto flex-1 min-w-0 [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:bg-[var(--nim-bg-tertiary)] [&::-webkit-scrollbar-thumb]:rounded-sm">
            {terminals.map((terminal, index) => (
              <TerminalTabWrapper
                key={terminal.id}
                terminal={terminal}
                isActive={activeTerminalId === terminal.id}
                isActiveWorktree={!!activeWorktreeId && terminal.worktreeId === activeWorktreeId}
                terminalIndex={index}
                terminalCount={terminals.length}
                onSelect={() => handleSelectTerminal(terminal.id)}
                onClose={() => handleCloseTerminal(terminal.id)}
                onCloseOthers={() => handleCloseOthers(terminal.id)}
                onCloseAll={handleCloseAll}
                onCloseToRight={() => handleCloseToRight(terminal.id)}
              />
            ))}
            <button
              className="terminal-bottom-panel-new-tab flex items-center justify-center w-6 h-6 p-0 bg-transparent border-none text-[var(--nim-text-muted)] cursor-pointer rounded shrink-0 transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              onClick={handleCreateTerminal}
              title="New Terminal"
            >
              <MaterialSymbol icon="add" size={16} />
            </button>
          </div>
          <button
            className="terminal-bottom-panel-close flex items-center justify-center w-6 h-6 p-0 bg-transparent border-none text-[var(--nim-text-muted)] cursor-pointer rounded ml-2 shrink-0 transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
            onClick={handleClose}
            title="Close panel"
          >
            <MaterialSymbol icon="close" size={18} />
          </button>
        </div>
        <div className="terminal-bottom-panel-content flex-1 overflow-hidden flex flex-col min-h-0">
          {terminals.map((terminal) => (
            <div
              key={terminal.id}
              className="terminal-bottom-panel-terminal flex-1 flex flex-col min-h-0"
              style={{ display: activeTerminalId === terminal.id ? 'flex' : 'none' }}
            >
              <TerminalPanel
                terminalId={terminal.id}
                workspacePath={workspacePath}
                isActive={activeTerminalId === terminal.id}
                panelVisible={visible}
                onExit={(exitCode) => handleTerminalExit(terminal.id, exitCode)}
              />
            </div>
          ))}
          {terminals.length === 0 && (
            <div className="terminal-bottom-panel-empty flex-1 flex flex-col items-center justify-center gap-3 text-[var(--nim-text-muted)] text-sm">
              <p>No terminals open</p>
              <button
                className="flex items-center gap-1.5 px-4 py-2 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] text-[13px] cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-tertiary)] hover:border-[var(--nim-primary)]"
                onClick={handleCreateTerminal}
              >
                <MaterialSymbol icon="terminal" size={16} />
                New Terminal
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TerminalBottomPanel;
