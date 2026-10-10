import { createHierarchySyncMethods, newHierarchyIntent } from './sessionHierarchySyncStore';
import { sessionMetadataMergeSql } from './sessionMetadataMerge';
import type { SessionStore, CreateSessionPayload } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { parseJsonObjectColumn } from '../utils/jsonColumn';

export const MAX_SESSION_DEPTH = 8;
export type HierarchyStatement = { sql: string; params?: any[]; expectedRows?: number };
export type HierarchyDatabase = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  runTransaction?(statements: HierarchyStatement[]): Promise<void>;
};
export interface HierarchyRow {
  id: string;
  workspace_id: string;
  parent_session_id: string | null;
  worktree_id: string | null;
  created_by_session_id: string | null;
  session_type: string;
  title?: string;
  metadata?: unknown;
}

// All hierarchy writers share this lane, including incoming phone writes. A
// query() BEGIN/COMMIT pair is not a transaction across worker messages.
let writeLane: Promise<unknown> = Promise.resolve();
export function withHierarchyWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = writeLane.then(write, write);
  writeLane = result.catch(() => undefined);
  return result;
}

export async function readHierarchy(db: HierarchyDatabase, workspaceId: string): Promise<HierarchyRow[]> {
  return (await db.query<HierarchyRow>(
    `SELECT id, workspace_id, parent_session_id, worktree_id, created_by_session_id, session_type, title, metadata
     FROM ai_sessions WHERE workspace_id = $1
       OR parent_session_id IN (SELECT id FROM ai_sessions WHERE workspace_id = $1)`, [workspaceId],
  )).rows;
}

export async function assertSessionCreation(db: HierarchyDatabase, payload: CreateSessionPayload, existing?: { workspace_id?: string }): Promise<void> {
  if (existing?.workspace_id && existing.workspace_id !== payload.workspaceId) throw new Error('Cannot recreate a session in a different workspace');
  const node: HierarchyRow = { id: payload.id, workspace_id: payload.workspaceId,
    worktree_id: payload.worktreeId ?? null, parent_session_id: payload.parentSessionId ?? null,
    session_type: payload.sessionType ?? 'session', created_by_session_id: payload.createdBySessionId ?? null };
  const hierarchy = node.parent_session_id || node.created_by_session_id || existing ? await readHierarchy(db, payload.workspaceId) : [];
  assertHierarchyPlacement(hierarchy, node, node.parent_session_id);
  if (node.created_by_session_id && (node.created_by_session_id === node.id || !hierarchy.some(row => row.id === node.created_by_session_id && row.workspace_id === node.workspace_id))) throw new Error('Invalid session manager in this workspace');
}

/** Validate the proposed edge against the entire moved subtree, not just its root. */
export function assertHierarchyPlacement(rows: HierarchyRow[], node: HierarchyRow, parentId: string | null): void {
  if ((node.session_type === 'workstream' || node.session_type === 'blitz') && node.worktree_id) throw new Error('Workstream and Blitz containers cannot belong to a worktree');
  if (parentId && (node.session_type === 'workstream' || node.session_type === 'blitz')) {
    throw new Error('Workstream and Blitz containers must remain roots');
  }
  const byId = new Map(rows.map(row => [row.id, row]));
  byId.set(node.id, { ...node, parent_session_id: parentId });
  let ancestorId = parentId;
  const ancestors = new Set([node.id]);
  let targetDepth = 0;
  while (ancestorId) {
    if (ancestors.has(ancestorId)) throw new Error('Session hierarchy cycle');
    ancestors.add(ancestorId);
    const ancestor = byId.get(ancestorId);
    if (!ancestor || ancestor.workspace_id !== node.workspace_id) throw new Error('Parent session is not in this workspace');
    if (ancestor.session_type !== 'blitz' && (ancestor.worktree_id ?? null) !== (node.worktree_id ?? null)) throw new Error('Parent session is in a different worktree');
    targetDepth++;
    if (targetDepth > MAX_SESSION_DEPTH) throw new Error('Session hierarchy depth exceeds 8');
    ancestorId = ancestor.parent_session_id;
  }
  const children = new Map<string, string[]>();
  for (const row of byId.values()) {
    if (!row.parent_session_id) continue;
    const siblings = children.get(row.parent_session_id) ?? [];
    siblings.push(row.id);
    children.set(row.parent_session_id, siblings);
  }
  const pending: Array<[string, number]> = [[node.id, targetDepth]];
  const seen = new Set<string>();
  while (pending.length) {
    const [id, depth] = pending.pop()!;
    if (seen.has(id)) throw new Error('Session hierarchy cycle');
    seen.add(id);
    if (depth > MAX_SESSION_DEPTH) throw new Error('Session subtree depth exceeds 8');
    const row = byId.get(id)!;
    if (row.workspace_id !== node.workspace_id) throw new Error('Session subtree spans different workspaces');
    const parent = row.parent_session_id ? byId.get(row.parent_session_id) : null;
    if (parent && parent.session_type !== 'blitz' && (row.worktree_id ?? null) !== (parent.worktree_id ?? null)) throw new Error('Session subtree spans different worktrees');
    for (const child of children.get(id) ?? []) pending.push([child, depth + 1]);
  }
}

