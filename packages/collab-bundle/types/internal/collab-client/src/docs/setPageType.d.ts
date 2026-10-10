/**
 * "Set type" on a plain page: the page becomes an item of that type in place,
 * with the same title, body and tree position.
 *
 * The page is the only copy of its text until the item's body has been read
 * back and matches, the item is confirmed at the page's position, and the page
 * is shown not to have changed since it was copied. Nothing touches the page
 * before all three. Then the page's children (pages, placed types and placed
 * typed pages) move under the new typed page, and only once every one of them
 * has moved does the page go to Trash. A half-created item is removed only when
 * it never left this machine, so no teammate can have written to it.
 *
 * The decision sequence lives here with its effects injected, so it is tested
 * without a team room and every host runs the same one; the desktop's
 * `useSetPageType` supplies its effects, a browser host supplies its own.
 */
export type PageTypeLane = 'team' | 'personal';
export interface SetPageTypePage {
    documentId: string;
    title: string;
    documentType: string;
    /** Parent page or typed page id, or null at the section root. */
    parentId: string | null;
    /** What `parentId` names; absent means a page. */
    parentKind?: 'page' | 'item';
    /** The page's order among its siblings, which the typed page takes over. */
    sortOrder?: number | null;
}
/** Something directly under a page in the tree. */
export type PageChild = {
    kind: 'page' | 'type' | 'item';
    id: string;
};
export interface SetPageTypeRequest {
    lane: PageTypeLane;
    page: SetPageTypePage;
    typeId: string;
}
/** The page text that was copied, with the stored version when it has one. */
export interface PageCopy {
    markdown: string;
    version?: number;
}
/** Where the new item's creation got to. Team items must reach the team. */
export interface CreatedPageItem {
    itemId: string;
    publication: 'published' | 'local' | 'pending';
    error?: string;
}
/** Mirrors `ItemBodyCheck` from the desktop main process's `pageTypeBodyCheck.ts`. */
export type ItemBodyCheck = {
    status: 'match';
} | {
    status: 'mismatch';
} | {
    status: 'unreadable';
    reason: string;
};
export type ItemPlacementResult = {
    ok: true;
} | {
    ok: false;
    error: string;
};
/** Where the typed page goes: the page's own place. */
export interface ItemPosition {
    parentKind: 'page' | 'item';
    sortOrder: number | null;
}
export interface SetPageTypeDependencies {
    /** Pages, placed types and placed typed pages directly under the page. */
    listChildren(pageId: string): PageChild[];
    /** Resolves ok only once the child is stored under the typed page. */
    moveChildUnderItem(child: PageChild, itemId: string): Promise<ItemPlacementResult>;
    /** Save any edit an open editor still holds for the page. Throws if it cannot. */
    flushPageEditor(pageId: string): Promise<void>;
    /** The page body as markdown. Throws when it cannot be read. */
    readPageMarkdown(pageId: string): Promise<PageCopy>;
    /** Throws only when nothing was committed. */
    createItem(input: {
        typeId: string;
        title: string;
        markdown: string;
    }): Promise<CreatedPageItem>;
    verifyItemBody(itemId: string, markdown: string): Promise<ItemBodyCheck>;
    removeItem(itemId: string): Promise<void>;
    /** Resolves ok only once the placement is stored where the section keeps it. */
    setItemPlacement(itemId: string, parentId: string | null, position: ItemPosition): Promise<ItemPlacementResult>;
    /** False when the page's text or version moved on since `copy` was taken. */
    pageUnchangedSince(pageId: string, copy: PageCopy): Promise<boolean>;
    trashPage(pageId: string): Promise<void>;
    /** Open the item where the page's tab was, closing that tab. */
    openItem(itemId: string, pageId: string): void;
    wait(ms: number): Promise<void>;
}
export type SetPageTypeOutcome = {
    status: 'done';
    itemId: string;
}
/** Nothing was created or changed. */
 | {
    status: 'refused';
    message: string;
}
/** The page is untouched unless the message says otherwise. */
 | {
    status: 'failed';
    message: string;
    itemId?: string;
    itemKept: boolean;
};
/** Waits before the 2nd and 3rd read-back; a fresh room can take a moment to sync. */
export declare const READ_BACK_RETRY_DELAYS_MS: number[];
export declare function setPageType(request: SetPageTypeRequest, dependencies: SetPageTypeDependencies): Promise<SetPageTypeOutcome>;
