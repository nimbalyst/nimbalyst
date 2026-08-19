// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asPersonalJwt, asPersonalMemberId } from '../../auth/jwtScopes';

import { createCollabV3Sync } from '../CollabV3Sync';

/**
 * #1268: `requestMobilePush` used to resolve as soon as `WebSocket.send()` did
 * not throw, so a suppressed push, a dropped push, and a delivered push were
 * indistinguishable -- to the client, to a test, and to the user. That is what
 * made the original report take a night to diagnose.
 */

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

  /** Every `requestMobilePush` frame this socket was asked to send. */
  pushRequests(): Array<Record<string, unknown>> {
    return this.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string) as Record<string, unknown>)
      .filter((msg) => msg.type === 'requestMobilePush');
  }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

async function connectedProvider() {
  const provider = createCollabV3Sync({
    serverUrl: 'wss://sync.example.test',
    orgId: 'org-1',
    personalMemberId: asPersonalMemberId('user-1'),
    getJwt: async () => asPersonalJwt(jwtFor('user-1')),
    deviceInfo: {
      deviceId: 'desktop-1',
      name: 'MacBook Pro',
      type: 'desktop',
      platform: 'macos',
      connectedAt: 0,
      lastActiveAt: 0,
    },
  });

  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const indexSocket = FakeWebSocket.instances[0];
  indexSocket.open();

  return { provider, indexSocket };
}

describe('mobile push acknowledgement', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('resolves with the server result and carries force/reason on the wire', async () => {
    const { provider, indexSocket } = await connectedProvider();

    const pending = provider.requestMobilePush!('session-1', 'Blocked', 'Waiting for you', {
      force: true,
      reason: 'awaiting_human',
    });

    await vi.waitFor(() => expect(indexSocket.pushRequests()).toHaveLength(1));
    const sent = indexSocket.pushRequests()[0];
    expect(sent).toMatchObject({
      sessionId: 'session-1',
      requestingDeviceId: 'desktop-1',
      force: true,
      reason: 'awaiting_human',
    });
    expect(typeof sent.requestId).toBe('string');

    indexSocket.receive({
      type: 'mobilePushResult',
      requestId: sent.requestId,
      sessionId: 'session-1',
      accepted: true,
      attemptedCount: 2,
      deliveredCount: 1,
      skipped: [{ deviceId: 'phone-2', reason: 'device_present' }],
    });

    await expect(pending).resolves.toEqual({
      accepted: true,
      attemptedCount: 2,
      deliveredCount: 1,
      skipped: [{ deviceId: 'phone-2', reason: 'device_present' }],
      rejection: undefined,
    });

    provider.disconnectAll();
  });

  it('surfaces a server rejection rather than looking like a success', async () => {
    const { provider, indexSocket } = await connectedProvider();

    const pending = provider.requestMobilePush!('session-1', 'Done', 'Response ready');
    await vi.waitFor(() => expect(indexSocket.pushRequests()).toHaveLength(1));

    indexSocket.receive({
      type: 'mobilePushResult',
      requestId: indexSocket.pushRequests()[0].requestId,
      sessionId: 'session-1',
      accepted: false,
      attemptedCount: 0,
      deliveredCount: 0,
      skipped: [],
      rejection: 'suppressed_active_device',
    });

    const result = await pending;
    expect(result.accepted).toBe(false);
    expect(result.rejection).toBe('suppressed_active_device');

    provider.disconnectAll();
  });

  it('resolves to no_ack when the server never answers', async () => {
    const { provider, indexSocket } = await connectedProvider();

    vi.useFakeTimers();
    const pending = provider.requestMobilePush!('session-1', 'Done', 'Response ready');
    await vi.waitFor(() => expect(indexSocket.pushRequests()).toHaveLength(1), {
      interval: 1,
      timeout: 1000,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toMatchObject({
      accepted: false,
      rejection: 'no_ack',
    });

    provider.disconnectAll();
  });

  it('matches concurrent requests to their own results', async () => {
    const { provider, indexSocket } = await connectedProvider();

    const first = provider.requestMobilePush!('session-1', 'One', 'First');
    const second = provider.requestMobilePush!('session-2', 'Two', 'Second');
    await vi.waitFor(() => expect(indexSocket.pushRequests()).toHaveLength(2));

    const [sentFirst, sentSecond] = indexSocket.pushRequests();
    expect(sentFirst.requestId).not.toBe(sentSecond.requestId);

    // Answer out of order: without requestId correlation the client would hand
    // each caller whichever result arrived first.
    indexSocket.receive({
      type: 'mobilePushResult',
      requestId: sentSecond.requestId,
      sessionId: 'session-2',
      accepted: true,
      attemptedCount: 1,
      deliveredCount: 1,
      skipped: [],
    });
    indexSocket.receive({
      type: 'mobilePushResult',
      requestId: sentFirst.requestId,
      sessionId: 'session-1',
      accepted: false,
      attemptedCount: 0,
      deliveredCount: 0,
      skipped: [],
      rejection: 'rate_limited',
    });

    expect((await first).rejection).toBe('rate_limited');
    expect((await second).deliveredCount).toBe(1);

    provider.disconnectAll();
  });
});
