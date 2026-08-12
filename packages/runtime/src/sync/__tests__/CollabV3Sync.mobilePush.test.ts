// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollabV3Sync } from '../CollabV3Sync';

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn<(payload: string) => void>();
  close = vi.fn(() => { this.readyState = 3; });

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
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.signature`;
}

function config() {
  return {
    serverUrl: 'wss://sync.example.test',
    orgId: 'org-1',
    userId: 'user-1',
    getJwt: async () => jwtFor('user-1'),
    getDeviceInfo: () => ({
      deviceId: 'desktop-1',
      name: 'Desktop',
      type: 'desktop' as const,
      platform: 'windows',
      connectedAt: 1,
      lastActiveAt: 2,
      isFocused: true,
      status: 'active' as const,
    }),
  };
}

async function connectedProvider() {
  const provider = createCollabV3Sync(config());
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.send.mockClear();
  return { provider, socket };
}

describe('CollabV3 explicit mobile attention push', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps default pushes presence-routed', async () => {
    const { provider, socket } = await connectedProvider();

    await provider.requestMobilePush!('session-1', 'Title', 'Body');

    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
      type: 'requestMobilePush',
      requestingDeviceId: 'desktop-1',
    });
    provider.disconnectAll();
  });

  it('advertises an active desktop as away before an explicit push, then restores it', async () => {
    const { provider, socket } = await connectedProvider();
    vi.useFakeTimers();

    const result = await provider.requestMobilePush!('session-1', 'Title', 'Body', {
      bypassActiveDeviceRouting: true,
      forceDesktopAwayForPush: true,
    });

    const frames = socket.send.mock.calls.map(([payload]) => JSON.parse(payload));
    expect(frames.map((frame) => frame.type)).toEqual(['deviceAnnounce', 'requestMobilePush']);
    expect(frames[0].device).toMatchObject({
      deviceId: 'desktop-1',
      isFocused: false,
      status: 'away',
    });
    expect(frames[1].requestingDeviceId).toBeUndefined();
    expect(result).toMatchObject({
      outcome: 'request_frame_written',
      forcedAwayFrameWritten: true,
      restorationScheduled: true,
    });

    await vi.advanceTimersByTimeAsync(1500);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0]).device.status).toBe('active');
    provider.disconnectAll();
  });
});
