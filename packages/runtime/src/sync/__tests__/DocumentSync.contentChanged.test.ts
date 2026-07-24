import { describe, expect, it, vi } from 'vitest';

import { DocumentSyncProvider } from '../DocumentSync';

describe('DocumentSyncProvider content change signal', () => {
  it('notifies the host after a local Y.Doc update', async () => {
    const onContentChanged = vi.fn();
    const provider = new DocumentSyncProvider({
      serverUrl: 'wss://example.invalid',
      getJwt: async () => 'jwt',
      orgId: 'org-1',
      keyCustody: 'server-managed',
      userId: 'user-1',
      documentId: 'doc-1',
      onContentChanged,
    });

    provider.getYDoc().getText('content').insert(0, 'plaintext');
    await Promise.resolve();

    expect(onContentChanged).toHaveBeenCalledTimes(1);
    provider.destroy();
  });

  it('keeps the local update queued when the host callback throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = new DocumentSyncProvider({
      serverUrl: 'wss://example.invalid',
      getJwt: async () => 'jwt',
      orgId: 'org-1',
      keyCustody: 'server-managed',
      userId: 'user-1',
      documentId: 'doc-1',
      onContentChanged: () => { throw new Error('host serialization failed'); },
    });

    provider.getYDoc().getText('content').insert(0, 'still queued');
    await Promise.resolve();

    expect(provider.getStatus()).toBe('offline-unsynced');
    expect(warn).toHaveBeenCalledWith(
      '[DocumentSync] Content-change callback failed:',
      expect.any(Error),
    );
    provider.destroy();
    warn.mockRestore();
  });
});
