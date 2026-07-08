/**
 * Unit test for startModule concurrency coalescing.
 *
 * A single start attempt can park on an async consent/trust prompt
 * ('awaiting-consent'), which the running/starting fast-paths do NOT treat as
 * in-flight. Two near-simultaneous callers (the set-enable IPC and the
 * workspace-open sweep) would then each launch a runtime — double-spawning the
 * utility process. startModule now tracks the in-flight attempt on
 * `managed.startInFlight` so later concurrent callers await it instead.
 *
 * This drives the real startModule but stubs the extracted `runStartAttempt`
 * (the trust→consent→spawn body) with a controllable deferred, so the test is
 * fast and asserts exactly the coalescing decision.
 *
 * Run from repo root:
 *   npx vitest --run packages/electron/src/main/extensions/__tests__/PrivilegedExtensionHost.startModule.coalesce.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const noop = () => {};
  return {
    app: {
      on: vi.fn(), once: vi.fn(), whenReady: vi.fn(() => Promise.resolve()),
      getPath: vi.fn(() => '/mock/path'), getName: vi.fn(() => 'test-app'),
      getVersion: vi.fn(() => '1.0.0'), setName: vi.fn(), setPath: vi.fn(), quit: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true), commandLine: { appendSwitch: vi.fn() },
      isPackaged: false,
    },
    BrowserWindow: class FakeBrowserWindow {
      static fromWebContents = vi.fn(() => null);
      static getFocusedWindow = vi.fn(() => null);
      static getAllWindows = vi.fn(() => []);
      on = noop;
    },
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    ipcRenderer: { send: vi.fn(), on: vi.fn(), invoke: vi.fn() },
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
    screen: { getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })), on: vi.fn() },
    nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
    nativeImage: { createFromPath: vi.fn(() => ({})), createEmpty: vi.fn(() => ({})) },
    Menu: class FakeMenu { static setApplicationMenu = vi.fn(); static buildFromTemplate = vi.fn(); },
    shell: { openExternal: vi.fn() },
    utilityProcess: { fork: vi.fn() },
  };
});

import { PrivilegedExtensionHost, type StartModuleArgs } from '../PrivilegedExtensionHost';

const ARGS: StartModuleArgs = {
  extensionId: 'com.nimbalyst.memory',
  extensionName: 'Nimbalyst Memory',
  extensionPath: '/x',
  module: { id: 'memory-engine', entry: 'dist/backend.js', runtime: 'utility-process', permissions: [], enablement: { default: 'disabled', promptOn: 'firstUse', purpose: 'test' } } as any,
  workspacePath: '/ws',
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('PrivilegedExtensionHost.startModule coalescing', () => {
  let host: PrivilegedExtensionHost;

  beforeEach(() => {
    vi.clearAllMocks();
    host = new PrivilegedExtensionHost();
  });

  it('coalesces concurrent starts into a single attempt, but runs sequential starts separately', async () => {
    const gate = deferred<void>();
    const runHandle = { extensionId: ARGS.extensionId, moduleId: ARGS.module.id, workspacePath: ARGS.workspacePath, state: { status: 'running', startedAt: 0, methods: [] } };
    const runStartAttempt = vi.fn(async () => {
      await gate.promise;
      return runHandle;
    });
    (host as unknown as { runStartAttempt: unknown }).runStartAttempt = runStartAttempt;

    // Two concurrent callers for the SAME module.
    const p1 = host.startModule(ARGS);
    const p2 = host.startModule(ARGS);

    // Only one attempt launched; the second coalesced onto the same promise.
    expect(runStartAttempt).toHaveBeenCalledTimes(1);

    gate.resolve();
    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h1).toBe(runHandle);
    expect(h2).toBe(runHandle);

    // After completion the in-flight latch is cleared, so a later start re-attempts.
    const gate2 = deferred<void>();
    runStartAttempt.mockImplementationOnce(async () => {
      await gate2.promise;
      return runHandle;
    });
    const p3 = host.startModule(ARGS);
    expect(runStartAttempt).toHaveBeenCalledTimes(2);
    gate2.resolve();
    await p3;
  });
});
