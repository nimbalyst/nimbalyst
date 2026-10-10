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
export type PageChild = { kind: 'page' | 'type' | 'item'; id: string };

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
export type ItemBodyCheck =
  | { status: 'match' }
  | { status: 'mismatch' }
  | { status: 'unreadable'; reason: string };

export type ItemPlacementResult = { ok: true } | { ok: false; error: string };

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
  createItem(input: { typeId: string; title: string; markdown: string }): Promise<CreatedPageItem>;
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

export type SetPageTypeOutcome =
  | { status: 'done'; itemId: string }
  /** Nothing was created or changed. */
  | { status: 'refused'; message: string }
  /** The page is untouched unless the message says otherwise. */
  | { status: 'failed'; message: string; itemId?: string; itemKept: boolean };

// Both are bound to the page's own room: an uploaded image is addressed by that
// room's id, and a decision block's answers are stored by that room. Copied
// into the item's body they would lose their images and answers.
const PAGE_ROOM_ASSET = /collab-asset:\/\//i;
const DECISION_BLOCK = /^```decision\b/m;

/** Waits before the 2nd and 3rd read-back; a fresh room can take a moment to sync. */
export const READ_BACK_RETRY_DELAYS_MS = [500, 1500];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readBack(
  dependencies: SetPageTypeDependencies,
  itemId: string,
  markdown: string,
): Promise<ItemBodyCheck> {
  let check: ItemBodyCheck = { status: 'unreadable', reason: 'not read' };
  for (let attempt = 0; attempt <= READ_BACK_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await dependencies.wait(READ_BACK_RETRY_DELAYS_MS[attempt - 1]);
    try {
      check = await dependencies.verifyItemBody(itemId, markdown);
    } catch (error) {
      check = { status: 'unreadable', reason: errorText(error) };
    }
    if (check.status !== 'unreadable') return check;
  }
  return check;
}

export async function setPageType(
  request: SetPageTypeRequest,
  dependencies: SetPageTypeDependencies,
): Promise<SetPageTypeOutcome> {
  const { lane, page, typeId } = request;

  if (page.documentType !== 'markdown') {
    return { status: 'refused', message: 'Only a text page can be given a type.' };
  }

  let copy: PageCopy;
  try {
    await dependencies.flushPageEditor(page.documentId);
    copy = await dependencies.readPageMarkdown(page.documentId);
  } catch (error) {
    return { status: 'failed', message: `Could not read the page: ${errorText(error)}`, itemKept: false };
  }
  const { markdown } = copy;
  if (PAGE_ROOM_ASSET.test(markdown) || DECISION_BLOCK.test(markdown)) {
    return {
      status: 'refused',
      message: 'This page has uploaded images or decision blocks, which cannot move to a typed page yet. The page is unchanged.',
    };
  }

  const title = page.title.trim() || 'Untitled';
  let created: CreatedPageItem;
  try {
    created = await dependencies.createItem({ typeId, title, markdown });
  } catch (error) {
    return { status: 'failed', message: `Could not create the item: ${errorText(error)}`, itemKept: false };
  }
  const { itemId } = created;
  const keepBoth = (message: string): SetPageTypeOutcome => ({ status: 'failed', message, itemId, itemKept: true });

  // Only for an item that never left this machine: only this flow has written
  // to it, and the page still holds the text, so removing it loses nothing.
  const abandon = async (message: string): Promise<SetPageTypeOutcome> => {
    try {
      await dependencies.removeItem(itemId);
      return { status: 'failed', message: `${message} The page is unchanged.`, itemId, itemKept: false };
    } catch (error) {
      return keepBoth(`${message} The page is unchanged, but the new item could not be removed (${errorText(error)}).`);
    }
  };

  const reachedTeam = created.publication === 'published';
  const reachedItsSection = lane === 'team' ? reachedTeam : created.publication !== 'pending';
  if (!reachedItsSection) {
    return abandon(created.error
      ? `The item did not reach the team: ${created.error}`
      : 'The item did not reach the team.');
  }

  const check = await readBack(dependencies, itemId, markdown);
  if (check.status === 'unreadable') {
    const message = `The item's text could not be read back (${check.reason}).`;
    // Teammates can already see and edit a published item; never delete it.
    return reachedTeam
      ? keepBoth(`${message} The page was kept. Open the item to check it, then delete the one you do not need.`)
      : abandon(message);
  }
  if (check.status === 'mismatch') {
    // A different body may already carry someone's edit; keep it for review.
    return keepBoth('The item\'s text does not match the page, so the page was kept. Compare them and delete the one you do not need.');
  }

  let placement: ItemPlacementResult;
  try {
    placement = await dependencies.setItemPlacement(itemId, page.parentId, {
      parentKind: page.parentKind ?? 'page',
      sortOrder: page.sortOrder ?? null,
    });
  } catch (error) {
    placement = { ok: false, error: errorText(error) };
  }
  if (!placement.ok) {
    return keepBoth(`The typed page was created but sits under its type, not where the page was (${placement.error}). The page is unchanged.`);
  }

  let unchanged: boolean;
  try {
    unchanged = await dependencies.pageUnchangedSince(page.documentId, copy);
  } catch {
    unchanged = false;
  }
  if (!unchanged) {
    // Someone is still editing the page; leave its tab where it is.
    return keepBoth('The page changed while its type was being set, so it was kept beside the new typed page. Copy the latest edits across, then delete the page.');
  }

  // Read when they move, not at the start: a child added meanwhile moves too.
  // A child that cannot move keeps the page, so nothing is left under Trash.
  for (const child of dependencies.listChildren(page.documentId)) {
    let moved: ItemPlacementResult;
    try {
      moved = await dependencies.moveChildUnderItem(child, itemId);
    } catch (error) {
      moved = { ok: false, error: errorText(error) };
    }
    if (!moved.ok) {
      return keepBoth(`The typed page is ready, but not everything inside the page could move under it (${moved.error}), so the page was kept. Move the rest across, then delete the page.`);
    }
  }

  try {
    await dependencies.trashPage(page.documentId);
  } catch (error) {
    dependencies.openItem(itemId, page.documentId);
    return keepBoth(`The typed page is ready, but the old page could not be moved to Trash (${errorText(error)}). Delete it yourself.`);
  }

  dependencies.openItem(itemId, page.documentId);
  return { status: 'done', itemId };
}
