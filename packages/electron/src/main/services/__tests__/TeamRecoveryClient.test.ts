// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { TeamRecoveryClient } from '../TeamRecoveryClient';
import { recoveryDigest } from '../TeamRecoveryPreparation';

it('never starts a write without a verified saved recovery artifact', async () => {
  const api = vi.fn();
  const client = new TeamRecoveryClient('org', { api } as any);
  await expect(client.restore('passphrase')).rejects.toThrow('saved');
  expect(api).not.toHaveBeenCalled();
});

it('refuses to acknowledge a verification read whose contents differ from the saved manifest', async () => {
  const payload = { documents: [], folders: [{ id: 'folder', expectedRevision: 'a'.repeat(64), name: 'Reviewed title' }] };
  const room = { kind: 'team', id: 'org', digest: recoveryDigest(payload) };
  const manifest = { version: 1, orgId: 'org', bundleDigest: 'b'.repeat(64), rooms: [room] };
  const operation = { operationId: 'op', manifestDigest: recoveryDigest(manifest), manifest, phase: 'validating', initiatorClientId: 'first', startedAt: new Date().toISOString(), rooms: [{ ...room, fenced: true, restored: true, verified: false, released: false }] };
  const prepared = { manifest, payloads: [{ kind: 'team', id: 'org', payload }], blockers: [], counts: { projects: 0, items: 0, documents: 0, attachments: 0 } };
  const bundle = { version: 1, orgId: 'org', createdAt: new Date().toISOString(), trackerRows: [], documents: [], projects: [{ recovery: { inventory: { diagnostics: {} }, sources: [], encryptedAssets: [], prepared } }] };
  const api = vi.fn(async (_path: string, body: any) => body.action === 'status' ? { operation } : { nonce: 'nonce', digest: room.digest, value: { documents: [], folders: [{ id: 'folder', name: 'Different content' }] } });
  const client = new TeamRecoveryClient('org', { api, clientId: () => 'second', openFile: async () => '/recovery.nimrecovery', readBundle: async () => bundle } as any);
  await client.import('a recovery passphrase');
  await expect(client.verify('a recovery passphrase')).rejects.toThrow('differs');
  expect(api.mock.calls.some(([, body]) => body.action === 'verify-ack' || body.action === 'advance')).toBe(false);
});

it('rejects malformed recovery diagnostics before reading any inventory', async () => {
  const api = vi.fn(async (path: string) => path === 'control' ? { operation: null }
    : path === 'diagnostics' ? { version: 1, orgId: 'org', status: 'legacy', keyProbe: 'maybe', keyPresent: false, projects: [{ projectId: 7 }] } : {});
  const client = new TeamRecoveryClient('org', { api, clientId: () => 'first' } as any);
  await expect(client.inspect()).rejects.toThrow('Invalid recovery diagnostics');
  expect(api.mock.calls.some(([path]) => String(path).startsWith('inventory'))).toBe(false);
});

it('fails an oversized bundle before asking where to save it, naming the limit', async () => {
  const saveFile = vi.fn(async () => '/never');
  const client = new TeamRecoveryClient('org', { api: vi.fn(), clientId: () => 'first', saveFile, writeBundle: vi.fn() } as any);
  const bytes = (fill: string) => fill.repeat(70 * 1024 * 1024);
  Object.assign(client as any, {
    inventory: { version: 1, orgId: 'org', diagnostics: {}, rooms: [] },
    prepared: { manifest: null, payloads: [], blockers: [], counts: { projects: 0, items: 0, documents: 0, attachments: 0 } },
    bundles: [{ version: 1, orgId: 'org', createdAt: new Date().toISOString(), trackerRows: [], projects: [],
      documents: [{ documentId: 'a', snapshot: { base64: bytes('A') } }, { documentId: 'b', snapshot: { base64: bytes('B') } }] }],
  });
  await expect(client.save('a recovery passphrase')).rejects.toThrow('128 MiB');
  expect(saveFile).not.toHaveBeenCalled();
});

