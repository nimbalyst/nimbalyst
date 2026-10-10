/**
 * SQL for personal pages (schemas 0049 to 0051). Every query here runs on both
 * PGLite and better-sqlite3: whole columns only, `$N` params, Date objects bound
 * for timestamps and read back through `toMillis()`.
 *
 * Since 0050 the tree is one page tree: a document's `parent_folder_id` names
 * its parent page. `personal_page_folders` is only the record of the tree
 * before that migration and is never read or written here. Since 0051 every
 * parent column has a `parent_kind` beside it: 'page', or 'item' when the
 * parent is a typed page (a tracker item id); pages carry a `sort_order`.
 */
import type { PageFields, SharedDocument, SharedItemPlacement, SharedParentKind, SharedTypePlacement } from '@nimbalyst/collab-client/docs';
import { applyPageFieldsPatch, normalizePageFields } from '@nimbalyst/collab-client/docs';
import { toMillis } from '../../utils/timestampUtils';

export interface PersonalPagesDb {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  runTransaction(statements: Array<{ sql: string; params?: any[] }>): Promise<void>;
}

interface DocumentRow {
  document_id: string;
  title: string;
  document_type: string;
  editor_id: string | null;
  file_extension: string | null;
  metadata_version: number | string | null;
  parent_folder_id: string | null;
  parent_kind: string | null;
  sort_order: number | string | null;
  created_at: unknown;
  updated_at: unknown;
  trashed_at: unknown;
  fields: string | null;
}

interface PlacementRow {
  type_id: string;
  parent_folder_id: string | null;
  parent_kind: string | null;
  sort_order: number | string;
  created_at: unknown;
  updated_at: unknown;
}

interface ItemPlacementRow {
  item_id: string;
  parent_id: string | null;
  parent_kind: string | null;
  sort_order: number | string;
  created_at: unknown;
  updated_at: unknown;
}

const LOCAL_AUTHOR = 'local';
const parentKindOf = (value: string | null): SharedParentKind => (value === 'item' ? 'item' : 'page');
/** Mirrors `TYPE_PAGE_DOCUMENT_PREFIX` in collab-client (not imported: main must not load that module graph). */
const TYPE_PAGE_PREFIX = 'type-page:';

export async function listDocuments(db: PersonalPagesDb, ws: string): Promise<SharedDocument[]> {
  const { rows } = await db.query<DocumentRow>(
    `SELECT document_id, title, document_type, editor_id, file_extension, metadata_version, parent_folder_id,
            parent_kind, sort_order, created_at, updated_at, trashed_at, fields
     FROM personal_page_documents WHERE workspace_path = $1 ORDER BY created_at, document_id`,
    [ws],
  );
  return rows.map((row) => ({
    documentId: row.document_id,
    teamProjectId: null,
    title: row.title,
    documentType: row.document_type,
    // A page converted from a folder has no type metadata; it is inferred.
    ...(Number(row.metadata_version) === 2 ? { metadataVersion: 2 as const } : {}),
    ...(row.file_extension ? { fileExtension: row.file_extension } : {}),
    ...(row.editor_id ? { editorId: row.editor_id } : {}),
    createdBy: LOCAL_AUTHOR,
    createdAt: toMillis(row.created_at) ?? 0,
    updatedAt: toMillis(row.updated_at) ?? 0,
    parentFolderId: row.parent_folder_id ?? null,
    parentKind: parentKindOf(row.parent_kind),
    sortOrder: row.sort_order === null || row.sort_order === undefined ? null : Number(row.sort_order),
    trashedAt: toMillis(row.trashed_at),
    ...pageFieldsOf(row.fields),
  }));
}

/** The row's stored fields, validated; nothing when none are set or the JSON is bad. */
function pageFieldsOf(json: string | null): { fields?: PageFields } {
  if (!json) return {};
  try {
    const fields = normalizePageFields(JSON.parse(json));
    return Object.keys(fields).length > 0 ? { fields } : {};
  } catch {
    return {};
  }
}

