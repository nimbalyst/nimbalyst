/**
 * The Links section of a page: every relationship edge touching an item, in
 * both directions, with the other item's title resolved here so the renderer
 * does not need the other item loaded. Body links (`body:<rel>`, `body:link`)
 * and relationship-field edges come from the same local index.
 */
import type { FieldDefinition, TrackerPageLink } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getDatabase } from '../../database/initialize';
import { BODY_LINK_FIELD_PREFIX } from './trackerBodyLinks';
import {
  ensureWorkspaceRelationshipIndex,
  getBacklinks,
  getOutgoingRelationships,
  type RelationshipIndexDb,
  type RelationshipIndexRow,
} from './trackerRelationshipIndexStore';

function rowsOf(result: unknown): any[] {
  const r = result as { rows?: unknown[] } | undefined;
  return Array.isArray(r?.rows) ? (r!.rows as any[]) : [];
}

/** Select the whole `data` column and parse it; sub-extraction differs by backend. */
function titleOf(data: unknown): string {
  let parsed = data;
  if (typeof data === 'string') {
    try { parsed = JSON.parse(data); } catch { parsed = null; }
  }
  const title = (parsed as { title?: unknown } | null)?.title;
  return typeof title === 'string' ? title : '';
}

/**
 * Every query is constrained to `workspacePath`, the caller's workspace: an
 * item id from another workspace returns nothing rather than that workspace's
 * titles and sentences. Tombstoned items (remote deletes keep the row with
 * `deleted_at` set) have no Links section and never appear in one.
 */
export async function getTrackerItemLinks(
  workspacePath: string,
  itemId: string,
  fieldDefsFor: (type: string) => FieldDefinition[],
  dbOverride?: RelationshipIndexDb,
): Promise<TrackerPageLink[]> {
  const db = dbOverride ?? (getDatabase() as RelationshipIndexDb | null);
  if (!db) return [];
  const self = rowsOf(await db.query(
    `SELECT id FROM tracker_items WHERE id = $1 AND workspace = $2 AND deleted_at IS NULL`,
    [itemId, workspacePath],
  ))[0];
  if (!self) return [];
  const workspace = workspacePath;
  await ensureWorkspaceRelationshipIndex(workspace, fieldDefsFor, db);

  const edges: Array<{ direction: 'out' | 'in'; otherItemId: string; row: RelationshipIndexRow }> = [
    ...(await getOutgoingRelationships(workspace, itemId, db)).map((row) => ({
      direction: 'out' as const, otherItemId: row.targetItemId, row,
    })),
    ...(await getBacklinks(workspace, itemId, db)).map((row) => ({
      direction: 'in' as const, otherItemId: row.sourceItemId, row,
    })),
  ];
  const otherIds = [...new Set(edges.map((edge) => edge.otherItemId))];
  if (otherIds.length === 0) return [];

  const placeholders = otherIds.map((_, index) => `$${index + 2}`).join(', ');
  const others = new Map<string, any>();
  for (const row of rowsOf(await db.query(
    `SELECT id, type, issue_key, data FROM tracker_items
     WHERE workspace = $1 AND deleted_at IS NULL AND id IN (${placeholders})`,
    [workspace, ...otherIds],
  ))) {
    others.set(row.id, row);
  }

  const links: TrackerPageLink[] = [];
  for (const { direction, otherItemId, row } of edges) {
    const other = others.get(otherItemId);
    // A dangling edge (the other item was deleted or tombstoned) has nothing to show.
    if (!other) continue;
    const isBody = row.sourceFieldId.startsWith(BODY_LINK_FIELD_PREFIX);
    const sentence = row.metadata.sentence;
    links.push({
      direction,
      predicateId: row.predicate ?? null,
      relationshipTypeKey: row.relationshipTypeKey ?? null,
      otherItemId,
      otherTitle: titleOf(other.data),
      otherIssueKey: other.issue_key ?? null,
      otherTypeId: other.type,
      sentence: isBody && typeof sentence === 'string' ? sentence : null,
      sourceFieldId: row.sourceFieldId,
    });
  }
  return links;
}
