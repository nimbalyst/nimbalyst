/**
 * Local-only derived relationship index (Epic C Phase 2).
 *
 * Relationship FIELD values are canonical and sync on the metadata socket like
 * `labels`; this store maintains the `tracker_relationship_index` projection of
 * those values so reverse lookup ("what links to X?") and backlinks are a single
 * indexed query instead of a full scan. The index is NEVER synced — it is
 * rebuilt locally from item JSON whenever an item is written.
 *
 * All ops are best-effort and injectable (`dbOverride`) so they unit-test
 * against a real in-memory SQLite without the global app database.
 */
import type { FieldDefinition, RelationshipEdge } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { deriveRelationshipEdges } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getDatabase } from '../../database/initialize';
import { logger } from '../../utils/logger';
import { flattenDataForRead } from './relationshipFieldStorage';
import {
  BODY_LINK_FIELD_PREFIX,
  bodyLinkHomeScope,
  bodyLinkKeys,
  bodyMarkdownOf,
  deriveBodyLinkEdges,
  type ResolvedLinkTarget,
} from './trackerBodyLinks';

export interface RelationshipIndexDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] } | unknown>;
}

function edgeId(workspace: string, sourceItemId: string, fieldId: string, targetItemId: string): string {
  return `${workspace}|${sourceItemId}|${fieldId}|${targetItemId}`;
}

/** A row read back from the index. */
export interface RelationshipIndexRow {
  sourceItemId: string;
  sourceFieldId: string;
  relationshipTypeKey: string | null;
  targetItemId: string;
  targetTrackerType: string | null;
  predicate: string | null;
  metadata: Record<string, unknown>;
}

export interface RelationshipReindexItem {
  workspace: string;
  sourceItemId: string;
  fields: Record<string, unknown> | undefined;
  fieldDefs: FieldDefinition[];
  sourceUpdatedAt: string | null;
}

function rowsOf(result: unknown): any[] {
  const r = result as { rows?: unknown[] } | undefined;
  return Array.isArray(r?.rows) ? (r!.rows as any[]) : [];
}

/** PGLite JSONB returns an object; SQLite TEXT returns a string (DATABASE.md). */
function parseMeta(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string' && value) {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return {};
}

async function upsertRelationshipEdges(
  workspace: string,
  sourceItemId: string,
  edges: RelationshipEdge[],
  sourceUpdatedAt: string | null,
  db: RelationshipIndexDb,
): Promise<void> {
  for (const e of edges) {
    await db.query(
      `INSERT INTO tracker_relationship_index
         (id, workspace, source_item_id, source_field_id, relationship_type_key,
          target_item_id, target_tracker_type, source_updated_at, metadata, predicate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (workspace, source_item_id, source_field_id, target_item_id) DO UPDATE
         SET relationship_type_key = EXCLUDED.relationship_type_key,
             target_tracker_type   = EXCLUDED.target_tracker_type,
             source_updated_at     = EXCLUDED.source_updated_at,
             metadata              = EXCLUDED.metadata,
             predicate             = EXCLUDED.predicate`,
      [
        edgeId(workspace, sourceItemId, e.sourceFieldId, e.targetItemId),
        workspace,
        sourceItemId,
        e.sourceFieldId,
        e.relationshipTypeKey ?? null,
        e.targetItemId,
        e.targetTrackerType ?? null,
        sourceUpdatedAt,
        JSON.stringify(e.metadata ?? {}),
        e.predicate ?? null,
      ],
    );
  }
}

/** Field-derived rows only; body links (`body:*`) are replaced by their own reindex. */
const FIELD_ROWS_ONLY = `source_field_id NOT LIKE '${BODY_LINK_FIELD_PREFIX}%'`;

/**
 * Replace the field-derived outgoing edges for one source item with `edges`
 * (delete-then-insert). Body-link rows are left alone. Called after an item
 * write; idempotent and safe to re-run.
 */
