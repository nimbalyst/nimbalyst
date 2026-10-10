/** Tree projection shared by the sidebar, navigation, and move validation. */
export interface TreeSession {
  id: string;
  parentSessionId?: string | null;
  worktreeId?: string | null;
  workspaceId?: string;
  remoteHostDeviceId?: string;
  sessionType?: string;
  isPinned?: boolean;
  createdAt: number;
  updatedAt?: number;
  uncommittedCount?: number;
}

export interface SessionTreeNode<T extends TreeSession> {
  session: T;
  children: SessionTreeNode<T>[];
  depth: number;
  activity: number;
  uncommittedCount: number;
  ids: string[];
}

export function treeIndent(depth: number) {
  return { level: Math.min(Math.max(0, depth), 3), rail: depth > 3 };
}

/** Missing parents become visible roots; corrupt cycles are cut without losing rows. */
export function buildSessionTree<T extends TreeSession>(rows: readonly T[]): SessionTreeNode<T>[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const nodes = new Map<string, SessionTreeNode<T>>();
  const parentIds = new Map<string, string>();
  for (const row of byId.values()) {
    nodes.set(row.id, {
      session: row,
      children: [],
      depth: 0,
      activity: row.updatedAt ?? row.createdAt,
      uncommittedCount: row.uncommittedCount ?? 0,
      ids: [row.id],
    });
    const parent = row.parentSessionId && byId.get(row.parentSessionId);
    if (!parent || parent.id === row.id || (parent.worktreeId ?? null) !== (row.worktreeId ?? null)) continue;
    const seen = new Set([row.id]);
    let cursor: string | undefined = parent.id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parentIds.get(cursor);
    }
    if (!cursor) parentIds.set(row.id, parent.id);
  }
  const roots: SessionTreeNode<T>[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(parentIds.get(node.session.id) ?? '');
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const finish = (node: SessionTreeNode<T>, depth: number) => {
    node.depth = depth;
    for (const child of node.children) {
      finish(child, depth + 1);
      node.activity = Math.max(node.activity, child.activity);
      node.uncommittedCount += child.uncommittedCount;
      node.ids.push(...child.ids);
    }
    node.children.sort(compareNodes);
  };
  roots.forEach((node) => finish(node, 0));
  return roots.sort(compareNodes);
}

function compareNodes<T extends TreeSession>(a: SessionTreeNode<T>, b: SessionTreeNode<T>) {
  return (
    Number(!!b.session.isPinned) - Number(!!a.session.isPinned) ||
    b.activity - a.activity ||
    a.session.id.localeCompare(b.session.id)
  );
}

export function mergedTreeHeader<T extends TreeSession>(node: SessionTreeNode<T>): SessionTreeNode<T> {
  return node.session.sessionType === 'workstream' && node.children.length === 1 ? node.children[0] : node;
}

/** Visible preorder is also the range-selection order; hidden wrappers never participate. */
export function visibleSessionTreeIds<T extends TreeSession>(
  rows: readonly T[],
  isExpanded: (node: SessionTreeNode<T>) => boolean
): string[] {
  const ids: string[] = [];
  const visit = (node: SessionTreeNode<T>) => {
    ids.push(node.session.id);
    if (isExpanded(node)) node.children.forEach(visit);
  };
  buildSessionTree(rows).forEach((root) => visit(mergedTreeHeader(root)));
  return ids;
}

export function sessionTreeRootId(id: string, rows: ReadonlyMap<string, TreeSession>): string {
  const visited = new Set<string>();
  let current = id;
  while (!visited.has(current)) {
    visited.add(current);
    const row = rows.get(current);
    const parent = row?.parentSessionId && rows.get(row.parentSessionId);
    if (
      !row ||
      !parent ||
      parent.sessionType === 'blitz' ||
      (row.worktreeId ?? null) !== (parent.worktreeId ?? null) ||
      visited.has(parent.id)
    )
      break;
    current = parent.id;
  }
  return current;
}

/** Server is authoritative; this check supplies immediate drag and picker feedback. */
export function sessionMoveError(
  rows: ReadonlyMap<string, TreeSession>,
  sourceId: string,
  parentId: string | null
): string | null {
  const source = rows.get(sourceId);
  if (!source) return 'Session is no longer available';
  if (source.sessionType === 'workstream' || source.sessionType === 'blitz')
    return 'Containers must stay at top level';
  if (parentId === null) return null;
  const parent = rows.get(parentId);
  if (!parent) return 'Parent is no longer available';
  if (
    (source.remoteHostDeviceId ?? '') !== (parent.remoteHostDeviceId ?? '') ||
    (source.workspaceId && parent.workspaceId && source.workspaceId !== parent.workspaceId)
  )
    return 'Sessions must stay in the same workspace and machine';
  if (parent.sessionType === 'blitz') return 'Blitz sessions cannot receive moved sessions';
  if ((source.worktreeId ?? null) !== (parent.worktreeId ?? null))
    return 'Sessions must stay in the same worktree';
  let depth = 1;
  let cursor: TreeSession | undefined = parent;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor.id === sourceId) return 'A session cannot move under its descendant';
    if (seen.has(cursor.id)) return 'The target has a cyclic parent chain';
    seen.add(cursor.id);
    if (!cursor.parentSessionId) break;
    cursor = rows.get(cursor.parentSessionId);
    if (!cursor) return 'Parent hierarchy is not loaded';
    depth++;
  }
  const forest = buildSessionTree([...rows.values()]);
  const find = (nodes: SessionTreeNode<TreeSession>[]): SessionTreeNode<TreeSession> | undefined => {
    for (const node of nodes) {
      if (node.session.id === sourceId) return node;
      const found = find(node.children);
      if (found) return found;
    }
    return undefined;
  };
  const node = find(forest);
  const height = (n: SessionTreeNode<TreeSession>): number =>
    n.children.length ? 1 + Math.max(...n.children.map(height)) : 0;
  return depth + (node ? height(node) : 0) > 8 ? 'The moved tree would exceed 8 levels' : null;
}
