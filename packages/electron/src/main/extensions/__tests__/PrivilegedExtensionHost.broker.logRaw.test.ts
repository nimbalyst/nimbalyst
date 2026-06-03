/**
 * OBSERVED integration test for the privileged broker logRaw path.
 *
 * Substitutes for a never-run GUI antigravity turn. It drives the REAL
 * PrivilegedExtensionHost.handleBrokerRequest -> REAL assertPermission gate ->
 * REAL dispatchBrokerMethod 'logRaw' branch -> REAL AgentMessagesRepository.create
 * into an injected spy store. The only stubbed boundaries are the grant lookup
 * (isPermissionGranted) and the terminal store adapter. Everything that the
 * functional claims hinge on -- host-stamped source, inbound/outbound mapping,
 * hidden/searchable flags, the { id: 0 } sentinel reply, and the gate rejection
 * -- is asserted against real code paths.
 *
 * Run from repo root:
 *   npx vitest --run packages/electron/src/main/extensions/__tests__/PrivilegedExtensionHost.broker.logRaw.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fuller `electron` mock than the global partial one in vitest.setup.ts.
// Importing PrivilegedExtensionHost transitively loads WindowManager.ts, which
// calls `app.on('before-quit', ...)` at MODULE LOAD. The global mock lacks
// `app.on` (and BrowserWindow/dialog/etc), so the host import crashes without
// this. None of these stubs touch the broker dispatch path under test -- they
// only let the transitive module graph load. Provided as a noop surface so the
// REAL host code runs unmodified.
vi.mock('electron', () => {
  const noop = () => {};
  return {
    app: {
      on: vi.fn(),
      once: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve()),
      getPath: vi.fn(() => '/mock/path'),
      getName: vi.fn(() => 'test-app'),
      getVersion: vi.fn(() => '1.0.0'),
      setName: vi.fn(),
      setPath: vi.fn(),
      quit: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true),
      commandLine: { appendSwitch: vi.fn() },
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

// Control ONLY the grant lookup. assertPermission itself stays real: it reads
// grants exclusively via isPermissionGranted (verified: the only consumer in
// the logRaw path), so stubbing that one function exercises the genuine gate
// logic + the real CapabilityDeniedError throw/catch in handleBrokerRequest,
// without electron-store or a DB. Everything else in permissionGrantStore is
// kept real via importActual.
vi.mock('../permissionGrantStore', async (orig) => {
  const actual = await orig<typeof import('../permissionGrantStore')>();
  return {
    ...actual,
    isPermissionGranted: vi.fn(),
  };
});

import { PrivilegedExtensionHost } from '../PrivilegedExtensionHost';
import { isPermissionGranted } from '../permissionGrantStore';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';

// `electron` (app/ipc) is already globally mocked in packages/electron/vitest.setup.ts.
// utilityProcess / UtilityProcess are imported as named bindings used only
// inside methods (never at module load), so the partial electron mock is fine.

const grantMock = isPermissionGranted as unknown as ReturnType<typeof vi.fn>;

describe('PrivilegedExtensionHost broker logRaw', () => {
  let host: PrivilegedExtensionHost;
  let storeCreate: ReturnType<typeof vi.fn>;

  // ctx is what the host stamps `source` from (anti-impersonation guarantee).
  const ctx = {
    extensionId: 'gemini-antigravity',
    moduleId: 'agent',
    workspacePath: '/ws',
    grantedPermissions: ['nimbalyst-database-write'],
    entryFilePath: '/x/entry.js',
    extensionPath: '/x',
  } as const;

  // managed.args is what the gate reads (extensionId/module.id/workspacePath).
  // Kept consistent with ctx so the granted-case source matches the gate target.
  function makeManaged(send: (m: unknown) => void) {
    return {
      args: {
        extensionId: 'gemini-antigravity',
        extensionName: 'Gemini Antigravity',
        extensionPath: '/x',
        module: { id: 'agent' },
        workspacePath: '/ws',
      },
      state: { status: 'running', startedAt: 0, methods: [] },
      grantedPermissions: ['nimbalyst-database-write'],
      runtime: { send, kill: async () => {}, isAlive: () => true },
      pending: new Map(),
      nextRpcId: 1,
    } as unknown as Parameters<
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >[0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    storeCreate = vi.fn(async () => {});
    // Real DI seam -- no module mock of the repository. The host imports it as
    // a value and calls .create() on whatever store we inject.
    AgentMessagesRepository.setStore({
      create: storeCreate,
      list: async () => [],
    } as never);
    host = new PrivilegedExtensionHost();
  });

  afterEach(() => {
    AgentMessagesRepository.clearStore();
  });

  it('granted logRaw broker request writes to AgentMessagesRepository.create exactly once with sessionId + host-stamped source', async () => {
    grantMock.mockReturnValue(true);
    const sent: Array<Record<string, unknown>> = [];
    const managed = makeManaged((m) => sent.push(m as Record<string, unknown>));

    const payload = {
      direction: 'outbound',
      sessionId: 'sess-123',
      content: 'hello world',
      metadata: { foo: 1 },
    };

    // Drive the FULL real broker path: gate -> tracker -> dispatch -> create -> reply.
    await (host as unknown as {
      handleBrokerRequest: (
        m: unknown, c: unknown, r: string, method: string, p: unknown, l: string,
      ) => Promise<void>;
    }).handleBrokerRequest(managed, ctx, 'req-1', 'logRaw', payload, 'test');

    // The write happened exactly once with the expected shape.
    expect(storeCreate).toHaveBeenCalledTimes(1);
    const arg = storeCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.sessionId).toBe('sess-123');
    // source is HOST-stamped `${ctx.extensionId}/${ctx.moduleId}`, not extension-supplied.
    expect(arg.source).toBe('gemini-antigravity/agent');
    expect(arg.direction).toBe('output'); // wire 'outbound' -> stored 'output'
    expect(arg.content).toBe('hello world');
    expect(arg.metadata).toEqual({ foo: 1 });
    expect(arg.hidden).toBe(false);
    expect(arg.searchable).toBe(true);
    expect(arg.createdAt).toBeInstanceOf(Date);

    // The gate queried the HOST-authoritative permission for logRaw.
    expect(grantMock).toHaveBeenCalledWith(
      'gemini-antigravity',
      'agent',
      'nimbalyst-database-write',
      '/ws',
    );

    // The host replied with the { id: 0 } sentinel broker-response.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'broker-response',
      requestId: 'req-1',
      result: { id: 0 },
    });
  });

  it('maps inbound wire direction to stored input direction', async () => {
    grantMock.mockReturnValue(true);
    const managed = makeManaged(() => {});
    const payload = {
      direction: 'inbound',
      sessionId: 'sess-in',
      content: 'user said hi',
    };

    await (host as unknown as {
      handleBrokerRequest: (
        m: unknown, c: unknown, r: string, method: string, p: unknown, l: string,
      ) => Promise<void>;
    }).handleBrokerRequest(managed, ctx, 'req-in', 'logRaw', payload, 'test');

    expect(storeCreate).toHaveBeenCalledTimes(1);
    const arg = storeCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.direction).toBe('input'); // wire 'inbound' -> stored 'input'
    expect(arg.sessionId).toBe('sess-in');
  });

  it('rejects a broker method whose required permission is not granted, before any DB write (defense-in-depth gate)', async () => {
    // Gate denies. This drives the real assertPermission throw of a real
    // CapabilityDeniedError and the real catch/serialize/reply in the host.
    grantMock.mockReturnValue(false);
    const sent: Array<Record<string, unknown>> = [];
    const managed = makeManaged((m) => sent.push(m as Record<string, unknown>));

    const payload = {
      direction: 'outbound',
      sessionId: 'sess-deny',
      content: 'should never persist',
    };

    await (host as unknown as {
      handleBrokerRequest: (
        m: unknown, c: unknown, r: string, method: string, p: unknown, l: string,
      ) => Promise<void>;
    }).handleBrokerRequest(managed, ctx, 'req-2', 'logRaw', payload, 'test');

    // Dispatch never ran -> no write reached the store.
    expect(storeCreate).not.toHaveBeenCalled();

    // The host surfaced a broker-error carrying the CapabilityDeniedError,
    // NOT a broker-response.
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('broker-error');
    expect(sent[0].requestId).toBe('req-2');
    const error = sent[0].error as { name?: string; message?: string };
    expect(error.name).toBe('CapabilityDeniedError');
    expect(error.message).toContain('permission-not-granted');
    expect(error.message).toContain('nimbalyst-database-write');
  });

  it('routes a broker-request message through handleBackendMessage switch-case to the same logRaw write', async () => {
    // Closes the routing gap: the other tests enter at handleBrokerRequest
    // directly. This one drives the real message dispatcher
    // handleBackendMessage -> case 'broker-request' -> handleBrokerRequest, so
    // a missing case clause or a kind mismatch in the switch would fail here.
    // The broker handling is fired as a detached promise inside the sync
    // dispatcher, so we vi.waitFor the write to land.
    grantMock.mockReturnValue(true);
    const sent: Array<Record<string, unknown>> = [];
    const managed = makeManaged((m) => sent.push(m as Record<string, unknown>));

    const msg = {
      kind: 'broker-request',
      requestId: 'req-route',
      method: 'logRaw',
      payload: {
        direction: 'outbound',
        sessionId: 'sess-route',
        content: 'routed via switch-case',
      },
    };

    (host as unknown as {
      handleBackendMessage: (m: unknown, msg: unknown, c: unknown) => void;
    }).handleBackendMessage(managed, msg, ctx);

    // Dispatch is detached; wait for the real create() to land.
    await vi.waitFor(() => expect(storeCreate).toHaveBeenCalledTimes(1));
    const arg = storeCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.sessionId).toBe('sess-route');
    expect(arg.source).toBe('gemini-antigravity/agent');
    expect(arg.direction).toBe('output');

    // The broker-response reply was sent back over the runtime channel.
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      kind: 'broker-response',
      requestId: 'req-route',
      result: { id: 0 },
    });
  });
});