// UNION, rather than UNION ALL, terminates even on pre-existing corrupt cycles.
export const SESSION_DESCENDANTS_CTE = `WITH RECURSIVE session_subtree(id) AS (
  SELECT id FROM ai_sessions WHERE id = $1
  UNION
  SELECT c.id FROM ai_sessions c JOIN session_subtree p ON c.parent_session_id = p.id
  WHERE c.workspace_id = (SELECT workspace_id FROM ai_sessions WHERE id = $1)
)`;

export async function readSessionSubtree(db: HierarchyDatabase, sessionId: string, workspaceId: string) {
  const rows = (await db.query<any>(`WITH RECURSIVE subtree(id, depth) AS (
    SELECT id, 0 FROM ai_sessions WHERE id = $1 AND workspace_id = $2
    UNION
    SELECT c.id, p.depth + 1 FROM ai_sessions c JOIN subtree p ON c.parent_session_id = p.id
    WHERE c.workspace_id = $2 AND p.depth < ${MAX_SESSION_DEPTH}
  ) SELECT s.*, t.depth,
    (SELECT COUNT(*) FROM ai_sessions c WHERE c.parent_session_id = s.id) AS child_count,
    (SELECT COUNT(*) FROM ai_agent_messages m WHERE m.session_id = s.id AND m.direction = 'input' AND (m.hidden = FALSE OR m.hidden IS NULL)) AS message_count
    FROM (SELECT id, MIN(depth) AS depth FROM subtree GROUP BY id) t JOIN ai_sessions s ON s.id = t.id
    ORDER BY t.depth, s.created_at`, [sessionId, workspaceId])).rows;
  // Every descendant of a subtree member is itself in the subtree, so count here.
  const counts = computeDescendantStats(rows.map(row => ({ id: row.id, parentId: row.parent_session_id, updatedAt: 0 })));
  return rows.map(row => ({ ...row, descendant_count: counts.get(row.id)?.count ?? 0 }));
}

/**
 * Descendant count and latest descendant activity per ancestor, computed in JS.
 * A recursive closure in SQL went quadratic on SQLite once orchestrator trees
 * held thousands of sessions and stalled the database worker for minutes.
 * Cycle-safe: a corrupt parent chain stops at the first repeated id.
 */
export function computeDescendantStats(nodes: Array<{ id: string; parentId: string | null | undefined; updatedAt: number }>) {
  const parentOf = new Map(nodes.map(node => [node.id, node.parentId ?? null]));
  const stats = new Map<string, { count: number; maxUpdatedAt: number }>();
  for (const node of nodes) {
    const seen = new Set<string>([node.id]);
    for (let ancestor = parentOf.get(node.id); ancestor && parentOf.has(ancestor) && !seen.has(ancestor); ancestor = parentOf.get(ancestor)) {
      seen.add(ancestor);
      const entry = stats.get(ancestor) ?? { count: 0, maxUpdatedAt: 0 };
      entry.count++;
      entry.maxUpdatedAt = Math.max(entry.maxUpdatedAt, node.updatedAt);
      stats.set(ancestor, entry);
    }
  }
  return stats;
}

