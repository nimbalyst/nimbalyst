/**
 * Personal pages from the app database, seen from the Local wiki.
 *
 * Before the Local section moved to files, Personal pages were rows in
 * `personal_page_documents` (schemas 0049 to 0051). Those rows are never
 * deleted here. Until the user exports them they stay visible, read through
 * `legacyPersonalSnapshot`, and editable through the old `personal://` path.
 *
 * `exportPersonalPages` runs only when the user chooses Export. It follows the
 * destructive-data rule even though it only writes new files: it logs and
 * emits its event before touching anything, copies each page through the
 * library, reads each one back and compares it, and stops at the first
 * mismatch. The database rows stay as they are, so a failed or partial export
 * loses nothing, and running it again skips what is already in the wiki.
 */
import type { SharedDocument, SharedItemPlacement, SharedTypePlacement } from '@nimbalyst/collab-client/docs';
import { DEFAULT_EDITOR_TYPES, type LocalWiki, type LocalWikiSnapshot } from '@nimbalyst/local-wiki';
import * as store from '../personalPages/personalPagesStore';
import { PERSONAL_HOME_MARKDOWN, PERSONAL_HOME_PAGE_ID } from '../personalPages/personalHomePage';

/** Database pages that are not in the wiki yet. */
export interface LegacyPersonalSnapshot {
  items: SharedDocument[];
  typePlacements: SharedTypePlacement[];
  itemPlacements: SharedItemPlacement[];
  /** Pages (live or in Trash) the Export action would copy. */
  unexportedPageCount: number;
}

export interface PersonalPagesExportReport {
  ok: boolean;
  root: string;
  exported: string[];
  alreadyInWiki: string[];
  /** Pages the format cannot hold (code, or an editor type with no known file extension), left in the database. */
  skipped: Array<{ id: string; title: string; reason: string }>;
  /** Pages whose parent was a typed page, placed at the top of the wiki instead. */
  reparentedToRoot: string[];
  typePlacementsExported: string[];
  /** Placed typed pages: not exported (still in the database); items are never moved without asking. */
  itemPlacementsKept: string[];
  error?: string;
}

export type ExportPhase = 'started' | 'completed' | 'failed';

export interface PersonalPagesExportDeps {
  db: store.PersonalPagesDb;
  workspacePath: string;
  /** The wiki, created when missing: the user asked for files. */
  wiki: () => Promise<LocalWiki>;
  /** Logged and sent as an analytics event; `started` fires before any write. */
  emit: (phase: ExportPhase, details: Record<string, unknown>) => void;
}

/**
 * A type page's prose (`type-page:<typeId>`, collab-client's TYPE_PAGE_DOCUMENT_PREFIX)
 * is stored as a Personal page row but is not a page of the tree. It stays on
 * the database path with its type until typed pages move to files.
 */
const TYPE_PAGE_PREFIX = 'type-page:';
export const isTypePageProse = (documentId: string): boolean => documentId.startsWith(TYPE_PAGE_PREFIX);

/** A Home page the app seeded and nobody touched: nothing of the user's to keep. */
export function isUntouchedSeededHome(document: SharedDocument, body: string | null, documents: SharedDocument[]): boolean {
  return document.documentId === PERSONAL_HOME_PAGE_ID
    && document.title === 'Home'
    && document.trashedAt == null
    && (body ?? '') === PERSONAL_HOME_MARKDOWN
    && !document.fields
    && !documents.some((other) => other.parentFolderId === document.documentId);
}

function wikiIds(snapshot: Pick<LocalWikiSnapshot, 'pages'>): Set<string> {
  return new Set(snapshot.pages.map((page) => page.id));
}

/** Database pages worth keeping that the wiki does not hold yet. */
async function pagesToKeep(db: store.PersonalPagesDb, ws: string): Promise<SharedDocument[]> {
  const documents = await store.listDocuments(db, ws);
  const out: SharedDocument[] = [];
  for (const document of documents) {
    if (document.documentId === PERSONAL_HOME_PAGE_ID) {
      const body = (await store.readBody(db, ws, document.documentId))?.content ?? '';
      if (isUntouchedSeededHome(document, body, documents)) continue;
    }
    out.push(document);
  }
  return out;
}

