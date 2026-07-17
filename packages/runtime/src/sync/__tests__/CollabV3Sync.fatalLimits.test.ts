import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCollabV3Sync,
  isFatalMessageSyncErrorCodeForTest,
} from '../CollabV3Sync';

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

describe('CollabV3 fatal session limits', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recognizes every non-retryable server limit code', () => {
    expect(isFatalMessageSyncErrorCodeForTest('message_limit_exceeded')).toBe(true);
    expect(isFatalMessageSyncErrorCodeForTest('message_too_large')).toBe(true);
    expect(isFatalMessageSyncErrorCodeForTest('storage_limit_exceeded')).toBe(true);
    expect(isFatalMessageSyncErrorCodeForTest('temporary_failure')).toBe(false);
  });

  it('closes the session, clears active status, and refuses reconnects', async () => {
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      userId: 'user-1',
      getJwt: async () => jwtFor('user-1'),
    });

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].open();

    const connect = provider.connect('session-1');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const sessionSocket = FakeWebSocket.instances[1];
    sessionSocket.open();
    await connect;

    const statuses: Array<{ connected: boolean; syncing: boolean; error: string | null }> = [];
    provider.onStatusChange('session-1', (status) => {
      statuses.push({
        connected: status.connected,
        syncing: status.syncing,
        error: status.error,
      });
    });

    sessionSocket.receive({
      type: 'error',
      code: 'storage_limit_exceeded',
      message: 'Session storage limit reached',
    });

    expect(statuses.at(-1)).toEqual({
      connected: false,
      syncing: false,
      error: 'Session storage limit reached',
    });
    expect(sessionSocket.close).toHaveBeenCalledOnce();
    expect(provider.isConnected('session-1')).toBe(false);

    await provider.connect('session-1');
    expect(FakeWebSocket.instances).toHaveLength(2);

    provider.disconnectAll();
  });
});