export async function findSessionTreeRoot(db: HierarchyDatabase, sessionId: string, workspaceId: string): Promise<string> {
  const { rows } = await db.query<{ id: string; parent_session_id: string | null }>(`WITH RECURSIVE ancestors(id, parent_session_id, depth) AS (
    SELECT id, parent_session_id, 0 FROM ai_sessions WHERE id = $1 AND workspace_id = $2
    UNION
    SELECT p.id, p.parent_session_id, a.depth + 1 FROM ai_sessions p JOIN ancestors a ON p.id = a.parent_session_id
    WHERE p.workspace_id = $2 AND a.depth < ${MAX_SESSION_DEPTH}
  ) SELECT id, parent_session_id FROM ancestors ORDER BY depth DESC LIMIT 1`, [sessionId, workspaceId]);
  if (!rows.length) throw new Error('Session not found in this workspace');
  if (rows[0].parent_session_id) throw new Error('Invalid session tree: cycle or depth exceeds 8');
  return rows[0].id;
}

/** `source` is unset for a local user move. 'remote' (snapshot apply) and 'system' (delete-lift) are not user moves and must not notify anyone. */
export interface HierarchyMove { source?: 'remote' | 'system'; sessionId: string; workspaceId: string; title: string; previousParentId: string | null; previousManagerId: string | null; parentId: string | null; managerId: string | null }
const moveListeners = new Set<(move: HierarchyMove) => Promise<void>>();
const archiveListeners = new Set<(sessionIds: string[], archived: boolean) => Promise<void>>();
export function onSubtreeArchive(listener: (sessionIds: string[], archived: boolean) => Promise<void>): () => void {
  archiveListeners.add(listener);
  return () => { archiveListeners.delete(listener); };
}
export async function publishSubtreeArchive(sessionIds: string[], archived: boolean): Promise<void> {
  for (const listener of archiveListeners) {
    try { await listener(sessionIds, archived); } catch (error) { console.error('[SessionHierarchy] Failed to publish archive:', error); }
  }
}
export function onHierarchyMove(listener: (move: HierarchyMove) => Promise<void>): () => void {
  moveListeners.add(listener);
  return () => { moveListeners.delete(listener); };
}
export async function publishHierarchyMove(move: HierarchyMove): Promise<void> {
  for (const listener of moveListeners) {
    try { await listener(move); } catch (error) { console.error('[SessionHierarchy] Failed to publish committed move:', error); }
  }
}

export function managerReassignmentMetadata(node: HierarchyRow, managerId: string | null): Record<string, unknown> {
  const metadata = parseJsonObjectColumn(node.metadata);
  return { originalSpawnerSessionId: Object.prototype.hasOwnProperty.call(metadata, 'originalSpawnerSessionId') ? metadata.originalSpawnerSessionId : node.created_by_session_id ?? null,
    managerReassignedByUser: true, reassignedManagerSessionId: managerId };
}

