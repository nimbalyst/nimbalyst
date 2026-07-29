/**
 * Client-side counterpart to the server's NIM-2231 fail-closed change.
 *
 * The retired client-managed lane is gone, so the client holds no org key. The
 * server serves content it owns as PLAINTEXT with the empty-iv sentinel; a
 * NON-EMPTY iv means the row is pre-cutover ciphertext nothing can read.
 *
 * Those rows must surface as locked/failed, never as text. Rendering raw base64
 * as a document title is the specific regression this guards: the shared-tree
 * builder splits titles on '/', so a base64 title shreds the tree.
 */

import { describe, expect, it, vi } from 'vitest';
import { TeamSyncProvider } from '../TeamSync';
import type { TeamSyncConfig } from '../teamSyncTypes';

function createProvider(overrides: Partial<TeamSyncConfig> = {}): TeamSyncProvider {
  const config: TeamSyncConfig = {
    serverUrl: 'ws://example.test',
    getJwt: async () => 'token',
    orgId: 'org-1',
    userId: 'user-1',
    ...overrides,
  };
  return new TeamSyncProvider(config);
}

describe('TeamSyncProvider pre-cutover content', () => {
  it('marks a doc-index title with a non-empty iv as decryptFailed instead of showing ciphertext', async () => {
    const onDocumentsLoaded = vi.fn();
    const provider = createProvider({ onDocumentsLoaded });

    await (provider as unknown as {
      handleDocIndexSyncResponse: (msg: unknown) => Promise<void>;
    }).handleDocIndexSyncResponse({
      type: 'docIndexSyncResponse',
      documents: [
        {
          documentId: 'doc-plain',
          encryptedTitle: 'Readable Title',
          titleIv: '',
          documentType: 'markdown',
          createdBy: 'user-1',
          createdAt: 1,
          updatedAt: 2,
          projectId: null,
          lastWriterUserId: null,
          parentFolderId: null,
          trashedAt: null,
        },
        {
          documentId: 'doc-legacy',
          encryptedTitle: 'c2hyZWRkZWQvYnkvc2xhc2hlcw==',
          titleIv: 'bm9uLWVtcHR5LWl2',
          documentType: 'markdown',
          createdBy: 'user-1',
          createdAt: 1,
          updatedAt: 2,
          projectId: null,
          lastWriterUserId: null,
          parentFolderId: null,
          trashedAt: null,
        },
      ],
    });

    const documents = onDocumentsLoaded.mock.calls[0][0] as Array<{
      documentId: string; title: string; decryptFailed?: boolean;
    }>;
    const plain = documents.find(d => d.documentId === 'doc-plain');
    const legacy = documents.find(d => d.documentId === 'doc-legacy');

    expect(plain).toMatchObject({ title: 'Readable Title' });
    expect(plain?.decryptFailed).toBeUndefined();

    expect(legacy?.decryptFailed).toBe(true);
    expect(legacy?.title).not.toContain('c2hyZWRkZWQ');

    provider.destroy();
  });

  it('refuses a folder name with a non-empty iv rather than returning ciphertext', async () => {
    const provider = createProvider();
    const decryptFolderName = (provider as unknown as {
      decryptFolderName: (name: string, iv: string) => Promise<string>;
    }).decryptFolderName.bind(provider);

    await expect(decryptFolderName('Plain Folder', '')).resolves.toBe('Plain Folder');
    await expect(decryptFolderName('Y2lwaGVydGV4dA==', 'bm9uLWVtcHR5')).rejects.toThrow(
      /pre-cutover client-encrypted content/,
    );

    provider.destroy();
  });

  it('sends plaintext titles with the empty-iv sentinel', async () => {
    const provider = createProvider();
    const sent: Array<Record<string, unknown>> = [];
    (provider as unknown as { send: (m: Record<string, unknown>) => void }).send =
      (message) => { sent.push(message); };

    await provider.registerDocument('doc-1', 'Notes.md', 'markdown', null);
    await provider.updateDocumentTitle('doc-1', 'Renamed.md');

    expect(sent).toEqual([
      expect.objectContaining({ type: 'docIndexRegister', encryptedTitle: 'Notes.md', titleIv: '' }),
      expect.objectContaining({ type: 'docIndexUpdate', encryptedTitle: 'Renamed.md', titleIv: '' }),
    ]);
    // No client-asserted key epoch travels on the wire any more.
    expect(sent.every(m => !('orgKeyFingerprint' in m))).toBe(true);

    provider.destroy();
  });
});
