import React, { useState, useEffect, useCallback } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

interface ArchiveTask {
  worktreeId: string;
  worktreeName: string;
  status: 'queued' | 'pending' | 'removing-worktree' | 'completed' | 'failed';
  startTime: Date;
  error?: string;
}

interface ArchiveProgressProps {
  /** Called when a worktree is fully archived (for refreshing the list) */
  onWorktreeArchived?: (worktreeId: string) => void;
}

/**
 * Displays archive progress at the bottom of the session history sidebar.
 * Shows queued, in-progress, completed, and failed archive tasks.
 * Collapsed by default to save space, expandable to see details.
 * Auto-hides when there are no tasks.
 */
export const ArchiveProgress: React.FC<ArchiveProgressProps> = ({ onWorktreeArchived }) => {
  const [tasks, setTasks] = useState<ArchiveTask[]>([]);
  const [notifiedWorktrees, setNotifiedWorktrees] = useState<Set<string>>(new Set());
  const [isExpanded, setIsExpanded] = useState(false);

  // Load initial tasks and subscribe to progress updates
  useEffect(() => {
    // Guard against archive API not being available (e.g., during hot reload before preload rebuilds)
    if (!window.electronAPI?.archive) {
      return;
    }

    // Get initial tasks
    window.electronAPI.archive.getTasks().then((result: { success: boolean; tasks: ArchiveTask[] }) => {
      if (result.success) {
        setTasks(result.tasks);
      }
    });

    // Subscribe to progress updates
    const unsubscribe = window.electronAPI.archive.onProgress((newTasks: ArchiveTask[]) => {
      setTasks(newTasks);

      // Notify parent when tasks complete (only once per worktree)
      if (onWorktreeArchived) {
        newTasks.forEach((task) => {
          if (task.status === 'completed' && !notifiedWorktrees.has(task.worktreeId)) {
            setNotifiedWorktrees((prev) => new Set(prev).add(task.worktreeId));
            onWorktreeArchived(task.worktreeId);
          }
        });
      }
    });

    return () => {
      unsubscribe();
    };
  }, [onWorktreeArchived, notifiedWorktrees]);

  const handleToggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  // Don't render anything if there are no tasks
  if (tasks.length === 0) {
    return null;
  }

  const getStatusIcon = (status: ArchiveTask['status']) => {
    switch (status) {
      case 'queued':
        return (
          <MaterialSymbol
            icon="schedule"
            className="archive-task-icon archive-task-icon--queued text-lg shrink-0 mt-0.5 text-[var(--nim-text-faint)]"
          />
        );
      case 'pending':
      case 'removing-worktree':
        return (
          <MaterialSymbol
            icon="progress_activity"
            className="archive-task-icon archive-task-icon--active text-lg shrink-0 mt-0.5 text-[var(--nim-primary)] animate-spin"
          />
        );
      case 'completed':
        return (
          <MaterialSymbol
            icon="check_circle"
            className="archive-task-icon archive-task-icon--completed text-lg shrink-0 mt-0.5 text-[var(--nim-success)]"
          />
        );
      case 'failed':
        return (
          <MaterialSymbol
            icon="error"
            className="archive-task-icon archive-task-icon--failed text-lg shrink-0 mt-0.5 text-[var(--nim-error)]"
          />
        );
    }
  };

  const getStatusText = (status: ArchiveTask['status']) => {
    switch (status) {
      case 'queued':
        return 'Queued';
      case 'pending':
        return 'Starting...';
      case 'removing-worktree':
        return 'Removing worktree (this may take a while)...';
      case 'completed':
        return 'Archived';
      case 'failed':
        return 'Failed';
    }
  };

  // Count active tasks (queued, pending, or removing)
  const activeTasks = tasks.filter(
    (t) => t.status === 'queued' || t.status === 'pending' || t.status === 'removing-worktree'
  );
  const activeCount = activeTasks.length;

  return (
    <div className="archive-progress shrink-0 border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
      <button
        className="archive-progress-header flex items-center gap-2 px-3 py-2.5 text-[13px] font-medium text-[var(--nim-text)] bg-transparent border-none w-full cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-tertiary)]"
        onClick={handleToggleExpand}
      >
        <MaterialSymbol
          icon="archive"
          className="archive-progress-header-icon text-lg text-[var(--nim-text-muted)] shrink-0"
        />
        <span className="archive-progress-header-text flex-1 text-left">Archive Tasks</span>
        {activeCount > 0 && (
          <span className="archive-progress-header-count text-[13px] font-medium text-[var(--nim-primary)]">
            {activeCount} active
          </span>
        )}
        <MaterialSymbol
          icon="expand_more"
          className={`archive-progress-header-chevron text-lg text-[var(--nim-text-muted)] shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
        />
      </button>
      {isExpanded && (
        <div className="archive-progress-content flex flex-col">
          {activeTasks.length > 0 && (
            <div className="archive-progress-warning flex items-start gap-2 px-3 py-2 bg-[rgba(251,191,36,0.1)] border-l-[3px] border-l-[var(--nim-warning)] mx-2 mb-2">
              <MaterialSymbol
                icon="warning"
                className="archive-progress-warning-icon text-base text-[var(--nim-warning)] shrink-0 mt-px"
              />
              <span className="archive-progress-warning-text text-[11px] italic text-[var(--nim-text-muted)] leading-[1.4]">
                Worktree removal can take several minutes for large repositories
              </span>
            </div>
          )}
          <div className="archive-progress-tasks flex flex-col px-2 pb-2 gap-1.5">
            {tasks.map((task) => (
              <div
                key={task.worktreeId}
                className={`archive-task flex items-start gap-2.5 px-3 py-2.5 bg-[var(--nim-bg)] rounded border border-[var(--nim-border)] ${task.status === 'completed' ? 'opacity-60' : ''}`}
              >
                {getStatusIcon(task.status)}
                <div className="archive-task-content flex-1 min-w-0 flex flex-col gap-1">
                  <div className="archive-task-name text-[13px] font-medium text-[var(--nim-text)] overflow-hidden text-ellipsis whitespace-nowrap">
                    {task.worktreeName}
                  </div>
                  <div className="archive-task-path text-[11px] text-[var(--nim-text-faint)] font-[var(--nim-font-mono)] overflow-hidden text-ellipsis whitespace-nowrap">
                    {task.worktreeId}
                  </div>
                  <div
                    className={`archive-task-status text-xs mt-0.5 ${task.status === 'failed' ? 'text-[var(--nim-error)]' : 'text-[var(--nim-text-muted)]'}`}
                  >
                    {task.error || getStatusText(task.status)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
