// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { SandboxManagement, BASELINE_ALLOWED_HOSTS, type NodeRecord, type ContainerState } from '../management';
import type { SandboxCommand } from '@cloudflare/sandbox';

function logStream(...chunks: Uint8Array[]) {
  return new ReadableStream({ start(controller) {
    for (const data of chunks) controller.enqueue({ type: 'stdout', data });
    controller.close();
  } });
}

function fixture() {
  const state: ContainerState = { status: 'stopped', lastChange: 123 };
  let record: NodeRecord | undefined;
  let processState = 'running';
  let startedAt = new Date().toISOString();
  let command: SandboxCommand = ['/usr/local/bin/nimbalyst-node', 'serve', '--config', '/home/nimbalyst/config'];
  const process = {
    id: 'node-1',
    status: vi.fn(async () => ({ id: 'node-1', pid: 42, command, startedAt, state: processState, ...(processState === 'exited' ? { exit: { code: 0, timedOut: false }, endedAt: new Date().toISOString() } : {}) })),
    logs: vi.fn(async () => new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stdout', data: new TextEncoder().encode('x'.repeat(5000) + 'end') });
      controller.close();
    } })),
    kill: vi.fn(async () => { processState = 'exited'; }),
    waitForExit: vi.fn(async () => {
      if (processState === 'running') throw Object.assign(new Error('wait expired'), { code: 'PROCESS_WAIT_TIMEOUT' });
      return { code: 0, timedOut: false };
    }),
  };
  const commandOutput = vi.fn(async (_argv: SandboxCommand) => ({ exitCode: 0, timedOut: false }));
  const launch = vi.fn(async (argv: SandboxCommand) => { startedAt = new Date().toISOString(); command = argv; state.status = 'running'; processState = 'running'; return process; });
  const port = {
    getState: vi.fn(async () => state),
    checkRuntime: vi.fn(async () => { state.status = 'healthy'; }),
    stop: vi.fn(async () => { state.status = 'stopping'; }),
    node: {
      readRecord: vi.fn(async () => record),
      writeRecord: vi.fn(async (value: NodeRecord) => { record = value; }),
      clearRecord: vi.fn(async () => { record = undefined; }),
      setAllowedHosts: vi.fn(async (_hosts: string[]) => {}),
      mkdir: vi.fn(async (_path: string) => {}),
      writeFile: vi.fn(async (_path: string, _content: string) => {}),
      exec: vi.fn(async (argv: SandboxCommand) => argv[0] === '/usr/local/bin/nimbalyst-node' ? launch(argv) : { output: () => commandOutput(argv) }),
      exists: vi.fn(async () => true),
      getProcess: vi.fn(async () => process),
      listProcesses: vi.fn(async () => state.status === 'running' ? [await process.status()] : []),
      setKeepAlive: vi.fn(async () => {}),
    },
  };
  return { state, port, process, commandOutput, launch, manager: new SandboxManagement(port as never) };
}

describe('sandbox management', () => {
  it('observes status without waking or extending the idle lifetime', async () => {
    const { manager, port, process, commandOutput, launch } = fixture();
    expect(await manager.status()).toMatchObject({ state: 'stopped', persistence: 'ephemeral' });
    expect(port.checkRuntime).not.toHaveBeenCalled();
    expect(port.stop).not.toHaveBeenCalled();
  });

  it('requires explicit discard confirmation and reports a stop still in progress honestly', async () => {
    const { manager, port, process, commandOutput, launch } = fixture();
    for (const request of [undefined, null, {}, { discardEphemeralData: 'true' }]) {
      await expect(manager.stop(request)).rejects.toThrow('requires confirmation');
    }
    expect(port.stop).not.toHaveBeenCalled();
    expect(await manager.stop({ discardEphemeralData: true })).toMatchObject({ state: 'stopping' });
  });

  it('orders a stop after an in-flight wake and recovers after a failed operation', async () => {
    const { manager, port, process, commandOutput, launch } = fixture();
    let release!: () => void;
    port.checkRuntime.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const waking = manager.wake();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const stopping = manager.stop({ discardEphemeralData: true });
    expect(port.stop).not.toHaveBeenCalled();
    release();
    await waking;
    await stopping;
    expect(port.stop).toHaveBeenCalledOnce();
    port.checkRuntime.mockRejectedValueOnce(new Error('startup failed'));
    await expect(manager.wake()).rejects.toThrow('startup failed');
    expect(await manager.wake()).toMatchObject({ state: 'healthy' });
  });
});

