import React from 'react';
import type { TodoItem } from '../types';
import { MaterialSymbol } from '../../icons/MaterialSymbol';

interface TodosSidebarProps {
  todos: TodoItem[];
  onTodoClick?: (todo: TodoItem) => void;
}

export const TodosSidebar: React.FC<TodosSidebarProps> = ({
  todos,
  onTodoClick
}) => {
  const getStatusIcon = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed':
        return (
          <span className="text-nim-success">
            <MaterialSymbol icon="check_circle" size={16} />
          </span>
        );
      case 'in_progress':
        return (
          <span className="text-nim-primary">
            <MaterialSymbol icon="sync" size={16} />
          </span>
        );
      case 'pending':
        return (
          <span className="text-nim-faint">
            <MaterialSymbol icon="schedule" size={16} />
          </span>
        );
    }
  };

  const getStatusColor = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed':
        return { backgroundColor: 'color-mix(in srgb, var(--nim-success) 10%, transparent)', borderColor: 'color-mix(in srgb, var(--nim-success) 30%, transparent)' };
      case 'in_progress':
        return { backgroundColor: 'color-mix(in srgb, var(--nim-primary) 10%, transparent)', borderColor: 'color-mix(in srgb, var(--nim-primary) 30%, transparent)' };
      case 'pending':
        return { backgroundColor: 'color-mix(in srgb, var(--nim-bg-tertiary) 50%, transparent)', borderColor: 'var(--nim-border)' };
    }
  };

  const getStatusLabel = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed':
        return 'Completed';
      case 'in_progress':
        return 'In Progress';
      case 'pending':
        return 'Pending';
    }
  };

  const formatTimeAgo = (timestamp?: string): string => {
    if (!timestamp) return '';
    try {
      const date = new Date(timestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);

      if (diffMins < 1) return 'just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `${diffHours}h ago`;
      const diffDays = Math.floor(diffHours / 24);
      return `${diffDays}d ago`;
    } catch {
      return '';
    }
  };

  // Group todos by status
  const groupedTodos = {
    in_progress: todos.filter(t => t.status === 'in_progress'),
    pending: todos.filter(t => t.status === 'pending'),
    completed: todos.filter(t => t.status === 'completed')
  };

  const completedCount = groupedTodos.completed.length;
  const totalCount = todos.length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div className="flex flex-col h-full bg-surface-secondary border-r border-border-primary">
      <div className="p-4 border-b border-border-primary">
        <h3 className="font-semibold text-text-primary flex items-center gap-2">
          <MaterialSymbol icon="checklist" size={16} />
          Tasks
        </h3>
        <div className="mt-2">
          <div className="flex items-center justify-between text-xs text-text-tertiary mb-1">
            <span>{completedCount} of {totalCount} completed</span>
            <span>{progressPercent}%</span>
          </div>
          <div className="w-full bg-nim-tertiary rounded-full h-1.5">
            <div
              className="bg-nim-success rounded-full h-1.5 transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {todos.length === 0 ? (
          <div className="p-4 text-text-tertiary text-sm text-center">
            No tasks yet
          </div>
        ) : (
          <div className="p-2 space-y-3">
            {/* In Progress */}
            {groupedTodos.in_progress.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-text-secondary uppercase tracking-wider px-2 mb-1">
                  In Progress ({groupedTodos.in_progress.length})
                </div>
                <div className="space-y-1">
                  {groupedTodos.in_progress.map(todo => (
                    <button
                      key={todo.id}
                      onClick={() => onTodoClick?.(todo)}
                      className="w-full text-left p-3 rounded-lg border transition-colors hover:bg-bg-hover"
                      style={getStatusColor(todo.status)}
                    >
                      <div className="flex items-start gap-2">
                        <div className="flex-shrink-0 mt-0.5">
                          {getStatusIcon(todo.status)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-text-primary">
                            {todo.activeForm}
                          </div>
                          {todo.timestamp && (
                            <div className="text-xs text-text-tertiary mt-1">
                              {formatTimeAgo(todo.timestamp)}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Pending */}
            {groupedTodos.pending.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-text-secondary uppercase tracking-wider px-2 mb-1">
                  Pending ({groupedTodos.pending.length})
                </div>
                <div className="space-y-1">
                  {groupedTodos.pending.map(todo => (
                    <button
                      key={todo.id}
                      onClick={() => onTodoClick?.(todo)}
                      className="w-full text-left p-3 rounded-lg border transition-colors hover:bg-bg-hover"
                      style={getStatusColor(todo.status)}
                    >
                      <div className="flex items-start gap-2">
                        <div className="flex-shrink-0 mt-0.5">
                          {getStatusIcon(todo.status)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-text-primary">
                            {todo.content}
                          </div>
                          {todo.timestamp && (
                            <div className="text-xs text-text-tertiary mt-1">
                              {formatTimeAgo(todo.timestamp)}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Completed */}
            {groupedTodos.completed.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-text-secondary uppercase tracking-wider px-2 mb-1">
                  Completed ({groupedTodos.completed.length})
                </div>
                <div className="space-y-1">
                  {groupedTodos.completed.map(todo => (
                    <button
                      key={todo.id}
                      onClick={() => onTodoClick?.(todo)}
                      className="w-full text-left p-3 rounded-lg border transition-colors hover:bg-bg-hover"
                      style={getStatusColor(todo.status)}
                    >
                      <div className="flex items-start gap-2">
                        <div className="flex-shrink-0 mt-0.5">
                          {getStatusIcon(todo.status)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-text-primary line-through opacity-60">
                            {todo.content}
                          </div>
                          {todo.timestamp && (
                            <div className="text-xs text-text-tertiary mt-1">
                              {formatTimeAgo(todo.timestamp)}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
