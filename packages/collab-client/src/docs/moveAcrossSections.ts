/**
 * Moving a page, with the plain pages under it, from one Pages section to the
 * other (Personal to Team, or Team to Personal). The two sections are
 * different stores, so a move is a copy that must be confirmed before the
 * source is touched:
 *
 *   1. Read the source subtree; refuse what can't cross yet (typed pages and
 *      types, whose type belongs to one section; images, whose files live in
 *      one section's asset store).
 *   2. Copy each page, parents first, and read each body back from the
 *      destination.
 *   3. Check no source page changed while it was copied.
 *   4. Only then move the source page (and its subtree) to its section's Trash.
 *
 * Any failure before step 4 sends the copies to the destination's Trash and
 * leaves the source as it was. Pure over its dependencies, like Set type.
 */
import type { PageFields } from './pageFields';
import type { CollabPlacementWriteResult } from './session';
import { TYPE_PAGE_DOCUMENT_PREFIX, type SharedDocument } from './types';

export interface MovePageNode {
  documentId: string;
  title: string;
  fields?: PageFields;
  children: MovePageNode[];
}

export interface MovePageCopy {
  markdown: string;
  /** The source's version where it has one (Personal), for the unchanged check. */
  version?: number;
}

export interface MoveAcrossSectionsDependencies {
  /** The page and its plain descendants, or why it can't move. */
  readTree(pageId: string): { ok: true; root: MovePageNode } | { ok: false; error: string };
  /** The source page's body, after any open editor's edits are stored. */
  readSource(pageId: string): Promise<MovePageCopy>;
  /** Whether the source still holds what was copied. */
  sourceUnchanged(pageId: string, copy: MovePageCopy): Promise<boolean>;
  /** Creates the page in the destination with its body; returns its id. */
  createDestination(input: { title: string; markdown: string; parentId: string | null; fields?: PageFields }): Promise<string>;
  /** The destination page's body, as stored. */
  readDestination(pageId: string): Promise<string>;
  /** Rollback: the copy and everything under it to the destination's Trash. */
  trashDestination(pageId: string): Promise<void>;
  /** The source page and its subtree to the source's Trash. */
  trashSource(pageId: string): Promise<CollabPlacementWriteResult>;
}

export type MoveAcrossSectionsResult =
  | { ok: true; pageId: string; moved: number }
  | { ok: false; error: string };

/** Line endings, trailing spaces and blank-line runs differ across a markdown round trip; nothing else may. */
export function normalizeBodyForComparison(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Markdown or HTML images, whose files stay in the source section's asset store. */
export function bodyHasImages(markdown: string): boolean {
  return /!\[[^\]]*\]\([^)]+\)/.test(markdown) || /<img\b/i.test(markdown);
}

function* preOrder(node: MovePageNode, parentId: string | null): Generator<{ node: MovePageNode; parentId: string | null }> {
  yield { node, parentId };
  for (const child of node.children) yield* preOrder(child, node.documentId);
}

export async function moveAcrossSections(pageId: string, deps: MoveAcrossSectionsDependencies): Promise<MoveAcrossSectionsResult> {
  const tree = deps.readTree(pageId);
  if (!tree.ok) return tree;

  const copies = new Map<string, MovePageCopy>();
  for (const { node } of preOrder(tree.root, null)) {
    const copy = await deps.readSource(node.documentId);
    if (bodyHasImages(copy.markdown)) {
      return { ok: false, error: `"${node.title}" has images, which can't move between sections yet.` };
    }
    copies.set(node.documentId, copy);
  }

  // Source id -> destination id, so children land under their parent's copy.
  const created = new Map<string, string>();
  let rootCopy: string | null = null;
  const fail = async (error: string): Promise<MoveAcrossSectionsResult> => {
    if (rootCopy) await deps.trashDestination(rootCopy).catch(() => undefined);
    return { ok: false, error };
  };
  try {
    for (const { node, parentId } of preOrder(tree.root, null)) {
      const copy = copies.get(node.documentId)!;
      const newId = await deps.createDestination({
        title: node.title,
        markdown: copy.markdown,
        parentId: parentId ? created.get(parentId) ?? null : null,
        ...(node.fields ? { fields: node.fields } : {}),
      });
      created.set(node.documentId, newId);
      rootCopy ??= newId;
      const stored = await deps.readDestination(newId);
      if (normalizeBodyForComparison(stored) !== normalizeBodyForComparison(copy.markdown)) {
        return await fail(`"${node.title}" did not arrive intact, so nothing was moved.`);
      }
    }
    for (const [sourceId, copy] of copies) {
      if (!(await deps.sourceUnchanged(sourceId, copy))) {
        return await fail('A page changed while it was being moved, so nothing was moved. Try again.');
      }
    }
  } catch (error) {
    return fail(`The move did not finish, so nothing was moved: ${error instanceof Error ? error.message : String(error)}`);
  }

  const trashed = await deps.trashSource(pageId);
  if (!trashed.ok) {
    // Both copies exist now; say so rather than guess which to drop.
    return { ok: false, error: `The pages were copied, but the originals could not be moved to Trash: ${trashed.error}` };
  }
  return { ok: true, pageId: rootCopy!, moved: copies.size };
}

/**
 * The page and the plain pages under it. Typed pages and types can't cross
 * (a type belongs to one section), nor can a type's prose or a non-markdown page.
 */
export function readMoveTree(
  pageId: string,
  documents: readonly SharedDocument[],
  placements: { items: ReadonlyArray<{ parentId?: string | null }>; types: ReadonlyArray<{ parentFolderId?: string | null }> },
): { ok: true; root: MovePageNode } | { ok: false; error: string } {
  const live = documents.filter((document) => !document.trashedAt);
  const byId = new Map(live.map((document) => [document.documentId, document]));
  const build = (document: SharedDocument): MovePageNode | string => {
    if (document.documentId.startsWith(TYPE_PAGE_DOCUMENT_PREFIX)) return `"${document.title}" is a type's description and stays with its type.`;
    if (document.documentType !== 'markdown') return `"${document.title}" is not a markdown page.`;
    if (placements.items.some((placement) => placement.parentId === document.documentId)
      || placements.types.some((placement) => placement.parentFolderId === document.documentId)) {
      return `"${document.title}" holds typed pages or a type, which belong to their own section.`;
    }
    const children: MovePageNode[] = [];
    for (const child of live.filter((candidate) => candidate.parentFolderId === document.documentId && candidate.parentKind !== 'item')) {
      const node = build(child);
      if (typeof node === 'string') return node;
      children.push(node);
    }
    return { documentId: document.documentId, title: document.title, ...(document.fields ? { fields: document.fields } : {}), children };
  };
  const root = byId.get(pageId);
  if (!root) return { ok: false, error: 'The page is no longer here.' };
  const node = build(root);
  return typeof node === 'string' ? { ok: false, error: node } : { ok: true, root: node };
}
