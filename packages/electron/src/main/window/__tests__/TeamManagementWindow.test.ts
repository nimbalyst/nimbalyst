import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A minimal fake BrowserWindow that records construction and lets us drive the
// singleton/retarget behavior of createTeamManagementWindow.
const { instances, ipcHandlers } = vi.hoisted(() => ({
  instances: [] as any[],
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
}));

class FakeBrowserWindow {
  options: any;
  focus = vi.fn();
  loadURL = vi.fn();
  loadFile = vi.fn();
  once = vi.fn();
  on = vi.fn();
  isDestroyed = vi.fn(() => false);
  show = vi.fn();
  setBackgroundColor = vi.fn();
  webContents = { send: vi.fn() };
  constructor(options: any) {
    this.options = options;
    instances.push(this);
  }
}

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/app',
    isPackaged: false,
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      ipcHandlers.set(channel, handler);
    },
  },
}));

vi.mock('../../utils/appPaths', () => ({ getPreloadPath: () => '/preload.js' }));
vi.mock('../../utils/store', () => ({ getTheme: () => 'dark' }));
vi.mock('../../theme/ThemeManager', () => ({ getBackgroundColor: () => '#111111' }));

describe('TeamManagementWindow', () => {
  beforeEach(() => {
    instances.length = 0;
    ipcHandlers.clear();
    vi.resetModules();
    process.env.NODE_ENV = 'development';
    process.env.VITE_PORT = '5273';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates a single window loading the team-management renderer with the target org', async () => {
    const { createTeamManagementWindow } = await import('../TeamManagementWindow');

    createTeamManagementWindow({ orgId: 'org-1', workspacePath: '/ws' });

    expect(instances).toHaveLength(1);
    const win = instances[0];
    expect(win.options.width).toBe(1100);
    expect(win.options.webPreferences.preload).toBe('/preload.js');

    const [url] = win.loadURL.mock.calls[0];
    expect(url).toContain('mode=team-management');
    expect(url).toContain('orgId=org-1');
    expect(url).toContain('workspacePath=%2Fws');
  });

  it('reuses the existing window and retargets it instead of opening a second one', async () => {
    const { createTeamManagementWindow } = await import('../TeamManagementWindow');

    createTeamManagementWindow({ orgId: 'org-1' });
    createTeamManagementWindow({ orgId: 'org-2', workspacePath: '/ws2' });

    expect(instances).toHaveLength(1);
    const win = instances[0];
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith('team-window:set-target', {
      orgId: 'org-2',
      workspacePath: '/ws2',
    });
  });

  it('registers the team-window:open IPC handler that opens the window', async () => {
    const { setupTeamManagementHandlers } = await import('../TeamManagementWindow');
    setupTeamManagementHandlers();

    const handler = ipcHandlers.get('team-window:open');
    expect(handler).toBeTypeOf('function');

    const result = await handler!({}, { orgId: 'org-9' });
    expect(result).toEqual({ success: true });
    expect(instances).toHaveLength(1);
    expect(instances[0].loadURL.mock.calls[0][0]).toContain('orgId=org-9');
  });
});
