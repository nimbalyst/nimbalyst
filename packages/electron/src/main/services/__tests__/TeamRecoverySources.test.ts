// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { collectRecoverySources } from '../TeamRecoverySources';

it('preserves already-synced and pending shared rows without changing sync state or including private rows', async () => {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM tracker_items') ? [
    { id: 'old', type: 'bug', sync_status: 'synced', issue_key: 'NIM-1', issue_number: 1, created: new Date('2026-01-01T00:00:00Z') },
    { id: 'pending', type: 'bug', sync_status: 'pending', issue_key: 'NIM-2', issue_number: 2 },
    { id: 'private', type: 'note', sync_status: 'local' },
  ] : [] }));
  const result = await collectRecoverySources({ orgId: 'org', accountId: 'account', workspacePath: '/workspace', teamProjectId: 'project',
    query, sharing: type => type === 'bug' ? 'team' : 'personal', readReplica: async () => null });
  expect(result.trackerRows.map(r => r.id)).toEqual(['old', 'pending']);
  expect(result.trackerRows[0].sync_status).toBe('synced');
  expect(result.trackerRows[0].created).toBe('2026-01-01T00:00:00.000Z');
  expect(query.mock.calls.every(([sql]) => /^SELECT/.test(sql))).toBe(true);
  expect(result.projects[0]).toMatchObject({ privateItemCount: 1 });
});

it('blocks unknown sharing and records incomplete replicas without claiming a readable source', async () => {
  const input = { orgId: 'org', accountId: 'account', workspacePath: '/workspace', teamProjectId: 'project',
    query: async (sql: string) => ({ rows: sql.includes('FROM tracker_items') ? [{ id: 'item', type: 'bug' }] : [] }),
    sharing: () => 'unknown' as const, readReplica: async () => null };
  await expect(collectRecoverySources(input)).rejects.toThrow('sharing policy');
});

it('keeps unpublished drafts and personal navigation out of a team recovery bundle', async () => {
  const result = await collectRecoverySources({ orgId: 'org', accountId: 'account', workspacePath: '/workspace', teamProjectId: 'project',
    query: async sql => ({ rows: sql.includes('FROM tracker_items') ? [{ id: 'draft', type: 'bug', data: { shared: false } }] : sql.includes('FROM tracker_type_navigation') ? [
      { entry_id: 'mine', payload: JSON.stringify({ kind: 'folder', ownership: 'personal' }) },
      { entry_id: 'ours', sync_id: 4, payload: JSON.stringify({ kind: 'folder' }) },
    ] : [] }), sharing: () => 'team', includeItem: () => false, readReplica: async () => null });
  expect(result.trackerRows).toEqual([]);
  expect((result.projects[0].navigation as Array<{ entry_id: string }>).map(row => row.entry_id)).toEqual(['ours']);
});

it('reads only attachment identities from the cache table and each attachment body once', async () => {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => ({ rows: sql.includes('FROM tracker_items') ? [{ id: 'item', type: 'bug' }]
    : sql.includes('FROM collab_document_assets') ? [{ document_id: 'tracker-content/item', asset_id: 'image', account_id: 'account' }] : [] }));
  const bytes = new Uint8Array([1, 2, 3]);
  const readAsset = vi.fn(async (documentId: string, assetId: string) => ({ identity: { accountId: 'account', orgId: 'org', documentId, assetId }, bytes, mimeType: 'image/png', fileName: 'a.png', uploadState: 'cached' } as any));
  const result = await collectRecoverySources({ orgId: 'org', accountId: 'account', workspacePath: '/workspace', teamProjectId: 'project',
    query, sharing: () => 'team', readReplica: async () => null, readAsset });
  const assetQuery = query.mock.calls.find(([sql]) => sql.includes('FROM collab_document_assets'))!;
  expect(assetQuery[0]).not.toMatch(/\*|encrypted_asset/);
  expect(assetQuery[1]).toEqual(['org', 'account']);
  expect(readAsset).toHaveBeenCalledTimes(1);
  expect(result.projects[0].assets).toMatchObject([{ assetId: 'image', verdict: 'complete', base64: 'AQID' }]);
});
