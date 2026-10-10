/**
 * A page header's menu: the actions its sidebar row's context menu has, so a
 * page can be renamed, moved, nested into, favorited or trashed without
 * finding it in the tree. One shape for every kind of page: export first, then
 * the tree actions, then the one that takes the page away (Trash, Archive,
 * Remove from tree).
 *
 * The sidebar runs the ones with a dialog (see `pageActionRequestAtom`); this
 * only raises them. Pages mode only: outside it no sidebar is shown to answer.
 */
import { useMemo } from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';
import type { CollabDocsSession, SharedDocument } from '@nimbalyst/collab-client/docs';
import type { PageTypeLane } from '@nimbalyst/collab-client/docs/pageTypes';
import type { PageHeaderMenuItem } from '@nimbalyst/collab-client/trackers-ui/page';
import type { CollabPageActionRequest } from '@nimbalyst/collab-client/docs-ui';
import { windowModeAtom } from '../../store/atoms/windowMode';
import { pageActionRequestAtom, pageMoveRequestAtom, pageTypeRequestAtom } from './pageTypeRequest';

const NO_FAVORITES = atom<string[]>([]);
const NO_ITEM_PLACEMENTS = atom<readonly { itemId: string }[]>([]);

const useInPages = () => useAtomValue(windowModeAtom) === 'collab';

/** Opens the Copy to Pages dialog on a file the author picks, inside this page. Loaded on use: tabs import this hook. */
function addFromFiles(section: PageTypeLane, parentId: string): void {
  void import('../../services/addFileToPages').then(({ addFileToPages }) => addFileToPages({ section, parentId }));
}

/** Marks the first item of each group after the first, for the menu's rules. */
function grouped(...groups: PageHeaderMenuItem[][]): PageHeaderMenuItem[] {
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => group.map((item, i) => (index > 0 && i === 0 ? { ...item, dividerBefore: true } : item)));
}

function useRequestAction(lane: PageTypeLane) {
  const request = useSetAtom(pageActionRequestAtom);
  return useMemo(() => (
    (pageId: string, action: CollabPageActionRequest['action'], kind?: 'type') => request({ lane, pageId, action, ...(kind ? { kind } : {}) })
  ), [lane, request]);
}

export interface PageMenuInput {
  lane: PageTypeLane;
  /** The section's docs session; favorites need it. */
  session: CollabDocsSession | null;
  /** The plain page, once its row is known. */
  page: SharedDocument | null;
  /** Whether the other section exists (a project with no team has no Team). */
  canMoveAcross: boolean;
  /** Copy as Markdown and Export to PDF, where the host has an editor to read. */
  exportItems?: PageHeaderMenuItem[];
}

export function usePageMenuItems({ lane, session, page, canMoveAcross, exportItems = [] }: PageMenuInput): PageHeaderMenuItem[] {
  const inPages = useInPages();
  const favorites = useAtomValue(session?.atoms.favorites ?? NO_FAVORITES);
  const requestAction = useRequestAction(lane);
  const requestType = useSetAtom(pageTypeRequestAtom);
  const requestMove = useSetAtom(pageMoveRequestAtom);
  const canFavorite = session?.uiCapabilities.personalState === true;
  return useMemo(() => {
    if (!inPages || !page) return exportItems;
    const pageId = page.documentId;
    const favorited = favorites.includes(pageId);
    const markdown = page.documentType === 'markdown';
    return grouped(exportItems, [
      { id: 'new-page-inside', label: 'New Page Inside', icon: 'note_add', onSelect: () => requestAction(pageId, 'newPageInside') },
      { id: 'add-from-files', label: 'Add from Files...', icon: 'upload_file', onSelect: () => addFromFiles(lane, pageId) },
      // A drawing or other editor page keeps its editor: no page type, no move across sections (it copies markdown).
      ...(markdown ? [{ id: 'set-type', label: 'Set Type...', icon: 'category', onSelect: () => requestType({ lane, page }) }] : []),
      { id: 'rename', label: 'Rename...', icon: 'edit', onSelect: () => requestAction(pageId, 'rename') },
      { id: 'move-to', label: 'Move to...', icon: 'drive_file_move', onSelect: () => requestAction(pageId, 'moveTo') },
      ...(canMoveAcross && markdown ? [{
        id: 'move-across',
        label: lane === 'team' ? 'Move to Personal...' : 'Move to Team...',
        icon: lane === 'team' ? 'person' : 'group',
        onSelect: () => requestMove({ from: lane, pageId }),
      }] : []),
      ...(canFavorite && session ? [{
        id: 'favorite',
        label: favorited ? 'Unfavorite' : 'Favorite',
        icon: 'star',
        onSelect: () => session.toggleFavorite(pageId),
      }] : []),
    ], [
      { id: 'trash', label: 'Move to Trash', icon: 'delete', destructive: true, onSelect: () => requestAction(pageId, 'trash') },
    ]);
  }, [inPages, page, favorites, canFavorite, session, lane, canMoveAcross, exportItems, requestAction, requestType, requestMove]);
}

/**
 * A typed page's: nest a page in it, move it, or put it back under its type
 * when it was placed elsewhere. Its header adds Archive after these.
 */
export function useTypedPageMenuItems(
  lane: PageTypeLane,
  itemId: string,
  session: CollabDocsSession | null,
  exportItems: PageHeaderMenuItem[] = [],
): PageHeaderMenuItem[] {
  const inPages = useInPages();
  const requestAction = useRequestAction(lane);
  const placements = useAtomValue<readonly { itemId: string }[]>(session?.atoms.itemPlacements ?? NO_ITEM_PLACEMENTS);
  const placed = placements.some((placement) => placement.itemId === itemId);
  return useMemo(() => (inPages ? grouped(exportItems, [
    { id: 'new-page-inside', label: 'New Page Inside', icon: 'note_add', onSelect: () => requestAction(itemId, 'newPageInside') },
    { id: 'move-to', label: 'Move to...', icon: 'drive_file_move', onSelect: () => requestAction(itemId, 'moveTo') },
    ...(placed ? [{ id: 'back-under-type', label: 'Back Under Its Type', icon: 'table', onSelect: () => requestAction(itemId, 'backUnderType') }] : []),
  ]) : exportItems), [inPages, exportItems, itemId, placed, requestAction]);
}

/** A type page's: move its row, or take it out of the tree (the type and its pages stay). */
export function useTypePageMenuItems(
  lane: PageTypeLane,
  typeId: string,
  placed: boolean,
  exportItems: PageHeaderMenuItem[] = [],
): PageHeaderMenuItem[] {
  const inPages = useInPages();
  const requestAction = useRequestAction(lane);
  return useMemo(() => (inPages ? grouped(exportItems, placed ? [
    { id: 'move-to', label: 'Move to...', icon: 'drive_file_move', onSelect: () => requestAction(typeId, 'moveTo', 'type') },
  ] : [], placed ? [
    { id: 'remove-from-tree', label: 'Remove from Tree', icon: 'playlist_remove', onSelect: () => requestAction(typeId, 'removeFromTree', 'type') },
  ] : []) : exportItems), [inPages, exportItems, placed, typeId, requestAction]);
}