export async function rebuildItemRelationships(
  workspace: string,
  sourceItemId: string,
  edges: RelationshipEdge[],
  sourceUpdatedAt: string | null,
  dbOverride?: RelationshipIndexDb,
): Promise<void> {
  try {
    const db = dbOverride ?? (getDatabase() as RelationshipIndexDb | null);
    if (!db) return;
    await db.query(
      `DELETE FROM tracker_relationship_index
       WHERE workspace = $1 AND source_item_id = $2 AND ${FIELD_ROWS_ONLY}`,
      [workspace, sourceItemId],
    );
    await upsertRelationshipEdges(workspace, sourceItemId, edges, sourceUpdatedAt, db);
  } catch (err) {
    logger.main.warn('[trackerRelationshipIndexStore] rebuild failed for', sourceItemId, err);
  }
}

/** Resolve body-link KEYs (issue key or raw id) to items in the same workspace. */
async function resolveLinkTargets(
  workspace: string,
  keys: string[],
  db: RelationshipIndexDb,
): Promise<Map<string, ResolvedLinkTarget>> {
  const resolved = new Map<string, ResolvedLinkTarget>();
  if (keys.length === 0) return resolved;
  const placeholders = keys.map((_, index) => `$${index + 2}`).join(', ');
  const result = await db.query(
    `SELECT id, type, issue_key FROM tracker_items
     WHERE workspace = $1 AND deleted_at IS NULL
       AND (id IN (${placeholders}) OR issue_key IN (${placeholders}))`,
    [workspace, ...keys],
  );
  for (const row of rowsOf(result)) {
    const target = { itemId: row.id, type: row.type };
    resolved.set(row.id, target);
    if (row.issue_key) resolved.set(row.issue_key, target);
  }
  return resolved;
}

/**
 * Replace one item's body-link rows (`body:*`) with the links in `body`
 * (markdown string or `{ markdown }`). Field-derived rows are left alone.
 */
export async function reindexItemBodyLinks(
  workspace: string,
  sourceItemId: string,
  body: unknown,
  sourceUpdatedAt: string | null,
  dbOverride?: RelationshipIndexDb,
): Promise<void> {
  try {
    const db = dbOverride ?? (getDatabase() as RelationshipIndexDb | null);
    if (!db) return;
    const markdown = bodyMarkdownOf(body);
    // Another team project's links never resolve to this workspace's items.
    const scope = { homeScope: bodyLinkHomeScope(workspace) };
    const targets = await resolveLinkTargets(workspace, bodyLinkKeys(markdown, scope), db);
    const edges = deriveBodyLinkEdges(sourceItemId, markdown, (key) => targets.get(key), scope);
    await db.query(
      `DELETE FROM tracker_relationship_index
       WHERE workspace = $1 AND source_item_id = $2 AND source_field_id LIKE '${BODY_LINK_FIELD_PREFIX}%'`,
      [workspace, sourceItemId],
    );
    await upsertRelationshipEdges(workspace, sourceItemId, edges, sourceUpdatedAt, db);
  } catch (err) {
    logger.main.warn('[trackerRelationshipIndexStore] body-link reindex failed for', sourceItemId, err);
  }
}

/** Drop all outgoing edges for an item (call when the item is deleted). */
export async function removeItemRelationships(
  workspace: string,
  sourceItemId: string,
  dbOverride?: RelationshipIndexDb,
): Promise<void> {
  try {
    const db = dbOverride ?? (getDatabase() as RelationshipIndexDb | null);
    if (!db) return;
    await db.query(
      `DELETE FROM tracker_relationship_index WHERE workspace = $1 AND source_item_id = $2`,
      [workspace, sourceItemId],
    );
  } catch (err) {
    logger.main.warn('[trackerRelationshipIndexStore] remove failed for', sourceItemId, err);
  }
}

