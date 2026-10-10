/**
 * Read-side helpers over a wiki snapshot, shared by `nim wiki` and `nim mcp`:
 * find a page from what a person or agent typed, and lay out the page tree.
 */
import { orderBetween, ORDER_STEP, type LocalPage, type LocalWikiSnapshot } from '@nimbalyst/local-wiki';
import { notFoundError, usageError } from '../cli/exitCodes.js';

/** How a local page is addressed in tool results. Bare ids are accepted too. */
export const LOCAL_URI_PREFIX = 'local-wiki://';

export const localPageUri = (id: string) => `${LOCAL_URI_PREFIX}${id}`;

/** A reference only a team wiki can mean: a collab uri or a console link. */
export function isTeamReference(ref: string): boolean {
  return /^(collab:|https?:)/i.test(ref.trim());
}

/** A team issue key (`NIM-123`). Local items have ULIDs and no key. */
export function isTeamIssueKey(ref: string): boolean {
  return /^[A-Z][A-Z0-9]*-\d+$/.test(ref.trim());
}

export function livePages(snapshot: LocalWikiSnapshot): LocalPage[] {
  return snapshot.pages.filter((page) => page.trashedAt === null);
}

const normalizePath = (value: string) =>
  value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();

/**
 * A live page by id, `local-wiki://` uri, wiki-relative path (with or without
 * `.md`; an editor page by its file, `Flow.excalidraw`; a folder page by its
 * folder), or exact title (case-insensitive, must be unique). Throws a
 * not-found or usage error naming what was tried.
 */
export function findPage(snapshot: LocalWikiSnapshot, ref: string): LocalPage {
  const pages = livePages(snapshot);
  const raw = ref.startsWith(LOCAL_URI_PREFIX) ? ref.slice(LOCAL_URI_PREFIX.length) : ref.trim();
  const byId = pages.find((page) => page.id === raw);
  if (byId) return byId;
  const wanted = normalizePath(raw);
  const withMd = wanted.endsWith('.md') ? wanted : `${wanted}.md`;
  const byPath = pages.find(
    (page) => (page.path && [wanted, withMd].includes(normalizePath(page.path))) || normalizePath(page.dir) === wanted,
  );
  if (byPath) return byPath;
  const byTitle = pages.filter((page) => page.title.toLowerCase() === raw.toLowerCase());
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw usageError(
      `"${ref}" matches ${byTitle.length} pages; use an id:\n` +
        byTitle.map((page) => `  ${page.id}  ${page.path ?? page.dir}`).join('\n'),
    );
  }
  throw notFoundError(`No local wiki page "${ref}" (looked for an id, a path and a title).`);
}

export type TreeNodeKind = 'page' | 'typedPage' | 'type';

export interface TreeNode {
  nodeId: string;
  kind: TreeNodeKind;
  id: string;
  title: string;
  parentNodeId: string | null;
  depth: number;
  sortOrder: number | null;
  childCount: number;
  /** Pages and typed pages: the uri to read and edit the body. */
  uri?: string;
  type?: string | null;
  /** Editor pages only: their document type (`excalidraw`, `csv`, ...). Absent for markdown. */
  documentType?: string;
  path: string | null;
  hasContent?: boolean;
  updatedAt?: number;
  fields?: Record<string, unknown>;
  /** Table types: rows in the CSV. */
  rowCount?: number;
}

export const pageNodeId = (page: Pick<LocalPage, 'id' | 'type'>) => `${page.type ? 'item' : 'document'}:${page.id}`;

/** The whole live tree in display order (depth-first, siblings by order then title). */
export function buildTree(snapshot: LocalWikiSnapshot): TreeNode[] {
  const pages = livePages(snapshot);
  const byId = new Map(pages.map((page) => [page.id, page]));
  type Entry = { node: Omit<TreeNode, 'depth' | 'childCount' | 'parentNodeId'>; parentId: string | null };
  const entries: Entry[] = pages.map((page) => ({
    parentId: page.parentId && byId.has(page.parentId) ? page.parentId : null,
    node: {
      nodeId: pageNodeId(page),
      kind: page.type ? 'typedPage' : 'page',
      id: page.id,
      title: page.title,
      sortOrder: page.order,
      uri: localPageUri(page.id),
      type: page.type,
      ...(page.documentType !== 'markdown' ? { documentType: page.documentType } : {}),
      path: page.path,
      hasContent: page.hasContent,
      updatedAt: page.updatedAt,
      fields: page.fields,
    },
  }));
  for (const table of snapshot.tables) {
    const placement = snapshot.typePlacements.find((p) => p.typeId === table.typeId);
    entries.push({
      parentId: table.parentId && byId.has(table.parentId) ? table.parentId : null,
      node: {
        nodeId: `type:${table.typeId}`,
        kind: 'type',
        id: table.typeId,
        title: table.typeId,
        sortOrder: placement?.sortOrder ?? null,
        path: table.path,
        rowCount: table.rowCount,
      },
    });
  }
  const children = new Map<string | null, Entry[]>();
  for (const entry of entries) {
    const list = children.get(entry.parentId) ?? [];
    list.push(entry);
    children.set(entry.parentId, list);
  }
  const compare = (a: Entry, b: Entry) => {
    const ao = a.node.sortOrder;
    const bo = b.node.sortOrder;
    if (ao !== null && bo !== null && ao !== bo) return ao - bo;
    if (ao !== null && bo === null) return -1;
    if (ao === null && bo !== null) return 1;
    return a.node.title.localeCompare(b.node.title);
  };
  const out: TreeNode[] = [];
  const walk = (parentId: string | null, parentNodeId: string | null, depth: number) => {
    for (const entry of (children.get(parentId) ?? []).sort(compare)) {
      const kids = entry.node.kind === 'type' ? [] : children.get(entry.node.id) ?? [];
      out.push({ ...entry.node, parentNodeId, depth, childCount: kids.length });
      if (entry.node.kind !== 'type') walk(entry.node.id, entry.node.nodeId, depth + 1);
    }
  };
  walk(null, null, 0);
  return out;
}

function byOrder(a: LocalPage, b: LocalPage): number {
  if (a.order !== null && b.order !== null && a.order !== b.order) return a.order - b.order;
  if (a.order !== null && b.order === null) return -1;
  if (a.order === null && b.order !== null) return 1;
  return a.title.localeCompare(b.title);
}

/** Where a page goes to sit just before or after `siblingRef`: that sibling's parent and an order between neighbors. */
export function positionBeside(
  snapshot: LocalWikiSnapshot,
  siblingRef: string,
  side: 'before' | 'after',
  movingId?: string,
): { parentId: string | null; sortOrder: number } {
  const sibling = findPage(snapshot, siblingRef.replace(/^(document|item|page):/, ''));
  const parentId = sibling.parentId ?? null;
  const siblings = livePages(snapshot)
    .filter((page) => (page.parentId ?? null) === parentId && page.id !== movingId)
    .sort(byOrder);
  const at = siblings.findIndex((page) => page.id === sibling.id);
  const ordered = siblings.map((page, i) => page.order ?? (i + 1) * ORDER_STEP);
  const before = side === 'before' ? ordered[at - 1] : ordered[at];
  const after = side === 'before' ? ordered[at] : ordered[at + 1];
  return { parentId, sortOrder: orderBetween(before, after) };
}
