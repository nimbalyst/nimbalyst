// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';
import { TeamSyncProvider } from '../TeamSync';

const metadata = { orgId: 'org-1', name: 'Org', gitRemoteHash: null, teamProjectId: 'p1', createdBy: 'u', createdAt: 1 };

function receive(provider: TeamSyncProvider, message: Record<string, unknown>): Promise<void> {
  return (provider as any).handleMessage({ data: JSON.stringify(message) });
}

it('confirms the author\'s page writes: capability, requestIds kept across an offline replay, echoes and refusals', async () => {
  const onWriteRefused = vi.fn();
  const onDocumentChanged = vi.fn();
  const onDocumentRemoved = vi.fn();
  const onFoldersRemoved = vi.fn();
  const provider = new TeamSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => asTeamJwt('token'),
    orgId: 'org-1',
    teamMemberId: asTeamMemberId('user-1'),
    onWriteRefused, onDocumentChanged, onDocumentRemoved, onFoldersRemoved,
  });

  // Written while offline; the replay sends them with their requestIds.
  provider.moveDocument('page-b', 'page-a', { sortOrder: 5, requestId: 'move-1' });
  provider.removeDocument('page-c', { requestId: 'remove-1' });
  provider.removeFolder('page-a', { requestId: 'remove-2' });
  provider.removeDocument('page-d');
  // Only Trash's permanent delete purges.
  provider.removeDocument('page-e', { requestId: 'remove-3', purge: true });
  const sent: unknown[] = [];
  (provider as any).ws = { readyState: WebSocket.OPEN, send: (data: string) => sent.push(JSON.parse(data)), close: () => undefined };
  (provider as any).replayPendingOfflineMessages();
  expect(sent).toEqual([
    { type: 'docMove', documentId: 'page-b', newParentFolderId: 'page-a', sortOrder: 5, requestId: 'move-1' },
    { type: 'docIndexRemove', documentId: 'page-c', requestId: 'remove-1' },
    { type: 'folderRemove', folderId: 'page-a', requestId: 'remove-2' },
    { type: 'docIndexRemove', documentId: 'page-d' },
    { type: 'docIndexRemove', documentId: 'page-e', requestId: 'remove-3', purge: true },
  ]);

  // Only a server that says so echoes author writes.
  await receive(provider, { type: 'teamSyncResponse', team: { metadata, members: [], documents: [], pageTree: true } });
  expect(provider.echoesAuthorWrites()).toBe(false);
  await receive(provider, { type: 'teamSyncResponse', team: { metadata, members: [], documents: [], pageTree: true, authorWriteEcho: true } });
  expect(provider.echoesAuthorWrites()).toBe(true);

  // The author's own echoes reach the same callbacks as a teammate's writes.
  await receive(provider, {
    type: 'docIndexBroadcast',
    document: {
      documentId: 'page-b', encryptedTitle: 'B', titleIv: '', documentType: 'markdown', createdBy: 'user-1', createdAt: 1,
      updatedAt: 2, projectId: 'p1', lastWriterUserId: 'user-1', parentFolderId: 'page-a', parentKind: 'page', sortOrder: 5, trashedAt: null,
    },
  });
  expect(onDocumentChanged).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'page-b', parentFolderId: 'page-a', sortOrder: 5 }));
  await receive(provider, { type: 'docIndexRemoveBroadcast', documentId: 'page-c' });
  expect(onDocumentRemoved).toHaveBeenCalledWith('page-c');
  await receive(provider, { type: 'folderRemoveBroadcast', folderIds: [], documentIds: ['page-a', 'page-b'] });
  await receive(provider, { type: 'folderRemoveBroadcast', folderIds: ['page-a'], documentIds: [] });
  expect(onFoldersRemoved.mock.calls).toEqual([[[], ['page-a', 'page-b']], [['page-a'], []]]);

  // A refusal names the write; an error without a requestId is not one.
  await receive(provider, { type: 'error', code: 'folder_cycle', message: 'cycle', requestId: 'move-1' });
  await receive(provider, { type: 'error', code: 'invalid_message', message: 'bad' });
  expect(onWriteRefused.mock.calls).toEqual([['move-1', { code: 'folder_cycle', message: 'cycle' }]]);
  provider.destroy();
});

