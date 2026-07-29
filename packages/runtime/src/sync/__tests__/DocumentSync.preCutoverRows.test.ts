import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { DocumentSyncProvider } from '../DocumentSync';

/**
 * Pre-cutover contract. Team custody is server-managed: the server decrypts
 * the rows it owns and ships PLAINTEXT with the empty-iv sentinel (''). A
 * non-empty `iv` can only be a row from the retired client-managed lane, and
 * no supported client holds that key.
 *
 * Two invariants:
 *   1. `decryptFromWire` REFUSES a non-empty iv rather than handing Yjs bytes
 *      that decode to garbage.
 *   2. The per-payload catch in `handleSyncResponse` skips only that row --
 *      a readable row in the same batch still applies, and sync survives.
 */

function createProvider(): DocumentSyncProvider {
  return new DocumentSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => 'token',
    orgId: 'org-1',
    userId: 'user-1',
    documentId: 'doc-1',
    reviewGateEnabled: false,
  });
}

/** Base64 of the Y.Doc update that sets `content` to `text`. */
function plaintextUpdate(text: string): string {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
}

describe('DocumentSync pre-cutover rows', () => {
  it('refuses a non-empty iv instead of decoding ciphertext as Yjs bytes', async () => {
    const provider = createProvider();

    await expect(
      (provider as any).decryptFromWire(plaintextUpdate('anything'), 'aXYtYnl0ZXM='),
    ).rejects.toThrow(/pre-cutover/i);

    provider.destroy();
  });

  it('accepts the empty-iv sentinel as plaintext', async () => {
    const provider = createProvider();

    const bytes = await (provider as any).decryptFromWire(plaintextUpdate('hello'), '');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes);
    expect(doc.getText('content').toString()).toBe('hello');

    provider.destroy();
  });

  it('skips only the pre-cutover row and still applies the readable one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = createProvider();

    await (provider as any).handleSyncResponse({
      type: 'docSyncResponse',
      updates: [
        { sequence: 1, encryptedUpdate: plaintextUpdate('legacy'), iv: 'aXYtYnl0ZXM=' },
        { sequence: 2, encryptedUpdate: plaintextUpdate('readable'), iv: '' },
      ],
      cursor: 2,
      hasMore: false,
      serverHead: 2,
      serverHasState: true,
    });

    expect(provider.getYDoc().getText('content').toString()).toBe('readable');
    // The batch is marked incomplete so compaction can never bury the row we
    // could not read (NIM-1519), and the cursor still advances past it.
    expect((provider as any).skippedUndecodablePayload).toBe(true);
    expect((provider as any).lastSeq).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping undecodable update at seq 1'),
      expect.stringMatching(/pre-cutover/i),
    );

    provider.destroy();
    warn.mockRestore();
  });

  it('skips a pre-cutover snapshot without aborting the sync', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = createProvider();

    await (provider as any).handleSyncResponse({
      type: 'docSyncResponse',
      snapshot: {
        encryptedState: plaintextUpdate('legacy snapshot'),
        iv: 'aXYtYnl0ZXM=',
        replacesUpTo: 5,
      },
      updates: [
        { sequence: 6, encryptedUpdate: plaintextUpdate('after cutover'), iv: '' },
      ],
      cursor: 6,
      hasMore: false,
      serverHead: 6,
      serverHasState: true,
    });

    expect(provider.getYDoc().getText('content').toString()).toBe('after cutover');
    expect((provider as any).skippedUndecodablePayload).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      '[DocumentSync] Skipping undecodable snapshot; sync will continue:',
      expect.stringMatching(/pre-cutover/i),
    );

    provider.destroy();
    warn.mockRestore();
  });
});
