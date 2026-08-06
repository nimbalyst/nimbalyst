import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A minimal fake BrowserWindow that records construction and lets us drive the
// singleton/retarget behavior of createTeamManagementWindow.
const {
  instances,
  ipcHandlers,
  ipcListeners,
  savedWindowState,
  getTeamManagementWindowState,
  saveTeamManagementWindowState,
} = vi.hoisted(() => ({
  instances: [] as any[],
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
  ipcListeners: new Map<string, (...args: any[]) => any>(),
  savedWindowState: { current: undefined as
    | {
      bounds: { x: number; y: number; width: number; height: number };
      maximized: boolean;
    }
    | undefined },
  getTeamManagementWindowState: vi.fn(),
  saveTeamManagementWindowState: vi.fn(),
}));

class FakeBrowserWindow {
  options: any;
  focus = vi.fn();
  loadURL = vi.fn();
  loadFile = vi.fn();
  once = vi.fn();
  on = vi.fn();
  isDestroyed = vi.fn(() => false);
  isFocused = vi.fn(() => true);
  isMaximized = vi.fn(() => false);
  getNormalBounds = vi.fn(() => ({ x: 80, y: 90, width: 1100, height: 750 }));
  maximize = vi.fn();
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
  screen: {
    getAllDisplays: () => [
      { workArea: { x: 0, y: 0, width: 1440, height: 900 } },
    ],
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      ipcHandlers.set(channel, handler);
    },
    on: (channel: string, listener: (...args: any[]) => any) => {
      ipcListeners.set(channel, listener);
    },
  },
}));

vi.mock('../../utils/appPaths', () => ({ getPreloadPath: () => '/preload.js' }));
vi.mock('../../utils/store', () => ({
  getTheme: () => 'dark',
  getTeamManagementWindowState,
  saveTeamManagementWindowState,
}));
vi.mock('../../theme/ThemeManager', () => ({ getBackgroundColor: () => '#111111' }));

