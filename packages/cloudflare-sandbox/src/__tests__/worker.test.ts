// @vitest-environment node
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@cloudflare/sandbox/extensions', () => ({
  createExtensionProcessSandbox: (sandbox: { exec: (...args: unknown[]) => unknown; getProcess: (...args: unknown[]) => unknown }) => ({
    exec: (...args: unknown[]) => sandbox.exec(...args),
    getProcess: (...args: unknown[]) => sandbox.getProcess(...args),
  }),
}));

vi.mock('@cloudflare/sandbox', () => ({
  ContainerProxy: class {},
  Sandbox: class {
    ctx = { storage: { get: vi.fn(async () => undefined) } };
    sleepAfter = '10m';
    enableInternet = true;
    interceptHttps = false;
    getState = vi.fn(async () => ({ status: 'stopped', lastChange: 12 }));
    exec = vi.fn(async () => ({ output: vi.fn(async () => ({ exitCode: 0, timedOut: false })) }));
    stop = vi.fn(async () => {});
    setSandboxName = vi.fn(async () => {});
    setKeepAlive = vi.fn(async () => {});
    setSleepAfter = vi.fn(async () => {});
  },
}));
vi.mock('cloudflare:workers', () => ({
  RpcTarget: class {},
  WorkerEntrypoint: class {
    constructor(_ctx: unknown, public env: unknown) {}
  },
}));

import worker, { NimbalystSandbox, SandboxManager } from '../index';

describe('private Worker entrypoints', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lets the runtime emit WebSocket upgrade headers once and preserves the socket and negotiated protocol', async () => {
    const socket = {};
    const upstream = { status: 101, webSocket: socket, headers: new Headers({
      Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Protocol': 'sync',
    }) };
    vi.stubGlobal('fetch', vi.fn(async () => upstream));
    vi.stubGlobal('Response', class {
      constructor(public body: unknown, init: ResponseInit) { Object.assign(this, init); }
    });
    const result = await NimbalystSandbox.outbound!(new Request('https://sync.nimbalyst.com/'), {} as never, {} as never);
    expect(result.headers.has('upgrade')).toBe(false);
    expect(result.headers.has('connection')).toBe(false);
    expect(result.headers.get('sec-websocket-protocol')).toBe('sync');
    expect(result.status).toBe(101);
    expect(result.webSocket).toBe(socket);
    expect(upstream.headers.get('upgrade')).toBe('websocket');
  });

  it('passes ordinary HTTP and rejected WebSocket responses through unchanged', async () => {
    for (const status of [200, 401, 403, 502]) {
      const upstream = new Response('body', { status });
      vi.stubGlobal('fetch', vi.fn(async () => upstream));
      expect(await NimbalystSandbox.outbound!(new Request('https://sync.nimbalyst.com/'), {} as never, {} as never)).toBe(upstream);
    }
  });
  it('routes node RPC requests to the personal sandbox without exposing HTTP', async () => {
    const response = { sandboxId: 'personal', node: { running: false } };
    const sandbox = {
      managedProvision: vi.fn(async () => response),
      managedStartNode: vi.fn(async () => response),
      managedNodeStatus: vi.fn(async () => response),
      managedStopNode: vi.fn(async () => response),
    };
    const getByName = vi.fn(() => sandbox);
    const manager = new SandboxManager({} as never, { Sandbox: { getByName } } as never);
    const provision = { files: [{ path: '/home/nimbalyst/config', content: 'secret' }], allowedHosts: [] };
    expect(await manager.provision(provision)).toEqual(response);
    expect(await manager.startNode({ configPath: '/home/nimbalyst/config' })).toEqual(response);
    expect(await manager.nodeStatus()).toEqual(response);
    expect(await manager.stopNode({ discardEphemeralData: true })).toEqual(response);
    expect(sandbox.managedProvision).toHaveBeenCalledWith(provision);
    expect(sandbox.managedStartNode).toHaveBeenCalledWith({ configPath: '/home/nimbalyst/config' });
    expect(sandbox.managedStopNode).toHaveBeenCalledWith({ discardEphemeralData: true });
    expect(getByName.mock.calls).toEqual(Array.from({ length: 4 }, () => ['personal']));
  });
  it('has no HTTP management route and enforces the management runtime policy', async () => {
    expect((await worker.fetch()).status).toBe(404);
    const sandbox = new NimbalystSandbox({} as never, {} as never);
    expect(sandbox.enableInternet).toBe(false);
    expect(sandbox.interceptHttps).toBe(true);
    expect(sandbox.allowedHosts).toEqual([]);
    expect(sandbox.sleepAfter).toBe('300s');
    expect(await sandbox.managedStatus()).toMatchObject({ state: 'stopped', sleepAfterSeconds: 300 });
    expect(sandbox.exec).not.toHaveBeenCalled();
    await sandbox.managedWake();
    expect(sandbox.setKeepAlive).toHaveBeenCalledWith(false);
    expect(sandbox.setSleepAfter).toHaveBeenCalledWith(300);
    expect(sandbox.exec).toHaveBeenCalledWith(['/usr/local/bin/nimbalyst-node', '--smoke'], { timeout: 30_000 });
    expect(sandbox.setSandboxName).toHaveBeenCalledWith('personal');

    // A container that is up is not a runtime that works, so the smoke result is
    // the only evidence a wake succeeded. Failing it must surface as an error
    // and must not discard the container: that would lose files without consent.
    (sandbox.exec as unknown as Mock).mockResolvedValueOnce({ output: async () => ({ exitCode: 1, timedOut: false }) });
    await expect(sandbox.managedWake()).rejects.toThrow(/headless node runtime check failed/);
    expect(sandbox.stop).not.toHaveBeenCalled();

    const getByName = vi.fn(() => sandbox);
    const manager = new SandboxManager({} as never, { Sandbox: { getByName } } as never);
    await manager.status();
    expect(getByName).toHaveBeenCalledWith('personal');
    await expect(manager.stop({})).rejects.toThrow('requires confirmation');
    expect(sandbox.stop).not.toHaveBeenCalled();
    await manager.stop({ discardEphemeralData: true });
    expect(sandbox.stop).toHaveBeenCalledWith('SIGTERM');
  });
});
