// @vitest-environment node
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const { browserWindowCtor, appMock, screenMock, applyDockIconMock } = vi.hoisted(() => {
  const listeners = new Map<string, Function>();
  const instance = {
    listeners,
    on: vi.fn((event: string, handler: Function) => { listeners.set(event, handler); }),
    once: vi.fn((event: string, handler: Function) => { listeners.set(event, handler); }),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    destroy: vi.fn(),
    setBounds: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 380, height: 460 })),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    loadURL: vi.fn(() => Promise.resolve()),
    loadFile: vi.fn(() => Promise.resolve()),
    webContents: { send: vi.fn() },
  };
  return {
    browserWindowCtor: Object.assign(
      vi.fn(function (_options?: Record<string, unknown>) { return instance; }),
      { instance },
    ),
    appMock: {
      getAppPath: () => '/app',
      isPackaged: false,
      setActivationPolicy: vi.fn(),
    },
    applyDockIconMock: vi.fn(),
    screenMock: { getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } })) },
  };
});

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowCtor,
  screen: screenMock,
}));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn(), safeOn: vi.fn() }));
vi.mock('../../utils/appPaths', () => ({ getPreloadPath: () => '/preload.js' }));
vi.mock('../../utils/store', () => ({
  getTheme: () => 'dark',
  getTrayPanelWidth: () => undefined,
  setTrayPanelWidth: vi.fn(),
}));
vi.mock('../../utils/logger', () => ({ logger: { main: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } }));
vi.mock('../../utils/dockIcon', () => ({ applyDockIcon: applyDockIconMock }));

import { closeTrayPanelWindow, computeTrayPanelPosition, toggleTrayPanelWindow } from '../TrayPanelWindow';
import { emptyTrayPanelFeed } from '../../../shared/traySessions';

const SIZE = { width: 380, height: 460 };
/** A 1440x900 primary display with the 25px menu bar excluded. */
const PRIMARY = { x: 0, y: 25, width: 1440, height: 875 };

function within(pos: { x: number; y: number }, workArea: typeof PRIMARY): boolean {
  return pos.x >= workArea.x
    && pos.y >= workArea.y
    && pos.x + SIZE.width <= workArea.x + workArea.width
    && pos.y + SIZE.height <= workArea.y + workArea.height;
}

describe('computeTrayPanelPosition', () => {
  it('centres under the tray icon when there is room on both sides', () => {
    const pos = computeTrayPanelPosition({ x: 700, y: 0, width: 24, height: 24 }, PRIMARY, SIZE);

    expect(pos.x).toBe(Math.round(700 + 12 - 190));
    // Below the icon, then held clear of the menu bar by the work-area padding.
    expect(pos.y).toBe(PRIMARY.y + 8);
    expect(within(pos, PRIMARY)).toBe(true);
  });

  it('pulls the panel back on-screen when the icon sits at the right edge', () => {
    // The common case: the tray is right-aligned, so a centred panel overhangs
    // by half its width and would be created partly off the display.
    const pos = computeTrayPanelPosition({ x: 1410, y: 0, width: 24, height: 24 }, PRIMARY, SIZE);

    expect(within(pos, PRIMARY)).toBe(true);
    expect(pos.x).toBe(PRIMARY.width - SIZE.width - 8);
  });

  it('stays inside a secondary display with a negative origin', () => {
    const secondary = { x: -1920, y: -180, width: 1920, height: 1055 };
    const pos = computeTrayPanelPosition({ x: -1900, y: -205, width: 24, height: 24 }, secondary, SIZE);

    expect(within(pos, secondary)).toBe(true);
    expect(pos.x).toBe(secondary.x + 8);
  });

  it('clamps upward when the panel is taller than the space below the icon', () => {
    const shortDisplay = { x: 0, y: 25, width: 1440, height: 400 };
    const pos = computeTrayPanelPosition({ x: 700, y: 0, width: 24, height: 24 }, shortDisplay, SIZE);

    // No room for a 460px panel in a 400px work area: it pins to the top rather
    // than hanging off the bottom where the footer buttons are unreachable.
    expect(pos.y).toBe(shortDisplay.y + 8);
  });
});

/**
 * The tray panel must never cost the app its Dock icon and Cmd+Tab entry.
 *
 * It did: the panel was first built with `type: 'panel'`, which puts NSApp into
 * `NSApplicationActivationPolicyAccessory`. Because the window is created lazily
 * on the first tray click, the app silently disappeared from the app switcher
 * the moment the user opened the panel, and the panel's own "Open Nimbalyst"
 * button was the only way back to a project window. LaunchServices reported
 * `ApplicationType="UIElement"` with `LSUIElement` unset in the Info.plist,
 * which is what pinned it on a runtime policy change rather than the bundle.
 */
describe('tray panel activation policy', () => {
  const trayBounds = { x: 700, y: 0, width: 24, height: 24 };
  let restorePlatform: () => void = () => {};

  afterEach(() => restorePlatform());

  beforeEach(() => {
    // The panel is macOS-only, so pin the platform rather than skipping on CI.
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    restorePlatform = () => Object.defineProperty(process, 'platform', original);

    closeTrayPanelWindow();
    vi.clearAllMocks();
    applyDockIconMock.mockClear();
    browserWindowCtor.instance.isVisible.mockReturnValue(false);
    browserWindowCtor.instance.isDestroyed.mockReturnValue(false);
  });

  it('does not create the panel as an NSPanel', () => {
    toggleTrayPanelWindow(trayBounds, emptyTrayPanelFeed);

    expect(browserWindowCtor).toHaveBeenCalledTimes(1);
    expect(browserWindowCtor.mock.calls[0][0]).not.toHaveProperty('type', 'panel');
  });

  it('never lets the all-workspaces call hide the Dock', () => {
    // On macOS `visibleOnFullScreen: true` makes Electron call its own
    // DockHide() unless `skipTransformProcessType` is set. The re-assert below
    // races that transform and can lose, leaving the app out of the Dock.
    toggleTrayPanelWindow(trayBounds, emptyTrayPanelFeed);

    expect(browserWindowCtor.instance.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ skipTransformProcessType: true }),
    );
  });

  it('reasserts the regular activation policy and puts the Dock icon back', () => {
    // Dropping `type: 'panel'` was not enough on its own -- creating this window
    // still demotes the app, and without the re-assert Nimbalyst vanishes from
    // Cmd+Tab the moment the panel opens.
    //
    // The icon call is not decoration. Setting an activation policy rebuilds the
    // Dock tile and discards the runtime icon, so re-asserting the policy on its
    // own swapped the Nimbalyst icon for the stock Electron one in dev. Asserting
    // the order keeps the pair from being split up again.
    toggleTrayPanelWindow(trayBounds, emptyTrayPanelFeed);

    expect(appMock.setActivationPolicy).toHaveBeenCalledWith('regular');
    expect(applyDockIconMock).toHaveBeenCalled();
    expect(appMock.setActivationPolicy.mock.invocationCallOrder[0])
      .toBeLessThan(applyDockIconMock.mock.invocationCallOrder[0]);
  });
});
