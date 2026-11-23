// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  match: vi.fn(),
  createWindow: vi.fn(),
  windowStates: new Map<number, any>(),
  existing: { isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(),
    focus: vi.fn(), webContents: { isDestroyed: () => false, send: vi.fn() } },
  managerWindows: [] as any[],
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeBrowserWindow extends EventEmitter {
    id = mocks.managerWindows.length + 100;
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { executeJavaScript: vi.fn().mockResolvedValue(true) });
    loadFile = vi.fn().mockResolvedValue(undefined);
    loadURL = vi.fn().mockResolvedValue(undefined);
    isDestroyed = () => this.destroyed;
    isMinimized = () => false;
    show = vi.fn(); showInactive = vi.fn(); focus = vi.fn(); restore = vi.fn();
    constructor() { super(); mocks.managerWindows.push(this); }
    // Probed on Electron 45 (Linux): close() emits 'closed' after it returns,
    // destroy() emits it before it returns.
    close() { setImmediate(() => this.destroy()); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  return { BrowserWindow: FakeBrowserWindow, dialog: {},
    app: Object.assign(new EventEmitter(), { isReady: () => true, quit: vi.fn(), isPackaged: false, getAppPath: () => '/app' }) };
});
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn() } } }));
vi.mock('fs/promises', () => ({ readdir: vi.fn().mockResolvedValue([]) }));
vi.mock('../../utils/appPaths', () => ({ getPreloadPath: vi.fn() }));
vi.mock('../unresponsiveHandler', () => ({ createUnresponsiveHandler: () => () => {} }));
vi.mock('../../utils/FileTree', () => ({ resolveEntryType: vi.fn() }));
vi.mock('../../utils/fileFilters', () => ({ shouldExcludeDir: vi.fn(), shouldExcludePath: vi.fn() }));
vi.mock('../../utils/store', () => ({ getRecentItems: vi.fn(), addToRecentItems: vi.fn(), store: {},
  getWorkspaceWindowState: () => ({ bounds: { x: 10, y: 20, width: 1000, height: 700 } }), getTheme: vi.fn() }));
vi.mock('../WindowManager', () => ({ createWindow: mocks.createWindow, findWorkspaceWindowMatch: mocks.match,
  windows: new Map(), windowStates: mocks.windowStates }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: (channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler) }));
vi.mock('../../theme/ThemeManager', () => ({ getBackgroundColor: vi.fn() }));
vi.mock('../../services/analytics/AnalyticsService', () => ({ AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) } }));
vi.mock('../../services/GitStatusService', () => ({ GitStatusService: class { isGitRepo = async () => false; } }));
vi.mock('../../index', () => ({ getMcpConfigService: vi.fn() }));
vi.mock('../../services/TeamService', () => ({ autoMatchTeamForWorkspace: vi.fn().mockResolvedValue(undefined),
  bindWorkspaceToSharedProject: vi.fn(), broadcastWorkspaceOrgChanged: vi.fn() }));