export function wrapSessionHierarchyWrites(store: SessionStore, db: HierarchyDatabase, ensureReady: () => Promise<void>): SessionStore {
  return {
    ...store,
    ...createHierarchySyncMethods(db, ensureReady),
    create: (payload) => withHierarchyWrite(async () => {
      await store.create(payload);
    }),
    updateMetadata: (sessionId, patch) => {
      const changesHierarchy = patch.parentSessionId !== undefined || patch.worktreeId !== undefined || patch.sessionType !== undefined || patch.workspaceId !== undefined || patch.createdBySessionId !== undefined;
      if (!changesHierarchy) return patch.isArchived !== undefined ? withHierarchyWrite(() => store.updateMetadata(sessionId, patch)) : store.updateMetadata(sessionId, patch);
      return withHierarchyWrite(async () => {
        await ensureReady();
        const { rows } = await db.query<HierarchyRow>('SELECT id, workspace_id, parent_session_id, worktree_id, created_by_session_id, session_type, title, metadata FROM ai_sessions WHERE id = $1', [sessionId]);
        const current = rows[0];
        if (!current) throw new Error('Session not found');
        if (patch.expectedParentSessionId !== undefined && patch.expectedParentSessionId !== (current.parent_session_id ?? null)) throw new Error('Session parent changed; refresh before moving it');
        if (patch.expectedCreatedBySessionId !== undefined && patch.expectedCreatedBySessionId !== (current.created_by_session_id ?? null)) throw new Error('Session manager changed; refresh before moving it');
        if (patch.workspaceId !== undefined && patch.workspaceId !== current.workspace_id) throw new Error('Cannot move a session to a different workspace');
        const parentId = patch.parentSessionId !== undefined ? patch.parentSessionId : current.parent_session_id;
        const proposed = { ...current, workspace_id: patch.workspaceId ?? current.workspace_id,
          worktree_id: patch.worktreeId !== undefined ? patch.worktreeId ?? null : current.worktree_id, session_type: patch.sessionType ?? current.session_type };
        const hierarchy = await readHierarchy(db, current.workspace_id);
        assertHierarchyPlacement(hierarchy, proposed, parentId);
        const moved = patch.parentSessionId !== undefined && (current.parent_session_id ?? null) !== parentId;
        const managerId = patch.createdBySessionId !== undefined ? patch.createdBySessionId : moved ? parentId : current.created_by_session_id ?? null;
        if (managerId && (managerId === sessionId || !hierarchy.some(row => row.id === managerId && row.workspace_id === current.workspace_id))) throw new Error('Invalid session manager in this workspace');
        const managerChanged = (current.created_by_session_id ?? null) !== managerId;
        const authoritativePatch = moved || managerChanged ? { ...patch, createdBySessionId: managerId,
          metadata: { ...patch.metadata, ...managerReassignmentMetadata(current, managerId),
            ...(patch.hierarchySync?.source === 'remote' ? {} : { hierarchySyncIntent: newHierarchyIntent(parentId, managerId) }) } } : patch;
        if (patch.hierarchySync && !patch.hierarchySync.isCurrent()) throw new Error('Superseded hierarchy update');
        const localIntent = parseJsonObjectColumn(current.metadata).hierarchySyncIntent;
        if (patch.hierarchySync && localIntent && (moved || managerChanged)) throw new Error('Local hierarchy intent pending');
        await store.updateMetadata(sessionId, authoritativePatch);
        if (moved || managerChanged) await publishHierarchyMove({ sessionId, workspaceId: current.workspace_id, title: current.title || 'Untitled Session',
          previousParentId: current.parent_session_id ?? null, previousManagerId: current.created_by_session_id ?? null, parentId, managerId, source: patch.hierarchySync?.source });
      });
    },
    delete: (sessionId) => withHierarchyWrite(() => store.delete(sessionId)),
  };
}

export async function deleteSessionAndLiftChildren(db: HierarchyDatabase, sessionId: string): Promise<void> {
  if (!db.runTransaction) throw new Error('Session deletion requires transactional storage');
  const { rows: deletedRows } = await db.query<HierarchyRow>('SELECT id, workspace_id, parent_session_id FROM ai_sessions WHERE id = $1', [sessionId]);
  const deleted = deletedRows[0];
  const { rows: children } = await db.query<HierarchyRow>('SELECT id, workspace_id, title, parent_session_id, created_by_session_id, metadata FROM ai_sessions WHERE parent_session_id = $1 OR created_by_session_id = $1', [sessionId]);
  const changes = children.map(child => ({ child,
    parentId: child.parent_session_id === sessionId ? deleted?.parent_session_id ?? null : child.parent_session_id ?? null,
    managerId: child.created_by_session_id === sessionId
      ? child.parent_session_id === sessionId ? deleted?.parent_session_id ?? null : null
      : child.created_by_session_id ?? null,
  }));
  await db.runTransaction([
    ...changes.map(({ child, parentId, managerId }) => {
      const patch = { ...(child.created_by_session_id === sessionId ? managerReassignmentMetadata(child, managerId) : {}), hierarchySyncIntent: newHierarchyIntent(parentId, managerId) };
      return {
        sql: `UPDATE ai_sessions SET parent_session_id = $2, created_by_session_id = $3,
              metadata = ${sessionMetadataMergeSql("COALESCE(metadata, '{}'::jsonb)", 4, patch)} WHERE id = $1 RETURNING id`,
        params: [child.id, parentId, managerId, JSON.stringify(patch)], expectedRows: 1,
      };
    }),
    { sql: 'DELETE FROM ai_sessions WHERE id=$1', params: [sessionId] },
  ]);
  if (deleted) for (const { child, parentId, managerId } of changes) await publishHierarchyMove({ sessionId: child.id, workspaceId: child.workspace_id, title: child.title || 'Untitled Session',
    previousParentId: child.parent_session_id ?? null, previousManagerId: child.created_by_session_id ?? null, parentId, managerId, source: 'system' });
}
