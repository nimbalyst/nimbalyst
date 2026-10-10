import { contentVersion } from './ids.js';
import { nameKey } from './names.js';
import { relJoin } from './fsutil.js';
import type { PageRecord, ScanState, TableRecord } from './scan.js';
import type {
  LocalDocument,
  LocalItemPlacement,
  LocalPage,
  LocalTableInfo,
  LocalTypePlacement,
  LocalWikiSnapshot,
  ParentKind,
} from './types.js';

export const ORDER_STEP = 1000;
const CREATED_BY = 'local';

/** A sparse order between two neighbors; either side may be absent. */
export function orderBetween(before: number | null | undefined, after: number | null | undefined): number {
  if (before == null && after == null) return ORDER_STEP;
  if (before == null) return after! - ORDER_STEP;
  if (after == null) return before + ORDER_STEP;
  return (before + after) / 2;
}

export function toLocalPage(page: PageRecord): LocalPage {
  const {
    stem: _stem,
    sidecar: _sidecar,
    parentDir: _parentDir,
    data: _data,
    body: _body,
    links: _links,
    linkTargets: _targets,
    legacyTrackerStatus: _legacy,
    ...rest
  } = page;
  return rest;
}

interface Sibling {
  key: string;
  order: number | null;
  title: string;
}

/**
 * Numbers for every sibling: an explicit order is kept; unordered siblings
 * follow the ordered ones by title, one step apart. Placements need a number
 * where a page's own `sortOrder` may be null.
 */
function effectiveOrders(groups: Map<string, Sibling[]>): Map<string, number> {
  const out = new Map<string, number>();
  for (const siblings of groups.values()) {
    const sorted = [...siblings].sort((a, b) => {
      if (a.order !== null && b.order !== null) return a.order - b.order;
      if (a.order !== null) return -1;
      if (b.order !== null) return 1;
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    });
    let last = 0;
    for (const sibling of sorted) {
      const value = sibling.order ?? last + ORDER_STEP;
      out.set(sibling.key, value);
      last = value;
    }
  }
  return out;
}

export interface ProjectInput {
  state: ScanState;
  formatVersion: number;
  tableOrders: Record<string, number>;
}

function tableParent(state: ScanState, table: TableRecord): { id: string | null; kind: ParentKind | null } {
  if (table.parentDir === '') return { id: null, kind: null };
  const parent = state.pages.get(state.byDir.get(nameKey(table.parentDir)) ?? '');
  return parent ? { id: parent.id, kind: parent.type ? 'item' : 'page' } : { id: null, kind: null };
}

export function tableInfo(state: ScanState, table: TableRecord): LocalTableInfo {
  const parent = tableParent(state, table);
  return {
    typeId: table.typeId,
    path: table.path,
    parentId: parent.id,
    parentKind: parent.kind,
    rowCount: table.rows.length,
    version: table.version,
    ...(table.malformed ? { malformed: true } : {}),
  };
}

export function projectSnapshot({ state, formatVersion, tableOrders }: ProjectInput): LocalWikiSnapshot {
  const live = [...state.pages.values()];
  const groups = new Map<string, Sibling[]>();
  const add = (dir: string, sibling: Sibling) => {
    const key = nameKey(dir);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(sibling);
  };
  for (const page of live) add(page.parentDir, { key: page.id, order: page.order, title: page.title });
  for (const table of state.tables.values()) {
    add(table.parentDir, { key: `table:${table.typeId}`, order: tableOrders[table.typeId] ?? null, title: table.typeId });
  }
  const effective = effectiveOrders(groups);

  const trashed: LocalPage[] = [...state.trash.values()]
    .filter((t) => t.manifest.kind === 'page')
    .map(({ entryDir, manifest }) => {
      const md = manifest.entries?.md ?? manifest.entries?.file;
      return {
        id: manifest.id,
        title: manifest.title,
        type: manifest.pageType ?? null,
        fields: {},
        documentType: manifest.documentType ?? 'markdown',
        fileExtension: manifest.fileExtension ?? '.md',
        parentId: manifest.originalParentId,
        parentKind: manifest.originalParentId ? 'page' : null,
        order: null,
        path: md ? relJoin(entryDir, md) : null,
        dir: relJoin(entryDir, manifest.entries?.dir ?? ''),
        bodySource: md ? 'file' : 'none',
        version: contentVersion(''),
        hasContent: Boolean(md),
        createdAt: manifest.trashedAt,
        updatedAt: manifest.trashedAt,
        trashedAt: manifest.trashedAt,
      };
    });

  const items: LocalDocument[] = [];
  const itemPlacements: LocalItemPlacement[] = [];
  for (const page of [...live.map(toLocalPage), ...trashed]) {
    if (page.type && page.trashedAt === null) {
      itemPlacements.push({
        itemId: page.id,
        projectId: null,
        parentId: page.parentId,
        ...(page.parentKind ? { parentKind: page.parentKind } : {}),
        sortOrder: effective.get(page.id) ?? ORDER_STEP,
        createdBy: CREATED_BY,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
      });
      continue;
    }
    if (page.type) continue;
    items.push({
      documentId: page.id,
      teamProjectId: null,
      title: page.title,
      documentType: page.documentType,
      metadataVersion: 2,
      fileExtension: page.fileExtension,
      // Markdown is the built-in Lexical editor; a host that resolves `editorId`
      // against its type catalog shows anything it cannot match as unsupported
      // (a lock). The library does not know which extension owns another
      // editor type; hosts that do may replace it.
      editorId: page.documentType === 'markdown' ? 'builtin.lexical' : page.documentType,
      createdBy: CREATED_BY,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      parentFolderId: page.parentId,
      ...(page.parentKind ? { parentKind: page.parentKind } : {}),
      sortOrder: page.order,
      trashedAt: page.trashedAt,
      hasContent: page.hasContent,
      ...(Object.keys(page.fields).length > 0 ? { fields: page.fields } : {}),
    });
  }

  const typePlacements: LocalTypePlacement[] = [...state.tables.values()].map((table) => {
    const parent = tableParent(state, table);
    return {
      typeId: table.typeId,
      projectId: null,
      parentFolderId: parent.id,
      ...(parent.kind ? { parentKind: parent.kind } : {}),
      sortOrder: effective.get(`table:${table.typeId}`) ?? ORDER_STEP,
      createdBy: CREATED_BY,
      createdAt: table.createdAt,
      updatedAt: table.updatedAt,
    };
  });

  return {
    items,
    containers: [],
    typePlacements,
    itemPlacements,
    pageTree: true,
    pageFields: true,
    primaryProjectId: null,
    formatVersion,
    pages: [...live.map(toLocalPage), ...trashed],
    tables: [...state.tables.values()].map((table) => tableInfo(state, table)),
    issues: state.issues,
  };
}
