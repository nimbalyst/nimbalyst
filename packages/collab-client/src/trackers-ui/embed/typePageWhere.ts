/**
 * The "Where" column of a type page: the page an item lives under in the page
 * tree. An item with no placement sits under its type, so it names the type;
 * so does a placement whose page is gone, which is where the tree shows it.
 */

export interface WherePage {
  folderId: string;
  parentFolderId?: string | null;
  /** What `parentFolderId` names; absent means a page. */
  parentKind?: 'page' | 'item';
  name: string;
}

export interface WherePlacement {
  itemId: string;
  /** Null means the root of the section. */
  parentId?: string | null;
  /** What `parentId` names; absent means a page. */
  parentKind?: 'page' | 'item';
}

export interface ItemWhereInput {
  placements: readonly WherePlacement[];
  /** Every page that can be a parent, as the docs session lists them. */
  pages: readonly WherePage[];
  /** Shown for an item with no placement: the type's own name. */
  typeLabel: string;
  /** Shown for an item placed at the root of its section. */
  rootLabel: string;
  /** A typed page's title, for one that is a parent; null when unknown here. */
  itemTitle?: (itemId: string) => string | null;
}

/**
 * Walks up through pages and typed pages, root first. A typed page with no
 * placement of its own sits under its type, so the walk stops at it.
 */
export function createItemWhereResolver({ placements, pages, typeLabel, rootLabel, itemTitle }: ItemWhereInput): (itemId: string) => string {
  const placementByItem = new Map(placements.map((placement) => [placement.itemId, placement]));
  const pagesById = new Map(pages.map((page) => [page.folderId, page]));
  return (itemId) => {
    const placement = placementByItem.get(itemId);
    if (!placement) return typeLabel;
    let parentId = placement.parentId ?? null;
    let parentKind = placement.parentKind ?? 'page';
    if (parentId === null) return rootLabel;
    const names: string[] = [];
    const seen = new Set<string>();
    while (parentId !== null && !seen.has(`${parentKind}:${parentId}`)) {
      seen.add(`${parentKind}:${parentId}`);
      if (parentKind === 'item') {
        const title = itemTitle?.(parentId);
        if (!title) break;
        names.unshift(title);
        const next = placementByItem.get(parentId);
        if (!next) break;
        parentId = next.parentId ?? null;
        parentKind = next.parentKind ?? 'page';
      } else {
        const page = pagesById.get(parentId);
        if (!page) break;
        names.unshift(page.name);
        parentId = page.parentFolderId ?? null;
        parentKind = page.parentKind ?? 'page';
      }
    }
    return names.length > 0 ? names.join(' / ') : typeLabel;
  };
}