describe('node management', () => {
  it('maps SDK launch diagnostics to a safe node failure without replaying work', async () => {
    const { manager, launch, port } = fixture();
    launch.mockRejectedValueOnce(Object.assign(new Error('secret spawn diagnostic'), { code: 'PROCESS_SPAWN_FAILED' }));
    await expect(manager.startNode({ configPath: '/home/nimbalyst/config' })).rejects.toThrow('node-start-failed');
    expect(launch).toHaveBeenCalledOnce();
    expect(await port.node.readRecord()).toMatchObject({ processId: null });
  });

  it.each(['setAllowedHosts', 'mkdir', 'writeFile'] as const)('normalizes %s provisioning failures without exposing diagnostics', async operation => {
    const { manager, port } = fixture();
    port.node[operation].mockRejectedValueOnce(Object.assign(new Error('secret provisioning diagnostic'), { code: 'RPC_TRANSPORT_ERROR' }));
    await expect(manager.provision({ files: [{ path: '/home/nimbalyst/config', content: 'secret' }], allowedHosts: [] })).rejects.toThrow('node-not-provisioned');
  });

  it.each(['lookup', 'kill', 'wait'])('reconciles a stale handle during stop %s and releases keep-alive', async stage => {
    const { manager, port, process } = fixture();
    await manager.startNode({ configPath: '/home/nimbalyst/config' });
    const stale = Object.assign(new Error('old container'), { code: 'STALE_PROCESS_HANDLE' });
    const gone = async () => { port.node.getProcess.mockResolvedValue(null as never); throw stale; };
    if (stage === 'lookup') port.node.getProcess.mockResolvedValueOnce(process).mockImplementationOnce(gone);
    if (stage === 'kill') process.kill.mockImplementationOnce(gone);
    if (stage === 'wait') process.waitForExit.mockImplementationOnce(gone);
    expect((await manager.stopNode({ discardEphemeralData: true })).node).toMatchObject({ running: false, processId: null });
    expect(port.node.setKeepAlive).toHaveBeenLastCalledWith(false);
    expect(await port.node.readRecord()).toBeUndefined();
  });

  it('validates all paths and UTF-8 content size before changing the sandbox', async () => {
    const { manager, port, process, commandOutput, launch } = fixture();
    for (const path of ['/etc/passwd', '/home/nimbalyst/../root/key', '/home/nimbalyst2/a', '/home/nimbalyst/', '/home/nimbalyst/a\u0000b']) {
      await expect(manager.provision({ files: [{ path, content: 'secret' }], allowedHosts: [] })).rejects.toThrow('invalid-path');
      await expect(manager.startNode({ configPath: path })).rejects.toThrow('invalid-path');
    }
    await expect(manager.provision({ files: [{ path: '/home/nimbalyst/config', content: 'é'.repeat(131073) }], allowedHosts: [] })).rejects.toThrow('invalid-request');
    await expect(manager.provision({ files: [], allowedHosts: ['*'] })).rejects.toThrow('invalid-request');
    await expect(manager.provision({ files: Array.from({ length: 33 }, () => ({ path: '/home/nimbalyst/config', content: '' })), allowedHosts: [] })).rejects.toThrow('invalid-request');
    await expect(manager.provision({ files: [], allowedHosts: Array.from({ length: 17 }, (_, i) => `host${i}.example.com`) })).rejects.toThrow('invalid-request');
    expect(port.node.setAllowedHosts).not.toHaveBeenCalled();
    expect(port.node.writeFile).not.toHaveBeenCalled();
  });

  it('preflights every path before writing files or changing egress', async () => {
    const { manager, port, process, commandOutput, launch } = fixture();
    commandOutput.mockImplementation(async argv => ({ exitCode: argv.includes('/home/nimbalyst/link') ? 1 : 0, timedOut: false }));
    await expect(manager.provision({ files: [
      { path: '/home/nimbalyst/config', content: 'secret' },
      { path: '/home/nimbalyst/link/config', content: 'secret' },
    ], allowedHosts: ['example.com'] })).rejects.toThrow('invalid-path');
    expect(port.node.setAllowedHosts).not.toHaveBeenCalled();
    expect(port.node.mkdir).not.toHaveBeenCalled();
    expect(port.node.writeFile).not.toHaveBeenCalled();
  });

  it('creates a private file before writing credentials and unlinks it if chmod fails', async () => {
    const { manager, port, process, commandOutput, launch } = fixture();
    const events: Array<string | readonly string[]> = [];
    commandOutput.mockImplementation(async argv => { if (argv[0] !== '/usr/bin/test') events.push(argv); return { exitCode: argv[0] === '/usr/bin/chmod' ? 1 : 0, timedOut: false }; });
    port.node.writeFile.mockImplementation(async () => { events.push('write-secret'); });
    await expect(manager.provision({ files: [{ path: '/home/nimbalyst/config', content: 'secret', mode: 0o640 }], allowedHosts: [] })).rejects.toThrow('invalid-path');
    expect(events).toEqual([
      ['/usr/bin/install', '-m', '600', '--', '/dev/null', '/home/nimbalyst/config'],
      'write-secret',
      ['/usr/bin/chmod', '640', '--', '/home/nimbalyst/config'],
      ['/usr/bin/rm', '-f', '--', '/home/nimbalyst/config'],
    ]);
  });

  it('releases keep-alive on spontaneous exit while preserving the final diagnostic observation', async () => {
    const { manager, port, process, commandOutput, launch } = fixture();
    await manager.startNode({ configPath: '/home/nimbalyst/config' });
    const status = await process.status();
    process.status.mockResolvedValueOnce({ ...status, state: 'exited', exit: { code: 3, timedOut: false }, endedAt: new Date(1235).toISOString() });
    process.logs.mockResolvedValueOnce(logStream(new TextEncoder().encode('credential revoked')));
    expect((await manager.nodeStatus()).node).toMatchObject({ running: false, exitCode: 3, recentLog: 'credential revoked' });
    expect(port.node.setKeepAlive).toHaveBeenLastCalledWith(false);
    expect(port.node.clearRecord).toHaveBeenCalledOnce();
    expect((await manager.nodeStatus()).node.processId).toBeNull();
  });

  it('bounds re-encoded logs containing invalid-byte replacements and a split UTF-8 character', async () => {
    const { manager, port, process, commandOutput, launch } = fixture();
    const invalid = new TextDecoder().decode(new Uint8Array([0xff, 0xfe]));
    process.logs.mockImplementation(async () => logStream(new Uint8Array(6000).fill(0xff), new TextEncoder().encode(invalid + '😀'.repeat(2000) + 'xx')));
    const status = await manager.startNode({ configPath: '/home/nimbalyst/config' });
    expect(Buffer.byteLength(status.node.recentLog, 'utf8')).toBeLessThanOrEqual(4096);
    expect(status.node.recentLog.endsWith('xx')).toBe(true);
  });

  it('normalizes files, rejects symlinks, applies permissions, and unions concrete egress hosts', async () => {
    const { manager, port, process, commandOutput, launch } = fixture();
    await manager.provision({ files: [{ path: '/home/nimbalyst//./node/config', content: 'secret' }], allowedHosts: ['github.com', 'GIT.EXAMPLE.COM'] });
    expect(port.node.setAllowedHosts).toHaveBeenCalledWith([...BASELINE_ALLOWED_HOSTS, 'git.example.com']);
    expect(port.node.mkdir).toHaveBeenCalledWith('/home/nimbalyst/node');
    expect(port.node.writeFile).toHaveBeenCalledWith('/home/nimbalyst/node/config', 'secret');
    expect(port.node.exec).toHaveBeenLastCalledWith(['/usr/bin/chmod', '600', '--', '/home/nimbalyst/node/config'], { timeout: 30_000 });
    commandOutput.mockResolvedValueOnce({ exitCode: 1, timedOut: false });
    await expect(manager.provision({ files: [{ path: '/home/nimbalyst/link/config', content: 'secret' }], allowedHosts: [] })).rejects.toThrow('invalid-path');
    expect(port.node.writeFile).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent starts, persists identity, and observes idle containers without waking them', async () => {
    const { manager, port, state, process, commandOutput, launch } = fixture();
    const request = { configPath: "/home/nimbalyst/node's config" };
    const [first, second] = await Promise.all([manager.startNode(request), manager.startNode(request)]);
    expect(first.node.running).toBe(true);
    expect(second.node.processId).toBe(first.node.processId);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(['/usr/local/bin/nimbalyst-node', 'serve', '--config', request.configPath]);
    expect(port.node.setKeepAlive).toHaveBeenCalledWith(true);
    expect(Buffer.byteLength(first.node.recentLog)).toBe(4096);
    const freshManager = new SandboxManagement(port);
    expect((await freshManager.nodeStatus()).node.processId).toBe('node-1');
    await manager.wake();
    expect(port.checkRuntime).toHaveBeenLastCalledWith(true);
    state.status = 'stopped';
    port.node.getProcess.mockClear();
    port.node.exec.mockClear();
    expect((await manager.nodeStatus()).node.running).toBe(false);
    expect(port.node.getProcess).not.toHaveBeenCalled();
    expect(port.node.exec).not.toHaveBeenCalled();
  });

  it('recovers an interrupted launch from the stored job without launching twice', async () => {
    const { manager, port, process, launch } = fixture();
    const original = launch.getMockImplementation()!;
    launch.mockImplementationOnce(async argv => {
      await original(argv);
      throw Object.assign(new Error('connection lost'), { code: 'RPC_TRANSPORT_ERROR' });
    });
    await expect(manager.startNode({ configPath: '/home/nimbalyst/config' })).rejects.toThrow('node-start-failed');
    expect(port.node.writeRecord).toHaveBeenCalledWith(expect.objectContaining({ processId: null, configPath: '/home/nimbalyst/config' }));
    expect((await manager.startNode({ configPath: '/home/nimbalyst/config' })).node.running).toBe(true);
    expect(launch).toHaveBeenCalledOnce();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('does not attach to a reused ID or restart a stale process during observation', async () => {
    const { manager, port, process, launch } = fixture();
    await manager.startNode({ configPath: '/home/nimbalyst/config' });
    const status = await process.status();
    process.status.mockResolvedValueOnce({ ...status, startedAt: new Date(Date.parse(status.startedAt) + 1000).toISOString() });
    expect((await manager.nodeStatus()).node.running).toBe(false);
    expect(process.kill).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledOnce();
    await manager.startNode({ configPath: '/home/nimbalyst/config' });
    port.node.getProcess.mockRejectedValueOnce(Object.assign(new Error('stale handle'), { code: 'STALE_PROCESS_HANDLE' }));
    expect((await manager.nodeStatus()).node.running).toBe(false);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('waits for command output before writing credentials', async () => {
    const { manager, port, commandOutput } = fixture();
    let release!: (value: { exitCode: number; timedOut: boolean }) => void;
    commandOutput.mockImplementation(async argv => argv[0] === '/usr/bin/install'
      ? new Promise(resolve => { release = resolve; }) : { exitCode: 0, timedOut: false });
    const provisioning = manager.provision({ files: [{ path: '/home/nimbalyst/config', content: 'secret' }], allowedHosts: [] });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(port.node.writeFile).not.toHaveBeenCalled();
    release({ exitCode: 0, timedOut: false });
    await provisioning;
    expect(port.node.writeFile).toHaveBeenCalledOnce();
  });

  it('requires stop consent, retains a process surviving SIGTERM, then clears it after observed exit', async () => {
    const { manager, port, state, process, commandOutput, launch } = fixture();
    await manager.startNode({ configPath: '/home/nimbalyst/config' });
    for (const request of [null, {}, { discardEphemeralData: 'true' }]) {
      await expect(manager.stopNode(request)).rejects.toThrow('requires confirmation');
    }
    expect(process.kill).not.toHaveBeenCalled();
    state.status = 'stopping';
    expect((await manager.stopNode({ discardEphemeralData: true })).node.processId).toBe('node-1');
    expect(port.node.clearRecord).not.toHaveBeenCalled();
    state.status = 'running';
    process.kill.mockImplementationOnce(async () => {});
    expect((await manager.stopNode({ discardEphemeralData: true })).node.running).toBe(true);
    expect(port.node.clearRecord).not.toHaveBeenCalled();
    process.logs.mockRejectedValueOnce(new Error('secret log failure'));
    expect((await manager.stopNode({ discardEphemeralData: true })).node).toMatchObject({ running: false, processId: null });
    expect(process.kill).toHaveBeenCalledWith(15);
    expect(port.node.setKeepAlive).toHaveBeenLastCalledWith(false);
    expect(port.node.clearRecord).toHaveBeenCalledOnce();
  });

  it('distinguishes missing configuration and failed process startup', async () => {
    const { manager, port, process, commandOutput, launch } = fixture();
    port.node.exists.mockResolvedValueOnce(false);
    await expect(manager.startNode({ configPath: '/home/nimbalyst/config' })).rejects.toThrow('node-not-provisioned');
    expect(launch).not.toHaveBeenCalled();
    launch.mockRejectedValueOnce(new Error('raw secret diagnostic'));
    await expect(manager.startNode({ configPath: '/home/nimbalyst/config' })).rejects.toThrow('node-start-failed');
    port.node.writeRecord.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(manager.startNode({ configPath: '/home/nimbalyst/config' })).rejects.toThrow('node-start-failed');
    expect(process.kill).toHaveBeenCalledWith(15);
  });

  it('retries recording a process when both the initial storage write and compensating kill fail', async () => {
    const { manager, port, process, commandOutput, launch } = fixture();
    port.node.writeRecord.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('storage unavailable'));
    process.kill.mockRejectedValueOnce(new Error('kill unavailable'));
    await expect(manager.startNode({ configPath: '/home/nimbalyst/config' })).rejects.toThrow('node-start-failed');
    expect(port.node.writeRecord).toHaveBeenCalledTimes(3);
    expect((await manager.nodeStatus()).node).toMatchObject({ running: true, processId: 'node-1' });
    await manager.stopNode({ discardEphemeralData: true });
    expect(process.kill).toHaveBeenCalledTimes(2);
  });
});
