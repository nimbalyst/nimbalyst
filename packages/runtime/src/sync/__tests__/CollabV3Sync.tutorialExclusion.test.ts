// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asPersonalJwt, asPersonalMemberId } from '../../auth/jwtScopes';
import { createCollabV3Sync } from '../CollabV3Sync';

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
  });

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

function indexUpdates(socket: FakeWebSocket): Array<Record<string, any>> {
  return socket.send.mock.calls
    .map(([payload]) => JSON.parse(payload as string))
    .filter((message) => message.type === 'indexUpdate');
}

describe('CollabV3 personal sync tutorial exclusion', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omits tutorial sessions from the index sync payload', async () => {
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      personalMemberId: asPersonalMemberId('user-1'),
      getJwt: async () => asPersonalJwt(jwtFor('user-1')),
      encryptionKey,
    });

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const indexSocket = FakeWebSocket.instances[0];
    indexSocket.open();

    provider.syncSessionsToIndex?.([
      {
        id: 'tutorial-session',
        title: 'Tutorial example',
        provider: 'claude-code',
        workspaceId: '/tutorial',
        messageCount: 0,
        updatedAt: 1_000,
        createdAt: 1_000,
        metadata: { tutorial: true },
      },
      {
        id: 'personal-session',
        title: 'Personal conversation',
        provider: 'claude-code',
        workspaceId: '/project',
        messageCount: 0,
        updatedAt: 2_000,
        createdAt: 2_000,
      },
    ]);

    await vi.waitFor(() => expect(indexUpdates(indexSocket)).toHaveLength(1));
    expect(indexUpdates(indexSocket)[0]?.session.sessionId).toBe(
      'personal-session'
    );

    provider.syncSessionsToIndex?.([
      {
        id: 'tutorial-only',
        title: 'Tutorial only',
        provider: 'claude-code',
        workspaceId: '/tutorial',
        messageCount: 0,
        updatedAt: 3_000,
        createdAt: 3_000,
        metadata: { tutorial: true },
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(indexUpdates(indexSocket)).toHaveLength(1);

    provider.disconnectAll();
  });
});
