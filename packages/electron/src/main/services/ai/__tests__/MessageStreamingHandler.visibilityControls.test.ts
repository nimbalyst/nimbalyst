import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    on: vi.fn(), once: vi.fn(), whenReady: vi.fn(async () => undefined),
    getPath: vi.fn(() => 'C:\\user-data'), getName: vi.fn(() => 'test'),
    getVersion: vi.fn(() => '1.0.0'), isPackaged: false,
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows = vi.fn(() => []);
    static getFocusedWindow = vi.fn(() => null);
    static fromWebContents = vi.fn(() => null);
  },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
  shell: { openExternal: vi.fn() },
  utilityProcess: { fork: vi.fn() },
}));
vi.mock('electron-log/main', () => ({
  default: {
    initialize: vi.fn(), scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    transports: { file: {}, console: {} },
  },
}));
vi.mock('electron-store', () => ({
  default: class ElectronStore {
    get = vi.fn((_key: string, fallback: unknown) => fallback);
    set = vi.fn();
  },
}));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../../../utils/store', () => ({
  getProviderApiKeyFromSettings: vi.fn(), shouldShowCommunityPopup: vi.fn(() => false),
  markCommunityPopupShown: vi.fn(), wasCommunityPopupShownThisLaunch: vi.fn(() => false),
  incrementCompletedSessionsWithTools: vi.fn(), getDefaultEffortLevel: vi.fn(),
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: vi.fn(async () => undefined) },
}));
vi.mock('../../../extensions/extensionCapabilityPolicy', () => ({
  canModuleStart: vi.fn(async () => ({ ok: true })), assertPermission: vi.fn(),
  CapabilityDeniedError: class CapabilityDeniedError extends Error {},
}));
vi.mock('../../../extensions/permissionGrantStore', () => ({
  diffDeclaredAgainstGrants: vi.fn(() => ({ added: [], removed: [] })),
  shrinkGrantsToDeclared: vi.fn(), listEffectiveGrants: vi.fn(() => []),
  clearAllGrantsForExtension: vi.fn(), grantModulePermissions: vi.fn(),
}));
vi.mock('../../../extensions/permissionPrompt', () => ({
  raisePermissionPrompt: vi.fn(), generatePermissionPromptId: vi.fn(() => 'prompt'),
}));
vi.mock('../../../extensions/permissionUsageTracker', () => ({
  getPermissionUsageTracker: () => ({ record: vi.fn(), clearExtension: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(async () => JSON.stringify({ ok: true })),
  revokeMcpAuthority: vi.fn(async () => undefined),
}));
vi.mock('../../../mcp/metaAgentServer', () => ({
  dispatchExtensionMetaAgentTool: mocks.dispatch,
  getMetaAgentOpenAITools: vi.fn(() => []),
}));
vi.mock('../../../mcp/httpServer', () => ({
  revokeHostBoundMcpAuthority: mocks.revokeMcpAuthority,
  updateDocumentState: vi.fn(),
  registerWorkspaceWindow: vi.fn(),
}));

import { ExtensionAgentProvider } from '@nimbalyst/runtime/ai/server/providers/ExtensionAgentProvider';
import {
  installExtensionAgentBridge,
  uninstallExtensionAgentBridge,
} from '../../../extensions/extensionAgentBridge';
import { getAgentProviderRegistry } from '../../../extensions/AgentProviderRegistry';
import { getPrivilegedExtensionHost } from '../../../extensions/PrivilegedExtensionHost';
import {
  beginHostBoundExtensionAgentTurn,
  endHostBoundAiSession,
} from '../MessageStreamingHandler';

describe('MessageStreamingHandler extension visibility authority flow', () => {
  afterEach(async () => {
    uninstallExtensionAgentBridge();
    getAgentProviderRegistry().__resetForTests();
    await getPrivilegedExtensionHost().dispose();
    vi.clearAllMocks();
  });

  it('revokes host MCP authority only after the real terminal transition commits', async () => {
    const order: string[] = [];
    const stateManager = {
      endSession: vi.fn(async () => { order.push('ended'); }),
      getSessionState: vi.fn(() => ({ attentionGeneration: '7' })),
    };
    mocks.revokeMcpAuthority.mockImplementationOnce(async () => { order.push('revoked'); });

    await endHostBoundAiSession(stateManager as any, 'actor-session', {
      attentionGeneration: '7',
    });

    expect(stateManager.endSession).toHaveBeenCalledWith('actor-session', {
      attentionGeneration: '7',
    });
    expect(mocks.revokeMcpAuthority).toHaveBeenCalledWith('actor-session');
    expect(order).toEqual(['revoked', 'ended']);
  });

  it('carries an exact live capability through provider, bridge, host, and broker', async () => {
    const registry = getAgentProviderRegistry();
    registry.register({
      extensionId: 'com.nimbalyst.agent',
      contributionId: 'extension-agent',
      backendModuleId: 'agent-backend',
      extensionPath: 'C:\\extension',
      status: 'active',
      contribution: { id: 'extension-agent', backendModuleId: 'agent-backend', name: 'Agent' },
      manifest: {
        id: 'com.nimbalyst.agent', name: 'Agent', version: '1.0.0',
        contributions: { backendModules: [{ id: 'agent-backend', entry: 'backend.js' }] },
      },
    } as any);

    const host = getPrivilegedExtensionHost();
    const sent: any[] = [];
    let turnCapability = '';
    const runtime: any = {
      args: {
        extensionId: 'com.nimbalyst.agent', extensionName: 'Agent',
        extensionPath: 'C:\\extension', module: { id: 'agent-backend' },
        workspacePath: 'C:\\repo-worktrees\\repair',
      },
      state: { status: 'running', startedAt: 0, methods: ['createSession', 'sendMessage'] },
      grantedPermissions: ['nimbalyst-database-write'],
      pending: new Map(), nextRpcId: 1,
      runtime: {
        isAlive: () => true, kill: async () => undefined,
        send: (message: any) => {
          sent.push(message);
          queueMicrotask(() => {
            if (message.kind === 'rpc-request' && message.method === 'createSession') {
              turnCapability = message.params.sessionId;
              (host as any).handleBackendMessage(runtime, {
                kind: 'rpc-result', id: message.id, result: undefined,
              }, runtimeContext);
            } else if (message.kind === 'rpc-request' && message.method === 'sendMessage') {
              expect(message.params.sessionId).toBe(turnCapability);
              (host as any).handleBackendMessage(runtime, {
                kind: 'broker-request', requestId: 'tool-live', method: 'toolExecutor',
                payload: {
                  sessionId: turnCapability, workspacePath: 'C:\\spoofed',
                  name: 'session_set_pinned', args: { sessionId: 'target', pinned: true },
                },
              }, runtimeContext);
            } else if (message.kind === 'broker-response' && message.requestId === 'tool-live') {
              const stream = [...runtime.pending.entries()].find(([, value]: any) => value.streaming);
              if (stream) (host as any).handleBackendMessage(runtime, {
                kind: 'rpc-stream-end', id: stream[0],
              }, runtimeContext);
            }
          });
        },
      },
    };
    const runtimeContext = {
      extensionId: 'com.nimbalyst.agent', moduleId: 'agent-backend',
      workspacePath: 'C:\\repo-worktrees\\repair',
      grantedPermissions: ['nimbalyst-database-write'], entryFilePath: 'C:\\extension\\backend.js',
      extensionPath: 'C:\\extension',
    };
    (host as any).modules.set(
      'com.nimbalyst.agent::agent-backend::C:\\repo-worktrees\\repair',
      runtime,
    );
    installExtensionAgentBridge({
      resolveActiveWorkspacePath: () => 'C:\\repo-worktrees\\repair',
    });
    const provider = new ExtensionAgentProvider({
      extensionId: 'com.nimbalyst.agent', contributionId: 'extension-agent',
      sessionId: 'actor-session', model: 'extension-agent:model',
    });

    const stream = beginHostBoundExtensionAgentTurn({
      extensionId: 'com.nimbalyst.agent', moduleId: 'agent-backend',
      runtimeWorkspacePath: 'C:\\repo-worktrees\\repair',
      actorSessionId: 'actor-session', canonicalWorkspacePath: 'C:\\repo',
      send: () => provider.sendMessage(
        'change visibility', undefined, 'actor-session', [],
        'C:\\repo-worktrees\\repair', undefined, [] as any, 'meta prompt',
      ),
    });
    for await (const _chunk of stream) { /* no chunks required */ }

    expect(turnCapability).toMatch(/^svturn-[0-9a-f]{64}$/);
    expect(turnCapability).not.toBe('actor-session');
    expect(mocks.dispatch).toHaveBeenCalledWith(
      'session_set_pinned',
      { sessionId: 'target', pinned: true },
      { actorSessionId: 'actor-session', workspacePath: 'C:\\repo' },
    );

    (host as any).handleBackendMessage(runtime, {
      kind: 'broker-request', requestId: 'tool-stale', method: 'toolExecutor',
      payload: { sessionId: turnCapability, name: 'session_set_pinned', args: { sessionId: 'target', pinned: false } },
    }, runtimeContext);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toContainEqual(expect.objectContaining({
      kind: 'broker-error', requestId: 'tool-stale',
    }));
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
});
