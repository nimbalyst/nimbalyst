// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { asPersonalJwt, asPersonalMemberId } from '../../auth/jwtScopes';
import { createCollabV3Sync } from '../CollabV3Sync';
import type { EncryptedMessage } from '../collabV3WireTypes';
import { decideSessionAdmission } from '../sessionConnectionAdmission';
import { writeSessionMessagesOverTransientSocket, type TransientSessionWriteDeps } from '../sessionTransientWrite';

class FakeWebSocket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '', wasClean: true } as CloseEvent);
  });

  constructor(readonly url: string) {}

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.signature`;
}

describe('CollabV3 session connection cap', () => {
  it('refuses a session past the cap with a typed error instead of resolving as if connected', async () => {
    const sockets: FakeWebSocket[] = [];
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      personalMemberId: asPersonalMemberId('user-1'),
      getJwt: async () => asPersonalJwt(jwtFor('user-1')),
      createWebSocket: url => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    for (let i = 0; i < 10; i++) {
      const connected = provider.connect(`busy-${i}`);
      await vi.waitFor(() => expect(sockets.some(s => s.url.includes(`busy-${i}`))).toBe(true));
      sockets.find(s => s.url.includes(`busy-${i}`))!.open();
      await connected;
    }

    await expect(provider.connect('overflow')).rejects.toMatchObject({ code: 'SESSION_CONNECTION_CAP', retryable: true });
    expect(provider.isConnected('overflow')).toBe(false);

    // After teardown (sign-out, account switch) a queued write must not go out under the next account.
    provider.disconnectAll();
    const message = { sessionId: 'overflow', source: 'claude-code', direction: 'output' as const, content: 'x', createdAt: new Date() };
    await expect(provider.sendSessionMessages!('overflow', [message])).resolves.toMatchObject({ published: false, retryable: false });
  });
});

describe('decideSessionAdmission', () => {
  const open = (...activity: number[]) => activity.map((lastActivity, i) => [`s${i}`, { lastActivity }] as [string, { lastActivity: number }]);

  it('admits under the cap, evicts the longest-idle past the idle window, and refuses when every slot is busy', () => {
    expect(decideSessionAdmission(open(0, 0), 1_000, 3, 100)).toEqual({ kind: 'admit' });
    expect(decideSessionAdmission(open(950, 500, 100, 800), 1_000, 4, 400))
      .toEqual({ kind: 'evict-then-admit', evictSessionId: 's2', idleMs: 900 });
    expect(decideSessionAdmission(open(950, 700, 900), 1_000, 3, 400)).toEqual({ kind: 'refuse' });
  });
});

describe('writeSessionMessagesOverTransientSocket', () => {
  function deps(socket: FakeWebSocket, overrides: Partial<TransientSessionWriteDeps> = {}): TransientSessionWriteDeps {
    return {
      encryptionKey: {} as CryptoKey,
      isMessageSyncDisabled: () => false,
      disableMessageSync: vi.fn(),
      isFatalErrorCode: code => code === 'message_limit_exceeded',
      isRetained: () => true,
      withholdWrite: () => false,
      writeGeneration: () => 0,
      openSocket: async () => ({ ws: socket as unknown as WebSocket, release: () => {} }),
      shouldSync: () => true,
      encryptMessage: async message => ({ id: message.content } as unknown as EncryptedMessage),
      encryptTitle: async () => ({ encryptedTitle: 't', titleIv: 'iv' }),
      ...overrides,
    };
  }
  const rows = [{ sessionId: 's', source: 'claude-code', direction: 'output' as const, content: 'a', createdAt: new Date() }];

  it('reports a socket the server closes before the write finishes as retryable, not sent', async () => {
    const socket = new FakeWebSocket('wss://x');
    const write = writeSessionMessagesOverTransientSocket(deps(socket), 's', rows);
    await vi.waitFor(() => expect(socket.onclose).not.toBeNull());
    socket.onclose!({ code: 1008, reason: 'auth', wasClean: true } as CloseEvent);
    await expect(write).resolves.toEqual({ published: false, reason: 'socket closed before the write finished', retryable: true });
  });

  it('sends the rows in order and reports them sent; a fatal room error disables sync instead', async () => {
    const socket = new FakeWebSocket('wss://x');
    const write = writeSessionMessagesOverTransientSocket(deps(socket), 's', [...rows, { ...rows[0], content: 'b' }]);
    await vi.waitFor(() => expect(socket.onopen).not.toBeNull());
    socket.open();
    await expect(write).resolves.toEqual({ published: true });
    expect(socket.send.mock.calls.map(([raw]) => JSON.parse(raw).message?.id ?? JSON.parse(raw).type))
      .toEqual(['beginSessionReplay', 'a', 'b']);

    const fatal = new FakeWebSocket('wss://y');
    const disableMessageSync = vi.fn();
    const refused = writeSessionMessagesOverTransientSocket(deps(fatal, { disableMessageSync }), 's', rows);
    await vi.waitFor(() => expect(fatal.onmessage).not.toBeNull());
    fatal.onmessage!({ data: JSON.stringify({ type: 'error', code: 'message_limit_exceeded', message: 'full' }) } as MessageEvent);
    await expect(refused).resolves.toMatchObject({ published: false, retryable: false });
    expect(disableMessageSync).toHaveBeenCalledWith('s', 'message_limit_exceeded', 'full');
  });

  it('sends nothing more once teardown happens mid-write, and a reconnect does not revive it', async () => {
    const socket = new FakeWebSocket('wss://x');
    let generation = 0;
    const write = writeSessionMessagesOverTransientSocket(deps(socket, { writeGeneration: () => generation }), 's', rows);
    await vi.waitFor(() => expect(socket.onopen).not.toBeNull());
    generation++; // sign-out while the socket was opening
    socket.open();
    await expect(write).resolves.toEqual({ published: false, reason: 'sync was shut down', retryable: false });
    expect(socket.send).not.toHaveBeenCalled();
  });
});