/** Applies a fields patch to one page; false when the page is not in this workspace. */
export async function patchDocumentFields(
  db: PersonalPagesDb,
  ws: string,
  documentId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { rows } = await db.query<{ fields: string | null }>(
    'SELECT fields FROM personal_page_documents WHERE workspace_path = $1 AND document_id = $2',
    [ws, documentId],
  );
  if (rows.length === 0) return false;
  const next = applyPageFieldsPatch(pageFieldsOf(rows[0].fields).fields, patch);
  return updateDocument(db, ws, documentId, { fields: Object.keys(next).length > 0 ? JSON.stringify(next) : null });
}

export async function listTypePlacements(db: PersonalPagesDb, ws: string): Promise<SharedTypePlacement[]> {
  const { rows } = await db.query<PlacementRow>(
    `SELECT type_id, parent_folder_id, parent_kind, sort_order, created_at, updated_at
     FROM personal_page_type_placements WHERE workspace_path = $1 ORDER BY sort_order, type_id`,
    [ws],
  );
  return rows.map((row) => ({
    typeId: row.type_id,
    projectId: null,
    parentFolderId: row.parent_folder_id ?? null,
    parentKind: parentKindOf(row.parent_kind),
    sortOrder: Number(row.sort_order),
    createdBy: LOCAL_AUTHOR,
    createdAt: toMillis(row.created_at) ?? 0,
    updatedAt: toMillis(row.updated_at) ?? 0,
  }));
}

export async function listItemPlacements(db: PersonalPagesDb, ws: string): Promise<SharedItemPlacement[]> {
  const { rows } = await db.query<ItemPlacementRow>(
    `SELECT item_id, parent_id, parent_kind, sort_order, created_at, updated_at
     FROM personal_page_item_placements WHERE workspace_path = $1 ORDER BY sort_order, item_id`,
    [ws],
  );
  return rows.map((row) => ({
    itemId: row.item_id,
    projectId: null,
    parentId: row.parent_id ?? null,
    parentKind: parentKindOf(row.parent_kind),
    sortOrder: Number(row.sort_order),
    createdBy: LOCAL_AUTHOR,
    createdAt: toMillis(row.created_at) ?? 0,
    updatedAt: toMillis(row.updated_at) ?? 0,
  }));
}

/** Update named columns of one row. Column names come from callers in this module only. */
async function updateRow(
  db: PersonalPagesDb,
  table: 'personal_page_documents',
  keyColumn: 'document_id',
  ws: string,
  id: string,
  values: Record<string, unknown>,
): Promise<boolean> {
  const columns = Object.keys(values);
  const assignments = columns.map((column, index) => `${column} = $${index + 3}`);
  const { rows } = await db.query(
    `UPDATE ${table} SET ${assignments.join(', ')}, updated_at = $${columns.length + 3}
     WHERE workspace_path = $1 AND ${keyColumn} = $2 RETURNING ${keyColumn}`,
    [ws, id, ...columns.map((column) => values[column]), new Date()],
  );
  return rows.length > 0;
}

export const updateDocument = (db: PersonalPagesDb, ws: string, documentId: string, values: Record<string, unknown>) =>
  updateRow(db, 'personal_page_documents', 'document_id', ws, documentId, values);

export async function upsertDocument(
  db: PersonalPagesDb,
  ws: string,
  doc: {
    documentId: string;
    title: string;
    documentType: string;
    parentFolderId: string | null;
    parentKind: SharedParentKind;
    sortOrder: number | null;
    editorId: string | null;
    fileExtension: string | null;
  },
): Promise<void> {
  const now = new Date();
  // Re-registering an existing id refreshes its metadata; the body, its
  // version and the trash state are left alone. A page registered without type
  // metadata (one made as a container) records none, like a converted folder.
  const metadataVersion = doc.editorId || doc.fileExtension ? 2 : null;
  await db.query(
    `INSERT INTO personal_page_documents
       (workspace_path, document_id, title, document_type, editor_id, file_extension,
        metadata_version, parent_folder_id, parent_kind, sort_order, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $9, $7, $10, $11, $8, $8)
     ON CONFLICT (workspace_path, document_id) DO UPDATE SET
       title = EXCLUDED.title,
       document_type = EXCLUDED.document_type,
       editor_id = EXCLUDED.editor_id,
       file_extension = EXCLUDED.file_extension,
       metadata_version = EXCLUDED.metadata_version,
       parent_folder_id = EXCLUDED.parent_folder_id,
       parent_kind = EXCLUDED.parent_kind,
       sort_order = EXCLUDED.sort_order,
       updated_at = EXCLUDED.updated_at`,
    [
      ws, doc.documentId, doc.title, doc.documentType, doc.editorId, doc.fileExtension, doc.parentFolderId, now,
      metadataVersion, doc.parentKind, doc.sortOrder,
    ],
  );
}

