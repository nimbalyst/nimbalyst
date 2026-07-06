/**
 * Built-in extensions must never raise the first-use consent prompt.
 *
 * Built-ins ship inside the app bundle and pass the backend-module allowlist
 * unconditionally -- they are the same trust domain as the app itself, so a
 * "this extension will run native code" prompt is warning the user about
 * code they already installed. runStartAttempt auto-grants globally for
 * built-in extension paths and skips the prompt; marketplace / sideloaded
 * extensions still go through the full consent flow.
 *
 * Run from repo root:
 *   npx vitest --run packages/electron/src/main/extensions/__tests__/PrivilegedExtensionHost.builtinAutoGrant.test.ts
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

vi.mock('../builtinExtensionsDirectory', () => ({
  getBuiltinExtensionsDirectory: vi.fn(async () => '/builtin'),
  isBuiltinExtensionPath: vi.fn(async (p: string) => p.startsWith('/builtin/')),
}));

vi.mock('../extensionCapabilityPolicy', () => ({
  canModuleStart: vi.fn(async () => ({ ok: true })),
  assertPermission: vi.fn(),
  CapabilityDeniedError: class CapabilityDeniedError extends Error {},
}));

vi.mock('../permissionPrompt', () => ({
  raisePermissionPrompt: vi.fn(async () => ({ decision: 'not-now' })),
  generatePermissionPromptId: vi.fn(() => 'prompt-1'),
}));

// In-memory grant store mirroring the real semantics the host relies on:
// zero-permission grants persist a sentinel row, and the diff reports a scope
// entry only when rows exist for the module.
vi.mock('../permissionGrantStore', () => {
  const SENTINEL = 'module:enabled';
  const rows: Array<{ extensionId: string; moduleId: string; permissionId: string; scope: string }> = [];
  return {
    __rows: rows,
    grantModulePermissions: vi.fn((req: { extensionId: string; moduleId: string; permissions: string[]; scope: string }) => {
      const ids = req.permissions.length === 0 ? [SENTINEL] : req.permissions;
      for (const permissionId of ids) {
        rows.push({ extensionId: req.extensionId, moduleId: req.moduleId, permissionId, scope: req.scope });
      }
      return [];
    }),
    diffDeclaredAgainstGrants: vi.fn((args: { extensionId: string; moduleId: string; declaredPermissions: string[] }) => {
      const mine = rows.filter((r) => r.extensionId === args.extensionId && r.moduleId === args.moduleId);
      if (mine.length === 0) return {};
      const granted = new Set(mine.map((r) => r.permissionId));
      return { global: { added: args.declaredPermissions.filter((p) => !granted.has(p)), removed: [] } };
    }),
    shrinkGrantsToDeclared: vi.fn(),
    listEffectiveGrants: vi.fn(() => rows.slice()),
    clearAllGrantsForExtension: vi.fn(),
  };
});

import { PrivilegedExtensionHost, type StartModuleArgs } from '../PrivilegedExtensionHost';
import { raisePermissionPrompt } from '../permissionPrompt';
import { grantModulePermissions } from '../permissionGrantStore';
import * as grantStore from '../permissionGrantStore';

function makeArgs(extensionPath: string): StartModuleArgs {
  return {
    extensionId: 'com.nimbalyst.github-issues-importer',
    extensionName: 'GitHub Issues Importer',
    extensionPath,
    module: {
      id: 'github-issues-backend',
      entry: 'dist/backend.js',
      runtime: 'utility-process',
      permissions: [],
      enablement: { default: 'disabled', promptOn: 'firstUse', purpose: 'test' },
    } as never,
    workspacePath: '/ws',
  };
}

function stubSpawn(host: PrivilegedExtensionHost): void {
  const h = host as unknown as {
    spawnRuntime: (managed: { state: unknown }) => Promise<void>;
    waitForRunning: () => Promise<void>;
  };
  h.spawnRuntime = vi.fn(async (managed) => {
    managed.state = { status: 'running', startedAt: Date.now(), methods: [] };
  });
  h.waitForRunning = vi.fn(async () => {});
}

describe('PrivilegedExtensionHost built-in auto-grant', () => {
  let host: PrivilegedExtensionHost;

  beforeEach(() => {
    vi.clearAllMocks();
    (grantStore as unknown as { __rows: unknown[] }).__rows.length = 0;
    host = new PrivilegedExtensionHost();
    stubSpawn(host);
  });

  it('starts a built-in module without raising the consent prompt', async () => {
    const handle = await host.startModule(makeArgs('/builtin/github-issues-importer'));

    expect(raisePermissionPrompt).not.toHaveBeenCalled();
    expect(grantModulePermissions).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: 'com.nimbalyst.github-issues-importer',
        moduleId: 'github-issues-backend',
        scope: 'global',
      })
    );
    expect(handle.state.status).toBe('running');
  });

  it('still raises the consent prompt for non-built-in extensions', async () => {
    const handle = await host.startModule(makeArgs('/user-extensions/some-marketplace-ext'));

    expect(raisePermissionPrompt).toHaveBeenCalledTimes(1);
    // Our mock resolves 'not-now', so the module must be denied, not started.
    expect(handle.state.status).toBe('denied');
  });
});
