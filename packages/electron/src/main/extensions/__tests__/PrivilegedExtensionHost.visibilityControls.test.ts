import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const noop = () => {};
  return {
    app: {
      on: vi.fn(), once: vi.fn(), whenReady: vi.fn(() => Promise.resolve()),
      getPath: vi.fn(() => '/mock/path'), getName: vi.fn(() => 'test-app'),
      getVersion: vi.fn(() => '1.0.0'), setName: vi.fn(), setPath: vi.fn(),
      quit: vi.fn(), requestSingleInstanceLock: vi.fn(() => true),
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

vi.mock('electron-log', () => ({
  default: {
    scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    transports: { file: {}, console: {} },
  },
}));
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../../utils/store', () => ({
  getProviderApiKeyFromSettings: vi.fn(),
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: vi.fn() },
}));

vi.mock('../extensionCapabilityPolicy', () => ({
  canModuleStart: vi.fn(async () => ({ ok: true })),
  assertPermission: vi.fn(),
  CapabilityDeniedError: class CapabilityDeniedError extends Error {},
}));
vi.mock('../permissionGrantStore', () => ({
  diffDeclaredAgainstGrants: vi.fn(() => ({ added: [], removed: [] })),
  shrinkGrantsToDeclared: vi.fn(),
  listEffectiveGrants: vi.fn(() => []),
  clearAllGrantsForExtension: vi.fn(),
  grantModulePermissions: vi.fn(),
}));
vi.mock('../permissionPrompt', () => ({
  raisePermissionPrompt: vi.fn(),
  generatePermissionPromptId: vi.fn(() => 'prompt'),
}));
vi.mock('../permissionUsageTracker', () => ({
  getPermissionUsageTracker: () => ({ record: vi.fn() }),
}));

vi.mock('../../mcp/metaAgentServer', () => ({
  dispatchExtensionMetaAgentTool: vi.fn(async () => JSON.stringify({ ok: true })),
}));

import { PrivilegedExtensionHost } from '../PrivilegedExtensionHost';
import { dispatchExtensionMetaAgentTool } from '../../mcp/metaAgentServer';

function managed(send: (message: unknown) => void) {
  return {
    args: {
      extensionId: 'com.nimbalyst.agent',
      extensionName: 'Agent',
      extensionPath: '/extension',
      module: { id: 'agent-backend' },
      workspacePath: '/repo-worktrees/repair',
    },
    state: { status: 'running', startedAt: 0, methods: ['sendMessage'] },
    grantedPermissions: ['nimbalyst-database-write'],
    runtime: { send, kill: async () => {}, isAlive: () => true },
    pending: new Map(),
    nextRpcId: 1,
    loggingPrincipalPolicy: 'ordinary-session-id',
  };
}

const runtimeContext = {
  extensionId: 'com.nimbalyst.agent',
  moduleId: 'agent-backend',
  workspacePath: '/repo-worktrees/repair',
  grantedPermissions: ['nimbalyst-database-write'],
  entryFilePath: '/extension/backend.js',
  extensionPath: '/extension',
};

async function prepareTurn(
  host: PrivilegedExtensionHost,
  runtime: ReturnType<typeof managed>,
  sent: any[],
  actorSessionId: string,
): Promise<{ capability: string; streamId: string; cancel: () => void }> {
  host.bindNextExtensionAgentTurnAuthority({
    extensionId: 'com.nimbalyst.agent',
    moduleId: 'agent-backend',
    runtimeWorkspacePath: '/repo-worktrees/repair',
    actorSessionId,
    canonicalWorkspacePath: '/repo',
  });
  const create = host.request({
    extensionId: 'com.nimbalyst.agent',
    moduleId: 'agent-backend',
    workspacePath: '/repo-worktrees/repair',
    method: 'createSession',
    params: { sessionId: actorSessionId, workspacePath: '/repo-worktrees/repair' },
    requiredPermission: null,
  });
  const createRequest = sent.at(-1);
  const capability = createRequest.params.sessionId;
  (host as any).handleBackendMessage(runtime, {
    kind: 'rpc-result', id: createRequest.id, result: undefined,
  }, runtimeContext);
  await create;
  const stream = host.stream({
    extensionId: 'com.nimbalyst.agent',
    moduleId: 'agent-backend',
    workspacePath: '/repo-worktrees/repair',
    method: 'sendMessage',
    params: { sessionId: actorSessionId },
    requiredPermission: null,
  });
  expect(sent.at(-1)).toMatchObject({
    kind: 'rpc-request',
    id: stream.id,
    params: { sessionId: capability },
  });
  return { capability, streamId: stream.id, cancel: stream.cancel };
}