export async function legacyPersonalSnapshot(
  db: store.PersonalPagesDb,
  ws: string,
  wiki: Pick<LocalWikiSnapshot, 'pages' | 'typePlacements'> | null,
): Promise<LegacyPersonalSnapshot> {
  const inWiki = wiki ? wikiIds(wiki) : new Set<string>();
  const placedInWiki = new Set((wiki?.typePlacements ?? []).map((placement) => placement.typeId));
  // A wiki file can never stand in for a type description: that row stays listed.
  const items = (await pagesToKeep(db, ws)).filter((document) => !inWiki.has(document.documentId) || isTypePageProse(document.documentId));
  const [typePlacements, itemPlacements] = await Promise.all([store.listTypePlacements(db, ws), store.listItemPlacements(db, ws)]);
  return {
    items,
    typePlacements: typePlacements.filter((placement) => !placedInWiki.has(placement.typeId)),
    itemPlacements,
    unexportedPageCount: items.filter((document) => !isTypePageProse(document.documentId) && fileShape(document).ok).length,
  };
}

/** Parents before children, so every page's parent exists when it is written. */
function parentsFirst(documents: SharedDocument[]): SharedDocument[] {
  const byId = new Map(documents.map((document) => [document.documentId, document]));
  const out: SharedDocument[] = [];
  const placed = new Set<string>();
  const visit = (document: SharedDocument, path: Set<string>) => {
    if (placed.has(document.documentId) || path.has(document.documentId)) return;
    path.add(document.documentId);
    const parent = document.parentFolderId && (document.parentKind ?? 'page') === 'page' ? byId.get(document.parentFolderId) : undefined;
    if (parent) visit(parent, path);
    placed.add(document.documentId);
    out.push(document);
  };
  for (const document of documents) visit(document, new Set());
  return out;
}

/**
 * How a database page lands in the wiki: markdown as `Title.md`, any other
 * editor type as its own file with a sidecar. A database title of an editor
 * page carries its extension ("Sketch.excalidraw"); the wiki title does not.
 */