describe('TeamManagementWindow', () => {
  beforeEach(() => {
    instances.length = 0;
    ipcHandlers.clear();
    ipcListeners.clear();
    savedWindowState.current = undefined;
    getTeamManagementWindowState.mockImplementation(() => savedWindowState.current);
    saveTeamManagementWindowState.mockReset();
    vi.resetModules();
    process.env.NODE_ENV = 'development';
    process.env.VITE_PORT = '5273';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates a single window loading the team-management renderer with the target org', async () => {
    const { createTeamManagementWindow } = await import('../TeamManagementWindow');

    createTeamManagementWindow({
      orgId: 'org-1',
      workspacePath: '/ws',
      conversationId: 'general',
    });

    expect(instances).toHaveLength(1);
    const win = instances[0];
    expect(win.options.width).toBe(1100);
    expect(win.options.webPreferences.preload).toBe('/preload.js');

    const [url] = win.loadURL.mock.calls[0];
    expect(url).toContain('mode=team-management');
    expect(url).toContain('orgId=org-1');
    expect(url).toContain('workspacePath=%2Fws');
    expect(url).toContain('conversationId=general');
  });

  it('reuses the existing window and retargets it instead of opening a second one', async () => {
    const { createTeamManagementWindow } = await import('../TeamManagementWindow');

    createTeamManagementWindow({ orgId: 'org-1' });
    createTeamManagementWindow({
      orgId: 'org-2',
      workspacePath: '/ws2',
      conversationId: 'room-2',
    });

    expect(instances).toHaveLength(1);
    const win = instances[0];
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith('team-window:set-target', {
      orgId: 'org-2',
      workspacePath: '/ws2',
      conversationId: 'room-2',
    });
  });

  it('restores persisted bounds and maximized state', async () => {
    savedWindowState.current = {
      bounds: { x: 120, y: 140, width: 980, height: 680 },
      maximized: true,
    };
    const { createTeamManagementWindow } = await import('../TeamManagementWindow');

    createTeamManagementWindow({ orgId: 'org-1' });

    const win = instances[0];
    expect(win.options).toMatchObject({
      x: 120,
      y: 140,
      width: 980,
      height: 680,
    });
    const readyToShow = win.once.mock.calls.find(
      (call: any[]) => call[0] === 'ready-to-show',
    )?.[1];
    readyToShow();
    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('clamps bounds from a disconnected display into the primary work area', async () => {
    savedWindowState.current = {
      bounds: { x: 2200, y: 160, width: 1000, height: 700 },
      maximized: false,
    };
    const { createTeamManagementWindow } = await import('../TeamManagementWindow');

    createTeamManagementWindow({ orgId: 'org-1' });

    expect(instances[0].options).toMatchObject({
      x: 440,
      y: 160,
      width: 1000,
      height: 700,
    });
  });

  it('persists normal bounds and maximized state when the window closes', async () => {
    const { createTeamManagementWindow } = await import('../TeamManagementWindow');
    const win = createTeamManagementWindow({ orgId: 'org-1' }) as unknown as FakeBrowserWindow;
    win.getNormalBounds.mockReturnValue({ x: 40, y: 60, width: 1024, height: 720 });
    win.isMaximized.mockReturnValue(true);

    const close = win.on.mock.calls.find(
      (call: any[]) => call[0] === 'close',
    )?.[1];
    close();

    expect(saveTeamManagementWindowState).toHaveBeenCalledWith({
      bounds: { x: 40, y: 60, width: 1024, height: 720 },
      maximized: true,
    });
  });

  it('suppresses only when the focused organization window reports the exact conversation', async () => {
    const {
      createTeamManagementWindow,
      isTeamManagementWindowFocusedOn,
      setupTeamManagementHandlers,
    } = await import('../TeamManagementWindow');
    setupTeamManagementHandlers();
    const win = createTeamManagementWindow({ orgId: 'org-1' });
    const listener = ipcListeners.get('team-window:route-state');
    expect(listener).toBeTypeOf('function');

    listener!({ sender: win.webContents }, {
      orgId: 'org-1',
      view: 'conversation',
      conversationId: 'general',
    });

    expect(isTeamManagementWindowFocusedOn('org-1', 'general')).toBe(true);
    expect(isTeamManagementWindowFocusedOn('org-1', 'random')).toBe(false);
    expect(isTeamManagementWindowFocusedOn('org-2', 'general')).toBe(false);
  });

  it('delivers a Messages-menu command to the organization window only', async () => {
    const {
      createTeamManagementWindow,
      sendOrgWindowCommand,
    } = await import('../TeamManagementWindow');

    // Nothing to deliver to before the window exists — the menu item checks
    // this rather than opening a window behind the user's back.
    expect(sendOrgWindowCommand('newMessage')).toBe(false);
    expect(instances).toHaveLength(0);

    const win = createTeamManagementWindow({ orgId: 'org-1' }) as unknown as FakeBrowserWindow;
    expect(sendOrgWindowCommand('newMessage')).toBe(true);
    expect(win.webContents.send).toHaveBeenCalledWith('org-window:command', 'newMessage');

    win.isDestroyed.mockReturnValue(true);
    win.webContents.send.mockClear();
    expect(sendOrgWindowCommand('goToInbox')).toBe(false);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('reports focus and rebuilds the menu on each focus transition', async () => {
    const {
      createTeamManagementWindow,
      isTeamManagementWindowFocused,
      registerTeamManagementFocusChange,
    } = await import('../TeamManagementWindow');

    const onFocusChange = vi.fn();
    registerTeamManagementFocusChange(onFocusChange);

    expect(isTeamManagementWindowFocused()).toBe(false);

    const win = createTeamManagementWindow({ orgId: 'org-1' }) as unknown as FakeBrowserWindow;
    const listener = (event: string) => win.on.mock.calls.find(
      (call: any[]) => call[0] === event,
    )?.[1];

    win.isFocused.mockReturnValue(true);
    listener('focus')!();
    expect(isTeamManagementWindowFocused()).toBe(true);
    expect(onFocusChange).toHaveBeenCalledTimes(1);

    // An unchanged state must not rebuild the whole application menu again.
    listener('focus')!();
    expect(onFocusChange).toHaveBeenCalledTimes(1);

    win.isFocused.mockReturnValue(false);
    listener('blur')!();
    expect(isTeamManagementWindowFocused()).toBe(false);
    expect(onFocusChange).toHaveBeenCalledTimes(2);
  });

  it('drops the focused state when the window closes, so the Messages menu leaves', async () => {
    const {
      createTeamManagementWindow,
      isTeamManagementWindowFocused,
      registerTeamManagementFocusChange,
    } = await import('../TeamManagementWindow');

    const onFocusChange = vi.fn();
    registerTeamManagementFocusChange(onFocusChange);
    const win = createTeamManagementWindow({ orgId: 'org-1' }) as unknown as FakeBrowserWindow;
    win.isFocused.mockReturnValue(true);
    win.on.mock.calls.find((call: any[]) => call[0] === 'focus')![1]();
    onFocusChange.mockClear();

    win.on.mock.calls.find((call: any[]) => call[0] === 'closed')![1]();

    expect(isTeamManagementWindowFocused()).toBe(false);
    expect(onFocusChange).toHaveBeenCalledTimes(1);
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

  it('lists tracker metadata only for the organization currently hosted by the org window', async () => {
    const listTrackerItemsForOrg = vi.fn().mockResolvedValue([
      { id: 'plan-1', issueKey: 'NIM-1', type: 'plan', title: 'Satellite apps' },
    ]);
    const { setupTeamManagementHandlers } = await import('../TeamManagementWindow');
    setupTeamManagementHandlers({ listTrackerItemsForOrg });

    await ipcHandlers.get('team-window:open')!({}, { orgId: 'org-9' });
    const win = instances[0];
    ipcListeners.get('team-window:route-state')!(
      { sender: win.webContents },
      { orgId: 'org-9', view: 'conversation', conversationId: 'general' },
    );

    await expect(
      ipcHandlers.get('team-window:tracker-items-list')!(
        { sender: win.webContents },
        { orgId: 'org-9' },
      ),
    ).resolves.toEqual([
      { id: 'plan-1', issueKey: 'NIM-1', type: 'plan', title: 'Satellite apps' },
    ]);
    expect(listTrackerItemsForOrg).toHaveBeenCalledWith('org-9');

    await expect(
      ipcHandlers.get('team-window:tracker-items-list')!(
        { sender: win.webContents },
        { orgId: 'org-other' },
      ),
    ).resolves.toEqual([]);
    await expect(
      ipcHandlers.get('team-window:tracker-items-list')!(
        { sender: {} },
        { orgId: 'org-9' },
      ),
    ).resolves.toEqual([]);
    expect(listTrackerItemsForOrg).toHaveBeenCalledTimes(1);
  });
});
