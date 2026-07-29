import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getApplicationMenu, getAllWindows, getFocusedWindow, quit, error } = vi.hoisted(() => ({
  getApplicationMenu: vi.fn(),
  getAllWindows: vi.fn(() => [] as unknown[]),
  getFocusedWindow: vi.fn(() => null as unknown),
  quit: vi.fn(),
  error: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { quit },
  Menu: { getApplicationMenu },
  BrowserWindow: { getAllWindows, getFocusedWindow },
}));

vi.mock('../../utils/logger', () => ({
  logger: { menu: { error, warn: vi.fn(), info: vi.fn() } },
}));

import {
  getWindowMenuBar,
  invokeWindowMenuItem,
  notifyWindowMenuChanged,
  resetWindowMenuRevisionForTests,
} from '../menuBarBridge';

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function makeWindow() {
  return {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn(),
      copy: vi.fn(),
      undo: vi.fn(),
    },
    minimize: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWindowMenuRevisionForTests();
  setPlatform('win32');
  getAllWindows.mockReturnValue([]);
  getFocusedWindow.mockReturnValue(null);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('getWindowMenuBar', () => {
  it('serializes the live application menu on Windows', () => {
    getApplicationMenu.mockReturnValue({
      items: [{ label: 'File', submenu: { items: [{ label: 'Save', accelerator: 'CmdOrCtrl+S' }] } }],
    });

    const menuBar = getWindowMenuBar();

    expect(menuBar.items[0].label).toBe('File');
    expect(menuBar.items[0].submenu?.[0].acceleratorLabel).toBe('Ctrl+S');
  });

  it('flags macOS as not drawing the bar in-window, where the system menu bar shows it', () => {
    setPlatform('darwin');
    getApplicationMenu.mockReturnValue({ items: [{ label: 'File' }] });

    const menuBar = getWindowMenuBar();

    expect(menuBar.inWindow).toBe(false);
    expect(menuBar.items).toHaveLength(1);
  });
});

describe('notifyWindowMenuChanged', () => {
  it('bumps the revision and pushes the model to every window', () => {
    getApplicationMenu.mockReturnValue({ items: [{ label: 'File' }] });
    const window = makeWindow();
    getAllWindows.mockReturnValue([window]);

    expect(getWindowMenuBar().revision).toBe(0);
    notifyWindowMenuChanged();

    expect(getWindowMenuBar().revision).toBe(1);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'window-menu:changed',
      expect.objectContaining({ revision: 1 }),
    );
  });

  it('skips destroyed windows', () => {
    getApplicationMenu.mockReturnValue({ items: [] });
    const destroyed = { ...makeWindow(), isDestroyed: () => true };
    getAllWindows.mockReturnValue([destroyed]);

    notifyWindowMenuChanged();

    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });
});

describe('invokeWindowMenuItem', () => {
  it('runs the click handler with the sender window', () => {
    const click = vi.fn();
    getApplicationMenu.mockReturnValue({
      items: [{ label: 'File', submenu: { items: [{ label: 'Save', click }] } }],
    });
    const window = makeWindow();

    const result = invokeWindowMenuItem('0.0', 0, window as never);

    expect(result).toEqual({ invoked: true });
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.calls[0][1]).toBe(window);
  });

  it('rejects a stale revision instead of firing whatever now sits at that index', () => {
    const click = vi.fn();
    getApplicationMenu.mockReturnValue({ items: [{ label: 'File', submenu: { items: [{ click }] } }] });

    notifyWindowMenuChanged();
    const result = invokeWindowMenuItem('0.0', 0, makeWindow() as never);

    expect(result).toEqual({ invoked: false, staleRevision: true });
    expect(click).not.toHaveBeenCalled();
  });

  it('performs role items, which carry no click handler', () => {
    getApplicationMenu.mockReturnValue({
      items: [{ label: 'Edit', submenu: { items: [{ label: 'Copy', role: 'copy' }] } }],
    });
    const window = makeWindow();

    expect(invokeWindowMenuItem('0.0', 0, window as never)).toEqual({ invoked: true });
    expect(window.webContents.copy).toHaveBeenCalledTimes(1);
  });

  it('normalizes role casing (selectAll) and falls back to the focused window', () => {
    getApplicationMenu.mockReturnValue({
      items: [{ label: 'Window', submenu: { items: [{ label: 'Minimize', role: 'minimize' }] } }],
    });
    const focused = makeWindow();
    getFocusedWindow.mockReturnValue(focused);

    expect(invokeWindowMenuItem('0.0', 0, null)).toEqual({ invoked: true });
    expect(focused.minimize).toHaveBeenCalledTimes(1);
  });

  it('flips checkbox state before the handler runs, like a native click', () => {
    const item = { label: 'Show Panel', type: 'checkbox', checked: false, click: vi.fn() };
    getApplicationMenu.mockReturnValue({ items: [{ label: 'View', submenu: { items: [item] } }] });

    invokeWindowMenuItem('0.0', 0, makeWindow() as never);

    expect(item.checked).toBe(true);
    expect(item.click).toHaveBeenCalledTimes(1);
  });

  it('selects radio items rather than toggling them', () => {
    const item = { label: 'Dark', type: 'radio', checked: true, click: vi.fn() };
    getApplicationMenu.mockReturnValue({ items: [{ label: 'View', submenu: { items: [item] } }] });

    invokeWindowMenuItem('0.0', 0, makeWindow() as never);

    expect(item.checked).toBe(true);
  });

  it('ignores disabled items, separators, and unknown ids', () => {
    const click = vi.fn();
    getApplicationMenu.mockReturnValue({
      items: [
        {
          label: 'File',
          submenu: { items: [{ label: 'Save', enabled: false, click }, { type: 'separator' }] },
        },
      ],
    });

    expect(invokeWindowMenuItem('0.0', 0, null)).toEqual({ invoked: false });
    expect(invokeWindowMenuItem('0.1', 0, null)).toEqual({ invoked: false });
    expect(invokeWindowMenuItem('9.9', 0, null)).toEqual({ invoked: false });
    expect(click).not.toHaveBeenCalled();
  });

  it('does not let a throwing handler escape into the IPC layer', () => {
    getApplicationMenu.mockReturnValue({
      items: [{
        label: 'File',
        submenu: { items: [{ label: 'Boom', click: () => { throw new Error('boom'); } }] },
      }],
    });

    expect(invokeWindowMenuItem('0.0', 0, null)).toEqual({ invoked: false });
    expect(error).toHaveBeenCalled();
  });
});
