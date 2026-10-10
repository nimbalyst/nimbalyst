import type { CollabDocsSession } from './session';
import type { SharedTypePlacement } from './types';
import type { ItemPlacementResult, PageChild } from './setPageType';
export type ChildMoveSession = Pick<CollabDocsSession, 'getDocuments' | 'getItemPlacements' | 'setItemPlacement'> & {
    dataSource: Pick<CollabDocsSession['dataSource'], 'command'>;
};
/** A type page's prose is not a child: it moves with its type. */
export declare function listPageChildren(session: ChildMoveSession, typePlacements: SharedTypePlacement[], pageId: string): PageChild[];
/** Move one child under the typed page, keeping its order. */
export declare function movePageChild(session: ChildMoveSession, typePlacements: SharedTypePlacement[], child: PageChild, itemId: string): Promise<ItemPlacementResult>;