function mapRow(r: any): RelationshipIndexRow {
  return {
    sourceItemId: r.source_item_id,
    sourceFieldId: r.source_field_id,
    relationshipTypeKey: r.relationship_type_key ?? null,
    targetItemId: r.target_item_id,
    targetTrackerType: r.target_tracker_type ?? null,
    predicate: r.predicate ?? null,
    metadata: parseMeta(r.metadata),
  };
}

/** Outgoing edges from an item ("what does X link to?"). */
export async function getOutgoingRelationships(
  workspace: string,
  sourceItemId: string,
  dbOverride?: RelationshipIndexDb,
): Promise<RelationshipIndexRow[]> {
  try {
    const db = dbOverride ?? (getDatabase() as RelationshipIndexDb | null);
    if (!db) return [];
    const result = await db.query(
      `SELECT * FROM tracker_relationship_index
       WHERE workspace = $1 AND source_item_id = $2
       ORDER BY source_field_id, target_item_id`,
      [workspace, sourceItemId],
    );
    return rowsOf(result).map(mapRow);
  } catch (err) {
    logger.main.warn('[trackerRelationshipIndexStore] getOutgoing failed for', sourceItemId, err);
    return [];
  }
}

/**
 * Derive a single item's relationship edges from its fields bag + the schema
 * field definitions for its type, then replace its index rows. The fields bag is
 * the parsed `data` column; relationship values may sit top-level (local) or
 * nested under `data.customFields` (synced), so flatten first (NIM-1305).
 */
export async function reindexItemRelationships(
  workspace: string,
  sourceItemId: string,
  fields: Record<string, unknown> | undefined,
  fieldDefs: FieldDefinition[],
  sourceUpdatedAt: string | null,
  dbOverride?: RelationshipIndexDb,
): Promise<void> {
  const edges = deriveRelationshipEdges(sourceItemId, flattenDataForRead(fields), fieldDefs);
  await rebuildItemRelationships(workspace, sourceItemId, edges, sourceUpdatedAt, dbOverride);
}

/**
 * Normalize a tracker row's `updated` column to ISO. SQLite hands back a
 * string, PGLite a Date.
 */
export function trackerRowUpdatedToIso(updated: unknown): string | null {
  if (typeof updated === 'string') return updated;
  if (updated instanceof Date) return updated.toISOString();
  return updated ? new Date(updated as never).toISOString() : null;
}

/**
 * Reindex one item straight after a main-process write.
 *
 * Until this existed the index was maintained ONLY by
 * `document-service:tracker-item-reindex-relationships`, which the renderer
 * calls after editing a relationship field. Anything written without a renderer
 * in the loop -- every MCP `tracker_create`/`tracker_update`, the CLI, the
 * commit linker -- produced an item whose relationship values were stored
 * correctly and whose edges did not exist, so backlinks and reverse lookup
 * silently returned nothing. An agent-authored graph had no edges at all.
 *
 * Best-effort by design: the index is a rebuildable projection, so a failure
 * here is logged and the write still stands. It must never be able to fail a
 * tracker write.
 *
 * `body` is the item's body when this write changed it (markdown or
 * `{ markdown }`); pass `undefined` when the body was not part of the write so
 * its link rows stay as they are.
 */
export async function reindexItemRelationshipsAfterWrite(
  workspace: string,
  sourceItemId: string,
  fields: Record<string, unknown> | undefined,
  fieldDefs: FieldDefinition[],
  sourceUpdatedAt: string | null,
  dbOverride?: RelationshipIndexDb,
  body?: unknown,
): Promise<void> {
  try {
    // A type with no relationship fields is the common case; skip the field
    // reindex rather than paying a delete per item save. Body links still count.
    if (fieldDefs.some(def => def.type === 'relationship' || def.type === 'reference')) {
      await reindexItemRelationships(workspace, sourceItemId, fields, fieldDefs, sourceUpdatedAt, dbOverride);
    }
    if (body !== undefined) {
      await reindexItemBodyLinks(workspace, sourceItemId, body, sourceUpdatedAt, dbOverride);
    }
  } catch (error) {
    logger.main.warn(`[relationshipIndex] reindex after write failed for ${sourceItemId}:`, error);
  }
}

