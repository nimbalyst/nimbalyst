/**
 * Unit test for the `request` RPC timeout.
 *
 * A backend module that stays alive but never answers used to park its caller
 * in `managed.pending` forever: no timer, no error, no log line. Only a crash or
 * a stop (`rejectAllPending`) could settle it. When the caller was an MCP tool
 * handler that meant no JSON-RPC response was ever written and the agent waited
 * on its own client timeout, which on `/mcp/core` is a week.
 *
 * Run from repo root:
 *   npx vitest --run packages/electron/src/main/extensions/__tests__/PrivilegedExtensionHost.request.timeout.test.ts
 */
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    on: vi.fn(), once: vi.fn(), whenReady: vi.fn(() => Promise.resolve()),
    getPath: vi.fn(() => '/mock/path'), getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'), isPackaged: false,
  },
  BrowserWindow: class { static getAllWindows = vi.fn(() => []); },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  utilityProcess: { fork: vi.fn() },
}));

import { PrivilegedExtensionHost } from '../PrivilegedExtensionHost';

const EXT = 'com.nimbalyst.memory';
const MOD = 'memory-engine';
const WS = '/ws';

/** Install a module in `running` state whose runtime records sends but never replies. */
function installSilentModule(host: PrivilegedExtensionHost) {
  const sent: Array<{ kind: string; id: string; method: string }> = [];
  const managed = {
    args: { extensionId: EXT, module: { id: MOD }, workspacePath: WS },
    state: { status: 'running', startedAt: 0, methods: [] },
    grantedPermissions: [],
    runtime: { send: (msg: any) => sent.push(msg), kill: vi.fn() },
    pending: new Map(),
    nextRpcId: 1,
  };
  (host as any).modules.set(`${EXT}::${MOD}::${WS}`, managed);
  return { managed, sent };
}

const REQUEST = {
  extensionId: EXT,
  moduleId: MOD,
  workspacePath: WS,
  method: 'status',
  requiredPermission: null,
} as const;

describe('PrivilegedExtensionHost.request timeout', () => {
  let host: PrivilegedExtensionHost;

  beforeEach(() => {
    vi.useFakeTimers();
    host = new PrivilegedExtensionHost();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects and drops the pending callback when the module never answers', async () => {
    const { managed } = installSilentModule(host);

    const call = host.request({ ...REQUEST, timeoutMs: 1000 });
    // Registered while in flight -- this is what used to leak.
    expect(managed.pending.size).toBe(1);

    // Attach before advancing: the timer rejects synchronously inside the tick.
    const rejected = expect(call).rejects.toThrow(/did not answer status within 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;

    expect(managed.pending.size).toBe(0);
  });

  it('does not fire once the module has answered', async () => {
    const { managed } = installSilentModule(host);

    const call = host.request({ ...REQUEST, timeoutMs: 1000 });
    // Mirrors handleMessage's 'rpc-result' branch: it drops the entry, then settles.
    const [id, cb] = [...managed.pending.entries()][0] as [string, any];
    managed.pending.delete(id);
    cb.resolve({ ok: true });

    await expect(call).resolves.toEqual({ ok: true });

    // Well past the deadline: the cleared timer must not fire and reject an
    // already-resolved call. An uncleared timer surfaces as an unhandled
    // rejection, which this file's runner treats as a failure.
    await vi.advanceTimersByTimeAsync(5000);
  });

  it('ignores a reply that arrives after the deadline', async () => {
    const { managed } = installSilentModule(host);

    const call = host.request({ ...REQUEST, timeoutMs: 1000 });
    const cb = [...managed.pending.values()][0] as any;

    const rejected = expect(call).rejects.toThrow(/did not answer/);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;

    // The late reply has nowhere to go; it must not throw or revive the call.
    expect(() => cb.resolve({ ok: true })).not.toThrow();
    expect(managed.pending.size).toBe(0);
  });
});
