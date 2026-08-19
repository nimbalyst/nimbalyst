// @vitest-environment node
/**
 * Broadcasts are applied per connection, not per person (#1204).
 *
 * `senderId` is stamped by DocumentRoom from the JWT `sub`, so it names the
 * member, not the socket. One human signed in on desktop and in the web console
 * is the same member id twice, and dropping those broadcasts as "our own echo"
 * left the browser showing nothing until a reload replayed the room history.
 */

import { describe, expect, it } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';
import * as Y from 'yjs';
import { DocumentSyncProvider } from '../DocumentSync';

const ME = 'member-me';

function provider(): DocumentSyncProvider {
  return new DocumentSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => asTeamJwt('token'),
    orgId: 'org-1',
    teamMemberId: asTeamMemberId(ME),
    documentId: 'doc-1',
  });
}

/** A peer's edit on the wire: plaintext base64 with the empty-iv sentinel. */
function broadcastFrom(senderId: string, text: string, sequence: number) {
  const peer = new Y.Doc();
  peer.getText('body').insert(0, text);
  return {
    type: 'docUpdateBroadcast' as const,
    senderId,
    sequence,
    encryptedUpdate: Buffer.from(Y.encodeStateAsUpdate(peer)).toString('base64'),
    iv: '',
  };
}

describe('DocumentSync update broadcasts', () => {
  it('applies a broadcast sent under this user\'s own member id', async () => {
    const p = provider();

    await (p as any).handleUpdateBroadcast(broadcastFrom('member-teammate', 'THEIRS ', 1));
    await (p as any).handleUpdateBroadcast(broadcastFrom(ME, 'MINE', 2));

    // Both land: the second is this user's other client, not an echo.
    expect(p.getYDoc().getText('body').toString()).toContain('THEIRS');
    expect(p.getYDoc().getText('body').toString()).toContain('MINE');
    p.destroy();
  });

  it('does not re-send an applied broadcast back to the server', async () => {
    const p = provider();
    let localUpdates = 0;
    (p as any).config.onLocalUpdate = () => { localUpdates += 1; };
    (p as any).setupUpdateObserver();

    await (p as any).handleUpdateBroadcast(broadcastFrom(ME, 'MINE', 1));

    // REMOTE_ORIGIN is blocklisted by the local-update observer, so applying
    // our own member's update cannot loop back out as a fresh local edit.
    expect(localUpdates).toBe(0);
    p.destroy();
  });
});
