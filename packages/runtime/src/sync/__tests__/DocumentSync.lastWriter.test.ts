/**
 * Last-writer attribution (NIM-953 / NIM-955).
 *
 * The DocumentRoom stamps each docSyncResponse with the userId + timestamp of
 * the most recent content update so the client can tell a user who/when last
 * edited a shared doc before their push overwrites it. The provider captures
 * those fields and exposes them via getters; main reads them in the overwrite
 * conflict path.
 */

import { describe, expect, it } from 'vitest';
import { DocumentSyncProvider } from '../DocumentSync';

function provider(): DocumentSyncProvider {
  return new DocumentSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => 'token',
    orgId: 'org-1',
    keyCustody: 'server-managed',
    userId: 'user-1',
    documentId: 'doc-1',
    reviewGateEnabled: false,
  });
}

describe('DocumentSync last-writer attribution', () => {
  it('captures lastWriterUserId/lastUpdatedAt from a docSyncResponse', async () => {
    const p = provider();
    await (p as any).handleSyncResponse({
      type: 'docSyncResponse',
      updates: [],
      hasMore: false,
      cursor: 0,
      lastWriterUserId: 'member-bob',
      lastUpdatedAt: 1782400000000,
    });
    expect(p.getLastWriterUserId()).toBe('member-bob');
    expect(p.getLastUpdatedAt()).toBe(1782400000000);
    p.destroy();
  });

  it('defaults to null and tolerates a response without attribution', async () => {
    const p = provider();
    expect(p.getLastWriterUserId()).toBeNull();
    expect(p.getLastUpdatedAt()).toBeNull();
    await (p as any).handleSyncResponse({
      type: 'docSyncResponse',
      updates: [],
      hasMore: false,
      cursor: 0,
    });
    expect(p.getLastWriterUserId()).toBeNull();
    expect(p.getLastUpdatedAt()).toBeNull();
    p.destroy();
  });

  it('keeps the last non-undefined attribution across paginated responses', async () => {
    const p = provider();
    // Page 1 carries attribution and signals more pages.
    await (p as any).handleSyncResponse({
      type: 'docSyncResponse',
      updates: [],
      hasMore: true,
      cursor: 0,
      lastWriterUserId: 'member-bob',
      lastUpdatedAt: 1782400000000,
    });
    expect(p.getLastWriterUserId()).toBe('member-bob');
    p.destroy();
  });
});