it('restores a reviewed organization from its saved bundle and leaves it validating', async () => {
  const Y = await import('yjs');
  const { createHash } = await import('node:crypto');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeRecoveryBundle, readRecoveryBundle } = await import('../TeamRecoveryBundle');
  const update = (text: string) => { const doc = new Y.Doc(); doc.getText('body').insert(0, text); const bytes = Buffer.from(Y.encodeStateAsUpdate(doc)); doc.destroy(); return bytes.toString('base64'); };
  const ticket = (itemId: string, extra: Record<string, unknown> = {}) => JSON.stringify({ itemId, primaryType: 'task', archived: false, bodyVersion: 0, fields: { title: itemId }, labels: {}, comments: [], system: {}, ...extra });
  const stored: Record<string, Array<Record<string, any>>> = {
    'folders:org': [{ id: 'folder', fingerprint: null, deleted: false, stored: { id: 'folder', encrypted_name: 'Preserved folder', name_iv: '' } }],
    'items:project': [{ id: 'old', fingerprint: 'legacy', deleted: false, syncId: 8, issueKey: 'NIM-610', issueNumber: 610, stored: { id: 'old', encrypted_payload: ticket('old', { issueKey: 'NIM-610', issueNumber: 610 }), iv: '' } }],
    'updates:tracker-content/old': [{ id: 'u1', fingerprint: 'legacy', deleted: false, sequence: 1, stored: { id: 'u1', update_data: update('server body'), iv: '' } }],
  };
  for (const rows of Object.values(stored)) for (const row of rows) row.revision = recoveryDigest(row.stored);
  const diagnostics = { version: 1, orgId: 'org', rawCustodyMode: null, status: 'legacy', keyPresent: false, keyProbe: 'absent', dekEpoch: null, dekFingerprint: null, projects: [{ projectId: 'project', teamProjectId: 'project' }] };
  let operation: any = null;
  const calls: Array<Record<string, any>> = [];
  const api = vi.fn(async (path: string, body?: Record<string, any>) => {
    if (path === 'diagnostics') return diagnostics;
    const query = new URLSearchParams(path.split('?')[1] ?? '');
    const rows = stored[`${query.get('kind')}:${query.get('targetId')}`] ?? [];
    if (path.startsWith('inventory?')) return { version: 1, kind: query.get('kind'), nextCursor: null, entries: rows.map(({ stored: _stored, ...entry }) => entry), ...(query.get('kind') === 'items' ? { nextIssueNumber: 611, issueKeyPrefix: 'NIM' } : {}) };
    if (path.startsWith('sources?')) return { version: 1, kind: query.get('kind'), nextCursor: null, entries: rows };
    calls.push(body!);
    if (body!.action === 'start') operation = { operationId: 'op', manifestDigest: recoveryDigest(body!.manifest), manifest: body!.manifest, phase: 'fenced', initiatorClientId: 'first', startedAt: new Date().toISOString(),
      rooms: body!.manifest.rooms.map((room: object) => ({ ...room, fenced: false, restored: false, verified: false, released: false })) };
    if (body!.action === 'advance' && operation.phase === 'fenced') operation = { ...operation, phase: 'restoring', rooms: operation.rooms.map((room: object) => ({ ...room, fenced: true })) };
    if (body!.action === 'restore') {
      operation = { ...operation, rooms: operation.rooms.map((room: any) => room.kind === body!.kind && room.id === body!.id ? { ...room, restored: true } : room) };
      if (operation.rooms.every((room: any) => room.restored)) operation = { ...operation, phase: 'validating' };
    }
    return { operation };
  });
  const asset = Buffer.from('attachment bytes');
  const collected = { version: 1 as const, orgId: 'org', createdAt: new Date().toISOString(),
    projects: [{ teamProjectId: 'project', workspacePath: '/workspace', accountId: 'account', schemas: [], views: [], navigation: [],
      assets: [{ documentId: 'tracker-content/new', assetId: 'image', verdict: 'complete', mimeType: 'image/png', fileName: 'image.png', base64: asset.toString('base64'), sha256: createHash('sha256').update(asset).digest('hex') }] }],
    trackerRows: [{ id: 'new', type: 'task', sync_id: null, issue_key: null, issue_number: null, deleted_at: null, recoveryProjectId: 'project', payload: ticket('new') }],
    documents: [{ documentId: 'tracker-content/new', source: 'local-replica', verdict: 'complete', encodingVersion: 1, lastServerSeq: 0, snapshot: { base64: update('local body') }, updates: [], outbox: [] }] };
  const directory = await mkdtemp(join(tmpdir(), 'recovery-client-'));
  const filename = join(directory, 'organization.nimrecovery');
  const deps = (clientId: string) => ({ api, clientId: () => clientId, collect: async () => structuredClone(collected),
    withKeys: (action: any) => action(() => { throw new Error('No retained key'); }, ['org-key-history.enc']),
    itemPayload: (row: Record<string, any>) => row.payload, saveFile: async () => filename, openFile: async () => filename,
    writeBundle: writeRecoveryBundle, readBundle: (file: string, password: string) => readRecoveryBundle(file, password, 'org') });
  const passphrase = 'a portable recovery passphrase';
  try {
    const client = new TeamRecoveryClient('org', deps('first'));
    await client.inspect();
    const reviewed = await client.collect('/workspace');
    expect(reviewed.blockers).toEqual([]);
    expect(reviewed.notices.map(notice => notice.id)).toEqual(['org-key-history.enc']);
    expect(reviewed.identityAssignments).toEqual([
      { projectId: 'project', itemId: 'old', issueKey: 'NIM-610', existing: true },
      { projectId: 'project', itemId: 'new', issueKey: 'NIM-611', existing: false },
    ]);
    expect((await client.save(passphrase)).saved).toBe(true);
    const restored = await client.restore(passphrase);
    expect(restored.operation?.phase).toBe('validating');

    const previews = calls.filter(call => call.action === 'preview');
    const manifest = calls.find(call => call.action === 'start')!.manifest;
    expect(previews.map(call => [call.room.kind, call.room.id])).toEqual([['team', 'org'], ['tracker', 'project'], ['document', 'tracker-content/old'], ['document', 'tracker-content/new']]);
    for (const call of previews) expect(call.room.digest).toBe(recoveryDigest(call.payload));
    expect(manifest.rooms).toEqual(previews.map(call => call.room));
    const restores = calls.filter(call => call.action === 'restore');
    expect(restores.map(call => recoveryDigest(call.payload))).toEqual(manifest.rooms.map((room: { digest: string }) => room.digest));
    const tracker = restores.find(call => call.kind === 'tracker')!.payload;
    expect(tracker.items.map((item: any) => [item.id, item.issueKey, item.expectedRevision, item.sourceSyncId])).toEqual([['old', 'NIM-610', stored['items:project'][0].revision, 8], ['new', 'NIM-611', null, null]]);
    expect(restores.find(call => call.id === 'tracker-content/new')!.payload.assets).toMatchObject([{ id: 'image', base64: asset.toString('base64') }]);

    // Dropped main-process state is recoverable: a fresh client resumes from the saved bundle.
    const second = await new TeamRecoveryClient('org', deps('second')).import(passphrase);
    expect(second).toMatchObject({ saved: true, ready: true, independentClient: true, operation: { phase: 'validating' } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
