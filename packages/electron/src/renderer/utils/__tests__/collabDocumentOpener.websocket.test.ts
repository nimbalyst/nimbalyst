import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({
  logger: { ui: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
}));

import {
  createProxiedWebSocket,
  getCollabConfig,
  registerCollabConfig,
} from '../collabDocumentOpener';

const scopeA = {
  scopeKey: 'scope-a',
  orgId: 'org-1',
  indexConfig: { serverUrl: 'wss://sync.example.test', userId: 'user-1' },
};
const scopeB = { ...scopeA, scopeKey: 'scope-b' };

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createProxiedWebSocket', () => {
  it('keeps identical document URIs isolated by host scope', () => {
    const baseConfig = {
      orgId: 'org-1',
      documentId: 'doc-1',
      title: 'Document',
      serverUrl: 'wss://sync.example.test',
      getJwt: async () => 'token',
      userId: 'user-1',
      accountId: 'account-1',
    };
    const configA = { ...baseConfig, scope: scopeA, title: 'Scope A' };
    const configB = { ...baseConfig, scope: scopeB, title: 'Scope B' };

    const uri = registerCollabConfig(configA);
    registerCollabConfig(configB);

    expect(getCollabConfig(scopeA, uri)).toBe(configA);
    expect(getCollabConfig(scopeB, uri)).toBe(configB);
  });

  it('waits for the proxied close event before reporting the socket closed', async () => {
    let emitWsEvent: ((event: {
      wsId: string;
      type: string;
      code?: number;
      reason?: string;
    }) => void) | undefined;
    const wsClose = vi.fn(async () => ({ success: true }));
    const wsConnect = vi.fn(async () => ({ success: true, wsId: 'ws-1' }));

    vi.stubGlobal('WebSocket', TestWebSocket);
    vi.stubGlobal('window', {
      electronAPI: {
        documentSync: {
          onWsEvent: vi.fn((listener) => {
            emitWsEvent = listener;
            return vi.fn();
          }),
          wsConnect,
          wsSend: vi.fn(),
          wsClose,
        },
      },
    });

    const socket = createProxiedWebSocket('wss://sync.example.test/room');
    const closeListener = vi.fn();
    socket.addEventListener('close', closeListener);
    await Promise.resolve();

    socket.close();

    expect(socket.readyState).toBe(TestWebSocket.CLOSING);
    expect(wsClose).toHaveBeenCalledWith('ws-1');
    expect(closeListener).not.toHaveBeenCalled();

    emitWsEvent?.({ wsId: 'ws-1', type: 'close', code: 1000, reason: 'closed' });

    expect(socket.readyState).toBe(TestWebSocket.CLOSED);
    expect(closeListener).toHaveBeenCalledOnce();

    let resolveSecondConnect:
      | ((result: { success: true; wsId: string }) => void)
      | undefined;
    wsConnect.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSecondConnect = resolve;
    }));
    const closingSocket = createProxiedWebSocket('wss://sync.example.test/second-room');
    const closingListener = vi.fn();
    closingSocket.addEventListener('close', closingListener);

    closingSocket.close();
    emitWsEvent?.({ wsId: 'ws-2', type: 'open' });
    resolveSecondConnect?.({ success: true, wsId: 'ws-2' });
    await Promise.resolve();
    await Promise.resolve();

    expect(closingSocket.readyState).toBe(TestWebSocket.CLOSING);
    expect(wsClose).toHaveBeenCalledWith('ws-2');
    expect(closingListener).not.toHaveBeenCalled();

    emitWsEvent?.({ wsId: 'ws-2', type: 'close', code: 1000, reason: 'closed' });

    expect(closingSocket.readyState).toBe(TestWebSocket.CLOSED);
    expect(closingListener).toHaveBeenCalledOnce();
  });
});
