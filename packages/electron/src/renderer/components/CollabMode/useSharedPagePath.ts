/**
 * Where a plain page sits in its section's tree, for the page's header crumb:
 * the pages, typed pages and types above it, root first, plus its own name.
 * Reads the section's session, so the crumb follows a move or a rename while
 * the tab is open.
 */
import { useMemo } from 'react';
import { atom, useAtomValue, type Atom } from 'jotai';
import { selectAtom } from 'jotai/utils';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import { getSharedDocumentDisplayName, pageDisplayName, type SharedDocument } from '@nimbalyst/collab-client/docs';
import { crumbItemLookup, type CrumbFolder, type CrumbItemPlacement, type CrumbPlacement, type PageTreeAncestor } from '@nimbalyst/collab-client/trackers-ui/page';
import { pageTreeAncestorRefs } from '@nimbalyst/collab-client/trackers-ui/embed';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { getElectronCollabDocsSession } from '../../store/atoms/collabDocuments';

export interface SharedPagePath {
  path: PageTreeAncestor[];
  /** The page's own name; null until the session lists it. */
  title: string | null;
}

const NO_DOCUMENTS: Atom<readonly SharedDocument[]> = atom([]);
const NO_FOLDERS: Atom<readonly CrumbFolder[]> = atom([]);
const NO_ITEM_PLACEMENTS: Atom<readonly CrumbItemPlacement[]> = atom([]);
const NO_TYPE_PLACEMENTS: Atom<readonly CrumbPlacement[]> = atom([]);
const typeName = (typeId: string): string | null => {
  const model = globalRegistry.get(typeId);
  return model ? model.displayNamePlural || model.displayName || typeId : null;
};

function samePath(left: SharedPagePath, right: SharedPagePath): boolean {
  return left.title === right.title
    && left.path.length === right.path.length
    && left.path.every((node, index) => node.id === right.path[index].id && node.name === right.path[index].name);
}

export function useSharedPagePath(scope: CollabScope | null, documentId: string): SharedPagePath {
  const session = useMemo(() => (scope ? getElectronCollabDocsSession(scope) : null), [scope]);
  const pathAtom = useMemo(() => selectAtom(
    atom((get): SharedPagePath => {
      const documents = get(session?.atoms.allSharedDocuments ?? NO_DOCUMENTS);
      const self = documents.find((document) => document.documentId === documentId);
      if (!self) return { path: [], title: null };
      const parent = self.parentFolderId ? { id: self.parentFolderId, kind: self.parentKind ?? 'page' } : null;
      const path = pageTreeAncestorRefs(parent, {
        documents,
        folders: get<readonly CrumbFolder[]>(session?.atoms.sharedFolders ?? NO_FOLDERS),
        itemPlacements: get<readonly CrumbItemPlacement[]>(session?.atoms.itemPlacements ?? NO_ITEM_PLACEMENTS),
        typePlacements: get<readonly CrumbPlacement[]>(session?.atoms.typePlacements ?? NO_TYPE_PLACEMENTS),
        item: crumbItemLookup(get(trackerItemsMapAtom)),
        typeName,
      });
      return { path, title: pageDisplayName(getSharedDocumentDisplayName(self.title, self.documentId), self.documentType) };
    }),
    (value) => value,
    samePath,
  ), [session, documentId]);
  return useAtomValue(pathAtom);
}
