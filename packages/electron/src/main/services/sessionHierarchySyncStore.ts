import { randomUUID } from 'node:crypto';
import type { SessionStore, HierarchySyncIntent, HierarchySnapshotResult } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { parseJsonObjectColumn } from '../utils/jsonColumn';
import { assertHierarchyPlacement, readHierarchy, withHierarchyWrite, publishHierarchyMove, managerReassignmentMetadata, type HierarchyDatabase, type HierarchyRow, type HierarchyStatement } from './sessionHierarchy';
import { sessionMetadataMergeSql } from './sessionMetadataMerge';

/** Result error for index entries whose session does not exist on this desktop. */
export const SESSION_NOT_HOSTED = 'Session not hosted on this desktop';

export function newHierarchyIntent(parentSessionId: string | null, createdBySessionId: string | null) {
  return { revision: randomUUID(), parentSessionId, createdBySessionId };
}
function intentFor(row: HierarchyRow): HierarchySyncIntent | null {
  const value = parseJsonObjectColumn(row.metadata).hierarchySyncIntent;
  if (!value || typeof value !== 'object' || typeof (value as any).revision !== 'string') return null;
  const intent = value as any;
  return { sessionId: row.id, revision: intent.revision, parentSessionId: intent.parentSessionId ?? null, createdBySessionId: intent.createdBySessionId ?? null };
}
function matches(intent: HierarchySyncIntent, parent: string | null, manager: string | null) {
  return intent.parentSessionId === parent && intent.createdBySessionId === manager;
}
function canonical(row: HierarchyRow, accepted: boolean, error?: string): HierarchySnapshotResult {
  return { sessionId: row.id, accepted, parentSessionId: row.parent_session_id ?? null, createdBySessionId: row.created_by_session_id ?? null, ...(error ? { error } : {}) };
}