vi.mock('../../services/TrackerSyncManager', () => ({ initializeTrackerSync: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/tracker/ensureWorkspaceLocalNumbers', () => ({ ensureWorkspaceLocalNumbersInBackground: vi.fn() }));
vi.mock('../../services/TrackerSchemaService', () => ({ updateTrackerSchemaWorkspace: vi.fn() }));
vi.mock('../../utils/dialogPaths', () => ({ getDialogDefaultPath: vi.fn(), rememberDialogSelection: vi.fn() }));
vi.mock('../windowState', async () => {
  const actual = await vi.importActual<typeof import('../windowState')>('../windowState');
  return { windowReferencesWorkspace: vi.fn(), getWindowProjectPaths: actual.getWindowProjectPaths,
    windows: actual.windows, getProjectWindows: actual.getProjectWindows };
});
vi.mock('../../services/tutorial/TutorialProjectService', () => ({ TutorialProjectService: class {} }));
vi.mock('../windowChrome', () => ({ windowControlsOverlayOptions: vi.fn() }));
vi.mock('../StartupActivation', () => ({ isStartupCohortWindow: vi.fn(), notifyStartupWindowRevealed: vi.fn(), registerStartupWindow: vi.fn(),
  isStartupActivationPending: () => false }));

import { app, type BrowserWindow } from 'electron';
import { windows } from '../windowState';
import { initializeApplicationWindowRecovery, recoverAfterProjectWindowClosed } from '../ApplicationWindowRecovery';
import {
  createWorkspaceManagerWindow,
  getWorkspaceManagerWindow,
  setupWorkspaceManagerHandlers,
  wasWorkspaceManagerManuallyClosed,
} from '../WorkspaceManagerWindow';

setupWorkspaceManagerHandlers();
const openWorkspace = (options?: { forceNewWindow: boolean }) =>
  mocks.handlers.get('workspace-manager:open-workspace')!({}, '/project-b', options);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.createWindow.mockReturnValue({ webContents: { once: vi.fn() } });
  mocks.match.mockReturnValue({ window: mocks.existing, windowId: 1,
    matchedPath: '/project-b', isActive: false, kind: 'referenced' });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('creates a separate window for an explicit request even when the project is in another rail', async () => {
  expect(await openWorkspace({ forceNewWindow: true })).toEqual({ success: true, action: 'created' });
  expect(mocks.createWindow).toHaveBeenCalledWith(false, true, '/project-b',
    { x: 10, y: 20, width: 1000, height: 700 }, { restorePreviousProjects: false });
  expect(mocks.existing.focus).not.toHaveBeenCalled();
  expect(mocks.existing.webContents.send).not.toHaveBeenCalled();
});

it('still switches an existing rail window for an ordinary project-open request', async () => {
  expect(await openWorkspace()).toEqual({ success: true, action: 'switched' });
  expect(mocks.existing.webContents.send).toHaveBeenCalledWith('workspace:activate-project', { workspacePath: '/project-b' });
  expect(mocks.createWindow).not.toHaveBeenCalled();
});

it('creates a window for an ordinary project not hosted by any window', async () => {
  mocks.match.mockReturnValue(null);
  expect(await openWorkspace()).toEqual({ success: true, action: 'created' });
  expect(mocks.createWindow).toHaveBeenCalledOnce();
});

it('lists every rail project as open, not just the project in front of each window', async () => {
  mocks.windowStates.clear();
  mocks.windowStates.set(1, { mode: 'workspace', workspacePath: '/a', additionalWorkspacePaths: ['/b', '/c'], activeWorkspacePath: '/b' });
  mocks.windowStates.set(2, { mode: 'workspace', workspacePath: '/d', additionalWorkspacePaths: ['/b'] });
  mocks.windowStates.set(3, { mode: 'document', workspacePath: '/e' });

  const open = await mocks.handlers.get('workspace-manager:get-open-workspaces')!({});

  expect([...open].sort()).toEqual(['/a', '/b', '/c', '/d']);
});

describe('closing the Project Manager while a hidden helper window is alive', () => {
  // The capture window (?mode=capture) is never closed, so Electron never emits
  // window-all-closed here; no test emits it.
  let dispose: () => void;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value });
  const openManager = () => createWorkspaceManagerWindow() as unknown as { close(): void };

  beforeEach(() => {
    mocks.managerWindows.length = 0;
    windows.clear();
    wasWorkspaceManagerManuallyClosed();
    dispose = initializeApplicationWindowRecovery({
      isQuitting: () => false,
      getPreferredProjectWindow: () => null,
      getWorkspaceManagerWindow,
      createWorkspaceManagerWindow,
      wasWorkspaceManagerManuallyClosed,
    });
  });
  afterEach(() => {
    (getWorkspaceManagerWindow() as unknown as { destroy(): void } | null)?.destroy();
    dispose();
    windows.clear();
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  it.each([
    ['linux', true],
    ['win32', true],
    ['darwin', false],
  ] as const)('a manual close with no project window left on %s quits: %s', async (platform, quits) => {
    setPlatform(platform);
    openManager().close();
    await vi.runAllTimersAsync();
    expect(vi.mocked(app.quit).mock.calls.length > 0).toBe(quits);
    // Never reopened: on macOS the app stays up with no window until the Dock is clicked.
    expect(mocks.managerWindows).toHaveLength(1);
  });

  it('a close for a project pick neither quits nor reopens the manager', async () => {
    setPlatform('linux');
    openManager();
    mocks.match.mockReturnValue(null);
    // createWindow is mocked and registers nothing, so a recovery run here would reopen the manager.
    await openWorkspace();
    await vi.runAllTimersAsync();
    expect(app.quit).not.toHaveBeenCalled();
    expect(mocks.managerWindows).toHaveLength(1);
    expect(getWorkspaceManagerWindow()).toBeNull();
  });

  it('a manual close while a project window is open does nothing until that window closes', async () => {
    setPlatform('linux');
    const project = { isDestroyed: () => false, show: vi.fn(), focus: vi.fn() };
    windows.set(1, project as unknown as BrowserWindow);
    openManager().close();
    await vi.runAllTimersAsync();
    expect(app.quit).not.toHaveBeenCalled();
    expect(mocks.managerWindows).toHaveLength(1);
    expect(project.focus).not.toHaveBeenCalled();

    // The flag stays set until read, so the last project close still quits.
    windows.clear();
    recoverAfterProjectWindowClosed();
    await vi.runAllTimersAsync();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('recreating an unhealthy manager keeps the app running', async () => {
    setPlatform('linux');
    openManager();
    mocks.managerWindows[0].webContents.executeJavaScript.mockResolvedValue(false);
    // The health check destroys the old manager and opens a replacement.
    createWorkspaceManagerWindow();
    await vi.runAllTimersAsync();
    expect(app.quit).not.toHaveBeenCalled();
    expect(mocks.managerWindows).toHaveLength(2);
    expect(getWorkspaceManagerWindow()).toBe(mocks.managerWindows[1]);
  });
});
