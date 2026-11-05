// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  match: vi.fn(),
  createWindow: vi.fn(),
  windowStates: new Map<number, any>(),
  existing: { isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(),
    focus: vi.fn(), webContents: { isDestroyed: () => false, send: vi.fn() } },
}));

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, app: {} }));
vi.mock('fs/promises', () => ({ readdir: vi.fn().mockResolvedValue([]) }));
vi.mock('../../utils/appPaths', () => ({ getPreloadPath: vi.fn() }));
vi.mock('../unresponsiveHandler', () => ({ createUnresponsiveHandler: vi.fn() }));
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
  return { windowReferencesWorkspace: vi.fn(), getWindowProjectPaths: actual.getWindowProjectPaths };
});
vi.mock('../../services/tutorial/TutorialProjectService', () => ({ TutorialProjectService: class {} }));
vi.mock('../windowChrome', () => ({ windowControlsOverlayOptions: vi.fn() }));
vi.mock('../StartupActivation', () => ({ isStartupCohortWindow: vi.fn(), notifyStartupWindowRevealed: vi.fn(), registerStartupWindow: vi.fn() }));

import { setupWorkspaceManagerHandlers } from '../WorkspaceManagerWindow';

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
