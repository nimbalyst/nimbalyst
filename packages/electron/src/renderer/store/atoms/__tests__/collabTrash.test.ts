import { afterEach, describe, expect, it } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../openProjects';
import {
  allSharedDocumentsAtom,
  emptySharedDocumentTrash,
  restoreSharedDocument,
  sharedDocumentsAtom,
  trashedSharedDocumentsAtom,
  trashSharedDocument,
  type SharedDocument,
} from '../collabDocuments';

const WORKSPACE = '/workspace/collab-trash';

function doc(documentId: string, trashedAt: number | null = null): SharedDocument {
  return {
    documentId,
    title: documentId,
    documentType: 'markdown',
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 1,
    trashedAt,
  };
}

afterEach(() => {
  store.set(allSharedDocumentsAtom, []);
  store.set(activeWorkspacePathAtom, null);
});

describe('shared document Trash projections', () => {
  it('keeps trash rows synced while hiding them from active consumers', () => {
    store.set(activeWorkspacePathAtom, WORKSPACE);
    store.set(allSharedDocumentsAtom, [doc('active'), doc('trashed', 100)]);

    expect(store.get(sharedDocumentsAtom).map(row => row.documentId)).toEqual(['active']);
    expect(store.get(trashedSharedDocumentsAtom).map(row => row.documentId)).toEqual(['trashed']);
    expect(store.get(allSharedDocumentsAtom)).toHaveLength(2);
  });

  it('moves, restores, and permanently removes rows without a connected provider', () => {
    store.set(activeWorkspacePathAtom, WORKSPACE);
    store.set(allSharedDocumentsAtom, [doc('one')]);

    trashSharedDocument('one');
    expect(store.get(sharedDocumentsAtom)).toEqual([]);
    expect(store.get(trashedSharedDocumentsAtom)).toHaveLength(1);

    restoreSharedDocument('one');
    expect(store.get(sharedDocumentsAtom)).toHaveLength(1);
    expect(store.get(trashedSharedDocumentsAtom)).toEqual([]);

    trashSharedDocument('one');
    expect(emptySharedDocumentTrash()).toBe(1);
    expect(store.get(allSharedDocumentsAtom)).toEqual([]);
  });
});