/** A root markdown page with its body, unless the id is already taken (never an overwrite). */
export async function insertDocumentIfAbsent(
  db: PersonalPagesDb,
  ws: string,
  doc: { documentId: string; title: string; fileExtension: string; editorId: string; body: string },
): Promise<void> {
  const now = new Date();
  await db.query(
    `INSERT INTO personal_page_documents
       (workspace_path, document_id, title, document_type, editor_id, file_extension,
        metadata_version, parent_folder_id, parent_kind, sort_order, body, body_version, created_at, updated_at)
     VALUES ($1, $2, $3, 'markdown', $4, $5, 2, NULL, 'page', NULL, $6, 1, $7, $7)
     ON CONFLICT (workspace_path, document_id) DO NOTHING`,
    [ws, doc.documentId, doc.title, doc.editorId, doc.fileExtension, doc.body, now],
  );
}

export async function upsertTypePlacement(
  db: PersonalPagesDb,
  ws: string,
  placement: { typeId: string; parentFolderId: string | null; parentKind: SharedParentKind; sortOrder: number },
): Promise<void> {
  const now = new Date();
  // The type page's prose (`type-page:<typeId>`) belongs to the type and moves
  // with it in the same transaction, so removing the page the type used to sit
  // under cannot take the prose along.
  await db.runTransaction([
    {
      sql: `INSERT INTO personal_page_type_placements
              (workspace_path, type_id, parent_folder_id, parent_kind, sort_order, created_at, updated_at)
            VALUES ($1, $2, $3, $6, $4, $5, $5)
            ON CONFLICT (workspace_path, type_id) DO UPDATE SET
              parent_folder_id = EXCLUDED.parent_folder_id,
              parent_kind = EXCLUDED.parent_kind,
              sort_order = EXCLUDED.sort_order,
              updated_at = EXCLUDED.updated_at`,
      params: [ws, placement.typeId, placement.parentFolderId, placement.sortOrder, now, placement.parentKind],
    },
    {
      sql: `UPDATE personal_page_documents SET parent_folder_id = $3, parent_kind = $5, updated_at = $4
            WHERE workspace_path = $1 AND document_id = $2`,
      params: [ws, `${TYPE_PAGE_PREFIX}${placement.typeId}`, placement.parentFolderId, now, placement.parentKind],
    },
  ]);
}

export async function upsertItemPlacement(
  db: PersonalPagesDb,
  ws: string,
  placement: { itemId: string; parentId: string | null; parentKind: SharedParentKind; sortOrder: number },
): Promise<void> {
  const now = new Date();
  await db.query(
    `INSERT INTO personal_page_item_placements
       (workspace_path, item_id, parent_id, parent_kind, sort_order, created_at, updated_at)
     VALUES ($1, $2, $3, $6, $4, $5, $5)
     ON CONFLICT (workspace_path, item_id) DO UPDATE SET
       parent_id = EXCLUDED.parent_id,
       parent_kind = EXCLUDED.parent_kind,
       sort_order = EXCLUDED.sort_order,
       updated_at = EXCLUDED.updated_at`,
    [ws, placement.itemId, placement.parentId, placement.sortOrder, now, placement.parentKind],
  );
}

export async function deleteItemPlacement(db: PersonalPagesDb, ws: string, itemId: string): Promise<void> {
  await db.query(
    `DELETE FROM personal_page_item_placements WHERE workspace_path = $1 AND item_id = $2`,
    [ws, itemId],
  );
}

