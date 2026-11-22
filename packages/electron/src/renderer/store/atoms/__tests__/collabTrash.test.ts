// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import {
  activeCollabScopeAtom,
  allSharedDocumentsAtom,
  emptySharedDocumentTrash,
  restoreSharedDocument,
  sharedDocumentsAtom,
  trashedSharedDocumentsAtom,
  trashSharedDocument,
  type SharedDocument,
} from '../collabDocuments';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import {
  allSharedDocumentsAtom as packageAllSharedDocumentsAtom,
  sharedDocumentsAtom as packageSharedDocumentsAtom,
  trashedSharedDocumentsAtom as packageTrashedSharedDocumentsAtom,
} from '@nimbalyst/collab-client/docs';
import { getSharedDocumentVisibility } from '../../../services/mcpCollabReadHandlers';
import { activeWorkspacePathAtom } from '../openProjects';

const WORKSPACE = '/workspace/collab-trash';
const SCOPE: CollabScope = {
  scopeKey: WORKSPACE,
  orgId: 'org-trash',
  indexConfig: { serverUrl: 'wss://example.test', teamMemberId: asTeamMemberId('user-trash') },
};

function doc(documentId: string, trashedAt: number | null = null): SharedDocument {
  return {
    documentId,
    teamProjectId: null,
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
  store.set(activeCollabScopeAtom, null);
  store.set(activeWorkspacePathAtom, null);
});

describe('shared document Trash projections', () => {
  it('re-exports the package atoms without creating a desktop copy', () => {
    expect(allSharedDocumentsAtom).toBe(packageAllSharedDocumentsAtom);
    expect(sharedDocumentsAtom).toBe(packageSharedDocumentsAtom);
    expect(trashedSharedDocumentsAtom).toBe(packageTrashedSharedDocumentsAtom);
  });

  it('keeps trash rows synced while hiding them from active consumers', () => {
    store.set(activeCollabScopeAtom, SCOPE);
    store.set(allSharedDocumentsAtom, [doc('active'), doc('trashed', 100)]);

    expect(store.get(sharedDocumentsAtom).map(row => row.documentId)).toEqual(['active']);
    expect(store.get(trashedSharedDocumentsAtom).map(row => row.documentId)).toEqual(['trashed']);
    expect(store.get(allSharedDocumentsAtom)).toHaveLength(2);
  });

  it('reports a document genuinely absent from the shared index as not shared', () => {
    store.set(activeCollabScopeAtom, SCOPE);
    store.set(allSharedDocumentsAtom, [doc('shared-doc')]);

    expect(getSharedDocumentVisibility('local-only-doc')).toEqual({
      kind: 'document',
      sourceId: 'local-only-doc',
      teamVisible: false,
      orgId: null,
      reason: 'notShared',
    });
  });

  // A local project with no team: main always names the project now.
  it('still reports noTeam for the active project when it has no team scope', () => {
    store.set(activeWorkspacePathAtom, WORKSPACE);
    store.set(activeCollabScopeAtom, null);

    expect(getSharedDocumentVisibility('local-doc', WORKSPACE).reason).toBe('noTeam');
  });

  // MCP routes the request to the window whose rail holds the project, which
  // may be showing another project with its own team index.
  it('does not answer for another rail project from the active project\'s index', () => {
    store.set(activeWorkspacePathAtom, WORKSPACE);
    store.set(activeCollabScopeAtom, SCOPE);
    store.set(allSharedDocumentsAtom, [doc('shared-doc')]);

    expect(() => getSharedDocumentVisibility('shared-doc', '/workspace/other-project')).toThrow(/not loaded/);
    expect(getSharedDocumentVisibility('shared-doc', WORKSPACE).teamVisible).toBe(true);
  });

  it('moves, restores, and permanently removes rows without a connected provider', () => {
    store.set(activeCollabScopeAtom, SCOPE);
    store.set(allSharedDocumentsAtom, [doc('one')]);

    trashSharedDocument(SCOPE, 'one');
    expect(store.get(sharedDocumentsAtom)).toEqual([]);
    expect(store.get(trashedSharedDocumentsAtom)).toHaveLength(1);

    restoreSharedDocument(SCOPE, 'one');
    expect(store.get(sharedDocumentsAtom)).toHaveLength(1);
    expect(store.get(trashedSharedDocumentsAtom)).toEqual([]);

    trashSharedDocument(SCOPE, 'one');
    expect(emptySharedDocumentTrash(SCOPE)).toBe(1);
    expect(store.get(allSharedDocumentsAtom)).toEqual([]);
  });

  it('applies a command to its supplied scope even when another scope is active', () => {
    const other: CollabScope = {
      scopeKey: '/workspace/other-trash',
      orgId: 'org-other',
      indexConfig: { serverUrl: 'wss://example.test', teamMemberId: asTeamMemberId('user-other') },
    };
    store.set(activeCollabScopeAtom, SCOPE);
    store.set(allSharedDocumentsAtom, [doc('scope-one')]);
    store.set(activeCollabScopeAtom, other);
    store.set(allSharedDocumentsAtom, [doc('scope-two')]);

    trashSharedDocument(SCOPE, 'scope-one');

    expect(store.get(sharedDocumentsAtom).map((item) => item.documentId)).toEqual(['scope-two']);
    store.set(activeCollabScopeAtom, SCOPE);
    expect(store.get(trashedSharedDocumentsAtom).map((item) => item.documentId)).toEqual(['scope-one']);
  });
});