it('re-reads the index after a refused author write, so the refused move does not stick', async () => {
  const onDocumentsLoaded = vi.fn();
  const provider = new TeamSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => asTeamJwt('token'),
    orgId: 'org-1',
    teamMemberId: asTeamMemberId('user-1'),
    onDocumentsLoaded,
  });
  const sent: Array<{ type: string }> = [];
  (provider as any).ws = { readyState: WebSocket.OPEN, send: (data: string) => sent.push(JSON.parse(data)), close: () => undefined };
  const entry = (parentFolderId: string | null) => ({
    documentId: 'page-b', encryptedTitle: 'B', titleIv: '', documentType: 'markdown', createdBy: 'user-1', createdAt: 1,
    updatedAt: 2, projectId: 'p1', lastWriterUserId: 'user-1', parentFolderId, parentKind: 'page', sortOrder: 1, trashedAt: null,
  });
  await receive(provider, { type: 'docIndexSyncResponse', documents: [entry('page-root')] });

  provider.moveDocument('page-b', 'page-a', { requestId: 'move-1' });
  expect(provider.getDocuments()[0]).toMatchObject({ parentFolderId: 'page-a' });

  // An error that names no author write is not a refusal of one: no re-read.
  sent.length = 0;
  await receive(provider, { type: 'error', code: 'invalid_message', message: 'bad' });
  expect(sent.map((message) => message.type)).not.toContain('docIndexSync');

  await receive(provider, { type: 'error', code: 'forbidden', message: 'read-only', requestId: 'move-1' });
  expect(sent.map((message) => message.type)).toEqual(expect.arrayContaining(['docIndexSync', 'folderIndexSync']));

  onDocumentsLoaded.mockClear();
  await receive(provider, { type: 'docIndexSyncResponse', documents: [entry('page-root')] });
  expect(provider.getDocuments()[0]).toMatchObject({ parentFolderId: 'page-root' });
  expect(onDocumentsLoaded).toHaveBeenCalledWith([expect.objectContaining({ documentId: 'page-b', parentFolderId: 'page-root' })]);
  provider.destroy();
});

it('page fields: capability, offline patches merged per page, and a broadcast without fields keeps what was known', async () => {
  const onDocumentChanged = vi.fn();
  const provider = new TeamSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => asTeamJwt('token'),
    orgId: 'org-1',
    teamMemberId: asTeamMemberId('user-1'),
    onDocumentChanged,
  });

  // Two offline edits to one page: the queue keeps one message per page, so
  // the second must not drop the first's status. A later key wins.
  provider.setDocumentFields('page-b', { status: 'draft', owner: 'ana@example.com' }, { requestId: 'fields-1' });
  provider.setDocumentFields('page-b', { owner: null, tags: ['sync'] }, { requestId: 'fields-2' });
  provider.setDocumentFields('page-c', { summary: 'Other page' });
  const sent: unknown[] = [];
  (provider as any).ws = { readyState: WebSocket.OPEN, send: (data: string) => sent.push(JSON.parse(data)), close: () => undefined };
  (provider as any).replayPendingOfflineMessages();
  expect(sent).toEqual([
    { type: 'docIndexSetFields', documentId: 'page-b', fields: { status: 'draft', owner: null, tags: ['sync'] }, requestId: 'fields-2' },
    { type: 'docIndexSetFields', documentId: 'page-c', fields: { summary: 'Other page' } },
  ]);

  await receive(provider, { type: 'teamSyncResponse', team: { metadata, members: [], documents: [], pageTree: true } });
  expect(provider.storesPageFields()).toBe(false);
  await receive(provider, { type: 'teamSyncResponse', team: { metadata, members: [], documents: [], pageTree: true, pageFields: true } });
  expect(provider.storesPageFields()).toBe(true);

  const entry = {
    documentId: 'page-b', encryptedTitle: 'B', titleIv: '', documentType: 'markdown', createdBy: 'user-1', createdAt: 1,
    updatedAt: 2, projectId: 'p1', lastWriterUserId: 'user-1', parentFolderId: null, parentKind: 'page', sortOrder: 1, trashedAt: null,
  };
  await receive(provider, { type: 'docIndexBroadcast', document: { ...entry, fields: { status: 'draft', tags: ['sync'] } } });
  expect(provider.getDocuments()[0].fields).toEqual({ status: 'draft', tags: ['sync'] });
  // A path that does not carry fields (absent) keeps them; null clears them.
  await receive(provider, { type: 'docIndexBroadcast', document: { ...entry, sortOrder: 2 } });
  expect(provider.getDocuments()[0]).toMatchObject({ sortOrder: 2, fields: { status: 'draft', tags: ['sync'] } });
  await receive(provider, { type: 'docIndexSyncResponse', documents: [entry] });
  expect(provider.getDocuments()[0].fields).toEqual({ status: 'draft', tags: ['sync'] });
  await receive(provider, { type: 'docIndexBroadcast', document: { ...entry, fields: null } });
  expect(provider.getDocuments()[0].fields).toBeUndefined();
  expect(onDocumentChanged).toHaveBeenLastCalledWith(expect.not.objectContaining({ fields: expect.anything() }));
  provider.destroy();
});
