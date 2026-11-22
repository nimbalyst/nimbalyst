// @vitest-environment node
import { expect, it } from 'vitest';
import { prepareTeamRecovery } from '../TeamRecoveryPreparation';
import type { TeamRecoveryInventory } from '@nimbalyst/collab-protocol';

const inventory: TeamRecoveryInventory = { version: 1, orgId: 'org', inspectedAt: new Date().toISOString(), diagnostics: { version: 1, orgId: 'org', rawCustodyMode: null, status: 'legacy', keyPresent: false, keyProbe: 'absent', dekEpoch: null, dekFingerprint: null, projects: [{ projectId: 'project', teamProjectId: 'project' }] }, rooms: [
  { kind: 'documents', targetId: 'org', entries: [] }, { kind: 'folders', targetId: 'org', entries: [] },
  ...(['items', 'schemas', 'views', 'navigation'] as const).map(kind => ({ kind, targetId: 'project', entries: [] })),
] };
it('requires collecting a linked folder even when the server has no content', async () => {
  const result = await prepareTeamRecovery({ inventory, sources: [], bundles: [], decrypt: () => { throw new Error('No key'); }, itemPayload: row => row.payload as string });
  expect(result.manifest).toBeNull();
  expect(result.blockers).toContainEqual({ id: 'project', reason: 'Collect a linked folder for this project, including its never-uploaded shared tickets, before recovery' });
});
it('names content the server recovery cannot restore yet, so Start is disabled before the server refuses', async () => {
  const value = structuredClone(inventory);
  value.diagnostics.uncoveredContent = ['team-inbox', 'conversations'];
  const result = await prepareTeamRecovery({ inventory: value, sources: [], bundles: [], decrypt: () => { throw new Error('No key'); }, itemPayload: row => row.payload as string });
  expect(result.manifest).toBeNull();
  expect(result.blockers).toContainEqual({ id: 'org', reason: 'Recovery does not yet cover team inbox messages; this organization cannot be recovered in place until it does' });
  expect(result.blockers).toContainEqual({ id: 'org', reason: 'Recovery does not yet cover team conversations; this organization cannot be recovered in place until it does' });
});
it('blocks a live server item whose plaintext is absent instead of dropping it', async () => {
  const value = structuredClone(inventory);
  value.rooms.find(room => room.kind === 'items')!.entries.push({ id: 'old', revision: 'a'.repeat(64), fingerprint: 'old-key', deleted: false, syncId: 8, issueKey: 'NIM-610', issueNumber: 610 });
  const result = await prepareTeamRecovery({ inventory: value, sources: [], bundles: [], decrypt: () => { throw new Error('No key'); }, itemPayload: row => row.payload as string });
  expect(result.manifest).toBeNull();
  expect(result.blockers.some(blocker => blocker.id === 'old')).toBe(true);
});

it('uses another device’s recovered metadata without requiring its legacy key on this device', async () => {
  const value = structuredClone(inventory);
  value.rooms.find(room => room.kind === 'folders')!.entries.push({ id: 'folder', revision: 'a'.repeat(64), fingerprint: 'old-key', deleted: false });
  const result = await prepareTeamRecovery({ inventory: value, sources: [], bundles: [{ version: 1, orgId: 'org', createdAt: new Date().toISOString(), trackerRows: [], documents: [], projects: [
    { teamProjectId: 'project', workspacePath: '/workspace', accountId: 'account' },
    { recoveredMetadata: { documents: [], folders: [{ id: 'folder', expectedRevision: 'a'.repeat(64), name: 'Preserved folder' }] } },
  ] }], decrypt: () => { throw new Error('No local key'); }, itemPayload: row => row.payload as string });
  expect(result.blockers).toEqual([]);
  expect(result.payloads[0].payload).toMatchObject({ folders: [{ id: 'folder', name: 'Preserved folder' }] });
});

it('blocks a never-uploaded attachment without readable bytes instead of omitting it', async () => {
  const value = structuredClone(inventory);
  value.rooms.find(room => room.kind === 'documents')!.entries.push({ id: 'doc', revision: 'a'.repeat(64), fingerprint: null, deleted: false });
  const result = await prepareTeamRecovery({ inventory: value, sources: [], bundles: [{ version: 1, orgId: 'org', createdAt: new Date().toISOString(), trackerRows: [],
    documents: [{ documentId: 'doc', verdict: 'complete', lastServerSeq: 0, encodingVersion: 1, snapshot: { base64: 'AAA=' }, updates: [], outbox: [] }],
    projects: [{ teamProjectId: 'project', workspacePath: '/workspace', accountId: 'account', assets: [{ documentId: 'doc', assetId: 'pending-asset', verdict: 'unreadable' }],
      recoveredMetadata: { documents: [{ id: 'doc', expectedRevision: 'a'.repeat(64), title: 'Document' }], folders: [] } }],
  }], decrypt: () => { throw new Error('No key'); }, itemPayload: row => row.payload as string });
  expect(result.manifest).toBeNull();
  expect(result.blockers.some(blocker => blocker.id === 'doc')).toBe(true);
});

it('blocks a local document whose shared identity is absent from the server registry', async () => {
  const result = await prepareTeamRecovery({ inventory, sources: [], bundles: [{ version: 1, orgId: 'org', createdAt: new Date().toISOString(), trackerRows: [],
    documents: [{ documentId: 'unregistered-local-doc', verdict: 'complete' }],
    projects: [{ teamProjectId: 'project', workspacePath: '/workspace', accountId: 'account' }],
  }], decrypt: () => { throw new Error('No key'); }, itemPayload: row => row.payload as string });
  expect(result.manifest).toBeNull();
  expect(result.blockers.some(blocker => blocker.id === 'unregistered-local-doc')).toBe(true);
});