/**
 * Delete a page for good only while it is still in Trash with the trash time
 * the caller read: a page another window restored, or restored and trashed
 * again, since that read is not the page the caller saw and stays. The check
 * and the delete are one statement. Returns how many pages went (0 or 1).
 */
export async function deleteTrashedDocument(db: PersonalPagesDb, ws: string, documentId: string, trashedAt: Date): Promise<number> {
  const { rows } = await db.query(
    `DELETE FROM personal_page_documents WHERE workspace_path = $1 AND document_id = $2 AND trashed_at = $3 RETURNING document_id`,
    [ws, documentId, trashedAt],
  );
  return rows.length;
}

export async function deleteTypePlacement(db: PersonalPagesDb, ws: string, typeId: string): Promise<void> {
  await db.query(
    `DELETE FROM personal_page_type_placements WHERE workspace_path = $1 AND type_id = $2`,
    [ws, typeId],
  );
}

/**
 * A page and every page below it, by page parents only: what sits under a typed
 * page stays with that typed page wherever it now lives. `UNION` (not `UNION
 * ALL`) stops the walk on a corrupt parent cycle. With `trashedOnly` the root
 * must still be in Trash with the trash time in `$3`, the one the caller read,
 * and the walk stays inside Trash, so a live page is never a member. Membership is computed
 * by each statement inside its transaction, never captured beforehand: a page
 * moved out of the subtree before the transaction takes the write lock is no
 * longer a member.
 */
const pageSubtree = (trashedOnly: boolean) => `WITH RECURSIVE subtree(document_id) AS (
      SELECT document_id FROM personal_page_documents WHERE workspace_path = $1 AND document_id = $2${trashedOnly ? ' AND trashed_at = $3' : ''}
      UNION
      SELECT d.document_id FROM personal_page_documents d
      JOIN subtree s ON d.parent_folder_id = s.document_id
      WHERE d.workspace_path = $1 AND d.parent_kind = 'page'${trashedOnly ? ' AND d.trashed_at IS NOT NULL' : ''}
    )`;

/**
 * A type page's prose belongs to its type, not to the page it sits under: when
 * its type is placed outside the subtree it moves to the type's parent page
 * (or root) instead of going with the subtree. Must run while the type
 * placements still exist.
 */
const moveOutsideTypeProse = (subtree: string) => `${subtree} UPDATE personal_page_documents
            SET parent_folder_id = (
              SELECT tp.parent_folder_id FROM personal_page_type_placements tp
              WHERE tp.workspace_path = $1 AND '${TYPE_PAGE_PREFIX}' || tp.type_id = personal_page_documents.document_id
                AND NOT (tp.parent_kind = 'page' AND tp.parent_folder_id IN (SELECT document_id FROM subtree))
            ),
            parent_kind = COALESCE((
              SELECT tp.parent_kind FROM personal_page_type_placements tp
              WHERE tp.workspace_path = $1 AND '${TYPE_PAGE_PREFIX}' || tp.type_id = personal_page_documents.document_id
                AND NOT (tp.parent_kind = 'page' AND tp.parent_folder_id IN (SELECT document_id FROM subtree))
            ), 'page')
            WHERE workspace_path = $1
              AND document_id LIKE '${TYPE_PAGE_PREFIX}%'
              AND parent_kind = 'page'
              AND parent_folder_id IN (SELECT document_id FROM subtree)
              AND NOT EXISTS (
                SELECT 1 FROM personal_page_type_placements tp
                WHERE tp.workspace_path = $1 AND '${TYPE_PAGE_PREFIX}' || tp.type_id = personal_page_documents.document_id
                  AND tp.parent_kind = 'page' AND tp.parent_folder_id IN (SELECT document_id FROM subtree)
              )`;

/**
 * Move a page and every page below it to Trash with one trash time, all or
 * nothing, so restore brings the subtree back together. A page already in
 * Trash keeps its own time. Placements under the subtree stay: its types and
 * typed pages show in their usual place meanwhile and are back under it once
 * it is restored. Nothing is deleted.
 */
