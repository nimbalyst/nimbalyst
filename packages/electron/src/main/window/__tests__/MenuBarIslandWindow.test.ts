// @vitest-environment node
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

/**
 * What only the window can be asked.
 *
 * The strip's content is pure and covered next to the state machine. What is
 * only observable here is the window's own behaviour: that it stays on screen
 * when the fleet goes quiet (in island mode it is the only thing in the menu
 * bar, so hiding it strands the user), that the pill's press resolves into a
 * pin or a move, and that switching the style releases the pin before the
 * window it focused is destroyed.
 */

const {
  browserWindowCtor,
  appMock,
  screenMock,
  applyDockIconMock,
  setIslandDisplayMock,
  cursorRef,
} = vi.hoisted(() => {
  /** The primary at the origin, and a second display 2048pt to its right. */
  const displays = [
    {
      id: 1,
      label: 'Studio Display',
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 30, width: 1440, height: 870 },
      internal: false,
    },
    {
      id: 2,
      label: 'Built-in',
      bounds: { x: 2048, y: 0, width: 1440, height: 900 },
      workArea: { x: 2048, y: 30, width: 1440, height: 870 },
      internal: false,
    },
  ];
  /** Mutable so a test can walk the cursor across the display boundary. */
  const cursorRef = { current: { x: 5, y: 800 } };
  const listeners = new Map<string, CallableFunction>();
  const webContentsListeners = new Map<string, CallableFunction>();
  const instance = {
    listeners,
    visible: false,
    on: vi.fn((event: string, handler: CallableFunction) => { listeners.set(event, handler); }),
    once: vi.fn((event: string, handler: CallableFunction) => { listeners.set(event, handler); }),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => instance.visible),
    showInactive: vi.fn(() => { instance.visible = true; }),
    hide: vi.fn(() => { instance.visible = false; }),
    focus: vi.fn(),
    destroy: vi.fn(),
    setBounds: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 760, height: 460 })),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setFocusable: vi.fn(),
    loadURL: vi.fn(() => Promise.resolve()),
    loadFile: vi.fn(() => Promise.resolve()),
    webContents: {
      listeners: webContentsListeners,
      send: vi.fn(),
      once: vi.fn((event: string, handler: CallableFunction) => { webContentsListeners.set(event, handler); }),
      insertCSS: vi.fn(() => Promise.resolve('css-key')),
    },
  };
  return {
    browserWindowCtor: Object.assign(
      vi.fn(function (_options?: Record<string, unknown>) { return instance; }),
      { instance },
    ),
    appMock: { getAppPath: () => '/app', isPackaged: false, setActivationPolicy: vi.fn() },
    applyDockIconMock: vi.fn(),
    setIslandDisplayMock: vi.fn(),
    cursorRef,
    screenMock: {
      // Two external displays, so a drag has somewhere to go and the island
      // centres on both. Notch placement is covered in islandGeometry.test.ts.
      getPrimaryDisplay: vi.fn(() => displays[0]),
      getAllDisplays: vi.fn(() => displays),
      getDisplayNearestPoint: vi.fn((point: { x: number; y: number }) => (
        displays.find((display) => (
          point.x >= display.bounds.x && point.x < display.bounds.x + display.bounds.width
        )) ?? displays[0]
      )),
      // Parked far from the island, so nothing hovers by accident.
      getCursorScreenPoint: vi.fn(() => cursorRef.current),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowCtor,
  screen: screenMock,
}));
const { ipcHandlers } = vi.hoisted(() => ({ ipcHandlers: new Map<string, CallableFunction>() }));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: vi.fn(),
  safeOn: vi.fn((channel: string, handler: CallableFunction) => { ipcHandlers.set(channel, handler); }),
}));
vi.mock('../../utils/appPaths', () => ({ getPreloadPath: () => '/preload.js' }));
vi.mock('../../utils/store', () => ({
  getTheme: () => 'dark',
  // No saved choice, so placement follows the primary until a drag says otherwise.
  getIslandDisplay: () => null,
  setIslandDisplay: setIslandDisplayMock,
}));
vi.mock('../../utils/logger', () => ({ logger: { main: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } }));
vi.mock('../../utils/dockIcon', () => ({ applyDockIcon: applyDockIconMock }));
vi.mock('../../tray/trayGlyph', () => ({ loadTrayGlyphDataUri: () => null }));

