import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOST_TOOLS } from '@nimbalyst/runtime/ai/server/services/mcpTopology';
import {
  generateMcpAuthToken,
  issueMcpSessionCredential,
  setMcpAuthTokenForTest,
} from '../mcpAuth';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\user-data'),
    getName: vi.fn(() => 'test'),
    getVersion: vi.fn(() => '1.0.0'),
    isPackaged: false,
    on: vi.fn(),
    once: vi.fn(),
    whenReady: vi.fn(async () => undefined),
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows = vi.fn(() => []);
    static getFocusedWindow = vi.fn(() => null);
    static fromWebContents = vi.fn(() => null);
  },
  clipboard: { writeText: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: { emit: vi.fn() },
  nativeImage: { createFromDataURL: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}));
vi.mock('../../window/WindowManager', () => ({
  getMostRecentlyFocusedWorkspaceWindow: vi.fn(() => null),
  windowStates: new Map(),
  windowFocusOrder: new Map(),
}));
vi.mock('../../window/windowState', () => ({ windows: new Map() }));

vi.mock('electron-log', () => ({
  default: {
    scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    transports: { file: {}, console: {} },
  },
}));
vi.mock('electron-log/main', () => ({
  default: {
    initialize: vi.fn(),
    scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    transports: { file: {}, console: {} },
  },
}));
vi.mock('electron-store', () => ({
  default: class ElectronStore {
    get = vi.fn();
    set = vi.fn();
    delete = vi.fn();
  },
}));
vi.mock('../../utils/logger', () => ({
  logger: {
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    store: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('../../utils/store', () => ({
  getProviderApiKeyFromSettings: vi.fn(),
  getProjectSettings: vi.fn(() => ({})),
  getAppSettings: vi.fn(() => ({})),
}));

describe('unified MCP host visibility-control wiring', () => {
  afterEach(async () => {
    const http = await import('../httpServer');
    await http.shutdownHttpServer();
    setMcpAuthTokenForTest(null);
  });

  it('advertises all visibility controls only through the deferred host topology', () => {
    const sessionContextSource = readFileSync(
      fileURLToPath(new URL('../sessionContextServer.ts', import.meta.url)),
      'utf8',
    );
    for (const tool of ['session_set_pinned', 'session_set_workstream', 'session_rename']) {
      expect(sessionContextSource).toContain(`name: "${tool}"`);
      expect(HOST_TOOLS).toContain(tool);
    }
  });

  it('uses identical production GET/POST/DELETE refusals for unknown and unauthorized transports', async () => {
    const http = await import('../httpServer');
    generateMcpAuthToken();
    const credentialA = issueMcpSessionCredential('actor-a', 'C:\\repo');
    const credentialB = issueMcpSessionCredential('actor-b', 'c:/REPO');
    const authorityA = {
      actorSessionId: 'actor-a',
      workspacePath: 'C:\\repo',
      workspaceComparisonPath: 'c:/repo',
    };
    http.updateDocumentState({ workspacePath: 'C:\\repo' }, 'actor-a');
    http.registerStreamableTransportForTest('known-transport', {
      authority: authorityA,
      nimbalystSessionId: 'actor-a',
      transport: {
        handleRequest: vi.fn(async (_req, res) => {
          res.writeHead(204);
          res.end();
        }),
        close: vi.fn(async () => undefined),
      },
    });
    const { httpServer } = await http.startMcpHttpServer(0);
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const endpoint = `http://127.0.0.1:${address.port}/mcp/host`;

    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const request = async (transportId: string) => {
        const response = await fetch(endpoint, {
          method,
          headers: {
            Authorization: `Bearer ${credentialB}`,
            'mcp-session-id': transportId,
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        return { status: response.status, body: await response.text() };
      };
      expect(await request('unknown-transport')).toEqual(await request('known-transport'));
      expect(await request('unknown-transport')).toEqual({ status: 404, body: 'Not found' });
    }

    const accepted = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${credentialA}`,
        'mcp-session-id': 'known-transport',
      },
    });
    expect(accepted.status).toBe(204);
  });

  it('revalidates and revokes an established transport through the host lifecycle', async () => {
    const http = await import('../httpServer');
    generateMcpAuthToken();
    http.updateDocumentState({ workspacePath: 'c:/repo/' }, 'actor-a');
    const credential = issueMcpSessionCredential('actor-a', 'C:\\Repo');
    const handleRequest = vi.fn(async (_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const close = vi.fn(async () => undefined);
    http.registerStreamableTransportForTest('transport-a', {
      authority: {
        actorSessionId: 'actor-a',
        workspacePath: 'c:/repo/',
        workspaceComparisonPath: 'c:/repo',
      },
      nimbalystSessionId: 'actor-a',
      transport: { handleRequest, close },
    });
    const { httpServer } = await http.startMcpHttpServer(0);
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const endpoint = `http://127.0.0.1:${address.port}/mcp/host`;
    const followUp = async (method: 'GET' | 'POST' | 'DELETE') => {
      const response = await fetch(endpoint, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          'mcp-session-id': 'transport-a',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      return { status: response.status, body: await response.text() };
    };

    expect(await followUp('GET')).toEqual({ status: 204, body: '' });

    // A host move invalidates the raw transport construction even though the
    // credential's normalized comparison identity is still equivalent.
    http.updateDocumentState({ workspacePath: 'C:/Repo' }, 'actor-a');
    expect(await followUp('GET')).toEqual({ status: 404, body: 'Not found' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(await followUp('POST')).toEqual({ status: 404, body: 'Not found' });
    expect(await followUp('DELETE')).toEqual({ status: 404, body: 'Not found' });
    expect(handleRequest).toHaveBeenCalledTimes(1);

    // Returning to the old spelling cannot resurrect the removed transport.
    http.updateDocumentState({ workspacePath: 'c:/repo/' }, 'actor-a');
    expect(await followUp('GET')).toEqual({ status: 404, body: 'Not found' });
    expect(close).toHaveBeenCalledTimes(1);

    const initializePayload = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'revoked-test', version: '1.0.0' },
      },
    };
    const movedInitialize = await fetch(`${endpoint}?sessionId=actor-a`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initializePayload),
    });
    expect(movedInitialize.status).toBe(200);
    await movedInitialize.text();

    await http.revokeHostBoundMcpAuthority('actor-a');
    expect(close).toHaveBeenCalledTimes(1);
    expect(await followUp('GET')).toEqual({ status: 401, body: 'Unauthorized' });

    // Recreating the same host actor/path cannot revive its revoked token.
    http.updateDocumentState({ workspacePath: 'c:/repo/' }, 'actor-a');

    const initialize = await fetch(`${endpoint}?sessionId=actor-a`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initializePayload),
    });
    const revokedResult = { status: initialize.status, body: await initialize.text() };
    const unknownCredential = await fetch(`${endpoint}?sessionId=actor-a`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer unknown-revoked-credential',
        'content-type': 'application/json',
      },
      body: JSON.stringify(initializePayload),
    });
    expect(revokedResult).toEqual({
      status: unknownCredential.status,
      body: await unknownCredential.text(),
    });

    const replacementCredential = issueMcpSessionCredential('actor-a', 'c:/repo/');
    expect(replacementCredential).not.toBe(credential);
    const recreated = await fetch(`${endpoint}?sessionId=actor-a`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${replacementCredential}`,
        'content-type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initializePayload),
    });
    expect(recreated.status).toBe(200);
    await recreated.text();
  });

  it('contains a synchronous close failure and removes every later matching transport', async () => {
    const http = await import('../httpServer');
    generateMcpAuthToken();
    http.updateDocumentState({ workspacePath: 'C:\\repo' }, 'actor-close');
    const firstClose = vi.fn(() => { throw new Error('synchronous close failure'); });
    const laterClose = vi.fn(async () => undefined);
    http.registerLegacyTransportForTest('close-first', {
      authority: {
        actorSessionId: 'actor-close', workspacePath: 'C:\\repo', workspaceComparisonPath: 'c:/repo',
      },
      nimbalystSessionId: 'actor-close',
      transport: { handlePostMessage: vi.fn(), close: firstClose },
    });
    http.registerLegacyTransportForTest('close-later', {
      authority: {
        actorSessionId: 'actor-close', workspacePath: 'C:\\repo', workspaceComparisonPath: 'c:/repo',
      },
      nimbalystSessionId: 'actor-close',
      transport: { handlePostMessage: vi.fn(), close: laterClose },
    });

    await expect(http.revokeHostBoundMcpAuthority('actor-close')).resolves.toBeUndefined();
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(laterClose).toHaveBeenCalledTimes(1);

    // A replacement host record and credential cannot reuse either removed
    // registration after one close implementation failed synchronously.
    http.updateDocumentState({ workspacePath: 'C:\\repo' }, 'actor-close');
    const replacement = issueMcpSessionCredential('actor-close', 'C:\\repo');
    const { httpServer } = await http.startMcpHttpServer(0);
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/mcp/host?sessionId=close-later`,
      { method: 'POST', headers: { Authorization: `Bearer ${replacement}`, 'content-type': 'application/json' }, body: '{}' },
    );
    expect({ status: response.status, body: await response.text() })
      .toEqual({ status: 404, body: 'Not found' });
  });

  it('request-invalidates a stale legacy transport before a synchronous close throw', async () => {
    const http = await import('../httpServer');
    generateMcpAuthToken();
    // Seed the currently host-bound raw authority directly. Calling
    // updateDocumentState here would proactively remove the stale transport
    // and bypass invalidateLegacyTransport, defeating this regression.
    http.documentStateBySession.set('actor-request-close', {
      sessionId: 'actor-request-close', workspacePath: 'C:/Repo',
    });
    const credential = issueMcpSessionCredential('actor-request-close', 'C:/Repo');
    const legacyHandle = vi.fn(async (_req, res) => { res.writeHead(204); res.end(); });
    const legacyClose = vi.fn(() => { throw new Error('legacy synchronous close'); });
    const staleAuthority = {
      actorSessionId: 'actor-request-close',
      workspacePath: 'c:/repo/',
      workspaceComparisonPath: 'c:/repo',
    };
    http.registerLegacyTransportForTest('legacy-sync-close', {
      authority: staleAuthority,
      nimbalystSessionId: 'actor-request-close',
      transport: { handlePostMessage: legacyHandle, close: legacyClose },
    });
    const { httpServer } = await http.startMcpHttpServer(0);
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const endpoint = `http://127.0.0.1:${address.port}/mcp/host`;
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const legacy = await fetch(`${endpoint}?sessionId=legacy-sync-close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect({ status: legacy.status, body: await legacy.text() })
        .toEqual({ status: 404, body: 'Not found' });
      expect(legacyClose).toHaveBeenCalledTimes(1);

      const laterClose = vi.fn().mockResolvedValue(undefined);
      http.registerLegacyTransportForTest('legacy-later-matching', {
        authority: { ...staleAuthority, workspacePath: 'C:/Repo' },
        nimbalystSessionId: 'actor-request-close',
        transport: { handlePostMessage: vi.fn(), close: laterClose },
      });
      await http.revokeHostBoundMcpAuthority('actor-request-close');
      expect(laterClose).toHaveBeenCalledTimes(1);
      http.documentStateBySession.set('actor-request-close', {
        sessionId: 'actor-request-close', workspacePath: 'C:/Repo',
      });
      const replacement = issueMcpSessionCredential('actor-request-close', 'C:/Repo');
      expect(replacement).not.toBe(credential);
      const reuse = await fetch(`${endpoint}?sessionId=legacy-sync-close`, {
        method: 'POST', headers: { Authorization: `Bearer ${replacement}`, 'content-type': 'application/json' }, body: '{}',
      });
      expect({ status: reuse.status, body: await reuse.text() })
        .toEqual({ status: 404, body: 'Not found' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(legacyHandle).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('request-invalidates a stale streamable transport before an async close rejection', async () => {
    const http = await import('../httpServer');
    generateMcpAuthToken();
    http.documentStateBySession.set('actor-stream-close', {
      sessionId: 'actor-stream-close', workspacePath: 'C:\\Repo',
    });
    const credential = issueMcpSessionCredential('actor-stream-close', 'C:\\Repo');
    const handleRequest = vi.fn(async (_req, res) => { res.writeHead(204); res.end(); });
    const close = vi.fn(() => Promise.reject(new Error('streamable async close')));
    const staleAuthority = {
      actorSessionId: 'actor-stream-close',
      workspacePath: 'c:/repo/',
      workspaceComparisonPath: 'c:/repo',
    };
    http.registerStreamableTransportForTest('streamable-async-close', {
      authority: staleAuthority,
      nimbalystSessionId: 'actor-stream-close',
      transport: { handleRequest, close },
    });
    const { httpServer } = await http.startMcpHttpServer(0);
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const endpoint = `http://127.0.0.1:${address.port}/mcp/host`;
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const refusal = await fetch(endpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}`, 'mcp-session-id': 'streamable-async-close' },
      });
      expect({ status: refusal.status, body: await refusal.text() })
        .toEqual({ status: 404, body: 'Not found' });
      expect(close).toHaveBeenCalledTimes(1);

      const laterClose = vi.fn().mockResolvedValue(undefined);
      http.registerStreamableTransportForTest('streamable-later-matching', {
        authority: { ...staleAuthority, workspacePath: 'C:\\Repo' },
        nimbalystSessionId: 'actor-stream-close',
        transport: { handleRequest: vi.fn(), close: laterClose },
      });
      await http.revokeHostBoundMcpAuthority('actor-stream-close');
      expect(laterClose).toHaveBeenCalledTimes(1);
      http.documentStateBySession.set('actor-stream-close', {
        sessionId: 'actor-stream-close', workspacePath: 'C:\\Repo',
      });
      const replacement = issueMcpSessionCredential('actor-stream-close', 'C:\\Repo');
      const reuse = await fetch(endpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${replacement}`, 'mcp-session-id': 'streamable-async-close' },
      });
      expect({ status: reuse.status, body: await reuse.text() })
        .toEqual({ status: 404, body: 'Not found' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(handleRequest).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('returns the legacy refusal without awaiting a never-settling close', async () => {
    const http = await import('../httpServer');
    generateMcpAuthToken();
    http.documentStateBySession.set('actor-legacy-never', {
      sessionId: 'actor-legacy-never', workspacePath: 'C:/Repo',
    });
    const credential = issueMcpSessionCredential('actor-legacy-never', 'C:/Repo');
    const never = new Promise<void>(() => undefined);
    const close = vi.fn(() => never);
    const handlePostMessage = vi.fn();
    http.registerLegacyTransportForTest('legacy-never-close', {
      authority: {
        actorSessionId: 'actor-legacy-never', workspacePath: 'c:/repo/',
        workspaceComparisonPath: 'c:/repo',
      },
      nimbalystSessionId: 'actor-legacy-never',
      transport: { handlePostMessage, close },
    });
    const { httpServer } = await http.startMcpHttpServer(0);
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const endpoint = `http://127.0.0.1:${address.port}/mcp/host?sessionId=legacy-never-close`;
    const response = await Promise.race([
      fetch(endpoint, {
        method: 'POST', headers: {
          Authorization: `Bearer ${credential}`, 'content-type': 'application/json',
        }, body: '{}',
      }),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('legacy refusal exceeded bounded deadline')), 250,
      )),
    ]);
    expect({ status: response.status, body: await response.text() })
      .toEqual({ status: 404, body: 'Not found' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(handlePostMessage).not.toHaveBeenCalled();

    const laterClose = vi.fn().mockResolvedValue(undefined);
    http.registerLegacyTransportForTest('legacy-never-later', {
      authority: {
        actorSessionId: 'actor-legacy-never', workspacePath: 'C:/Repo',
        workspaceComparisonPath: 'c:/repo',
      },
      nimbalystSessionId: 'actor-legacy-never',
      transport: { handlePostMessage: vi.fn(), close: laterClose },
    });
    await http.revokeHostBoundMcpAuthority('actor-legacy-never');
    expect(laterClose).toHaveBeenCalledTimes(1);
    http.documentStateBySession.set('actor-legacy-never', {
      sessionId: 'actor-legacy-never', workspacePath: 'C:/Repo',
    });
    const replacement = issueMcpSessionCredential('actor-legacy-never', 'C:/Repo');
    const reuse = await fetch(endpoint, {
      method: 'POST', headers: {
        Authorization: `Bearer ${replacement}`, 'content-type': 'application/json',
      }, body: '{}',
    });
    expect({ status: reuse.status, body: await reuse.text() })
      .toEqual({ status: 404, body: 'Not found' });
  });

  it('returns the streamable refusal without awaiting a never-settling close', async () => {
    const http = await import('../httpServer');
    generateMcpAuthToken();
    http.documentStateBySession.set('actor-stream-never', {
      sessionId: 'actor-stream-never', workspacePath: 'C:\\Repo',
    });
    const credential = issueMcpSessionCredential('actor-stream-never', 'C:\\Repo');
    const never = new Promise<void>(() => undefined);
    const close = vi.fn(() => never);
    const handleRequest = vi.fn();
    http.registerStreamableTransportForTest('stream-never-close', {
      authority: {
        actorSessionId: 'actor-stream-never', workspacePath: 'c:/repo/',
        workspaceComparisonPath: 'c:/repo',
      },
      nimbalystSessionId: 'actor-stream-never',
      transport: { handleRequest, close },
    });
    const { httpServer } = await http.startMcpHttpServer(0);
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const endpoint = `http://127.0.0.1:${address.port}/mcp/host`;
    const response = await Promise.race([
      fetch(endpoint, {
        method: 'GET', headers: {
          Authorization: `Bearer ${credential}`, 'mcp-session-id': 'stream-never-close',
        },
      }),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('streamable refusal exceeded bounded deadline')), 250,
      )),
    ]);
    expect({ status: response.status, body: await response.text() })
      .toEqual({ status: 404, body: 'Not found' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(handleRequest).not.toHaveBeenCalled();

    const laterClose = vi.fn().mockResolvedValue(undefined);
    http.registerStreamableTransportForTest('stream-never-later', {
      authority: {
        actorSessionId: 'actor-stream-never', workspacePath: 'C:\\Repo',
        workspaceComparisonPath: 'c:/repo',
      },
      nimbalystSessionId: 'actor-stream-never',
      transport: { handleRequest: vi.fn(), close: laterClose },
    });
    await http.revokeHostBoundMcpAuthority('actor-stream-never');
    expect(laterClose).toHaveBeenCalledTimes(1);
    http.documentStateBySession.set('actor-stream-never', {
      sessionId: 'actor-stream-never', workspacePath: 'C:\\Repo',
    });
    const replacement = issueMcpSessionCredential('actor-stream-never', 'C:\\Repo');
    const reuse = await fetch(endpoint, {
      method: 'GET', headers: {
        Authorization: `Bearer ${replacement}`, 'mcp-session-id': 'stream-never-close',
      },
    });
    expect({ status: reuse.status, body: await reuse.text() })
      .toEqual({ status: 404, body: 'Not found' });
  });

  it('removes a stale legacy SSE transport so an old raw path cannot resurrect it', async () => {
    const http = await import('../httpServer');
    generateMcpAuthToken();
    http.updateDocumentState({ workspacePath: 'c:/repo/' }, 'actor-a');
    const credential = issueMcpSessionCredential('actor-a', 'C:\\Repo');
    const handlePostMessage = vi.fn(async (_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const close = vi.fn(async () => undefined);
    http.registerLegacyTransportForTest('legacy-transport-a', {
      authority: {
        actorSessionId: 'actor-a',
        workspacePath: 'c:/repo/',
        workspaceComparisonPath: 'c:/repo',
      },
      nimbalystSessionId: 'actor-a',
      transport: { handlePostMessage, close },
    });
    const { httpServer } = await http.startMcpHttpServer(0);
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const endpoint = `http://127.0.0.1:${address.port}/mcp/host?sessionId=legacy-transport-a`;
    const post = async () => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      return { status: response.status, body: await response.text() };
    };

    expect(await post()).toEqual({ status: 204, body: '' });
    http.updateDocumentState({ workspacePath: 'C:/Repo' }, 'actor-a');
    expect(await post()).toEqual({ status: 404, body: 'Not found' });
    expect(close).toHaveBeenCalledTimes(1);
    http.updateDocumentState({ workspacePath: 'c:/repo/' }, 'actor-a');
    expect(await post()).toEqual({ status: 404, body: 'Not found' });
    expect(handlePostMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects initialize after current host ownership disappears with the unknown-actor response', async () => {
    const http = await import('../httpServer');
    generateMcpAuthToken();
    http.documentStateBySession.set('actor-a', {
      sessionId: 'actor-a',
      workspacePath: 'C:\\repo',
    });
    const credential = issueMcpSessionCredential('actor-a', 'C:\\repo');
    http.documentStateBySession.delete('actor-a');
    const { httpServer } = await http.startMcpHttpServer(0);
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const endpoint = `http://127.0.0.1:${address.port}/mcp/host`;
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'visibility-control-test', version: '1.0.0' },
      },
    };
    const request = async (sessionId: string) => {
      const response = await fetch(`${endpoint}?sessionId=${sessionId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(initialize),
      });
      return { status: response.status, body: await response.text() };
    };

    expect(await request('actor-a')).toEqual(await request('unknown-actor'));
    expect(await request('actor-a')).toEqual({ status: 404, body: 'Not found' });
  });

});
