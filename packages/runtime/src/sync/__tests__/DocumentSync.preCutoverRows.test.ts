// @vitest-environment node
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

function createProvider(
  overrides: Partial<ConstructorParameters<typeof DocumentSyncProvider>[0]> = {},
): DocumentSyncProvider {
  return new DocumentSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => 'token',
    orgId: 'org-1',
    userId: 'user-1',
    documentId: 'doc-1',
    ...overrides,
  });
}

/** Base64 of the Y.Doc update that sets `content` to `text`. */
function plaintextUpdate(text: string): string {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
}

/** Decrypts to bytes Yjs cannot read at all ("Integer out of Range"). */
const NOT_YJS_BYTES = Buffer.from([255, 255, 255, 255, 255, 255, 255, 255]).toString('base64');

/**
 * Install a Y.Doc observer that throws, standing in for an editor binding that
 * blows up on content it cannot render (the production case was an
 * unregistered Lexical node type surfacing as "Minified Lexical error #88").
 * Returns a disposer so the provider can be torn down normally.
 */
function installThrowingObserver(provider: DocumentSyncProvider, message: string): () => void {
  const text = provider.getYDoc().getText('content');
  const observer = () => {
    throw new Error(message);
  };
  text.observe(observer);
  return () => text.unobserve(observer);
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

/**
 * A single try/catch used to wrap BOTH the decrypt and the `Y.applyUpdate`, so
 * a crash in a Y.Doc listener was reported as a corrupt payload and permanently
 * vetoed compaction for the room. These cover the split: a payload that cannot
 * be read still skips, a listener that throws after the update is already
 * integrated does not.
 */
describe('DocumentSync apply failures vs undecodable payloads', () => {
  it('reports a throwing Y.Doc listener as a listener failure, not an undecodable payload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const provider = createProvider();
    const dispose = installThrowingObserver(provider, 'Minified Lexical error #88');

    await (provider as any).handleSyncResponse({
      type: 'docSyncResponse',
      updates: [{ sequence: 7, encryptedUpdate: plaintextUpdate('hello'), iv: '' }],
      cursor: 7,
      hasMore: false,
      serverHead: 7,
      serverHasState: true,
    });

    // yjs commits the transaction before calling observers, so the content is
    // in the CRDT even though the listener blew up.
    expect(provider.getYDoc().getText('content').toString()).toBe('hello');
    // Not a payload problem: compaction and local persistence stay enabled.
    expect((provider as any).skippedUndecodablePayload).toBe(false);
    expect((provider as any).lastSeq).toBe(7);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('a Y.Doc listener threw'),
      expect.objectContaining({ message: 'Minified Lexical error #88' }),
    );

    dispose();
    provider.destroy();
    warn.mockRestore();
    error.mockRestore();
  });

  /**
   * A console error is not a user-visible failure. Because sync stays healthy,
   * a host with no signal here reports the document as connected and shows the
   * empty editor the aborted binding left behind — which is how an unregistered
   * `tracker-reference` node shipped as "some docs still don't load".
   */
  it('tells the host when the binding, not the payload, is what failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onEditorBindingError = vi.fn();
    const provider = createProvider({ onEditorBindingError });
    const dispose = installThrowingObserver(provider, 'Minified Lexical error #88');

    await (provider as any).handleSyncResponse({
      type: 'docSyncResponse',
      updates: [{ sequence: 7, encryptedUpdate: plaintextUpdate('hello'), iv: '' }],
      cursor: 7,
      hasMore: false,
      serverHead: 7,
      serverHasState: true,
    });

    expect(onEditorBindingError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Minified Lexical error #88' }),
    );

    dispose();
    provider.destroy();
    error.mockRestore();
  });

  it('does not report a binding failure when a payload is merely unreadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onEditorBindingError = vi.fn();
    const provider = createProvider({ onEditorBindingError });

    await (provider as any).handleSyncResponse({
      type: 'docSyncResponse',
      updates: [{ sequence: 3, encryptedUpdate: NOT_YJS_BYTES, iv: '' }],
      cursor: 3,
      hasMore: false,
      serverHead: 3,
      serverHasState: true,
    });

    // A bad payload is the host's problem to skip, not the editor's to report.
    expect(onEditorBindingError).not.toHaveBeenCalled();

    provider.destroy();
    warn.mockRestore();
  });

  it('still skips a payload that decrypts but is not readable Yjs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = createProvider();

    await (provider as any).handleSyncResponse({
      type: 'docSyncResponse',
      updates: [
        { sequence: 3, encryptedUpdate: NOT_YJS_BYTES, iv: '' },
        { sequence: 4, encryptedUpdate: plaintextUpdate('readable'), iv: '' },
      ],
      cursor: 4,
      hasMore: false,
      serverHead: 4,
      serverHasState: true,
    });

    expect(provider.getYDoc().getText('content').toString()).toBe('readable');
    expect((provider as any).skippedUndecodablePayload).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('seq 3 that decrypted but could not be integrated'),
      expect.anything(),
    );

    provider.destroy();
    warn.mockRestore();
  });

  it('does not drop the connection when a broadcast trips a throwing listener', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const provider = createProvider();
    const dispose = installThrowingObserver(provider, 'Minified Lexical error #88');
    const close = vi.fn();
    (provider as any).ws = { readyState: 1, close };
    (provider as any).synced = true;

    await (provider as any).handleUpdateBroadcast({
      type: 'docUpdateBroadcast',
      senderId: 'other-user',
      sequence: 9,
      encryptedUpdate: plaintextUpdate('broadcast'),
      iv: '',
    });

    expect(provider.getYDoc().getText('content').toString()).toBe('broadcast');
    expect((provider as any).skippedUndecodablePayload).toBe(false);
    expect((provider as any).lastSeq).toBe(9);
    // Reconnecting would only replay the same update into the same broken
    // listener; the payload was fine, so the socket stays up.
    expect(close).not.toHaveBeenCalled();

    dispose();
    (provider as any).ws = null;
    provider.destroy();
    error.mockRestore();
  });

  it('still drops the connection for a broadcast payload it cannot read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = createProvider();
    const close = vi.fn();
    (provider as any).ws = { readyState: 1, close };
    (provider as any).synced = true;

    await (provider as any).handleUpdateBroadcast({
      type: 'docUpdateBroadcast',
      senderId: 'other-user',
      sequence: 9,
      encryptedUpdate: NOT_YJS_BYTES,
      iv: '',
    });

    expect((provider as any).skippedUndecodablePayload).toBe(true);
    expect((provider as any).lastSeq).toBe(9);
    expect(close).toHaveBeenCalled();

    (provider as any).ws = null;
    provider.destroy();
    warn.mockRestore();
  });
});
