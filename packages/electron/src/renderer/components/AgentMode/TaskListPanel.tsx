/**
 * TaskListPanel - Collapsible panel showing the agent's SDK-native task list.
 *
 * Displays the shared, dependency-aware task queue (TaskCreate/TaskUpdate tools)
 * from the active session's metadata (currentTaskList). This is distinct from
 * the TodoPanel (TodoWrite flat checklist) and the TeammatePanel (sub-agent
 * telemetry) — tasks here can have owners and blocked-by dependencies.
 * Collapse state is persisted at the project level.
 */

import React, { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  sessionTaskListAtom,
  taskListPanelCollapsedAtom,
  toggleTaskListPanelCollapsedAtom,
  type TaskListItem,
} from '../../store/atoms/agentMode';

interface TaskListPanelProps {
  /** The session ID to get tasks from */
  sessionId: string;
}

export const TaskListPanel: React.FC<TaskListPanelProps> = React.memo(({
  sessionId,
}) => {
  const isCollapsed = useAtomValue(taskListPanelCollapsedAtom);
  const toggleCollapsed = useSetAtom(toggleTaskListPanelCollapsedAtom);
  const tasks = useAtomValue(sessionTaskListAtom(sessionId));

  const handleToggle = useCallback(() => {
    toggleCollapsed();
  }, [toggleCollapsed]);

  // Don't render if no tasks
  if (tasks.length === 0) {
    return null;
  }

  const completedCount = tasks.filter(t => t.status === 'completed').length;
  const totalCount = tasks.length;

  // Tasks blocked by an unresolved dependency can't be started yet.
  const openIds = new Set(tasks.filter(t => t.status !== 'completed').map(t => t.id));

  return (
    <div className="task-list-panel border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
      {/* Header */}
      <button
        className="task-list-panel-header w-full flex items-center gap-2 px-3 py-2 bg-transparent border-none cursor-pointer text-left hover:bg-[var(--nim-bg-hover)]"
        onClick={handleToggle}
      >
        <MaterialSymbol
          icon={isCollapsed ? 'chevron_right' : 'expand_more'}
          size={16}
          className="text-[var(--nim-text-muted)] shrink-0"
        />
        <MaterialSymbol
          icon="task_alt"
          size={16}
          className="text-[var(--nim-text-muted)] shrink-0"
        />
        <span className="task-list-panel-title text-xs font-medium text-[var(--nim-text)]">
          Task List
        </span>
        <span className="task-list-panel-count ml-auto text-[11px] text-[var(--nim-text-muted)] font-mono">
          {completedCount}/{totalCount}
        </span>
      </button>

      {/* Content */}
      {!isCollapsed && (
        <div className="task-list-panel-content px-3 pb-2 max-h-[240px] overflow-y-auto">
          <div className="flex flex-col gap-1">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} openIds={openIds} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

TaskListPanel.displayName = 'TaskListPanel';

interface TaskRowProps {
  task: TaskListItem;
  openIds: Set<string>;
}

const TaskRow: React.FC<TaskRowProps> = React.memo(({ task, openIds }) => {
  const displayText = task.status === 'in_progress' && task.activeForm
    ? task.activeForm
    : task.subject;

  const blockedBy = (task.blockedBy ?? []).filter(id => openIds.has(id));
  const isBlocked = task.status !== 'completed' && blockedBy.length > 0;

  return (
    <div
      className={`task-list-item flex items-start gap-2 py-1 px-1 rounded text-xs ${
        task.status === 'in_progress' ? 'bg-[var(--nim-bg-hover)]' : ''
      } ${task.status === 'completed' ? 'opacity-60' : ''}`}
      data-status={task.status}
      data-task-id={task.id}
    >
      <div className="task-list-item-icon shrink-0 w-4 h-4 flex items-center justify-center mt-0.5">
        {task.status === 'pending' && (
          <span className="text-[var(--nim-text-faint)] text-[10px]">○</span>
        )}
        {task.status === 'in_progress' && (
          <span className="inline-block w-3 h-3 border-2 border-[var(--nim-bg-tertiary)] border-t-[var(--nim-primary)] rounded-full animate-spin" />
        )}
        {task.status === 'completed' && (
          <span className="text-[#4ade80] text-[10px]">●</span>
        )}
      </div>
      <div className="task-list-item-body flex-1 min-w-0">
        <div
          className={`task-list-item-text leading-[1.4] break-words ${
            task.status === 'completed'
              ? 'line-through text-[var(--nim-text-muted)]'
              : 'text-[var(--nim-text)]'
          }`}
        >
          {displayText}
        </div>
        {(isBlocked || task.owner) && (
          <div className="task-list-item-meta flex items-center gap-2 mt-0.5 text-[10px] text-[var(--nim-text-muted)]">
            {isBlocked && (
              <span className="task-list-item-blocked inline-flex items-center gap-0.5">
                <MaterialSymbol icon="lock" size={11} className="shrink-0" />
                blocked by {blockedBy.map(id => `#${id}`).join(', ')}
              </span>
            )}
            {task.owner && (
              <span className="task-list-item-owner inline-flex items-center gap-0.5">
                <MaterialSymbol icon="person" size={11} className="shrink-0" />
                {task.owner}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

TaskRow.displayName = 'TaskRow';
