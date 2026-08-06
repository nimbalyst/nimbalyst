import { describe, expect, it, vi } from 'vitest';
import { TeamSyncProvider } from '../TeamSync';
import type { TeamSyncConfig } from '../teamSyncTypes';

function createProvider(onFoldersLoaded = vi.fn()): TeamSyncProvider {
  const config: TeamSyncConfig = {
    serverUrl: 'ws://example.test',
    getJwt: async () => 'token',
    orgId: 'org-1',
    userId: 'user-1',
    onFoldersLoaded,
  };
  return new TeamSyncProvider(config);
}

/**
 * Stand in for the server's `docIndexRegistered` ack.
 *
 * `registerDocument` resolves on that ack (NIM-2472), so a stubbed `send` that
 * stays silent leaves every registration waiting out its timeout.
 */
function ackRegistration(provider: TeamSyncProvider, message: Record<string, unknown>): void {
  if (message.type !== 'docIndexRegister') return;
  (provider as any).resolveRegisterAck(message.documentId, true);
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
    (provider as any).send = (message: Record<string, unknown>) => {
      sent.push(message);
      ackRegistration(provider, message);
    };

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

  it('resolves a registration only once the server acks it', async () => {
    // The seed that follows cannot connect until the index row exists, so
    // "registered" has to mean confirmed, not merely sent (NIM-2472).
    const provider = createProvider();
    let settled = false;
    (provider as any).send = () => {};

    const registered = provider.registerDocument('doc-1', 'Notes.md', 'markdown', null, undefined, 50)
      .then((value) => { settled = true; return value; });

    await Promise.resolve();
    expect(settled).toBe(false);

    (provider as any).handleMessage({
      data: JSON.stringify({ type: 'docIndexRegistered', documentId: 'doc-1' }),
    });

    await expect(registered).resolves.toBe(true);
    provider.destroy();
  });

  it('reports an unacked registration as unconfirmed rather than throwing', async () => {
    // A server predating the ack, or a mutation queued offline. The caller
    // decides whether to proceed optimistically; it must not see a failure.
    const provider = createProvider();
    (provider as any).send = () => {};

    await expect(
      provider.registerDocument('doc-1', 'Notes.md', 'markdown', null, undefined, 10),
    ).resolves.toBe(false);
    provider.destroy();
  });

  it('writes explicit V2 document type metadata on registration', async () => {
    const provider = createProvider();
    const sent: Array<Record<string, unknown>> = [];
    (provider as any).send = (message: Record<string, unknown>) => {
      sent.push(message);
      ackRegistration(provider, message);
    };

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
