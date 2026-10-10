/**
 * Session-metadata writes the Claude Code provider makes outside the turn's
 * own data path. Moved out of ClaudeCodeProvider unchanged. All are
 * best-effort: a failure here must never disturb the turn.
 */

import type { TaskListItem } from './taskListReconstruct';

async function sessionsRepository() {
  const { AISessionsRepository } = await import('../../../../storage/repositories/AISessionsRepository');
  return AISessionsRepository;
}

/** Marks tasks persisted as 'running' by an earlier process as stopped. */
export async function stopStaleRunningTasks(sessionId: string, onChanged: () => void): Promise<void> {
  try {
    const AISessionsRepository = await sessionsRepository();
    const currentSession = await AISessionsRepository.get(sessionId);
    const tasks = currentSession?.metadata?.currentTasks;
    if (Array.isArray(tasks) && tasks.some((t: any) => t.status === 'running')) {
      const cleaned = tasks.map((t: any) =>
        t.status === 'running' ? { ...t, status: 'stopped' } : t
      );
      await AISessionsRepository.updateMetadata(sessionId, {
        metadata: { ...currentSession?.metadata, currentTasks: cleaned }
      });
      onChanged();
    }
  } catch {
    // Non-critical cleanup
  }
}

/** Seeds the per-instance task-list map from the persisted board. */
export async function hydrateTaskListItems(sessionId: string, items: Map<string, TaskListItem>): Promise<void> {
  try {
    const AISessionsRepository = await sessionsRepository();
    const currentSession = await AISessionsRepository.get(sessionId);
    const persisted = currentSession?.metadata?.currentTaskList;
    if (Array.isArray(persisted)) {
      for (const item of persisted as TaskListItem[]) {
        if (item && typeof item.id === 'string') items.set(item.id, item);
      }
    }
  } catch {
    // Non-critical hydration
  }
}

/** Stores the agent's current todos; the change event makes the panel reload them. */
export async function persistCurrentTodos(sessionId: string, todos: any[], onChanged: () => void): Promise<void> {
  try {
    const AISessionsRepository = await sessionsRepository();
    const currentSession = await AISessionsRepository.get(sessionId);
    const currentMetadata = currentSession?.metadata || {};
    await AISessionsRepository.updateMetadata(sessionId, {
      metadata: {
        ...currentMetadata,
        currentTodos: todos
      }
    });
    onChanged();
  } catch (error) {
    console.error('[CLAUDE-CODE] Failed to update session metadata with todos:', error);
    console.error('[CLAUDE-CODE] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
  }
}