export async function trashPageSubtree(db: PersonalPagesDb, ws: string, rootPageId: string, trashedAt: Date): Promise<void> {
  const subtree = pageSubtree(false);
  await db.runTransaction([
    { sql: moveOutsideTypeProse(subtree), params: [ws, rootPageId] },
    {
      sql: `${subtree} UPDATE personal_page_documents SET trashed_at = $3, updated_at = $3
            WHERE workspace_path = $1 AND trashed_at IS NULL AND document_id IN (SELECT document_id FROM subtree)`,
      params: [ws, rootPageId, trashedAt],
    },
  ]);
}

/**
 * Delete for good a page in Trash and the pages in Trash below it, all or
 * nothing. Only pages in Trash are members: a live page below one is moved to
 * the root, never deleted. A root that is no longer in Trash with `trashedAt`
 * (the time the caller read; another window restored it, or restored and
 * trashed it again) deletes nothing, because every statement checks it inside
 * the transaction. Types and typed pages placed under a deleted page lose
 * their placement (they fall back to root and under their type); no tracker
 * item is touched.
 */
export async function purgeTrashedPageSubtree(db: PersonalPagesDb, ws: string, rootPageId: string, trashedAt: Date): Promise<void> {
  const subtree = pageSubtree(true);
  const params = [ws, rootPageId, trashedAt];
  await db.runTransaction([
    { sql: moveOutsideTypeProse(subtree), params },
    {
      sql: `${subtree} UPDATE personal_page_documents SET parent_folder_id = NULL, parent_kind = 'page'
            WHERE workspace_path = $1 AND parent_kind = 'page' AND trashed_at IS NULL
              AND parent_folder_id IN (SELECT document_id FROM subtree)`,
      params,
    },
    {
      sql: `${subtree} DELETE FROM personal_page_type_placements
            WHERE workspace_path = $1 AND parent_kind = 'page' AND parent_folder_id IN (SELECT document_id FROM subtree)`,
      params,
    },
    {
      sql: `${subtree} DELETE FROM personal_page_item_placements
            WHERE workspace_path = $1 AND parent_kind = 'page' AND parent_id IN (SELECT document_id FROM subtree)`,
      params,
    },
    {
      sql: `${subtree} DELETE FROM personal_page_documents
            WHERE workspace_path = $1 AND document_id IN (SELECT document_id FROM subtree)`,
      params,
    },
  ]);
}

/** Whether a tracker item (a typed page) exists in this workspace and is not deleted. */
export async function itemType(db: PersonalPagesDb, ws: string, itemId: string): Promise<string | null> {
  const { rows } = await db.query<{ type: string }>(
    `SELECT type FROM tracker_items WHERE id = $1 AND workspace = $2 AND deleted_at IS NULL LIMIT 1`,
    [itemId, ws],
  );
  return rows[0]?.type ?? null;
}

export async function readBody(
  db: PersonalPagesDb,
  ws: string,
  documentId: string,
): Promise<{ content: string; version: number } | null> {
  const { rows } = await db.query<{ body: string | null; body_version: number | string }>(
    `SELECT body, body_version FROM personal_page_documents WHERE workspace_path = $1 AND document_id = $2`,
    [ws, documentId],
  );
  const row = rows[0];
  return row ? { content: row.body ?? '', version: Number(row.body_version) } : null;
}

/**
 * Write a body, conditionally on `expectedVersion` when one is given. The
 * check and the write are one statement, so a concurrent writer cannot slip
 * between them. Returns the new version, or null when the condition failed.
 */
export async function writeBody(
  db: PersonalPagesDb,
  ws: string,
  documentId: string,
  content: string,
  expectedVersion: number | undefined,
): Promise<number | null> {
  const conditional = expectedVersion !== undefined;
  const { rows } = await db.query<{ body_version: number | string }>(
    `UPDATE personal_page_documents
     SET body = $3, body_version = body_version + 1, updated_at = $4
     WHERE workspace_path = $1 AND document_id = $2${conditional ? ' AND body_version = $5' : ''}
     RETURNING body_version`,
    conditional ? [ws, documentId, content, new Date(), expectedVersion] : [ws, documentId, content, new Date()],
  );
  return rows[0] ? Number(rows[0].body_version) : null;
}
