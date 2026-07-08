/**
 * OBSERVED integration test for the privileged broker `registerMcpTools` path.
 *
 * Drives the REAL PrivilegedExtensionHost.handleBrokerRequest -> REAL
 * assertPermission gate -> REAL dispatchBrokerMethod 'registerMcpTools' branch
 * -> REAL backendToolRegistry. Confirms the fan-out the stub used to skip:
 * registered tools land in the registry keyed by the module's workspace, the
 * gate requires `mcp-server-register`, and a denied grant registers nothing.
 *
 * Run from repo root:
 *   npx vitest --run packages/electron/src/main/extensions/__tests__/PrivilegedExtensionHost.broker.registerMcpTools.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fuller `electron` mock (importing the host transitively loads WindowManager,
// which touches app.on at module load). Mirrors the logRaw broker test.
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

// Control ONLY the grant lookup; assertPermission stays real.
vi.mock('../permissionGrantStore', async (orig) => {
  const actual = await orig<typeof import('../permissionGrantStore')>();
  return { ...actual, isPermissionGranted: vi.fn() };
});

import { PrivilegedExtensionHost } from '../PrivilegedExtensionHost';
import { isPermissionGranted } from '../permissionGrantStore';
import {
  getBackendTools,
  getVoiceEnabledBackendTools,
  _resetBackendToolRegistry,
} from '../../mcp/backendToolRegistry';

const grantMock = isPermissionGranted as unknown as ReturnType<typeof vi.fn>;

const ctx = {
  extensionId: 'com.nimbalyst.memory',
  moduleId: 'memory-engine',
  workspacePath: '/ws',
  grantedPermissions: ['mcp-server-register'],
  entryFilePath: '/x/entry.js',
  extensionPath: '/x',
} as const;

function makeManaged(send: (m: unknown) => void) {
  return {
    args: {
      extensionId: 'com.nimbalyst.memory',
      extensionName: 'Nimbalyst Memory',
      extensionPath: '/x',
      module: { id: 'memory-engine' },
      workspacePath: '/ws',
    },
    state: { status: 'running', startedAt: 0, methods: [] },
    grantedPermissions: ['mcp-server-register'],
    runtime: { send, kill: async () => {}, isAlive: () => true },
    pending: new Map(),
    nextRpcId: 1,
  } as unknown as Parameters<any>[0];
}

function drive(
  host: PrivilegedExtensionHost,
  managed: unknown,
  payload: unknown
): Promise<void> {
  return (host as unknown as {
    handleBrokerRequest: (
      m: unknown, c: unknown, r: string, method: string, p: unknown, l: string,
    ) => Promise<void>;
  }).handleBrokerRequest(managed, ctx, 'req-1', 'registerMcpTools', payload, 'test');
}

describe('PrivilegedExtensionHost broker registerMcpTools', () => {
  let host: PrivilegedExtensionHost;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetBackendToolRegistry();
    host = new PrivilegedExtensionHost();
  });

  afterEach(() => {
    _resetBackendToolRegistry();
  });

  it('granted registerMcpTools fans tools into the registry keyed by the module workspace', async () => {
    grantMock.mockReturnValue(true);
    const sent: Array<Record<string, unknown>> = [];
    const managed = makeManaged((m) => sent.push(m as Record<string, unknown>));

    const payload = {
      tools: [
        {
          name: 'search_project_knowledge',
          description: 'hybrid search',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          voiceAgent: true,
        },
        { name: 'status', description: 'index status' },
      ],
    };

    await drive(host, managed, payload);

    // Tools landed in the registry for the module's workspace, namespaced.
    const tools = getBackendTools('/ws');
    expect(tools.map((t) => t.name).sort()).toEqual([
      'memory.search_project_knowledge',
      'memory.status',
    ]);
    expect(getVoiceEnabledBackendTools('/ws').map((t) => t.method)).toEqual([
      'search_project_knowledge',
    ]);

    // The gate queried the HOST-authoritative permission for this method.
    expect(grantMock).toHaveBeenCalledWith(
      'com.nimbalyst.memory',
      'memory-engine',
      'mcp-server-register',
      '/ws',
    );

    // The host replied with the registered (namespaced) names.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'broker-response',
      requestId: 'req-1',
      result: { registered: ['memory.search_project_knowledge', 'memory.status'] },
    });
  });

  it('denied grant registers nothing and replies broker-error (defense-in-depth gate)', async () => {
    grantMock.mockReturnValue(false);
    const sent: Array<Record<string, unknown>> = [];
    const managed = makeManaged((m) => sent.push(m as Record<string, unknown>));

    await drive(host, managed, { tools: [{ name: 'search' }] });

    expect(getBackendTools('/ws')).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('broker-error');
    const error = sent[0].error as { name?: string; message?: string };
    expect(error.name).toBe('CapabilityDeniedError');
    expect(error.message).toContain('mcp-server-register');
  });
});
