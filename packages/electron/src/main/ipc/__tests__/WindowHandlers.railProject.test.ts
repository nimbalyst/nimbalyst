// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { handlers, windows, windowStates, fakeWindow, openPath } = vi.hoisted(() => {
  const fakeWindow = { isDestroyed: () => false };
  return {
    handlers: new Map<string, (...args: any[]) => any>(),
    windows: new Map<number, unknown>([[1, fakeWindow]]),
    windowStates: new Map<number, Record<string, any>>(),
    fakeWindow,
    openPath: vi.fn(async () => ''),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => fakeWindow },
  app: { on: vi.fn() },
  powerMonitor: { on: vi.fn() },
  nativeImage: {},
}));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (name: string, fn: any) => handlers.set(name, fn),
  safeOn: (name: string, fn: any) => handlers.set(name, fn),
}));
vi.mock('../../window/WindowManager', () => ({ windows, windowStates, getWindowId: () => 1 }));
vi.mock('../../window/windowState', async () => {
  const actual = await vi.importActual<typeof import('../../window/windowState')>('../../window/windowState');
  return { ...actual, windows, windowStates };
});
vi.mock('../../utils/store', () => ({ getAttachedFolders: () => [] }));
vi.mock('../../utils/systemShell', () => ({ systemShell: { openPath } }));
vi.mock('../../services/SyncManager', () => ({
  reportDesktopActivity: vi.fn(),
  setWindowFocused: vi.fn(),
  setScreenLocked: vi.fn(),
  setIdleThresholdMs: vi.fn(),
  attemptReconnect: vi.fn(async () => {}),
}));
vi.mock('../../services/NetworkAvailability', () => ({
  startNetworkAvailability: vi.fn(),
  onNetworkAvailable: vi.fn(),
  notifyNetworkAvailable: vi.fn(),
}));
vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
vi.mock('../../services/analytics/dailyActiveHeartbeat', () => ({ hasFocusedWindow: vi.fn() }));
vi.mock('../../utils/appPaths', () => ({ getPackageRoot: () => '/pkg' }));
vi.mock('../../services/attachments/attachmentStagingRoot', () => ({
  resolveWorkspaceAttachmentStagingDirectory: (workspacePath: string) => join(workspacePath, 'staging'),
}));
vi.mock('../../services/consoleLinks/consoleLinkHandlers', () => ({
  registerConsoleLinkHandlers: vi.fn(),
  routeConsoleLink: vi.fn(),
}));

import { registerWindowHandlers } from '../WindowHandlers';

describe('window handlers in a project-rail window', () => {
  let projectA: string;
  let projectB: string;

  beforeEach(() => {
    projectA = mkdtempSync(join(tmpdir(), 'nim-rail-a-'));
    projectB = mkdtempSync(join(tmpdir(), 'nim-rail-b-'));
    // Opened on A, user switched the rail to B.
    windowStates.set(1, {
      mode: 'workspace',
      workspacePath: projectA,
      additionalWorkspacePaths: [projectB],
      activeWorkspacePath: projectB,
    });
    handlers.clear();
    openPath.mockClear();
    registerWindowHandlers();
  });

  afterEach(() => {
    windowStates.clear();
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  it('workspace:get-current reports the project on screen, not the first rail project', () => {
    const current = handlers.get('workspace:get-current')!({ sender: {} });
    expect(current).toEqual({ path: projectB, name: projectB.split('/').pop() });
  });

  it('stages a pasted image under the project on screen', async () => {
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const result = await handlers.get('image:open-in-default-app')!({ sender: {} }, `data:image/png;base64,${pixel}`);

    expect(result).toEqual({ success: true });
    const tempPath = (openPath.mock.calls[0] as unknown as [string])[0];
    expect(dirname(tempPath)).toBe(join(projectB, 'staging', 'images'));
    expect(existsSync(tempPath)).toBe(true);
  });
});