/**
 * Reindex multiple source items after one bounded IPC request. Items are grouped
 * by workspace so each group pays one delete instead of one delete per item;
 * edge upserts remain per edge because both supported backends share that safe
 * parameter shape.
 */
export async function reindexItemsRelationships(
  items: RelationshipReindexItem[],
  dbOverride?: RelationshipIndexDb,
): Promise<void> {
  try {
    const db = dbOverride ?? (getDatabase() as RelationshipIndexDb | null);
    if (!db || items.length === 0) return;

    const byWorkspace = new Map<string, RelationshipReindexItem[]>();
    for (const item of items) {
      const group = byWorkspace.get(item.workspace) ?? [];
      group.push(item);
      byWorkspace.set(item.workspace, group);
    }

    for (const [workspace, group] of byWorkspace) {
      const placeholders = group.map((_, index) => `$${index + 2}`).join(', ');
      await db.query(
        `DELETE FROM tracker_relationship_index
         WHERE workspace = $1 AND source_item_id IN (${placeholders}) AND ${FIELD_ROWS_ONLY}`,
        [workspace, ...group.map(item => item.sourceItemId)],
      );
      for (const item of group) {
        const edges = deriveRelationshipEdges(
          item.sourceItemId,
          flattenDataForRead(item.fields),
          item.fieldDefs,
        );
        await upsertRelationshipEdges(
          workspace,
          item.sourceItemId,
          edges,
          item.sourceUpdatedAt,
          db,
        );
      }
    }
  } catch (err) {
    logger.main.warn('[trackerRelationshipIndexStore] batch rebuild failed', err);
  }
}

/**
 * Full rebuild of a workspace's relationship index from `tracker_items` JSON.
 * Local projection is rebuildable at any time; call on tracker init so existing
 * items are indexed without a re-save. `fieldDefsFor(type)` resolves a type's
 * schema fields (e.g. `globalRegistry.get(type)?.fields ?? []`).
 */
export async function rebuildWorkspaceRelationshipIndex(
  workspace: string,
  fieldDefsFor: (type: string) => FieldDefinition[],
  dbOverride?: RelationshipIndexDb,
): Promise<number> {
  try {
    const db = dbOverride ?? (getDatabase() as RelationshipIndexDb | null);
    if (!db) return 0;
    return await rebuildWorkspaceIndexOrThrow(workspace, fieldDefsFor, db);
  } catch (err) {
    logger.main.warn('[trackerRelationshipIndexStore] workspace rebuild failed for', workspace, err);
    return 0;
  }
}

/**
 * The body to derive links from. A team-shared item's body is edited in its
 * collaborative room and arrives here only as a `tracker_body_cache` row at the
 * item's current `body_version` (see trackerRemoteBodyLinks.ts); remote
 * metadata sync never writes `content`. Local items, and shared items with no
 * cached row at their version, use `content`.
 */
function newestBodyOf(row: { sync_id?: unknown; content?: unknown; cached_content?: unknown }): unknown {
  if (row.sync_id != null && row.cached_content != null) return row.cached_content;
  return row.content;
}