export function createHierarchySyncMethods(db: HierarchyDatabase, ensureReady: () => Promise<void>): Pick<SessionStore, 'listPendingHierarchyIntents' | 'acknowledgeHierarchyIntent' | 'applyRemoteHierarchySnapshot'> {
  return {
    async listPendingHierarchyIntents() {
      await ensureReady();
      const { rows } = await db.query<HierarchyRow>("SELECT id, parent_session_id, created_by_session_id, metadata FROM ai_sessions WHERE metadata->'hierarchySyncIntent' IS NOT NULL");
      return rows.map(intentFor).filter((intent): intent is HierarchySyncIntent => !!intent);
    },
    acknowledgeHierarchyIntent: (id, revision, parent, manager) => withHierarchyWrite(async () => {
      await ensureReady();
      const { rows } = await db.query<{ id: string }>(`UPDATE ai_sessions SET metadata = metadata - 'hierarchySyncIntent'
        WHERE id = $1 AND metadata->'hierarchySyncIntent'->>'revision' = $2
          AND (parent_session_id = $3 OR (parent_session_id IS NULL AND $3 IS NULL))
          AND (created_by_session_id = $4 OR (created_by_session_id IS NULL AND $4 IS NULL))
          AND (metadata->'hierarchySyncIntent'->>'parentSessionId' = $3 OR (metadata->'hierarchySyncIntent'->>'parentSessionId' IS NULL AND $3 IS NULL))
          AND (metadata->'hierarchySyncIntent'->>'createdBySessionId' = $4 OR (metadata->'hierarchySyncIntent'->>'createdBySessionId' IS NULL AND $4 IS NULL)) RETURNING id`, [id, revision, parent, manager]);
      return rows.length === 1;
    }),
    applyRemoteHierarchySnapshot: (entries, isCurrent) => withHierarchyWrite(async () => {
      await ensureReady();
      if (!entries.length) return [];
      if (!db.runTransaction) throw new Error('Remote hierarchy reconciliation requires transactional storage');
      const { rows: currentRows } = await db.query<HierarchyRow>(`SELECT id, workspace_id, parent_session_id, created_by_session_id, worktree_id, session_type, title, metadata FROM ai_sessions WHERE id IN (${entries.map((_, i) => `$${i + 1}`).join(',')})`, entries.map(entry => entry.sessionId));
      const current = new Map(currentRows.map(row => [row.id, row]));
      const proposed = new Map<string, HierarchyRow>();
      const protectedIds = new Set<string>();
      const confirmedIds = new Set<string>();
      for (const entry of entries) {
        const row = current.get(entry.sessionId);
        if (!row) continue;
        const intent = intentFor(row);
        if (intent && (entry.createdBySessionId === undefined || !matches(intent, entry.parentSessionId, entry.createdBySessionId))) { protectedIds.add(row.id); continue; }
        if (intent && matches(intent, row.parent_session_id ?? null, row.created_by_session_id ?? null)) confirmedIds.add(row.id);
        const moved = (row.parent_session_id ?? null) !== entry.parentSessionId;
        proposed.set(row.id, { ...row, parent_session_id: entry.parentSessionId, created_by_session_id: moved ? entry.parentSessionId : row.created_by_session_id });
      }
      // Read a workspace graph only when the snapshot moves a row in it.
      const graphs = new Map<string, HierarchyRow[]>();
      for (const [id, next] of proposed) {
        const row = current.get(id)!;
        if ((row.parent_session_id ?? null) !== (next.parent_session_id ?? null) && !graphs.has(row.workspace_id)) {
          graphs.set(row.workspace_id, await readHierarchy(db, row.workspace_id));
        }
      }
      let failure: string | undefined;
      try {
        for (const rows of graphs.values()) {
          const finalGraph = rows.map(row => proposed.get(row.id) ?? row);
          // Only moved rows need checking: each check walks the row's ancestors and
          // its whole subtree, so it covers every unmoved row it could affect.
          // Validating every snapshot entry rebuilt the workspace graph per row
          // and made each fetchIndex quadratic in session count.
          for (const row of finalGraph) {
            if (proposed.has(row.id) && (current.get(row.id)?.parent_session_id ?? null) !== (row.parent_session_id ?? null)) {
              assertHierarchyPlacement(finalGraph, row, row.parent_session_id);
            }
          }
        }
      } catch (error) { failure = String(error); }
      if (!isCurrent()) failure = 'Superseded hierarchy snapshot';
      if (failure) return entries.map(entry => current.has(entry.sessionId) ? canonical(current.get(entry.sessionId)!, false, failure) : { ...entry, createdBySessionId: null, accepted: false, error: SESSION_NOT_HOSTED });
      const statements: HierarchyStatement[] = [];
      const moves: Array<{ old: HierarchyRow; next: HierarchyRow }> = [];
      for (const [id, next] of proposed) {
        const old = current.get(id)!;
        const changed = old.parent_session_id !== next.parent_session_id || old.created_by_session_id !== next.created_by_session_id;
        if (!changed && !confirmedIds.has(id)) continue;
        const patch = changed ? managerReassignmentMetadata(old, next.created_by_session_id ?? null) : {};
        const base = confirmedIds.has(id) ? "(COALESCE(metadata, '{}'::jsonb) - 'hierarchySyncIntent')" : "COALESCE(metadata, '{}'::jsonb)";
        statements.push({ sql: `UPDATE ai_sessions SET parent_session_id=$2, created_by_session_id=$3,
          metadata=${sessionMetadataMergeSql(base, 4, patch)} WHERE id=$1 RETURNING id`, params: [id, next.parent_session_id, next.created_by_session_id, JSON.stringify(patch)], expectedRows: 1 });
        if (changed) moves.push({ old, next });
      }
      if (!isCurrent()) return entries.map(entry => current.has(entry.sessionId) ? canonical(current.get(entry.sessionId)!, false, 'Superseded hierarchy snapshot') : { ...entry, createdBySessionId: null, accepted: false, error: SESSION_NOT_HOSTED });
      if (statements.length) await db.runTransaction(statements);
      for (const { old, next } of moves) await publishHierarchyMove({ sessionId: old.id, workspaceId: old.workspace_id, title: old.title || 'Untitled Session',
        previousParentId: old.parent_session_id, previousManagerId: old.created_by_session_id, parentId: next.parent_session_id, managerId: next.created_by_session_id, source: 'remote' });
      return entries.map(entry => {
        const row = proposed.get(entry.sessionId) ?? current.get(entry.sessionId);
        return row ? canonical(row, !protectedIds.has(row.id), protectedIds.has(row.id) ? 'Local hierarchy intent pending' : undefined)
          : { ...entry, createdBySessionId: null, accepted: false, error: SESSION_NOT_HOSTED };
      });
    }),
  };
}
