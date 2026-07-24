import { describe, expect, it, vi } from 'vitest';
import { TeamSyncProvider } from '../TeamSync';
import type { TeamSyncConfig } from '../teamSyncTypes';

function createProvider(onFoldersLoaded = vi.fn()): TeamSyncProvider {
  const config: TeamSyncConfig = {
    serverUrl: 'ws://example.test',
    getJwt: async () => 'token',
    orgId: 'org-1',
    userId: 'user-1',
    keyCustody: 'server-managed',
    orgKeyFingerprint: null,
    onFoldersLoaded,
  };
  return new TeamSyncProvider(config);
}

describe('TeamSyncProvider folder refresh', () => {
  it('requests a fresh folder-index snapshot and resolves with decrypted folders', async () => {
    const onFoldersLoaded = vi.fn();
    const provider = createProvider(onFoldersLoaded);
    const sent: Array<{ type: string }> = [];

    (provider as any).send = (message: { type: string }) => {
      sent.push(message);
      if (message.type === 'folderIndexSync') {
        void (provider as any).handleFolderIndexSyncResponse({
          type: 'folderIndexSyncResponse',
          folders: [{
            folderId: 'folder-1',
            parentFolderId: null,
            encryptedName: 'Current Folder',
            nameIv: '',
            sortOrder: 0,
            projectId: 'project-1',
            createdBy: 'user-1',
            createdAt: 1,
            updatedAt: 2,
          }],
        });
      }
    };

    const folders = await provider.refreshFolders(100);

    expect(sent).toEqual([{ type: 'folderIndexSync' }]);
    expect(folders).toEqual([
      expect.objectContaining({
        folderId: 'folder-1',
        name: 'Current Folder',
        parentFolderId: null,
      }),
    ]);
    expect(onFoldersLoaded).toHaveBeenCalledWith(folders);
    provider.destroy();
  });

  it('includes the authoritative parent folder id when registering a document', async () => {
    const provider = createProvider();
    const sent: Array<Record<string, unknown>> = [];
    (provider as any).send = (message: Record<string, unknown>) => sent.push(message);

    await provider.registerDocument('doc-1', 'Specs/Notes.md', 'markdown', 'specs');

    expect(sent).toEqual([
      expect.objectContaining({
        type: 'docIndexRegister',
        documentId: 'doc-1',
        parentFolderId: 'specs',
      }),
    ]);
    provider.destroy();
  });

  it('writes explicit V2 document type metadata on registration', async () => {
    const provider = createProvider();
    const sent: Array<Record<string, unknown>> = [];
    (provider as any).send = (message: Record<string, unknown>) => sent.push(message);

    await provider.registerDocument('doc-v2', 'Sketch.excalidraw', 'excalidraw', null, {
      metadataVersion: 2,
      fileExtension: '.excalidraw',
      editorId: 'com.nimbalyst.excalidraw',
    });

    expect(sent[0]).toMatchObject({
      type: 'docIndexRegister',
      metadataVersion: 2,
      fileExtension: '.excalidraw',
      editorId: 'com.nimbalyst.excalidraw',
    });
    provider.destroy();
  });
});
