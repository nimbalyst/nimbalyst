// @vitest-environment node
/**
 * Granting workspace trust must retry backend modules parked in
 * `awaiting-trust` (#1767). Without the retry their tools stay unavailable
 * until the workspace is reopened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
const retryBackendModulesAwaitingTrust = vi.fn(async () => {});
const getPermissionMode = vi.fn();

vi.mock('electron', () => ({
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { applyPermissionChange: async () => {} },
}));
vi.mock('../../services/PermissionService', () => ({
  getPermissionService: () => ({
    trustWorkspace: vi.fn(),
    setPermissionMode: vi.fn(),
    getPermissionMode,
  }),
  resolveWorkspacePathForPermissions: async (p: string) => p,
}));
vi.mock('../../services/ClaudeSettingsManager', () => ({ ClaudeSettingsManager: {} }));
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } },
}));
vi.mock('../../extensions/backendModuleLifecycle', () => ({
  getDefaultBackendModuleLifecycleDeps: () => ({}),
  retryBackendModulesAwaitingTrust: (...args: unknown[]) => retryBackendModulesAwaitingTrust(...(args as [])),
}));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(channel, handler),
  safeOn: vi.fn(),
}));
vi.mock('../../utils/workspaceDetection', () => ({
  resolveProjectPath: (p: string) => p,
  isWorktreePath: () => false,
}));
vi.mock('../../utils/dialogPaths', () => ({
  getDialogDefaultPath: vi.fn(),
  rememberDialogSelection: vi.fn(),
}));

import { registerPermissionHandlers } from '../PermissionHandlers';

describe('PermissionHandlers trust retries backend modules', () => {
  beforeEach(() => {
    handlers.clear();
    retryBackendModulesAwaitingTrust.mockClear();
    registerPermissionHandlers();
  });

  it('permissions:trustWorkspace retries modules awaiting trust', async () => {
    await handlers.get('permissions:trustWorkspace')!({}, '/ws/a');
    expect(retryBackendModulesAwaitingTrust).toHaveBeenCalledTimes(1);
  });

  it('permissions:setPermissionMode retries only when the workspace ends up trusted', async () => {
    getPermissionMode.mockReturnValueOnce(null);
    await handlers.get('permissions:setPermissionMode')!({}, '/ws/a', 'ask');
    expect(retryBackendModulesAwaitingTrust).not.toHaveBeenCalled();

    getPermissionMode.mockReturnValueOnce('bypass-all');
    await handlers.get('permissions:setPermissionMode')!({}, '/ws/a', 'bypass-all');
    expect(retryBackendModulesAwaitingTrust).toHaveBeenCalledTimes(1);
  });
});
