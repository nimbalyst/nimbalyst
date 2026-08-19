// @vitest-environment node
/**
 * NIM-3006: a desktop extension editor that reconnects must get its
 * collaborator list back.
 *
 * The regression this guards is asymmetric, and the asymmetry is the whole
 * point. `handleDisconnect` clears the awareness map, so after a reconnect the
 * client sees nobody. Re-announcing local state fixes "peers see me". Only the
 * heartbeat fixes "I see peers" -- peers repopulate my map by re-announcing on
 * a cadence -- so both directions are asserted here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';

import { DocumentSyncProvider } from '../DocumentSync';
import { createExtensionAwarenessBridge } from '../extensionAwarenessBridge';
import type { AwarenessState } from '../documentSyncTypes';

type SocketEvent = Event | MessageEvent | CloseEvent;

class RecordingWebSocket {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Set<(event: SocketEvent) => void>>();

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch('close', new CloseEvent('close', { code: 1006 }));
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open', new Event('open'));
  }

  deliver(message: Record<string, unknown>): void {
    this.dispatch('message', new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((message) => message.type === type);
  }

  private dispatch(type: string, event: SocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function peerAwarenessFrame(state: AwarenessState): Record<string, unknown> {
  return {
    type: 'docAwarenessBroadcast',
    fromUserId: 'member-dana',
    encryptedState: Buffer.from(JSON.stringify(state)).toString('base64'),
    iv: '',
  };
}

const DANA: AwarenessState = { user: { name: 'Dana Whitlock', color: '#2BA89A' } };

/** Empty room at head -- enough to carry the provider from 'syncing' to 'connected'. */
const EMPTY_SYNC_RESPONSE = {
  type: 'docSyncResponse',
  updates: [],
  hasMore: false,
  serverHead: 0,
  serverHasState: false,
} as const;

/** Remote clients only -- the bridge always holds our own local state too. */
function remoteNames(awareness: { states: Map<number, unknown>; clientID: number }): string[] {
  return [...awareness.states.entries()]
    .filter(([clientId]) => clientId !== awareness.clientID)
    .map(([, state]) => ((state as AwarenessState).user.name));
}

describe('extension awareness bridge across a reconnect (NIM-3006)', () => {
  let sockets: RecordingWebSocket[] = [];
  let provider: DocumentSyncProvider;

  beforeEach(async () => {
    vi.useFakeTimers();
    sockets = [];
    provider = new DocumentSyncProvider({
      serverUrl: 'ws://example.test',
      getJwt: async () => asTeamJwt('token'),
      orgId: 'org-1',
      teamMemberId: asTeamMemberId('member-rowan'),
      documentId: 'doc-1',
      createWebSocket: () => {
        const socket = new RecordingWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    await provider.connect();
    await reachConnected(0);
  });

  /** Open socket `index` and let the sync handshake settle. */
  async function reachConnected(index: number): Promise<void> {
    sockets[index].open();
    sockets[index].deliver({ ...EMPTY_SYNC_RESPONSE });
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.getStatus()).toBe('connected');
  }

  afterEach(() => {
    provider.destroy();
    vi.useRealTimers();
  });

  it('repopulates the collaborator list after a drop and reconnect', async () => {
    const bridge = createExtensionAwarenessBridge({
      syncProvider: provider,
      yDoc: provider.getYDoc(),
      user: { id: 'member-rowan', name: 'Rowan Petrie', color: '#3A8FD6' },
    });

    sockets[0].deliver(peerAwarenessFrame(DANA));
    await vi.advanceTimersByTimeAsync(0);
    expect(remoteNames(bridge.awareness)).toEqual(['Dana Whitlock']);

    // The drop clears the map -- that part is correct, we genuinely do not know
    // who is still in the room.
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(0);
    expect(remoteNames(bridge.awareness)).toEqual([]);

    provider.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    await reachConnected(1);

    // Direction 1 -- peers see me. Reconnecting must put our identity back on
    // the wire; the socket that carried the previous announcement is gone.
    expect(sockets[1].sentOfType('docAwareness')).toHaveLength(1);

    // Direction 2 -- I see peers. Nothing in the protocol replays a roster, so
    // recovery depends entirely on peers re-announcing on a cadence. Assert the
    // cadence exists, because a peer running this same code is what refills the
    // map below.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets[1].sentOfType('docAwareness').length).toBeGreaterThan(1);

    sockets[1].deliver(peerAwarenessFrame(DANA));
    await vi.advanceTimersByTimeAsync(0);
    expect(remoteNames(bridge.awareness)).toEqual(['Dana Whitlock']);

    bridge.destroy();
  });

  it('puts no awareness on the wire while disconnected or after destroy', async () => {
    const bridge = createExtensionAwarenessBridge({
      syncProvider: provider,
      yDoc: provider.getYDoc(),
      user: { id: 'member-rowan', name: 'Rowan Petrie', color: '#3A8FD6' },
    });

    await vi.advanceTimersByTimeAsync(0);
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(0);
    const sentWhileDown = sockets[0].sentOfType('docAwareness').length;

    // A disconnected provider drops awareness frames on the floor anyway; the
    // heartbeat must not keep firing into a dead socket for the whole outage.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets[0].sentOfType('docAwareness')).toHaveLength(sentWhileDown);

    provider.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    await reachConnected(1);
    bridge.destroy();

    const sentAtDestroy = sockets[1].sentOfType('docAwareness').length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets[1].sentOfType('docAwareness')).toHaveLength(sentAtDestroy);
  });
});
