// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';
import { DocumentSyncProvider } from '../DocumentSync';

describe('DocumentSyncProvider server diagnostics', () => {
  let provider: DocumentSyncProvider | null = null;

  afterEach(() => {
    provider?.destroy();
    provider = null;
  });

  it('forwards a custody-unavailable server diagnostic to its host', async () => {
    const onServerError = vi.fn();
    provider = new DocumentSyncProvider({
      serverUrl: 'wss://sync.test',
      orgId: 'org-1',
      teamMemberId: asTeamMemberId('member-1'),
      documentId: 'tracker-content/item-1',
      getJwt: async () => asTeamJwt('test-token'),
      // The contract is added by this regression: existing callers need no
      // server-error callback, but the headless tracker-body host does.
      onServerError,
    } as any);

    await (provider as any).handleMessage({
      data: JSON.stringify({
        type: 'error',
        code: 'key_custody_unavailable',
        message: 'Server-managed key custody is unavailable for this organization',
      }),
    });

    expect(onServerError).toHaveBeenCalledWith({
      type: 'error',
      code: 'key_custody_unavailable',
      message: 'Server-managed key custody is unavailable for this organization',
    });
  });

  it('still rejects the write when a host diagnostic listener throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    provider = new DocumentSyncProvider({
      serverUrl: 'wss://sync.test',
      orgId: 'org-1',
      teamMemberId: asTeamMemberId('member-1'),
      documentId: 'tracker-content/item-1',
      getJwt: async () => asTeamJwt('test-token'),
      onServerError: () => { throw new Error('observer failed'); },
    });
    const rejectionSpy = vi.spyOn(provider as any, 'handleWriteRejection').mockResolvedValue(undefined);

    try {
      await (provider as any).handleMessage({
        data: JSON.stringify({
          type: 'error',
          code: 'key_custody_unavailable',
          message: 'Server-managed key custody is unavailable for this organization',
          clientUpdateId: 'update-1',
        }),
      });

      expect(rejectionSpy).toHaveBeenCalledWith('key_custody_unavailable', 'update-1');
      expect(errorSpy).toHaveBeenCalledWith(
        '[DocumentSync] Server-error listener failed:',
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