import {
  closeMenuBarIsland,
  setupMenuBarIslandHandlers,
  showMenuBarIsland,
} from '../MenuBarIslandWindow';
import { MENU_BAR_ISLAND_CHANNELS } from '../../../shared/menuBarIsland';
import { ISLAND_WINDOW_WIDTH } from '../islandGeometry';
import { emptyTrayPanelFeed } from '../../../shared/traySessions';

const win = browserWindowCtor.instance;

function frame(running: number) {
  return {
    strip: {
      mode: 'counts' as const,
      needsApproval: 0,
      needsDecision: 0,
      running,
      failed: 0,
      stalled: 0,
      unread: 0,
      age: null,
    },
    feed: emptyTrayPanelFeed(),
    snippets: {},
    settings: {
      style: 'island' as const,
      showFleetStatus: true,
      osNotifications: true,
      preventSleep: null,
    },
  };
}

function handlers(overrides: Record<string, unknown> = {}) {
  return {
    onSelectSession: vi.fn(),
    onExpandedChange: vi.fn(),
    onNewSession: vi.fn(),
    onOpenApp: vi.fn(),
    onSettingChange: vi.fn(),
    onClearAllUnread: vi.fn(),
    ...overrides,
  } as Parameters<typeof setupMenuBarIslandHandlers>[0];
}

/** The window is created hidden and shown by the `did-finish-load` handler. */
function finishLoad() {
  const handler = win.webContents.listeners.get('did-finish-load');
  if (handler) return handler();
  else win.showInactive();
}

