// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { activeCollabScopeAtom, registerDocumentInIndex, sharedDocumentsAtom } from '../collabDocuments';
import { pendingDocRegistrations } from '../pendingDocRegistrations';
import type { CollabScope } from '@nimbalyst/collab-client/core';

const WS = '/workspace/register-test';
const SCOPE: CollabScope = {
  scopeKey: WS,
  orgId: 'org-register',
  indexConfig: { serverUrl: 'wss://example.test', teamMemberId: asTeamMemberId('user-register') },
};

afterEach(() => {
  pendingDocRegistrations.clear(WS);
  store.set(activeCollabScopeAtom, null);
});

describe('registerDocumentInIndex (NIM-1565)', () => {
  it('queues the registration when no team-sync provider is connected', async () => {
    store.set(activeCollabScopeAtom, SCOPE);

    await registerDocumentInIndex(SCOPE, 'doc-1', 'Folder/What is Next.md', 'markdown', 'folder-1', {
      metadataVersion: 2,
      fileExtension: '.md',
      editorId: 'builtin.lexical',
    });

    // Optimistic entry still shows in the atom this session...
    expect(store.get(sharedDocumentsAtom).some((d) => d.documentId === 'doc-1')).toBe(true);
    // ...and, crucially, the server registration is queued (not dropped) so a
    // later provider connect can persist it.
    expect(pendingDocRegistrations.list(WS)).toEqual([
      {
        documentId: 'doc-1',
        title: 'Folder/What is Next.md',
        documentType: 'markdown',
        parentFolderId: 'folder-1',
        metadataVersion: 2,
        fileExtension: '.md',
        editorId: 'builtin.lexical',
      },
    ]);
    expect(store.get(sharedDocumentsAtom).find((d) => d.documentId === 'doc-1')?.parentFolderId)
      .toBe('folder-1');
    expect(store.get(sharedDocumentsAtom).find((d) => d.documentId === 'doc-1')).toMatchObject({
      metadataVersion: 2,
      fileExtension: '.md',
      editorId: 'builtin.lexical',
    });
  });
});
