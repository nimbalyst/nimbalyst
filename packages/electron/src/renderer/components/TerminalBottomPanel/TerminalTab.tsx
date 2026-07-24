/**
 * TerminalTab - Tab component for terminal instances in the bottom panel
 */

import React, { useState, useEffect } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { TerminalTabContextMenu } from './TerminalTabContextMenu';

interface TerminalInstance {
  id: string;
  title: string;
  shellName: string;
  shellPath: string;
  cwd: string;
  worktreeId?: string;
  worktreeName?: string;
  createdAt: number;
  lastActiveAt: number;
  historyFile?: string;
}

interface TerminalTabProps {
  terminal: TerminalInstance;
  isActive: boolean;
  isActiveWorktree?: boolean;
  terminalIndex: number;
  terminalCount: number;
  isCommandRunning?: boolean;
  onSelect: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onCloseToRight: () => void;
}

export const TerminalTab: React.FC<TerminalTabProps> = ({
  terminal,
  isActive,
  isActiveWorktree,
  terminalIndex,
  terminalCount,
  isCommandRunning,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onCloseToRight,
}) => {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isFocusFlashing, setIsFocusFlashing] = useState(false);

  // Listen for terminal:focused event to trigger flash animation
  useEffect(() => {
    const handleTerminalFocused = (event: Event) => {
      const customEvent = event as CustomEvent<{ terminalId: string }>;
      if (customEvent.detail?.terminalId === terminal.id) {
        setIsFocusFlashing(true);
        // Remove flash after animation completes
        setTimeout(() => setIsFocusFlashing(false), 400);
      }
    };

    window.addEventListener('terminal:focused', handleTerminalFocused);
    return () => {
      window.removeEventListener('terminal:focused', handleTerminalFocused);
    };
  }, [terminal.id]);
  // Get shell icon based on shell name
  const getShellIcon = (shellName: string): string => {
    const name = shellName.toLowerCase();
    if (name.includes('zsh')) return 'terminal';
    if (name.includes('bash')) return 'terminal';
    if (name.includes('fish')) return 'terminal';
    if (name.includes('powershell') || name.includes('pwsh')) return 'terminal';
    return 'terminal';
  };

  // Get abbreviated CWD for display
  const getAbbreviatedCwd = (cwd: string): string => {
    const parts = cwd.split('/');
    if (parts.length <= 2) return cwd;
    return `.../${parts.slice(-2).join('/')}`;
  };

  // Get the display name for the tab
  // For worktree terminals, show the worktree name
  // For regular terminals, show the generic title
  const getDisplayName = (): string => {
    if (terminal.worktreeId && terminal.worktreeName) {
      return terminal.worktreeName;
    }
    return terminal.title;
  };

  const handleCloseClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  // Compute class names for the tab
  // - isActive: the terminal tab that is currently selected
  // - isActiveWorktree: the terminal belongs to the worktree currently being viewed
  // - isFocusFlashing: brief animation when terminal is focused via worktree button
  const baseClasses = 'terminal-tab group flex items-center gap-1 px-2 py-1 border-none text-xs cursor-pointer rounded whitespace-nowrap max-w-[200px] transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]';
  const activeClasses = isActive
    ? 'active bg-[var(--nim-bg)] text-[var(--nim-text)] font-medium'
    : 'bg-transparent text-[var(--nim-text-muted)]';
  const flashClasses = isFocusFlashing ? 'animate-focus-flash' : '';

  return (
    <>
      <div
        className={`${baseClasses} ${activeClasses} ${flashClasses}`}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        role="tab"
        tabIndex={0}
        aria-selected={isActive}
        title={`${terminal.title}\n${terminal.cwd}\nShell: ${terminal.shellName}${isActiveWorktree ? '\n(Current worktree)' : ''}`}
      >
      {terminal.worktreeId ? (
        <MaterialSymbol
          icon="alt_route"
          size={14}
          title={isActiveWorktree ? 'Current worktree terminal' : 'Worktree terminal'}
          className={isActiveWorktree ? 'text-[var(--nim-primary)]' : undefined}
        />
      ) : (
        <MaterialSymbol icon={getShellIcon(terminal.shellName)} size={14} />
      )}
      {isCommandRunning && (
        <div
          className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse shrink-0"
          title="Command running"
        />
      )}
      <span className="terminal-tab-title overflow-hidden text-ellipsis shrink min-w-0">{getDisplayName()}</span>
      {!terminal.worktreeId && (
        <span className={`terminal-tab-cwd text-[10px] overflow-hidden text-ellipsis shrink min-w-0 ${isActive ? 'text-[var(--nim-text-muted)]' : 'text-[var(--nim-text-faint)]'}`}>{getAbbreviatedCwd(terminal.cwd)}</span>
      )}
      <button
        className="terminal-tab-close hidden group-hover:flex items-center justify-center w-4 h-4 p-0 bg-transparent border-none text-[var(--nim-text-faint)] cursor-pointer rounded-sm shrink-0 ml-0.5 transition-colors duration-150 hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]"
        onClick={handleCloseClick}
        title="Close terminal"
      >
        <MaterialSymbol icon="close" size={12} />
      </button>
    </div>

      {contextMenu && (
        <TerminalTabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          terminalId={terminal.id}
          terminalCount={terminalCount}
          terminalIndex={terminalIndex}
          onClose={() => setContextMenu(null)}
          onCloseTab={onClose}
          onCloseOthers={onCloseOthers}
          onCloseAll={onCloseAll}
          onCloseToRight={onCloseToRight}
        />
      )}
    </>
  );
};
