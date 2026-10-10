// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { toLocalCommand } from '../LocalPagesDataSource';

describe('toLocalCommand', () => {
  it('stores an editor page rename as the stem, and leaves editor page creation to the app', () => {
    const extension = (id: string) => (id === 'draw' ? '.excalidraw' : undefined);
    expect(toLocalCommand({ type: 'update-document-title', documentId: 'draw', title: 'Flow v2.excalidraw' }, extension))
      .toEqual({ type: 'update-document-title', documentId: 'draw', title: 'Flow v2' });
    expect(toLocalCommand({ type: 'update-document-title', documentId: 'page', title: 'Notes.excalidraw' }, extension))
      .toEqual({ type: 'update-document-title', documentId: 'page', title: 'Notes.excalidraw' });
    expect(() => toLocalCommand({ type: 'register-document', documentId: 'x', title: 'Map', documentType: 'mindmap', parentFolderId: null }))
      .toThrow(/create it in Nimbalyst/);
  });
});