describe('PrivilegedExtensionHost visibility controls', () => {
  beforeEach(() => vi.clearAllMocks());

  it('executes only with the exact host-created live turn capability', async () => {
    const host = new PrivilegedExtensionHost();
    const sent: unknown[] = [];
    const runtime = managed((message) => sent.push(message));
    (host as any).modules.set(
      'com.nimbalyst.agent::agent-backend::/repo-worktrees/repair',
      runtime,
    );
    const { capability } = await prepareTurn(host, runtime, sent, 'host-session');
    expect(capability).not.toBe('host-session');

    await (host as any).handleBrokerRequest(
      runtime,
      runtimeContext,
      'broker-1',
      'toolExecutor',
      {
        name: 'session_set_pinned',
        sessionId: capability,
        workspacePath: '/backend-spoofed-workspace',
        args: { sessionId: 'target', pinned: true },
      },
      'test',
    );

    expect(dispatchExtensionMetaAgentTool).toHaveBeenCalledWith(
      'session_set_pinned',
      { sessionId: 'target', pinned: true },
      { actorSessionId: 'host-session', workspacePath: '/repo' },
    );
    expect(sent).toContainEqual(expect.objectContaining({
      kind: 'broker-response',
      requestId: 'broker-1',
    }));
  });

  it('rejects a delayed capability from turn A after A ends while turn B is live', async () => {
    const host = new PrivilegedExtensionHost();
    const sent: any[] = [];
    const runtime = managed((message) => sent.push(message));
    (host as any).modules.set(
      'com.nimbalyst.agent::agent-backend::/repo-worktrees/repair',
      runtime,
    );
    const turnA = await prepareTurn(host, runtime, sent, 'actor-a');
    (host as any).handleBackendMessage(runtime, {
      kind: 'rpc-stream-end', id: turnA.streamId,
    }, runtimeContext);
    const turnB = await prepareTurn(host, runtime, sent, 'actor-b');

    await (host as any).handleBrokerRequest(
      runtime,
      runtimeContext,
      'broker-stale-a',
      'toolExecutor',
      {
        sessionId: turnA.capability,
        name: 'session_set_pinned',
        args: { sessionId: 'target', pinned: true },
      },
      'test',
    );

    expect(dispatchExtensionMetaAgentTool).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({
      kind: 'broker-error',
      requestId: 'broker-stale-a',
    }));

    await (host as any).handleBrokerRequest(
      runtime,
      runtimeContext,
      'broker-live-b',
      'toolExecutor',
      {
        sessionId: turnB.capability,
        name: 'session_set_pinned',
        args: { sessionId: 'target', pinned: true },
      },
      'test',
    );
    expect(dispatchExtensionMetaAgentTool).toHaveBeenCalledWith(
      'session_set_pinned',
      { sessionId: 'target', pinned: true },
      { actorSessionId: 'actor-b', workspacePath: '/repo' },
    );
  });

  it('rejects delayed and backend-selected log principals after end or cancel', async () => {
    const host = new PrivilegedExtensionHost();
    const sent: any[] = [];
    const runtime = managed((message) => sent.push(message));
    (host as any).modules.set(
      'com.nimbalyst.agent::agent-backend::/repo-worktrees/repair',
      runtime,
    );
    const ended = await prepareTurn(host, runtime, sent, 'host-log-actor');
    (host as any).handleBackendMessage(runtime, {
      kind: 'rpc-stream-end', id: ended.streamId,
    }, runtimeContext);

    await (host as any).handleBrokerRequest(runtime, runtimeContext, 'delayed-log', 'logRaw', {
      sessionId: ended.capability,
      direction: 'outbound',
      content: 'must not be attributed after end',
    }, 'test');
    await (host as any).handleBrokerRequest(runtime, runtimeContext, 'forged-log', 'logRaw', {
      sessionId: 'backend-selected-victim',
      direction: 'outbound',
      content: 'must not impersonate a session',
    }, 'test');

    const cancelled = await prepareTurn(host, runtime, sent, 'cancelled-log-actor');
    cancelled.cancel();
    await (host as any).handleBrokerRequest(runtime, runtimeContext, 'cancelled-log', 'logRaw', {
      sessionId: cancelled.capability,
      direction: 'outbound',
      content: 'must not be attributed after cancel',
    }, 'test');

    const { AgentMessagesRepository } = await import(
      '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository'
    );
    expect(AgentMessagesRepository.create).not.toHaveBeenCalled();
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'broker-error', requestId: 'delayed-log' }),
      expect.objectContaining({ kind: 'broker-error', requestId: 'forged-log' }),
      expect.objectContaining({ kind: 'broker-error', requestId: 'cancelled-log' }),
    ]));
  });

  it('keeps ordinary-module logging usable but deliberately makes an agent module capability-only', async () => {
    const { AgentMessagesRepository } = await import(
      '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository'
    );
    const host = new PrivilegedExtensionHost();
    const ordinarySent: any[] = [];
    const ordinary = managed((message) => ordinarySent.push(message));

    await (host as any).handleBrokerRequest(ordinary, runtimeContext, 'ordinary-log', 'logRaw', {
      sessionId: 'ordinary-host-session',
      direction: 'outbound',
      content: 'ordinary module event',
    }, 'test');
    expect(AgentMessagesRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ordinary-host-session',
    }));

    vi.mocked(AgentMessagesRepository.create).mockClear();
    const agentSent: any[] = [];
    const agent = managed((message) => agentSent.push(message));
    (host as any).modules.set(
      'com.nimbalyst.agent::agent-backend::/repo-worktrees/repair',
      agent,
    );
    const live = await prepareTurn(host, agent, agentSent, 'host-log-actor');
    await (host as any).handleBrokerRequest(agent, runtimeContext, 'live-log', 'logRaw', {
      sessionId: live.capability,
      direction: 'outbound',
      content: 'live agent event',
    }, 'test');
    expect(AgentMessagesRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'host-log-actor',
    }));

    (host as any).handleBackendMessage(agent, {
      kind: 'rpc-stream-end', id: live.streamId,
    }, runtimeContext);
    vi.mocked(AgentMessagesRepository.create).mockClear();
    await (host as any).handleBrokerRequest(agent, runtimeContext, 'post-agent-raw-log', 'logRaw', {
      sessionId: 'ordinary-host-session',
      direction: 'outbound',
      content: 'must stay fail closed for this agent module lifetime',
    }, 'test');
    expect(AgentMessagesRepository.create).not.toHaveBeenCalled();
    expect(agentSent).toContainEqual(expect.objectContaining({
      kind: 'broker-error', requestId: 'post-agent-raw-log',
    }));
  });
});
