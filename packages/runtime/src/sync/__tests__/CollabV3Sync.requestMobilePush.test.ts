// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCollabV3Sync } from '../CollabV3Sync';

// Covers the client-side protocol extension proposed in upstream issue #704:
// optional `force`/`reason` fields on `requestMobilePush`. This is a
// protocol-only, backwards-compatible change -- these tests confirm the
// client threads the fields through the wire message when given, and that
// omitting `options` produces byte-identical output to before this change
// (no `force`/`reason` keys at all, since JSON.stringify drops `undefined`
// values). The sync server does not yet honor these fields; see #704.

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

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

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

describe('CollabV3Sync.requestMobilePush force/reason options', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omits force/reason when options is not provided (backwards compatible)', async () => {
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      userId: 'user-1',
      getJwt: async () => jwtFor('user-1'),
    });

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const indexSocket = FakeWebSocket.instances[0];
    indexSocket.open();

    await provider.requestMobilePush?.('session-1', 'Title', 'Body');

    expect(indexSocket.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(indexSocket.send.mock.calls[0][0] as string);
    expect(sent).toEqual({
      type: 'requestMobilePush',
      sessionId: 'session-1',
      title: 'Title',
      body: 'Body',
    });
    expect(sent).not.toHaveProperty('force');
    expect(sent).not.toHaveProperty('reason');

    provider.disconnectAll();
  });

  it('forwards force/reason on the wire when explicitly requested', async () => {
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      userId: 'user-1',
      getJwt: async () => jwtFor('user-1'),
    });

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const indexSocket = FakeWebSocket.instances[0];
    indexSocket.open();

    await provider.requestMobilePush?.('session-1', 'Title', 'Body', {
      force: true,
      reason: 'agent_attention',
    });

    expect(indexSocket.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(indexSocket.send.mock.calls[0][0] as string);
    expect(sent).toMatchObject({
      type: 'requestMobilePush',
      sessionId: 'session-1',
      title: 'Title',
      body: 'Body',
      force: true,
      reason: 'agent_attention',
    });

    provider.disconnectAll();
  });
});
