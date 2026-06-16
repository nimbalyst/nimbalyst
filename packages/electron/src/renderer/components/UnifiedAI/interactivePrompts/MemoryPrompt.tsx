/**
 * MemoryPrompt - Interactive prompt mode for adding to Claude Code memory
 *
 * When user types '#' as the first character in AIInput (for Claude Code provider),
 * this component takes over to handle saving the text to CLAUDE.md files.
 *
 * Supports:
 * - User Memory: ~/.claude/CLAUDE.md
 * - Project Memory: <workspace>/.claude/CLAUDE.md or CLAUDE.md
 */

import React, { useState, useCallback } from 'react';
import { errorNotificationService } from '../../../services/ErrorNotificationService';

export type MemoryTarget = 'user' | 'project';

interface MemoryPromptProps {
  /** The text content to save (without the # prefix) */
  content: string;
  /** Current memory target */
  target: MemoryTarget;
  /** Callback when target changes */
  onTargetChange: (target: MemoryTarget) => void;
  /** Callback when user confirms save */
  onSave: (content: string, target: MemoryTarget) => void;
  /** Callback when user cancels memory mode */
  onCancel: () => void;
  /** Whether save is in progress */
  isSaving?: boolean;
  /** Workspace path for project memory */
  workspacePath?: string;
}

/**
 * Memory mode indicator and controls
 * Displays current target and provides keyboard navigation hints
 */
export function MemoryPromptIndicator({
  target,
  onTargetChange,
  isSaving,
  workspacePath,
}: Pick<MemoryPromptProps, 'target' | 'onTargetChange' | 'isSaving' | 'workspacePath'>) {
  const toggleTarget = useCallback(() => {
    onTargetChange(target === 'user' ? 'project' : 'user');
  }, [target, onTargetChange]);

  const openMemoryFile = useCallback(async () => {
    if (!workspacePath && target === 'project') return;
    try {
      const { filePath } = await window.electronAPI.invoke('memory:get-path', { target, workspacePath });
      if (filePath) {
        await window.electronAPI.invoke('workspace:open-file', { workspacePath, filePath });
      }
    } catch {
      // File may not exist yet
    }
  }, [target, workspacePath]);

  return (
    <div className="memory-prompt-indicator flex items-center justify-between gap-2 px-2.5 py-1.5 mb-2 rounded-md border border-[var(--nim-primary)] bg-[var(--nim-bg-secondary)]">
      <div className="memory-prompt-left flex items-center gap-2">
        <div className="memory-prompt-icon flex items-center justify-center text-[var(--nim-primary)]">
          <MemoryIcon />
        </div>
        <span className="memory-prompt-label text-xs text-[var(--nim-text-muted)]">
          {isSaving ? 'Saving...' : 'Adding to memory'}
        </span>
        <button
          className="memory-prompt-target-button nim-btn-secondary gap-1 px-2 py-1 text-xs font-medium"
          onClick={toggleTarget}
          disabled={isSaving}
          title="Use arrow keys to switch"
        >
          <span className="memory-target-name text-[var(--nim-primary)]">
            {target === 'user' ? 'User Memory' : 'Project Memory'}
          </span>
          <span className="memory-target-hint flex items-center text-[var(--nim-text-faint)]">
            <ArrowsIcon />
          </span>
        </button>
        <button
          className="memory-prompt-open-button flex items-center justify-center p-1 rounded text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-tertiary)] transition-colors"
          onClick={openMemoryFile}
          title="Open memory file in editor"
          aria-label="Open memory file"
        >
          <OpenFileIcon />
        </button>
      </div>
      <div className="memory-prompt-shortcuts flex items-center gap-1 text-[11px] text-[var(--nim-text-faint)]">
        <kbd className="inline-block px-1.5 py-0.5 font-inherit text-[10px] bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] rounded">Enter</kbd> to save
        <span className="memory-shortcut-separator mx-1 text-[var(--nim-text-faint)]">&middot;</span>
        <kbd className="inline-block px-1.5 py-0.5 font-inherit text-[10px] bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] rounded">&uarr;</kbd><kbd className="inline-block px-1.5 py-0.5 font-inherit text-[10px] bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] rounded">&darr;</kbd> to switch target
        <span className="memory-shortcut-separator mx-1 text-[var(--nim-text-faint)]">&middot;</span>
        <kbd className="inline-block px-1.5 py-0.5 font-inherit text-[10px] bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] rounded">Esc</kbd> to cancel
      </div>
    </div>
  );
}

/**
 * Memory save button - replaces the normal send button when in memory mode
 */