async function rebuildWorkspaceIndexOrThrow(
  workspace: string,
  fieldDefsFor: (type: string) => FieldDefinition[],
  db: RelationshipIndexDb,
): Promise<number> {
  // Tombstoned items (remote deletes keep the row) are neither sources nor targets.
  const result = await db.query(
    `SELECT t.id, t.type, t.data, t.content, t.issue_key, t.updated, t.sync_id, c.content AS cached_content
       FROM tracker_items t
       LEFT JOIN tracker_body_cache c ON c.item_id = t.id AND c.body_version = t.body_version
      WHERE t.workspace = $1 AND t.deleted_at IS NULL`,
    [workspace],
  );
  const rows = rowsOf(result);
  // Body links resolve against this same snapshot: no query per link.
  const targets = new Map<string, ResolvedLinkTarget>();
  for (const row of rows) {
    const target = { itemId: row.id, type: row.type };
    targets.set(row.id, target);
    if (row.issue_key) targets.set(row.issue_key, target);
  }
  // Clear the whole workspace projection first so deleted items drop out.
  await db.query(`DELETE FROM tracker_relationship_index WHERE workspace = $1`, [workspace]);
  let indexed = 0;
  for (const row of rows) {
    const data = parseMeta(row.data);
    const defs = fieldDefsFor(row.type) ?? [];
    const edges = [
      ...deriveRelationshipEdges(row.id, flattenDataForRead(data), defs),
      ...deriveBodyLinkEdges(row.id, bodyMarkdownOf(newestBodyOf(row)), (key) => targets.get(key)),
    ];
    if (edges.length === 0) continue;
    const updatedAt = trackerRowUpdatedToIso(row.updated);
    // No per-item delete needed (workspace was just cleared).
    await upsertRelationshipEdges(workspace, row.id, edges, updatedAt, db);
    indexed += edges.length;
  }
  return indexed;
}

const RELATIONSHIP_INDEX_TTL_MS = 2000;

interface WorkspaceBuildState {
  builtAt: number;
  inflight: Promise<void> | null;
}

/** Per database, so a test's fresh database never inherits another's stamp. */
const buildStateByDb = new WeakMap<object, Map<string, WorkspaceBuildState>>();

/**
 * Lazily (re)build a workspace's index before a read. Rebuilds at most every
 * 2s per workspace so a read burst (backlinks + links on one page open) pays
 * once. A rebuild clears the index before re-inserting, so a reader arriving
 * mid-rebuild awaits the in-flight build instead of reading a half-filled
 * index; the TTL starts when the build finishes. A failed build leaves no
 * stamp, so the next read retries.
 */
export async function ensureWorkspaceRelationshipIndex(
  workspace: string,
  fieldDefsFor: (type: string) => FieldDefinition[],
  dbOverride?: RelationshipIndexDb,
): Promise<void> {
  const db = dbOverride ?? (getDatabase() as RelationshipIndexDb | null);
  if (!db) return;
  let states = buildStateByDb.get(db);
  if (!states) {
    states = new Map();
    buildStateByDb.set(db, states);
  }
  const state = states.get(workspace) ?? { builtAt: 0, inflight: null };
  states.set(workspace, state);
  if (state.inflight) return state.inflight;
  if (Date.now() - state.builtAt < RELATIONSHIP_INDEX_TTL_MS) return;
  state.inflight = (async () => {
    try {
      await rebuildWorkspaceIndexOrThrow(workspace, fieldDefsFor, db);
      state.builtAt = Date.now();
    } catch (err) {
      state.builtAt = 0;
      logger.main.warn('[trackerRelationshipIndexStore] lazy index build failed for', workspace, err);
    } finally {
      state.inflight = null;
    }
  })();
  return state.inflight;
}

/** Incoming edges pointing at an item — the backlinks / "Linked From" set. */
export async function getBacklinks(
  workspace: string,
  targetItemId: string,
  dbOverride?: RelationshipIndexDb,
): Promise<RelationshipIndexRow[]> {
  try {
    const db = dbOverride ?? (getDatabase() as RelationshipIndexDb | null);
    if (!db) return [];
    const result = await db.query(
      `SELECT * FROM tracker_relationship_index
       WHERE workspace = $1 AND target_item_id = $2
       ORDER BY source_item_id`,
      [workspace, targetItemId],
    );
    return rowsOf(result).map(mapRow);
  } catch (err) {
    logger.main.warn('[trackerRelationshipIndexStore] getBacklinks failed for', targetItemId, err);
    return [];
  }
}
