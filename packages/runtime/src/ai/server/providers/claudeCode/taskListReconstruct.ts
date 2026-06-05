/**
 * Pure reconstruction of the SDK-native task list (TaskCreate/TaskUpdate tools)
 * from individual tool calls.
 *
 * The CLI executes these tools natively and only reports the *mutation* back to
 * us — TaskUpdate carries just the changed fields, and TaskCreate echoes the
 * SDK-assigned id only in its result text, not its args. So we keep a running
 * map keyed by id and merge each mutation as it streams in.
 *
 * Kept pure (no DB, no events) so it can be unit-tested in isolation; the
 * provider wraps it with persistence + UI emission.
 */

export interface TaskListItem {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  blocks?: string[];
  blockedBy?: string[];
}

/**
 * Apply one task-list tool mutation to `map` in place.
 *
 * @returns true if the map changed (caller should persist/emit), false for
 *          reads (TaskList/TaskGet) or unparseable mutations.
 */
export function applyTaskListMutation(
  map: Map<string, TaskListItem>,
  toolName: string,
  args: Record<string, unknown> | undefined,
  resultText: string,
): boolean {
  if (toolName === 'TaskCreate') {
    // "Task #3 created successfully: <subject>"
    const idMatch = resultText.match(/Task #([^\s:]+)/);
    if (!idMatch) return false;
    const id = idMatch[1];
    map.set(id, {
      id,
      subject: typeof args?.subject === 'string' ? args.subject : `Task #${id}`,
      description: typeof args?.description === 'string' ? args.description : undefined,
      activeForm: typeof args?.activeForm === 'string' ? args.activeForm : undefined,
      status: 'pending',
    });
    return true;
  }

  if (toolName === 'TaskUpdate') {
    const id = typeof args?.taskId === 'string' ? args.taskId : String(args?.taskId ?? '');
    if (!id) return false;

    if (args?.status === 'deleted') {
      return map.delete(id);
    }

    // An update can arrive for a task we never saw created (resumed session
    // before hydration, or a teammate-created task) — start from a stub.
    const item: TaskListItem = map.get(id) ?? { id, subject: `Task #${id}`, status: 'pending' };
    if (args?.status === 'pending' || args?.status === 'in_progress' || args?.status === 'completed') {
      item.status = args.status;
    }
    if (typeof args?.subject === 'string') item.subject = args.subject;
    if (typeof args?.description === 'string') item.description = args.description;
    if (typeof args?.activeForm === 'string') item.activeForm = args.activeForm;
    if (typeof args?.owner === 'string') item.owner = args.owner;
    if (Array.isArray(args?.addBlockedBy)) {
      item.blockedBy = Array.from(new Set([...(item.blockedBy ?? []), ...args.addBlockedBy.map(String)]));
    }
    if (Array.isArray(args?.addBlocks)) {
      item.blocks = Array.from(new Set([...(item.blocks ?? []), ...args.addBlocks.map(String)]));
    }
    map.set(id, item);
    return true;
  }

  // TaskList / TaskGet are reads — nothing to mirror.
  return false;
}

/** Stable creation-order sort (numeric id) for rendering. */
export function sortTaskList(items: Iterable<TaskListItem>): TaskListItem[] {
  return Array.from(items).sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
}
