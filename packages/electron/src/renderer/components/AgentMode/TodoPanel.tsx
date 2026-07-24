/**
 * TodoPanel - Collapsible panel showing the agent's current task list.
 *
 * Displays todos from the active session's metadata (currentTodos).
 * Shows task progress with status indicators (pending, in progress, completed).
 * Collapse state is persisted at the project level.
 */

import React, { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { sessionStoreAtom } from '../../store';
import { todoPanelCollapsedAtom, toggleTodoPanelCollapsedAtom } from '../../store/atoms/agentMode';

export interface Todo {
  status: 'pending' | 'in_progress' | 'completed';
  content: string;
  activeForm: string;
}

interface TodoPanelProps {
  /** The session ID to get todos from */
  sessionId: string;
}

export const TodoPanel: React.FC<TodoPanelProps> = React.memo(({
  sessionId,
}) => {
  const isCollapsed = useAtomValue(todoPanelCollapsedAtom);
  const toggleCollapsed = useSetAtom(toggleTodoPanelCollapsedAtom);
  const sessionData = useAtomValue(sessionStoreAtom(sessionId));

  // Must call all hooks before any early return
  const handleToggle = useCallback(() => {
    toggleCollapsed();
  }, [toggleCollapsed]);

  // Extract todos from session metadata
  const rawTodos = sessionData?.metadata?.currentTodos;
  const todos: Todo[] = Array.isArray(rawTodos) ? rawTodos : [];

  // Don't render if no todos
  if (todos.length === 0) {
    return null;
  }

  const completedCount = todos.filter(t => t.status === 'completed').length;
  const totalCount = todos.length;

  return (
    <div className="todo-panel border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
      {/* Header */}
      <button
        className="todo-panel-header w-full flex items-center gap-2 px-3 py-2 bg-transparent border-none cursor-pointer text-left hover:bg-[var(--nim-bg-hover)]"
        onClick={handleToggle}
      >
        <MaterialSymbol
          icon={isCollapsed ? 'chevron_right' : 'expand_more'}
          size={16}
          className="text-[var(--nim-text-muted)] shrink-0"
        />
        <MaterialSymbol
          icon="checklist"
          size={16}
          className="text-[var(--nim-text-muted)] shrink-0"
        />
        <span className="todo-panel-title text-xs font-medium text-[var(--nim-text)]">
          Tasks
        </span>
        <span className="todo-panel-count ml-auto text-[11px] text-[var(--nim-text-muted)] font-mono">
          {completedCount}/{totalCount}
        </span>
      </button>

      {/* Content */}
      {!isCollapsed && (
        <div className="todo-panel-content px-3 pb-2 max-h-[200px] overflow-y-auto">
          <div className="flex flex-col gap-1">
            {todos.map((todo, index) => (
              <TodoItem key={index} todo={todo} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

TodoPanel.displayName = 'TodoPanel';

interface TodoItemProps {
  todo: Todo;
}

const TodoItem: React.FC<TodoItemProps> = React.memo(({ todo }) => {
  const displayText = todo.status === 'in_progress' ? todo.activeForm : todo.content;

  return (
    <div
      className={`todo-item flex items-start gap-2 py-1 px-1 rounded text-xs ${
        todo.status === 'in_progress' ? 'bg-[var(--nim-bg-hover)]' : ''
      } ${todo.status === 'completed' ? 'opacity-60' : ''}`}
      data-status={todo.status}
    >
      <div className="todo-item-icon shrink-0 w-4 h-4 flex items-center justify-center mt-0.5">
        {todo.status === 'pending' && (
          <span className="text-[var(--nim-text-faint)] text-[10px]">○</span>
        )}
        {todo.status === 'in_progress' && (
          <span className="inline-block w-3 h-3 border-2 border-[var(--nim-bg-tertiary)] border-t-[var(--nim-primary)] rounded-full animate-spin" />
        )}
        {todo.status === 'completed' && (
          <span className="text-[#4ade80] text-[10px]">●</span>
        )}
      </div>
      <div
        className={`todo-item-text flex-1 leading-[1.4] break-words ${
          todo.status === 'completed'
            ? 'line-through text-[var(--nim-text-muted)]'
            : 'text-[var(--nim-text)]'
        }`}
      >
        {displayText}
      </div>
    </div>
  );
});

TodoItem.displayName = 'TodoItem';
