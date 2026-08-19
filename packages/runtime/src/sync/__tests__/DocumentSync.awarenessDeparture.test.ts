// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';

import { CollabLexicalProvider } from '../CollabLexicalProvider';
import { DocumentSyncProvider } from '../DocumentSync';
import type { AwarenessState } from '../documentSyncTypes';

type SocketEvent = Event | MessageEvent | CloseEvent;

class RecordingWebSocket {
  readyState = 0;
  readonly timeline: string[] = [];
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Set<(event: SocketEvent) => void>>();

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    this.timeline.push(`send:${String(message.type)}`);
  }

  close(): void {
    this.timeline.push('close');
    this.readyState = 3;
    this.dispatch('close', new CloseEvent('close', { code: 1000 }));
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open', new Event('open'));
  }

  private dispatch(type: string, event: SocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function makeNetworkProvider(socket: RecordingWebSocket): DocumentSyncProvider {
  return new DocumentSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => asTeamJwt('token'),
    orgId: 'org-1',
    teamMemberId: asTeamMemberId('member-rowan'),
    documentId: 'doc-1',
    createWebSocket: () => socket as unknown as WebSocket,
  });
}

function decodeAwareness(message: Record<string, unknown>): AwarenessState {
  return JSON.parse(Buffer.from(String(message.encryptedState), 'base64').toString('utf8'));
}

describe('DocumentSync awareness departure', () => {
  it('puts departure on the wire synchronously before teardown closes the socket', async () => {
    const socket = new RecordingWebSocket();
    const network = makeNetworkProvider(socket);
    await network.connect();
    socket.open();
    const lexical = new CollabLexicalProvider(network);
    lexical.awareness.setLocalState({
      name: 'Rowan Petrie',
      color: '#9B59B6',
      anchorPos: null,
      focusPos: null,
      focusing: false,
      awarenessData: {},
    });
    await Promise.resolve();
    // Queue another awareness update inside the 500ms throttle window. The
    // departure must cancel it and still send synchronously before close.
    lexical.awareness.setLocalState({
      name: 'Rowan Petrie',
      color: '#9B59B6',
      anchorPos: null,
      focusPos: null,
      focusing: true,
      awarenessData: {},
    });
    socket.timeline.length = 0;
    socket.sent.length = 0;

    lexical.destroy();
    network.destroy();

    expect(socket.timeline).toEqual(['send:docAwareness', 'close']);
    const departure = decodeAwareness(socket.sent[0]);
    expect(departure).toEqual({
      user: { name: 'Rowan Petrie', color: '#9B59B6' },
      nimbalystDeparture: { version: 1 },
    });
    // Old clients can still read the required user block and ignore the
    // additive marker. They degrade to their existing stale sweep.
    expect(departure.user.name).toBe('Rowan Petrie');
    expect(departure.cursor).toBeUndefined();
  });

  it('deletes a remote state when the additive departure marker arrives', async () => {
    const provider = makeNetworkProvider(new RecordingWebSocket());
    const snapshots: string[][] = [];
    provider.onAwarenessChange((states) => snapshots.push([...states.keys()]));
    const broadcast = async (state: AwarenessState) => {
      await (provider as unknown as {
        handleAwarenessBroadcast(message: Record<string, unknown>): Promise<void>;
      }).handleAwarenessBroadcast({
        type: 'docAwarenessBroadcast',
        fromUserId: 'member-dana',
        encryptedState: Buffer.from(JSON.stringify(state)).toString('base64'),
        iv: '',
      });
    };

    await broadcast({
      user: { name: 'Rowan Petrie', color: '#9B59B6' },
      cursor: { anchor: '{}', head: '{}' },
    });
    await broadcast({
      user: { name: 'Rowan Petrie', color: '#9B59B6' },
      nimbalystDeparture: { version: 1 },
    });

    expect(snapshots).toEqual([['member-dana'], []]);
    provider.destroy();
  });

  it('keeps setLocalState(null) as cursor clearing rather than departure', () => {
    const syncProvider = {
      onAwarenessChange: vi.fn(() => () => {}),
      setLocalAwareness: vi.fn(),
      sendAwarenessDeparture: vi.fn(),
      connect: vi.fn(async () => {}),
      getYDoc: vi.fn(),
      getStatus: vi.fn(() => 'connected'),
    };
    const provider = new CollabLexicalProvider(syncProvider as never);
    provider.awareness.setLocalState({
      name: 'Rowan Petrie',
      color: '#9B59B6',
      anchorPos: null,
      focusPos: null,
      focusing: false,
      awarenessData: {},
    });
    provider.awareness.setLocalState(null);

    expect(syncProvider.setLocalAwareness).toHaveBeenLastCalledWith({
      cursor: undefined,
      user: { name: 'Rowan Petrie', color: '#9B59B6' },
    });
    expect(syncProvider.sendAwarenessDeparture).not.toHaveBeenCalled();
  });
});
