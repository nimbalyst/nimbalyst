/**
 * The docs session's page tree as plain values, for a host that renders its
 * own Pages routes (the web console's typed page, type page and Home landing).
 * Read here because the session's atoms belong to the Jotai instance bundled
 * with this package; a host reading them through its own `jotai` gets a second
 * store and nothing in it. Like `useSharedDocumentTitles`, it does not throw
 * without a provider.
 */
import { useContext } from 'react';
import { atom, useAtomValue, type Atom } from 'jotai';
import type { CollabDocsUIStatus } from '../docs/session';
import type { SharedDocument, SharedItemPlacement, SharedTypePlacement } from '../docs/types';
import { CollabDocsUIContext } from './CollabDocsUIProvider';

export interface CollabPagesState {
  /** Every non-trashed document in the index, type page prose included. */
  documents: SharedDocument[];
  typePlacements: SharedTypePlacement[];
  itemPlacements: SharedItemPlacement[];
  /** True once the server runs the one page tree. */
  pageTree: boolean;
  syncStatus: CollabDocsUIStatus;
}

const NO_DOCUMENTS: Atom<SharedDocument[]> = atom<SharedDocument[]>([]);
const NO_TYPE_PLACEMENTS: Atom<SharedTypePlacement[]> = atom<SharedTypePlacement[]>([]);
const NO_ITEM_PLACEMENTS: Atom<SharedItemPlacement[]> = atom<SharedItemPlacement[]>([]);
const NO_PAGE_TREE: Atom<boolean> = atom(false);
const DISCONNECTED: Atom<CollabDocsUIStatus> = atom<CollabDocsUIStatus>('disconnected');

export function useCollabPagesState(): CollabPagesState {
  const atoms = useContext(CollabDocsUIContext)?.session.atoms;
  return {
    documents: useAtomValue(atoms?.allSharedDocuments ?? NO_DOCUMENTS),
    typePlacements: useAtomValue(atoms?.typePlacements ?? NO_TYPE_PLACEMENTS),
    itemPlacements: useAtomValue(atoms?.itemPlacements ?? NO_ITEM_PLACEMENTS),
    pageTree: useAtomValue(atoms?.pageTree ?? NO_PAGE_TREE),
    syncStatus: useAtomValue(atoms?.syncStatus ?? DISCONNECTED),
  };
}
