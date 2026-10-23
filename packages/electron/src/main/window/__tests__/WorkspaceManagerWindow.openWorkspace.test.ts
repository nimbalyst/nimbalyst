// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Tests for the 'workspace-manager:open-workspace' handler: when it reuses a
// window that already holds the folder, and when it opens a fresh one.
// Everything that touches Electron, the disk or other services is faked, so
// only the choice between "reuse" and "create" is under test.
const { handlers, createWindow, findWorkspaceWindowMatch, reuseWorkspaceWindow } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  createWindow: vi.fn(),
  findWorkspaceWindowMatch: vi.fn(),
  reuseWorkspaceWindow: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: {},
  app: { getAppPath: () => '/app', isPackaged: false },
}));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (...args: any[]) => any) => { handlers.set(channel, handler); },
}));
vi.mock('../WindowManager', () => ({
  createWindow,
  findWorkspaceWindowMatch,
  windows: new Map(),
  windowStates: new Map(),
}));
vi.mock('../workspaceWindowMatch', () => ({ reuseWorkspaceWindow }));
vi.mock('../windowState', () => ({ windowReferencesWorkspace: vi.fn(() => false) }));
vi.mock('../StartupActivation', () => ({
  isStartupCohortWindow: vi.fn(() => false),
  notifyStartupWindowRevealed: vi.fn(),
  registerStartupWindow: vi.fn(),
}));
vi.mock('../unresponsiveHandler', () => ({ createUnresponsiveHandler: vi.fn() }));
vi.mock('../../utils/appPaths', () => ({ getPreloadPath: vi.fn(() => '/preload.js') }));
vi.mock('../../utils/FileTree', () => ({ resolveEntryType: vi.fn() }));
vi.mock('../../utils/fileFilters', () => ({ shouldExcludeDir: vi.fn(), shouldExcludePath: vi.fn() }));
vi.mock('../../utils/store', () => ({
  getRecentItems: vi.fn(() => []),
  addToRecentItems: vi.fn(),
  store: { get: vi.fn(), set: vi.fn() },
  getWorkspaceWindowState: vi.fn(() => undefined),
  getTheme: vi.fn(() => 'light'),
}));
vi.mock('../../utils/dialogPaths', () => ({
  getDialogDefaultPath: vi.fn(),
  rememberDialogSelection: vi.fn(),
}));
vi.mock('../../theme/ThemeManager', () => ({ getBackgroundColor: vi.fn(() => '#ffffff') }));
vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
vi.mock('../../services/GitStatusService', () => ({
  GitStatusService: class {
    isGitRepo = vi.fn(async () => false);
    hasGitHubRemote = vi.fn(async () => false);
  },
}));
vi.mock('../../index', () => ({ getMcpConfigService: vi.fn(() => null) }));
vi.mock('../../services/TeamService', () => ({
  autoMatchTeamForWorkspace: vi.fn(async () => {}),
  bindWorkspaceToSharedProject: vi.fn(),
  broadcastWorkspaceOrgChanged: vi.fn(),
}));
vi.mock('../../services/TrackerSyncManager', () => ({ initializeTrackerSync: vi.fn(async () => {}) }));
vi.mock('../../services/tracker/ensureWorkspaceLocalNumbers', () => ({
  ensureWorkspaceLocalNumbersInBackground: vi.fn(),
}));
vi.mock('../../services/TrackerSchemaService', () => ({ updateTrackerSchemaWorkspace: vi.fn() }));
vi.mock('../../services/tutorial/TutorialProjectService', () => ({
  TutorialProjectService: class {
    getStatus = vi.fn();
  },
}));

const WORKSPACE = '/tmp/nim-open-workspace-test/project';
const OPEN_WORKSPACE = 'workspace-manager:open-workspace';

function stubWindow() {
  return { webContents: { once: vi.fn(), openDevTools: vi.fn() } };
}

describe('workspace-manager:open-workspace', () => {
  beforeAll(async () => {
    const { setupWorkspaceManagerHandlers } = await import('../WorkspaceManagerWindow');
    setupWorkspaceManagerHandlers();
  });

  beforeEach(() => {
    createWindow.mockReset();
    createWindow.mockImplementation(() => stubWindow());
    reuseWorkspaceWindow.mockReset();
    reuseWorkspaceWindow.mockReturnValue('focused');
    findWorkspaceWindowMatch.mockReset();
    // A window already holds this folder (for example the one the user is in).
    findWorkspaceWindowMatch.mockReturnValue({ window: { isDestroyed: () => false } });
  });

  it('opens a new window even when a window already holds the folder, if forceNewWindow is set', async () => {
    const handler = handlers.get(OPEN_WORKSPACE)!;
    const result = await handler({}, WORKSPACE, { forceNewWindow: true });

    expect(createWindow).toHaveBeenCalledWith(false, true, WORKSPACE, undefined);
    expect(reuseWorkspaceWindow).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, action: 'created' });
  });

  it('still reuses the window that holds the folder when no options are given', async () => {
    const handler = handlers.get(OPEN_WORKSPACE)!;
    const result = await handler({}, WORKSPACE);

    expect(reuseWorkspaceWindow).toHaveBeenCalledTimes(1);
    expect(createWindow).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, action: 'focused' });
  });
});
