// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asPersonalJwt, asPersonalMemberId } from '../../auth/jwtScopes';

import {
  createCollabV3Sync,
  isFatalMessageSyncErrorCodeForTest,
  isSkippableMessageSyncErrorCodeForTest,
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

  it('treats only the terminal row-count ceiling as fatal', () => {
    expect(isFatalMessageSyncErrorCodeForTest('message_limit_exceeded')).toBe(true);
    expect(isFatalMessageSyncErrorCodeForTest('temporary_failure')).toBe(false);
  });

  it('skips per-message rejections instead of disabling the whole session', () => {
    // A screenshot too big to shrink must not take the rest of the session's
    // transcript off mobile with it, and a room that just refused a large
    // message may still have space for small ones.
    expect(isFatalMessageSyncErrorCodeForTest('message_too_large')).toBe(false);
    expect(isFatalMessageSyncErrorCodeForTest('storage_limit_exceeded')).toBe(false);
    expect(isSkippableMessageSyncErrorCodeForTest('message_too_large')).toBe(true);
    expect(isSkippableMessageSyncErrorCodeForTest('storage_limit_exceeded')).toBe(true);
    expect(isSkippableMessageSyncErrorCodeForTest('message_limit_exceeded')).toBe(false);
    expect(isSkippableMessageSyncErrorCodeForTest('temporary_failure')).toBe(false);
  });

  it('closes the session, clears active status, and refuses reconnects', async () => {
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      personalMemberId: asPersonalMemberId('user-1'),
      getJwt: async () => asPersonalJwt(jwtFor('user-1')),
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
      code: 'message_limit_exceeded',
      message: 'Session reached the message limit',
    });

    expect(statuses.at(-1)).toEqual({
      connected: false,
      syncing: false,
      error: 'Session reached the message limit',
    });
    expect(sessionSocket.close).toHaveBeenCalledOnce();
    expect(provider.isConnected('session-1')).toBe(false);

    await provider.connect('session-1');
    expect(FakeWebSocket.instances).toHaveLength(2);

    provider.disconnectAll();
  });

  it('stays connected when the server refuses one oversized message', async () => {
    // A screenshot the compressor could not get under the server's row cap must
    // cost us that one message, not the session's entire mobile transcript.
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      personalMemberId: asPersonalMemberId('user-1'),
      getJwt: async () => asPersonalJwt(jwtFor('user-1')),
    });

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].open();

    const connect = provider.connect('session-2');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const sessionSocket = FakeWebSocket.instances[1];
    sessionSocket.open();
    await connect;

    sessionSocket.receive({
      type: 'error',
      code: 'message_too_large',
      message: 'Encrypted message exceeds byte sync row cap',
    });

    expect(sessionSocket.close).not.toHaveBeenCalled();
    expect(provider.isConnected('session-2')).toBe(true);

    provider.disconnectAll();
  });
});
