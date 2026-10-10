import { newHierarchyIntent } from './sessionHierarchySyncStore';
import { sessionMetadataMergeSql } from './sessionMetadataMerge';
import { assertHierarchyPlacement, readHierarchy, withHierarchyWrite, type HierarchyDatabase, type HierarchyStatement } from './sessionHierarchy';
import { parseJsonObjectColumn } from '../utils/jsonColumn';

const MARKER = 'orchestrator-session-trees-v1';

/** Deferred maintenance shared by PGLite and SQLite; pointers only, no deleted rows. */
export async function migrateSessionTrees(db: HierarchyDatabase): Promise<{ moved: number }> {
  if (!db.runTransaction) throw new Error('Session tree migration requires transactional storage');
  await db.query('CREATE TABLE IF NOT EXISTS session_tree_migrations (id TEXT PRIMARY KEY)');
  if ((await db.query('SELECT id FROM session_tree_migrations WHERE id = $1', [MARKER])).rows.length) return { moved: 0 };
  const { rows: workspaces } = await db.query<{ workspace_id: string }>('SELECT DISTINCT workspace_id FROM ai_sessions');
  let moved = 0;
  for (const { workspace_id: workspaceId } of workspaces) {
    moved += await withHierarchyWrite(async () => {
      const rows = await readHierarchy(db, workspaceId);
      const original = new Map(rows.map(row => {
        const metadata = parseJsonObjectColumn(row.metadata);
        const migrated = Number(metadata.sessionTreeMigrationVersion) === 1;
        return [row.id, { ...row, parent_session_id: migrated ? (metadata.preTreeParentSessionId as string | null) ?? null : row.parent_session_id }];
      }));
      const byId = new Map(rows.map(row => [row.id, row]));
      // Creator ancestors first. Cyclic creator chains are skipped as a whole.
      const depth = (id: string): number => {
        const seen = new Set<string>();
        let current = original.get(id);
        while (current?.created_by_session_id) {
          if (seen.has(current.id)) return Infinity;
          seen.add(current.id);
          current = original.get(current.created_by_session_id);
        }
        return seen.size;
      };
      const ordered = rows.map(row => ({ row, depth: depth(row.id) })).sort((a, b) => a.depth - b.depth);
      let count = 0;
      let statements: HierarchyStatement[] = [];
      for (const { row, depth: creatorDepth } of ordered) {
        const manager = row.created_by_session_id ? byId.get(row.created_by_session_id) : null;
        const old = original.get(row.id)!;
        const oldManager = manager ? original.get(manager.id) : null;
        const metadata = parseJsonObjectColumn(row.metadata);
        if (!manager || !oldManager || !Number.isFinite(creatorDepth) || row.session_type === 'workstream' || row.session_type === 'blitz'
          || metadata.managerReassignedByUser || metadata.isolated || Object.prototype.hasOwnProperty.call(metadata, 'preTreeParentSessionId')
          || row.parent_session_id === manager.id || (row.worktree_id ?? null) !== (manager.worktree_id ?? null)) continue;
        const sameGroup = !!row.worktree_id || (old.parent_session_id ?? null) === (oldManager.parent_session_id ?? null)
          || old.parent_session_id === manager.id || (!old.parent_session_id && !!oldManager.parent_session_id);
        if (!sameGroup) continue;
        try { assertHierarchyPlacement(rows, row, manager.id); } catch { continue; }
        const backup = { preTreeParentSessionId: old.parent_session_id ?? null, sessionTreeMigrationVersion: 1,
          hierarchySyncIntent: newHierarchyIntent(manager.id, row.created_by_session_id ?? null) };
        statements.push({
          sql: `UPDATE ai_sessions SET parent_session_id = $2, metadata = ${sessionMetadataMergeSql("COALESCE(metadata, '{}'::jsonb)", 3, backup)}
                WHERE id = $1 AND (parent_session_id = $4 OR (parent_session_id IS NULL AND $4 IS NULL))
                  AND created_by_session_id = $2 RETURNING id`,
          params: [row.id, manager.id, JSON.stringify(backup), old.parent_session_id ?? null], expectedRows: 1,
        });
        row.parent_session_id = manager.id;
        count++;
        if (statements.length >= 100) {
          await db.runTransaction!(statements);
          statements = [];
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      if (statements.length) await db.runTransaction!(statements);
      return count;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  await db.runTransaction([{ sql: 'INSERT INTO session_tree_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', params: [MARKER] }]);
  console.info(`[SessionHierarchy] Migrated ${moved} session parent pointers`);
  return { moved };
}
