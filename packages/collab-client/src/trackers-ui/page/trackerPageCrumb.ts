/**
 * Where a typed page or a type sits in the Pages tree, as the page's crumb
 * reads it. Pure over the session's placements and pages, so the desktop and
 * the web console read the same crumb from their own sessions.
 */
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { pageTreeAncestorRefs, type PageTreeAncestor } from '../embed/pageTreeAncestors';

type CrumbParentKind = 'page' | 'item';
export interface CrumbPlacement { typeId: string; parentFolderId?: string | null; parentKind?: CrumbParentKind }
export interface CrumbItemPlacement { itemId: string; parentId?: string | null; parentKind?: CrumbParentKind }
export interface CrumbFolder { folderId: string; parentFolderId?: string | null; parentKind?: CrumbParentKind; name: string }
export interface CrumbDocument { documentId: string; parentFolderId?: string | null; parentKind?: CrumbParentKind; title: string; documentType?: string }
export type CrumbItemLookup = (itemId: string) => { title: string; typeId: string } | null;
const NO_ITEMS: CrumbItemLookup = () => null;
const crumbTypeName = (typeId: string): string | null => {
  const model = globalRegistry.get(typeId);
  return model ? model.displayNamePlural || model.displayName || typeId : null;
};

export interface TrackerPageCrumb {
  /** Ancestor page names, root first. */
  ancestors: string[];
  /** Unplaced items sit under their type, which the crumb then names. */
  underType: boolean;
  /**
   * The same ancestors with what each one opens, root first, followed by the
   * type when `underType`. Absent from crumbs built before it existed.
   */
  path?: PageTreeAncestor[];
}

/**
 * Where a typed page sits in the Pages tree. A placed item reads its own
 * parents (pages and typed pages); an unplaced one sits under its type page,
 * so it reads the type's placement and then the type.
 */
export function trackerPageCrumb(
  itemId: string,
  typeId: string,
  tree: {
    itemPlacements: readonly CrumbItemPlacement[];
    typePlacements: readonly CrumbPlacement[];
    documents: readonly CrumbDocument[];
    folders: readonly CrumbFolder[];
    item?: CrumbItemLookup;
  },
): TrackerPageCrumb {
  const walk = { ...tree, item: tree.item ?? NO_ITEMS, typeName: crumbTypeName };
  const itemPlacement = tree.itemPlacements.find((candidate) => candidate.itemId === itemId);
  if (itemPlacement) {
    const parent = itemPlacement.parentId ? { id: itemPlacement.parentId, kind: itemPlacement.parentKind ?? 'page' } : null;
    const path = pageTreeAncestorRefs(parent, walk);
    return { ancestors: path.map((ancestor) => ancestor.name), underType: false, path };
  }
  const typePlacement = tree.typePlacements.find((candidate) => candidate.typeId === typeId);
  const parent = typePlacement?.parentFolderId ? { id: typePlacement.parentFolderId, kind: typePlacement.parentKind ?? 'page' } : null;
  const above = pageTreeAncestorRefs(parent, walk);
  const typeName = crumbTypeName(typeId);
  return {
    ancestors: above.map((ancestor) => ancestor.name),
    underType: true,
    path: typeName ? [...above, { id: typeId, kind: 'type', name: typeName }] : above,
  };
}

/** Same crumb, same names: lets a host skip a re-render when only titles elsewhere moved. */
export function sameTrackerPageCrumb(left: TrackerPageCrumb, right: TrackerPageCrumb): boolean {
  return left.underType === right.underType
    && left.ancestors.length === right.ancestors.length
    && left.ancestors.every((name, index) => name === right.ancestors[index])
    && (left.path?.length ?? 0) === (right.path?.length ?? 0)
    && (left.path ?? []).every((node, index) => node.id === right.path?.[index]?.id && node.name === right.path?.[index]?.name);
}

/**
 * The ancestors of a type's placement, root first (the type page's crumb).
 * `folders` may be the session's folder list, which in a page tree is the
 * pages projected as folders.
 */
export function trackerPageCrumbFolders(
  typeId: string,
  placements: readonly CrumbPlacement[],
  folders: readonly CrumbFolder[],
  tree: { itemPlacements?: readonly CrumbItemPlacement[]; item?: CrumbItemLookup } = {},
): string[] {
  return trackerPageCrumbFolderRefs(typeId, placements, folders, tree).map((ancestor) => ancestor.name);
}

/** `trackerPageCrumbFolders` with what each ancestor opens. */
export function trackerPageCrumbFolderRefs(
  typeId: string,
  placements: readonly CrumbPlacement[],
  folders: readonly CrumbFolder[],
  tree: { itemPlacements?: readonly CrumbItemPlacement[]; item?: CrumbItemLookup } = {},
): PageTreeAncestor[] {
  const placement = placements.find((candidate) => candidate.typeId === typeId);
  const parent = placement?.parentFolderId ? { id: placement.parentFolderId, kind: placement.parentKind ?? 'page' } : null;
  return pageTreeAncestorRefs(parent, {
    documents: [],
    folders,
    itemPlacements: tree.itemPlacements ?? [],
    typePlacements: placements,
    item: tree.item ?? NO_ITEMS,
    typeName: crumbTypeName,
  });
}

/** A typed page's title and type, for a crumb walking up through typed pages. */
export function crumbItemLookup(records: ReadonlyMap<string, TrackerRecord>): CrumbItemLookup {
  return (itemId) => {
    const record = records.get(itemId);
    return record ? { title: getRecordTitle(record).trim(), typeId: record.primaryType } : null;
  };
}

/**
 * Whether a page should offer its legacy `description` back: only when it
 * holds text the body does not already contain (whitespace aside). Items
 * created with the same text in both fields have nothing to recover. Until
 * the body has loaded there is nothing to compare against, so nothing shows.
 */
export function legacyDescriptionToRecover(description: unknown, body: string | null): string | null {
  if (typeof description !== 'string' || body === null) return null;
  const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
  const saved = squash(description);
  return saved && !squash(body).includes(saved) ? description : null;
}