function fileShape(document: SharedDocument):
  | { ok: true; documentType: string; fileExtension: string | null; title: string }
  | { ok: false; reason: string } {
  const documentType = document.documentType ?? 'markdown';
  const rawTitle = document.title.trim() || 'Untitled';
  if (documentType === 'markdown') return { ok: true, documentType, fileExtension: null, title: rawTitle };
  if (documentType === 'code') return { ok: false, reason: 'a code page; the wiki does not hold code files' };
  const known = Object.entries(DEFAULT_EDITOR_TYPES).find(([, type]) => type === documentType)?.[0] ?? null;
  const fileExtension = document.fileExtension?.trim().toLowerCase() || known;
  if (!fileExtension) return { ok: false, reason: `a ${documentType} page with no known file extension` };
  const title = rawTitle.toLowerCase().endsWith(fileExtension) && rawTitle.length > fileExtension.length
    ? rawTitle.slice(0, -fileExtension.length)
    : rawTitle;
  return { ok: true, documentType, fileExtension, title };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

class ExportMismatch extends Error {}

export async function exportPersonalPages(deps: PersonalPagesExportDeps): Promise<PersonalPagesExportReport> {
  const { db, workspacePath: ws } = deps;
  const documents = (await pagesToKeep(db, ws)).filter((document) => !isTypePageProse(document.documentId));
  const [typePlacements, itemPlacements] = await Promise.all([store.listTypePlacements(db, ws), store.listItemPlacements(db, ws)]);
  const report: PersonalPagesExportReport = {
    ok: false,
    root: '',
    exported: [],
    alreadyInWiki: [],
    skipped: [],
    reparentedToRoot: [],
    typePlacementsExported: [],
    itemPlacementsKept: itemPlacements.map((placement) => placement.itemId),
  };
  // Before anything is written, so a death mid-export is still on record.
  deps.emit('started', {
    workspacePath: ws,
    pageCount: documents.length,
    typePlacementCount: typePlacements.length,
    itemPlacementCount: itemPlacements.length,
  });
  try {
    const wiki = await deps.wiki();
    report.root = wiki.root;
    const before = await wiki.snapshot();
    const existing = wikiIds(before);
    const written = new Set<string>();

    for (const document of parentsFirst(documents)) {
      const id = document.documentId;
      if (existing.has(id)) {
        report.alreadyInWiki.push(id);
        written.add(id);
        continue;
      }
      const shape = fileShape(document);
      if (!shape.ok) {
        report.skipped.push({ id, title: document.title, reason: shape.reason });
        continue;
      }
      let parentId: string | null = null;
      if (document.parentFolderId) {
        if ((document.parentKind ?? 'page') === 'page' && written.has(document.parentFolderId)) parentId = document.parentFolderId;
        else report.reparentedToRoot.push(id);
      }
      const { title } = shape;
      const body = (await store.readBody(db, ws, id))?.content ?? '';
      const fields = (document.fields ?? {}) as Record<string, unknown>;
      await wiki.command({
        type: 'register-document',
        documentId: id,
        title,
        parentFolderId: parentId,
        sortOrder: document.sortOrder ?? null,
        fields,
        body,
        documentType: shape.documentType,
        ...(shape.fileExtension ? { fileExtension: shape.fileExtension } : {}),
      });

      // Read back what landed and compare it with the source row.
      const readBack = await wiki.readBody(id);
      if (readBack.markdown !== body) throw new ExportMismatch(`"${title}" (${id}): the body read back differs from the database`);
      const page = (await wiki.snapshot()).pages.find((candidate) => candidate.id === id);
      if (!page) throw new ExportMismatch(`"${title}" (${id}) is not in the wiki after it was written`);
      if (page.title !== title) throw new ExportMismatch(`"${title}" (${id}) reads back as "${page.title}"`);
      if (page.parentId !== parentId) throw new ExportMismatch(`"${title}" (${id}) reads back under ${page.parentId ?? 'the top'}, not ${parentId ?? 'the top'}`);
      if (!sameJson(page.fields, fields)) throw new ExportMismatch(`"${title}" (${id}): its fields read back differently`);

      if (document.trashedAt != null) {
        await wiki.command({ type: 'trash-document', documentId: id, trashedAt: document.trashedAt });
        const trashed = (await wiki.snapshot()).pages.find((candidate) => candidate.id === id);
        if (trashed?.trashedAt == null) throw new ExportMismatch(`"${title}" (${id}) did not reach the wiki's trash`);
      }
      written.add(id);
      report.exported.push(id);
    }

    const tableTypes = new Set(wiki.typeDefs().filter((def) => def.storage === 'table').map((def) => def.typeId));
    const placedTables = new Set(before.typePlacements.map((placement) => placement.typeId));
    for (const placement of typePlacements) {
      if (!tableTypes.has(placement.typeId) || placedTables.has(placement.typeId)) continue;
      const parent = placement.parentFolderId && (placement.parentKind ?? 'page') === 'page' && written.has(placement.parentFolderId)
        ? placement.parentFolderId
        : null;
      await wiki.command({ type: 'set-type-placement', typeId: placement.typeId, parentFolderId: parent, sortOrder: placement.sortOrder });
      report.typePlacementsExported.push(placement.typeId);
    }

    report.ok = true;
    deps.emit('completed', {
      workspacePath: ws,
      root: report.root,
      exported: report.exported.length,
      alreadyInWiki: report.alreadyInWiki.length,
      skipped: report.skipped.length,
      typePlacementsExported: report.typePlacementsExported.length,
    });
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    deps.emit('failed', { workspacePath: ws, root: report.root, exported: report.exported.length, error: report.error });
    return report;
  }
}

/**
 * Launch heartbeat for the rows the export leaves behind. They are kept on
 * purpose; this line dates them, so a later cleanup can tell how long they
 * have been unused.
 */
export async function legacyPersonalPagesCensus(db: store.PersonalPagesDb): Promise<{ documents: number; workspaces: number; typePlacements: number; itemPlacements: number }> {
  const count = async (sql: string) => Number((await db.query<{ n: number | string }>(sql)).rows[0]?.n ?? 0);
  return {
    documents: await count('SELECT COUNT(*) AS n FROM personal_page_documents'),
    workspaces: await count('SELECT COUNT(DISTINCT workspace_path) AS n FROM personal_page_documents'),
    typePlacements: await count('SELECT COUNT(*) AS n FROM personal_page_type_placements'),
    itemPlacements: await count('SELECT COUNT(*) AS n FROM personal_page_item_placements'),
  };
}