describe('MenuBarIslandWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    closeMenuBarIsland();
    vi.clearAllMocks();
    // Back on the primary, far from the island, so nothing hovers or drags by
    // accident and each drag test starts its gesture from a known point.
    cursorRef.current = { x: 5, y: 800 };
    win.visible = false;
    win.listeners.clear();
    win.webContents.listeners.clear();
  });

  afterEach(() => {
    closeMenuBarIsland();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  /*
   * In island mode there is no tray item, so the island is the only way to
   * reach the panel, the gear, and the setting that switches back. Hiding it
   * when the fleet goes quiet -- which it used to do -- leaves an idle Mac with
   * no menu bar presence at all and no way out of the style.
   */
  it('stays on screen when the fleet goes quiet', async () => {
    showMenuBarIsland(frame(1));
    finishLoad();
    await Promise.resolve();
    expect(win.isVisible()).toBe(true);

    showMenuBarIsland(frame(0));
    vi.advanceTimersByTime(5_000);

    expect(win.hide).not.toHaveBeenCalled();
    expect(win.isVisible()).toBe(true);
    expect(browserWindowCtor).toHaveBeenCalledTimes(1);
  });

  it("hides Vite's error overlay before showing the development island", async () => {
    vi.stubEnv('NODE_ENV', 'development');
    let finishInsert: (key: string) => void = () => {};
    win.webContents.insertCSS.mockReturnValueOnce(new Promise((resolve) => {
      finishInsert = resolve;
    }));

    showMenuBarIsland(frame(1));
    const load = finishLoad();
    showMenuBarIsland(frame(2));

    expect(win.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('vite-error-overlay'));
    expect(win.showInactive).not.toHaveBeenCalled();

    finishInsert('css-key');
    await load;
    expect(win.showInactive).toHaveBeenCalledTimes(1);
  });

  /*
   * Switching the style destroys this window. Pinning made it focusable and
   * focused it, so the release has to happen while the window is still there --
   * `closeMenuBarIsland` resetting the flag afterwards is too late.
   */
  it('releases the pin before handing a style switch to the owner', () => {
    const deps = handlers();
    setupMenuBarIslandHandlers(deps);
    const event = { sender: win.webContents };

    showMenuBarIsland(frame(1));
    finishLoad();
    ipcHandlers.get(MENU_BAR_ISLAND_CHANNELS.setPinned)!(event, { pinned: true });
    expect(win.setFocusable).toHaveBeenLastCalledWith(true);

    ipcHandlers.get(MENU_BAR_ISLAND_CHANNELS.setSetting)!(event, { key: 'style', value: 'image' });

    expect(win.setFocusable).toHaveBeenLastCalledWith(false);
    expect(deps.onSettingChange).toHaveBeenCalledWith({ key: 'style', value: 'image' });
  });

  it('ignores settings and actions from any other renderer', () => {
    const deps = handlers();
    setupMenuBarIslandHandlers(deps);

    showMenuBarIsland(frame(1));
    finishLoad();

    const impostor = { sender: { id: 'someone else' } };
    ipcHandlers.get(MENU_BAR_ISLAND_CHANNELS.setSetting)!(impostor, { key: 'osNotifications', value: false });
    ipcHandlers.get(MENU_BAR_ISLAND_CHANNELS.newSession)!(impostor);
    ipcHandlers.get(MENU_BAR_ISLAND_CHANNELS.openApp)!(impostor);
    ipcHandlers.get(MENU_BAR_ISLAND_CHANNELS.clearAllUnread)!(impostor);

    expect(deps.onSettingChange).not.toHaveBeenCalled();
    expect(deps.onNewSession).not.toHaveBeenCalled();
    expect(deps.onOpenApp).not.toHaveBeenCalled();
    expect(deps.onClearAllUnread).not.toHaveBeenCalled();
  });

  /*
   * The footer's actions send the user somewhere else and so release the pin.
   * Marking the fleet read does not: the user stays on the panel to watch the
   * unread section go, and collapsing it out from under them loses that.
   */
  it('marks the fleet read without releasing the pin', () => {
    const deps = handlers();
    setupMenuBarIslandHandlers(deps);
    const event = { sender: win.webContents };

    showMenuBarIsland(frame(1));
    finishLoad();
    ipcHandlers.get(MENU_BAR_ISLAND_CHANNELS.setPinned)!(event, { pinned: true });
    expect(win.setFocusable).toHaveBeenLastCalledWith(true);

    ipcHandlers.get(MENU_BAR_ISLAND_CHANNELS.clearAllUnread)!(event);

    expect(deps.onClearAllUnread).toHaveBeenCalledTimes(1);
    expect(win.setFocusable).toHaveBeenLastCalledWith(true);
  });

  // The gesture that this whole drag path exists for: the island has to end up
  // on the display the user released it over, and stay there next launch.
  it('moves to the display the press was released on, and remembers it', () => {
    setupMenuBarIslandHandlers(handlers());
    const event = { sender: win.webContents };

    showMenuBarIsland(frame(1));
    finishLoad();
    win.setBounds.mockClear();

    ipcHandlers.get(MENU_BAR_ISLAND_CHANNELS.dragStart)!(event);
    // Travel well past the slop, onto the second display.
    cursorRef.current = { x: 2400, y: 10 };
    ipcHandlers.get(MENU_BAR_ISLAND_CHANNELS.dragMove)!(event);
    ipcHandlers.get(MENU_BAR_ISLAND_CHANNELS.dragEnd)!(event);

    expect(setIslandDisplayMock).toHaveBeenCalledWith({ id: 2, label: 'Built-in' });
    // Centred on the second display, whose origin is x=2048.
    expect(win.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 2048 + 720 - ISLAND_WINDOW_WIDTH / 2, y: 0 }),
    );
  });

  it('reads a press that never moved as a pin, not a move', () => {
    setupMenuBarIslandHandlers(handlers());
    const event = { sender: win.webContents };

    showMenuBarIsland(frame(1));
    finishLoad();

    ipcHandlers.get(MENU_BAR_ISLAND_CHANNELS.dragStart)!(event);
    // Within the slop: a hand that failed to hold still, not an instruction.
    cursorRef.current = { x: 5 + 3, y: 800 };
    ipcHandlers.get(MENU_BAR_ISLAND_CHANNELS.dragEnd)!(event);

    expect(setIslandDisplayMock).not.toHaveBeenCalled();
  });
});
