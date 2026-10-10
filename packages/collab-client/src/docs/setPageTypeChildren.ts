/**
 * Set type's child moves: what sits directly under the page, and moving each
 * piece under the new typed page with a real outcome. A page or type move is
 * sent as a confirmed command, so `ok` means the store holds it: the team
 * server echoed it (an older server that cannot take a typed-page parent never
 * does), or main committed it for Personal. A typed page's placement is
 * already confirmed by the session.
 */
import { isTypePageDocumentId } from './collabTree';
import type { CollabDocsSession } from './session';
import type { SharedTypePlacement } from './types';
import type { ItemPlacementResult, PageChild } from './setPageType';

export type ChildMoveSession = Pick<CollabDocsSession, 'getDocuments' | 'getItemPlacements' | 'setItemPlacement'> & {
  dataSource: Pick<CollabDocsSession['dataSource'], 'command'>;
};

const underPage = (pageId: string, parentId: string | null | undefined, parentKind: 'page' | 'item' | undefined) =>
  parentId === pageId && (parentKind ?? 'page') === 'page';

/** A type page's prose is not a child: it moves with its type. */
export function listPageChildren(session: ChildMoveSession, typePlacements: SharedTypePlacement[], pageId: string): PageChild[] {
  return [
    ...session.getDocuments()
      .filter((document) => underPage(pageId, document.parentFolderId, document.parentKind)
        && document.trashedAt == null && !isTypePageDocumentId(document.documentId))
      .map((document): PageChild => ({ kind: 'page', id: document.documentId })),
    ...typePlacements
      .filter((placement) => underPage(pageId, placement.parentFolderId, placement.parentKind))
      .map((placement): PageChild => ({ kind: 'type', id: placement.typeId })),
    ...session.getItemPlacements()
      .filter((placement) => underPage(pageId, placement.parentId, placement.parentKind))
      .map((placement): PageChild => ({ kind: 'item', id: placement.itemId })),
  ];
}

const failure = (error: unknown): ItemPlacementResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) });

/** Move one child under the typed page, keeping its order. */
export async function movePageChild(
  session: ChildMoveSession,
  typePlacements: SharedTypePlacement[],
  child: PageChild,
  itemId: string,
): Promise<ItemPlacementResult> {
  const moveDocument = (documentId: string) => session.dataSource.command({
    type: 'move-document',
    documentId,
    parentFolderId: itemId,
    parentKind: 'item',
    sortOrder: session.getDocuments().find((document) => document.documentId === documentId)?.sortOrder ?? null,
    confirm: true,
  });
  try {
    if (child.kind === 'page') {
      await moveDocument(child.id);
      return { ok: true };
    }
    if (child.kind === 'type') {
      const prose = `type-page:${child.id}`;
      if (session.getDocuments().some((document) => document.documentId === prose)) await moveDocument(prose);
      await session.dataSource.command({
        type: 'set-type-placement',
        typeId: child.id,
        parentFolderId: itemId,
        parentKind: 'item',
        sortOrder: typePlacements.find((placement) => placement.typeId === child.id)?.sortOrder ?? Date.now(),
        confirm: true,
      });
      return { ok: true };
    }
  } catch (error) {
    return failure(error);
  }
  const placed = await session.setItemPlacement(child.id, itemId, undefined, 'item');
  return placed.ok ? { ok: true } : { ok: false, error: placed.error };
}
