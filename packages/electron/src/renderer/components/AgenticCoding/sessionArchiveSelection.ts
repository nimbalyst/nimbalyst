import type { TreeSession } from './sessionTreeModel';

/** Session rows archive subtrees; only explicit container selections archive worktrees. */
export function resolveSessionArchiveSelection(
  registry: ReadonlyMap<string, TreeSession>,
  selectedSessionIds: ReadonlySet<string>,
  selectedGroupIds: ReadonlySet<string>,
) {
  const worktreeIds: string[] = [];
  const blitzIds: string[] = [];
  const superLoopIds: string[] = [];
  const workstreamIds: string[] = [];
  for (const key of selectedGroupIds) {
    const separator = key.indexOf(':');
    const type = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (!id) continue;
    if (type === 'worktree') worktreeIds.push(id);
    if (type === 'blitz') blitzIds.push(id);
    if (type === 'superloop') superLoopIds.push(id);
    if (type === 'workstream' && registry.has(id)) workstreamIds.push(id);
  }
  const selected = new Set([...selectedSessionIds, ...workstreamIds]);
  const isSubtreeRoot = (id: string) => {
    const row = registry.get(id);
    if (!row || (row.worktreeId && worktreeIds.includes(row.worktreeId))) return false;
    const seen = new Set([id]);
    let parentId = row.parentSessionId;
    while (parentId && !seen.has(parentId)) {
      if (selected.has(parentId) || blitzIds.includes(parentId)) return false;
      seen.add(parentId);
      parentId = registry.get(parentId)?.parentSessionId;
    }
    return true;
  };
  return {
    worktreeIds,
    blitzIds,
    superLoopIds,
    workstreamIds: workstreamIds.filter(isSubtreeRoot),
    regularSessionIds: [...selectedSessionIds].filter(id => !workstreamIds.includes(id) && isSubtreeRoot(id)),
  };
}

/** IDs affected by the backend's recursive session archive, for acknowledged UI cleanup. */
export function sessionArchiveSubtreeIds(registry: ReadonlyMap<string, TreeSession>, roots: readonly string[]): string[] {
  const children = new Map<string, string[]>();
  for (const row of registry.values()) {
    if (row.parentSessionId) {
      const siblings = children.get(row.parentSessionId) ?? [];
      siblings.push(row.id);
      children.set(row.parentSessionId, siblings);
    }
  }
  const ids = new Set<string>();
  const visit = (id: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    children.get(id)?.forEach(visit);
  };
  roots.forEach(visit);
  return [...ids];
}