export function MemorySaveButton({
  onSave,
  disabled,
  isSaving,
}: {
  onSave: () => void;
  disabled: boolean;
  isSaving?: boolean;
}) {
  return (
    <button
      className="memory-save-button flex items-center justify-center w-9 h-9 p-0 rounded-md border-none cursor-pointer text-white shrink-0 transition-all duration-150 bg-[var(--nim-primary)] hover:enabled:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
      onClick={onSave}
      disabled={disabled || isSaving}
      title="Save to memory (Enter)"
      aria-label="Save to memory"
    >
      {isSaving ? (
        <SpinnerIcon />
      ) : (
        <SaveIcon />
      )}
    </button>
  );
}

/**
 * Hook to manage memory mode state
 */
export function useMemoryMode(workspacePath?: string) {
  const [isMemoryMode, setIsMemoryMode] = useState(false);
  const [memoryTarget, setMemoryTarget] = useState<MemoryTarget>('user');
  const [isSaving, setIsSaving] = useState(false);

  const enterMemoryMode = useCallback(() => {
    setIsMemoryMode(true);
  }, []);

  const exitMemoryMode = useCallback(() => {
    setIsMemoryMode(false);
    setMemoryTarget('user');
  }, []);

  const toggleMemoryTarget = useCallback(() => {
    setMemoryTarget(prev => prev === 'user' ? 'project' : 'user');
  }, []);

  const saveToMemory = useCallback(async (content: string): Promise<boolean> => {
    if (!content.trim()) {
      return false;
    }

    setIsSaving(true);
    try {
      const result = await window.electronAPI.invoke('memory:append', {
        content: content.trim(),
        target: memoryTarget,
        workspacePath,
      });

      if (result.success) {
        const targetLabel = memoryTarget === 'user' ? 'User Memory' : 'Project Memory';
        errorNotificationService.showInfo(
          'Memory Updated',
          `Added to ${targetLabel}`,
          { duration: 2000 }
        );
        exitMemoryMode();
        return true;
      } else {
        errorNotificationService.showError(
          'Failed to Save Memory',
          result.error || 'Unknown error'
        );
        return false;
      }
    } catch (error) {
      errorNotificationService.showError(
        'Failed to Save Memory',
        error instanceof Error ? error.message : 'Unknown error'
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [memoryTarget, workspacePath, exitMemoryMode]);

  return {
    isMemoryMode,
    memoryTarget,
    isSaving,
    enterMemoryMode,
    exitMemoryMode,
    toggleMemoryTarget,
    setMemoryTarget,
    saveToMemory,
  };
}

/**
 * Check if input should activate memory mode
 * Memory mode activates when the first character is '#' (Claude Code providers
 * only). The widget writes CLAUDE.md directly, so it works identically for the
 * SDK and the terminal CLI (NIM-819).
 */
const MEMORY_MODE_PROVIDERS = new Set(['claude-code', 'claude-code-cli']);

export function shouldActivateMemoryMode(value: string, provider?: string): boolean {
  return !!provider && MEMORY_MODE_PROVIDERS.has(provider) && value.trimStart().startsWith('#');
}

/**
 * Get the content without the '#' prefix
 */
export function getMemoryContent(value: string): string {
  const trimmed = value.trimStart();
  if (trimmed.startsWith('#')) {
    // Remove the '#' and any following space
    return trimmed.slice(1).trimStart();
  }
  return value;
}

// Icons

function MemoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M8 2C5.239 2 3 4.239 3 7C3 8.126 3.372 9.164 4 10C4 10 4.5 10.5 4.5 12H11.5C11.5 10.5 12 10 12 10C12.628 9.164 13 8.126 13 7C13 4.239 10.761 2 8 2Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M6 14H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M8 5V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M6.5 6.5L8 8L9.5 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function OpenFileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 2H3.5C2.672 2 2 2.672 2 3.5V12.5C2 13.328 2.672 14 3.5 14H12.5C13.328 14 14 13.328 14 12.5V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M12 2L14 2L14 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M14 2L8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}

function ArrowsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 2L6 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M3 4L6 2L9 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M3 8L6 10L9 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12.667 14H3.333C2.597 14 2 13.403 2 12.667V3.333C2 2.597 2.597 2 3.333 2H10.667L14 5.333V12.667C14 13.403 13.403 14 12.667 14Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11 14V9H5V14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M5 2V5H9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="memory-spinner animate-spin">
      <path
        d="M8 2V4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.3"
      />
      <path
        d="M8 12V14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.3"
      />
      <path
        d="M3.76 3.76L5.17 5.17"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.5"
      />
      <path
        d="M10.83 10.83L12.24 12.24"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.5"
      />
      <path
        d="M2 8H4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M12 8H14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M3.76 12.24L5.17 10.83"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.9"
      />
      <path
        d="M10.83 5.17L12.24 3.76"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
