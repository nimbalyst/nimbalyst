import React, { useMemo } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useFloatingMenu, FloatingPortal, virtualElement } from '../hooks/useFloatingMenu';

export type FileTreeFilter = 'all' | 'markdown' | 'known' | 'git-uncommitted' | 'git-worktree' | 'ai-read' | 'ai-written';

interface FileTreeFilterMenuProps {
  x: number;
  y: number;
  currentFilter: FileTreeFilter;
  showIcons: boolean;
  showGitStatus: boolean;
  enableAutoScroll: boolean;
  onFilterChange: (filter: FileTreeFilter) => void;
  onShowIconsChange: (showIcons: boolean) => void;
  onShowGitStatusChange: (showGitStatus: boolean) => void;
  onEnableAutoScrollChange: (enableAutoScroll: boolean) => void;
  hasActiveClaudeSession: boolean;
  claudeSessionFileCounts: { read: number; written: number };
  isGitRepo: boolean;
  gitUncommittedCount: number;
  isGitWorktree: boolean;
  gitWorktreeCount: number;
  onClose: () => void;
}

export function FileTreeFilterMenu({
  x,
  y,
  currentFilter,
  showIcons,
  showGitStatus,
  enableAutoScroll,
  onFilterChange,
  onShowIconsChange,
  onShowGitStatusChange,
  onEnableAutoScrollChange,
  hasActiveClaudeSession,
  claudeSessionFileCounts,
  isGitRepo,
  gitUncommittedCount,
  isGitWorktree,
  gitWorktreeCount,
  onClose
}: FileTreeFilterMenuProps) {
  const reference = useMemo(() => virtualElement(x, y), [x, y]);
  const menu = useFloatingMenu({
    placement: 'right-start',
    reference,
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
  });

  const handleFilterSelect = (filter: FileTreeFilter, disabled?: boolean) => {
    if (disabled) {
      return;
    }
    onFilterChange(filter);
    onClose();
  };

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="file-tree-filter-menu min-w-[200px] p-1 rounded-md text-[13px] z-[10000] backdrop-blur-[10px] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
      >
        <div className="filter-menu-section-label nim-section-label px-3 pt-2 pb-1">Show Files</div>

        <div
          className={`filter-menu-item flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer relative transition-colors text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] ${currentFilter === 'all' ? 'active bg-[var(--nim-bg-selected)]' : ''}`}
          onClick={() => handleFilterSelect('all')}
        >
          <MaterialSymbol icon="folder_open" size={18} />
          <span>All Files</span>
          {currentFilter === 'all' && (
            <MaterialSymbol icon="check" size={16} className="filter-menu-check ml-auto text-[var(--nim-primary)]" />
          )}
        </div>

        <div
          className={`filter-menu-item flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer relative transition-colors text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] ${currentFilter === 'markdown' ? 'active bg-[var(--nim-bg-selected)]' : ''}`}
          onClick={() => handleFilterSelect('markdown')}
        >
          <MaterialSymbol icon="description" size={18} />
          <span>Markdown Only</span>
          {currentFilter === 'markdown' && (
            <MaterialSymbol icon="check" size={16} className="filter-menu-check ml-auto text-[var(--nim-primary)]" />
          )}
        </div>

        <div
          className={`filter-menu-item flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer relative transition-colors text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] ${currentFilter === 'known' ? 'active bg-[var(--nim-bg-selected)]' : ''}`}
          onClick={() => handleFilterSelect('known')}
        >
          <MaterialSymbol icon="filter_list" size={18} />
          <span>Known Files</span>
          {currentFilter === 'known' && (
            <MaterialSymbol icon="check" size={16} className="filter-menu-check ml-auto text-[var(--nim-primary)]" />
          )}
        </div>

        <div className="filter-menu-section-label nim-section-label px-3 pt-2 pb-1">Git</div>

        <div
          className={`filter-menu-item flex items-center gap-2.5 px-3 py-2 rounded relative transition-colors text-[var(--nim-text)] ${!isGitRepo ? 'disabled opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--nim-bg-hover)]'} ${currentFilter === 'git-uncommitted' ? 'active bg-[var(--nim-bg-selected)]' : ''}`}
          onClick={() => handleFilterSelect('git-uncommitted', !isGitRepo)}
        >
          <MaterialSymbol icon="difference" size={18} />
          <span>Uncommitted Changes</span>
          {gitUncommittedCount > 0 && (
            <span className="filter-menu-pill ml-auto rounded-full px-2 text-[11px] font-semibold leading-[18px] bg-[var(--nim-accent-subtle)] text-[var(--nim-primary)]">{gitUncommittedCount}</span>
          )}
          {currentFilter === 'git-uncommitted' && (
            <MaterialSymbol icon="check" size={16} className={`filter-menu-check text-[var(--nim-primary)] ${gitUncommittedCount > 0 ? 'ml-2' : 'ml-auto'}`} />
          )}
        </div>

        {isGitWorktree && (
          <div
            className={`filter-menu-item flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer relative transition-colors text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] ${currentFilter === 'git-worktree' ? 'active bg-[var(--nim-bg-selected)]' : ''}`}
            onClick={() => handleFilterSelect('git-worktree')}
          >
            <MaterialSymbol icon="account_tree" size={18} />
            <span>Worktree Changes</span>
            {gitWorktreeCount > 0 && (
              <span className="filter-menu-pill ml-auto rounded-full px-2 text-[11px] font-semibold leading-[18px] bg-[var(--nim-accent-subtle)] text-[var(--nim-primary)]">{gitWorktreeCount}</span>
            )}
            {currentFilter === 'git-worktree' && (
              <MaterialSymbol icon="check" size={16} className={`filter-menu-check text-[var(--nim-primary)] ${gitWorktreeCount > 0 ? 'ml-2' : 'ml-auto'}`} />
            )}
          </div>
        )}

        {!isGitRepo && (
          <div className="filter-menu-hint text-[11px] text-[var(--nim-text-faint)] px-3 pb-1.5">
            Not a git repository.
          </div>
        )}

        <div className="filter-menu-section-label nim-section-label px-3 pt-2 pb-1">Claude Agent Session</div>

        <div
          className={`filter-menu-item flex items-center gap-2.5 px-3 py-2 rounded relative transition-colors text-[var(--nim-text)] ${!hasActiveClaudeSession ? 'disabled opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--nim-bg-hover)]'} ${currentFilter === 'ai-read' ? 'active bg-[var(--nim-bg-selected)]' : ''}`}
          onClick={() => handleFilterSelect('ai-read', !hasActiveClaudeSession)}
        >
          <MaterialSymbol icon="visibility" size={18} />
          <span>Files Read</span>
          {claudeSessionFileCounts.read > 0 && (
            <span className="filter-menu-pill ml-auto rounded-full px-2 text-[11px] font-semibold leading-[18px] bg-[var(--nim-accent-subtle)] text-[var(--nim-primary)]">{claudeSessionFileCounts.read}</span>
          )}
          {currentFilter === 'ai-read' && (
            <MaterialSymbol icon="check" size={16} className={`filter-menu-check text-[var(--nim-primary)] ${claudeSessionFileCounts.read > 0 ? 'ml-2' : 'ml-auto'}`} />
          )}
        </div>

        <div
          className={`filter-menu-item flex items-center gap-2.5 px-3 py-2 rounded relative transition-colors text-[var(--nim-text)] ${!hasActiveClaudeSession ? 'disabled opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--nim-bg-hover)]'} ${currentFilter === 'ai-written' ? 'active bg-[var(--nim-bg-selected)]' : ''}`}
          onClick={() => handleFilterSelect('ai-written', !hasActiveClaudeSession)}
        >
          <MaterialSymbol icon="edit_note" size={18} />
          <span>Files Written</span>
          {claudeSessionFileCounts.written > 0 && (
            <span className="filter-menu-pill ml-auto rounded-full px-2 text-[11px] font-semibold leading-[18px] bg-[var(--nim-accent-subtle)] text-[var(--nim-primary)]">{claudeSessionFileCounts.written}</span>
          )}
          {currentFilter === 'ai-written' && (
            <MaterialSymbol icon="check" size={16} className={`filter-menu-check text-[var(--nim-primary)] ${claudeSessionFileCounts.written > 0 ? 'ml-2' : 'ml-auto'}`} />
          )}
        </div>

        {!hasActiveClaudeSession && (
          <div className="filter-menu-hint text-[11px] text-[var(--nim-text-faint)] px-3 pb-1.5">
            Open a Claude Agent session to enable these filters.
          </div>
        )}

        <div className="filter-menu-separator h-px mx-2 my-1 bg-[var(--nim-border)]" />

        <div
          className="filter-menu-item flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer relative transition-colors text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
          onClick={() => onShowIconsChange(!showIcons)}
        >
          <MaterialSymbol icon={showIcons ? 'check_box' : 'check_box_outline_blank'} size={18} />
          <span>Show Icons</span>
        </div>

        <div
          className="filter-menu-item flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer relative transition-colors text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
          onClick={() => onShowGitStatusChange(!showGitStatus)}
        >
          <MaterialSymbol icon={showGitStatus ? 'check_box' : 'check_box_outline_blank'} size={18} />
          <span>Show Git Status</span>
        </div>

        <div
          className="filter-menu-item flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer relative transition-colors text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
          onClick={() => onEnableAutoScrollChange(!enableAutoScroll)}
        >
          <MaterialSymbol icon={enableAutoScroll ? 'check_box' : 'check_box_outline_blank'} size={18} />
          <span>Auto-Scroll to Active File</span>
        </div>
      </div>
    </FloatingPortal>
  );
}
