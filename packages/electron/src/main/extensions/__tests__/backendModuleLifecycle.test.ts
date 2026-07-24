/**
 * Unit tests for the backend-module start-on-enable / stop-on-disable lifecycle
 * decision logic. The orchestration is dependency-injected, so these tests drive
 * it with a mocked host + manifest scan and assert WHICH (module, workspace)
 * pairs get started/stopped — no Electron, no real host, no filesystem.
 *
 * Run from repo root:
 *   npx vitest --run packages/electron/src/main/extensions/__tests__/backendModuleLifecycle.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

// The module statically imports the real host/store/scan/registry/logger, which
// transitively pull Electron. Stub them so importing the pure orchestration is
// safe; the tests never use the default deps — they inject their own.
vi.mock('../PrivilegedExtensionHost', () => ({ getPrivilegedExtensionHost: vi.fn() }));
vi.mock('../../ipc/ExtensionHandlers', () => ({
  listExtensionBackendModules: vi.fn(),
  resolveExtensionBackendModules: vi.fn(),
}));
vi.mock('../../utils/store', () => ({ getExtensionEnabled: vi.fn() }));
vi.mock('../../mcp/mcpWorkspaceResolver', () => ({ getRegisteredWorkspacePaths: vi.fn() }));
vi.mock('../../mcp/backendToolRegistry', () => ({ clearBackendToolsForModule: vi.fn() }));
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import {
  startExtensionBackendModules,
  stopExtensionBackendModules,
  startWorkspaceBackendModules,
  syncEnabledBackendModulesOnStartup,
  type BackendModuleLifecycleDeps,
  type ResolvedBackendModules,
} from '../backendModuleLifecycle';
import type { ModuleHandle } from '../PrivilegedExtensionHost';

const EXT = 'com.nimbalyst.memory';
const MOD = 'memory-engine';

function resolved(overrides: Partial<ResolvedBackendModules> = {}): ResolvedBackendModules {
  return {
    extensionId: EXT,
    extensionName: 'Memory',
    extensionPath: '/ext/memory',
    modules: [{ id: MOD, entry: 'dist/backend.js', runtime: 'utility-process' } as any],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<BackendModuleLifecycleDeps> = {}): BackendModuleLifecycleDeps {
  return {
    listBackendModuleExtensions: vi.fn(async () => [resolved()]),
    resolveBackendModules: vi.fn(async () => resolved()),
    isExtensionEnabled: vi.fn(() => true),
    collectWorkspaces: vi.fn(() => ['/ws/a', '/ws/b']),
    startModule: vi.fn(async (args) => ({
      extensionId: args.extensionId,
      moduleId: args.module.id,
      workspacePath: args.workspacePath,
      state: { status: 'running', startedAt: 0, methods: [] },
    }) as ModuleHandle),
    stopModule: vi.fn(async () => {}),
    listModuleHandles: vi.fn(() => []),
    clearBackendToolsForModule: vi.fn(),
    ...overrides,
  };
}

describe('backendModuleLifecycle', () => {
  it('startExtensionBackendModules starts each module in each open workspace when enabled', async () => {
    const deps = makeDeps();
    await startExtensionBackendModules(EXT, deps);

    expect(deps.startModule).toHaveBeenCalledTimes(2);
    const calls = (deps.startModule as any).mock.calls.map((c: any[]) => c[0].workspacePath).sort();
    expect(calls).toEqual(['/ws/a', '/ws/b']);
    expect((deps.startModule as any).mock.calls[0][0]).toMatchObject({
      extensionId: EXT,
      extensionPath: '/ext/memory',
      module: { id: MOD },
    });
  });

  it('startExtensionBackendModules is a no-op when the extension is disabled', async () => {
    const deps = makeDeps({ isExtensionEnabled: vi.fn(() => false) });
    await startExtensionBackendModules(EXT, deps);
    expect(deps.resolveBackendModules).not.toHaveBeenCalled();
    expect(deps.startModule).not.toHaveBeenCalled();
  });

  it('startExtensionBackendModules is a no-op when no backend modules resolve', async () => {
    const deps = makeDeps({ resolveBackendModules: vi.fn(async () => null) });
    await startExtensionBackendModules(EXT, deps);
    expect(deps.startModule).not.toHaveBeenCalled();
  });

  it('startExtensionBackendModules starts nothing when no workspaces are open', async () => {
    const deps = makeDeps({ collectWorkspaces: vi.fn(() => []) });
    await startExtensionBackendModules(EXT, deps);
    expect(deps.startModule).not.toHaveBeenCalled();
  });

  it('stopExtensionBackendModules stops every tracked instance and clears that module\'s tools', async () => {
    const handles: ModuleHandle[] = [
      { extensionId: EXT, moduleId: MOD, workspacePath: '/ws/a', state: { status: 'running', startedAt: 0, methods: [] } },
      { extensionId: EXT, moduleId: MOD, workspacePath: '/ws/b', state: { status: 'running', startedAt: 0, methods: [] } },
      { extensionId: 'other.ext', moduleId: 'm2', workspacePath: '/ws/a', state: { status: 'running', startedAt: 0, methods: [] } },
    ];
    const deps = makeDeps({ listModuleHandles: vi.fn(() => handles) });

    await stopExtensionBackendModules(EXT, deps);

    expect(deps.stopModule).toHaveBeenCalledTimes(2);
    expect(deps.stopModule).toHaveBeenCalledWith(EXT, MOD, '/ws/a');
    expect(deps.stopModule).toHaveBeenCalledWith(EXT, MOD, '/ws/b');
    // Never touches the unrelated extension's module.
    expect(deps.stopModule).not.toHaveBeenCalledWith('other.ext', 'm2', '/ws/a');
    // Tools cleared once per distinct module id.
    expect(deps.clearBackendToolsForModule).toHaveBeenCalledTimes(1);
    expect(deps.clearBackendToolsForModule).toHaveBeenCalledWith(EXT, MOD);
  });

  it('startWorkspaceBackendModules starts only enabled extensions in the one workspace', async () => {
    const enabled = resolved();
    const disabled = resolved({ extensionId: 'disabled.ext', modules: [{ id: 'm', entry: 'd', runtime: 'utility-process' } as any] });
    const deps = makeDeps({
      listBackendModuleExtensions: vi.fn(async () => [enabled, disabled]),
      isExtensionEnabled: vi.fn((id: string) => id === EXT),
    });

    await startWorkspaceBackendModules('/ws/new', deps);

    expect(deps.startModule).toHaveBeenCalledTimes(1);
    expect((deps.startModule as any).mock.calls[0][0]).toMatchObject({
      extensionId: EXT,
      workspacePath: '/ws/new',
    });
  });

  it('syncEnabledBackendModulesOnStartup starts enabled extensions across all open workspaces', async () => {
    const deps = makeDeps({ collectWorkspaces: vi.fn(() => ['/ws/a', '/ws/b']) });
    await syncEnabledBackendModulesOnStartup(deps);
    // one enabled extension x one module x two workspaces
    expect(deps.startModule).toHaveBeenCalledTimes(2);
  });

  it('does NOT eagerly start backend modules that back an agent provider', async () => {
    // Agent-provider backend modules (e.g. gemini-antigravity's antigravity-server)
    // start lazily via the bridge on first use — eagerly starting them here raises
    // the first-use consent prompt before the user has opted into the provider.
    const agentExt = resolved({
      extensionId: 'gemini-antigravity',
      extensionName: 'Gemini',
      modules: [{ id: 'antigravity-server', entry: 'dist/agent.js', runtime: 'utility-process' } as any],
      agentProviderModuleIds: ['antigravity-server'],
    });
    const deps = makeDeps({
      listBackendModuleExtensions: vi.fn(async () => [agentExt]),
      resolveBackendModules: vi.fn(async () => agentExt),
      isExtensionEnabled: vi.fn(() => true),
      collectWorkspaces: vi.fn(() => ['/ws/a', '/ws/b']),
    });

    await syncEnabledBackendModulesOnStartup(deps);
    await startWorkspaceBackendModules('/ws/new', deps);
    await startExtensionBackendModules('gemini-antigravity', deps);

    expect(deps.startModule).not.toHaveBeenCalled();
  });

  it('still starts non-agent-provider modules of an extension that also has agent-provider modules', async () => {
    const mixed = resolved({
      extensionId: 'mixed.ext',
      modules: [
        { id: 'agent-server', entry: 'a', runtime: 'utility-process' } as any,
        { id: 'memory-engine', entry: 'm', runtime: 'utility-process' } as any,
      ],
      agentProviderModuleIds: ['agent-server'],
    });
    const deps = makeDeps({
      listBackendModuleExtensions: vi.fn(async () => [mixed]),
      collectWorkspaces: vi.fn(() => ['/ws/a']),
    });

    await syncEnabledBackendModulesOnStartup(deps);

    expect(deps.startModule).toHaveBeenCalledTimes(1);
    expect((deps.startModule as any).mock.calls[0][0]).toMatchObject({
      extensionId: 'mixed.ext',
      module: { id: 'memory-engine' },
    });
  });
});
