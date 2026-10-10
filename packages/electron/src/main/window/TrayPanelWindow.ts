import { app, BrowserWindow, screen, type Rectangle } from 'electron';
import { join } from 'path';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { getPreloadPath } from '../utils/appPaths';
import { getTheme, getTrayPanelWidth, setTrayPanelWidth } from '../utils/store';
import { logger } from '../utils/logger';
import { applyDockIcon } from '../utils/dockIcon';
import {
  TRAY_PANEL_CHANNELS,
  emptyTrayPanelFeed,
  type TrayPanelFeed,
} from '../../shared/traySessions';
import { markWindowTransparent } from './transparentWindows';

/**
 * Tray sessions panel.
 *
 * A `Tray` context menu is a real `NSMenu`, and Electron exposes no binding for
 * `NSMenuItem.view`, so the app's session rows can never live inside it. This is
 * the standard menu-bar-app answer instead: skip the menu, open a frameless
 * vibrant `BrowserWindow` anchored to the tray icon, and render the same React
 * rows the in-app popover uses (`?mode=tray-panel`, same pattern as
 * TeamManagementWindow).
 *
 * macOS only. `type: 'panel'` and `vibrancy` have no Windows/Linux equivalent,
 * so those platforms keep the native session menu — see TrayManager.
 */

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 300;
const MAX_WIDTH = 640;
const PANEL_HEIGHT = 460;
/** Gap between the menu bar and the top of the panel, matching native menu inset. */
const TRAY_GAP = 6;
/** Keep the panel off the very edge of the work area. */
const EDGE_PADDING = 8;

let trayPanelWindow: BrowserWindow | null = null;
let latestFeed: TrayPanelFeed = emptyTrayPanelFeed();
/**
 * When the panel is open and the user clicks the tray icon, macOS blurs the
 * panel (which hides it) *before* delivering the click. Without this the toggle
 * always sees a hidden panel and re-opens it, so the icon can never close it.
 */
let lastAutoHideAt = 0;
const REOPEN_SUPPRESSION_MS = 250;

export function isTrayPanelSupported(): boolean {
  return process.platform === 'darwin';
}

export function trayPanelWidth(): number {
  const stored = getTrayPanelWidth();
  if (typeof stored !== 'number' || Number.isNaN(stored)) return DEFAULT_WIDTH;
  return Math.round(Math.min(Math.max(stored, MIN_WIDTH), MAX_WIDTH));
}

/**
 * Centre the panel under the tray icon, then pull it back inside the work area.
 *
 * The clamp is not optional polish: the icon can sit within half a panel width
 * of the right edge of the display (the common case — the tray is right-aligned)
 * or on a secondary display whose origin is negative, and an unclamped panel is
 * created off-screen where it can never be dismissed.
 */
export function computeTrayPanelPosition(
  trayBounds: Rectangle,
  workArea: Rectangle,
  size: { width: number; height: number },
): { x: number; y: number } {
  const centeredX = Math.round(trayBounds.x + trayBounds.width / 2 - size.width / 2);
  const minX = workArea.x + EDGE_PADDING;
  const maxX = workArea.x + workArea.width - size.width - EDGE_PADDING;
  const x = maxX < minX ? minX : Math.min(Math.max(centeredX, minX), maxX);

  const belowTray = Math.round(trayBounds.y + trayBounds.height + TRAY_GAP);
  const minY = workArea.y + EDGE_PADDING;
  const maxY = workArea.y + workArea.height - size.height - EDGE_PADDING;
  const y = maxY < minY ? minY : Math.min(Math.max(belowTray, minY), maxY);

  return { x, y };
}

function resolvePanelBounds(trayBounds: Rectangle): Rectangle {
  const width = trayPanelWidth();
  const anchor = {
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2),
  };
  const { workArea } = screen.getDisplayNearestPoint(anchor);
  const height = Math.min(PANEL_HEIGHT, Math.max(200, workArea.height - EDGE_PADDING * 2));
  const { x, y } = computeTrayPanelPosition(trayBounds, workArea, { width, height });
  return { x, y, width, height };
}

function loadPanelRenderer(window: BrowserWindow): void {
  const query: Record<string, string> = { mode: 'tray-panel', theme: getTheme() };

  if (process.env.NODE_ENV === 'development') {
    const devPort = process.env.VITE_PORT || '5273';
    const search = new URLSearchParams(query).toString();
    void window.loadURL(`http://localhost:${devPort}/?${search}`);
    return;
  }

  const appPath = app.getAppPath();
  let htmlPath: string;
  if (app.isPackaged) {
    htmlPath = join(appPath, 'out/renderer/index.html');
  } else if (appPath.includes('/out/main') || appPath.includes('\\out\\main')) {
    htmlPath = join(appPath, '../renderer/index.html');
  } else {
    htmlPath = join(appPath, 'out/renderer/index.html');
  }
  void window.loadFile(htmlPath, { query });
}

function createTrayPanelWindow(bounds: Rectangle): BrowserWindow {
  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    roundedCorners: true,
    vibrancy: 'popover',
    visualEffectState: 'active',
    // NOT `type: 'panel'`. An NSPanel would float over full-screen apps without
    // activating Nimbalyst, but Electron puts NSApp into the accessory
    // activation policy to do it -- which strips the Dock icon and the Cmd+Tab
    // entry for the whole app. Because this window is created on the first tray
    // click, opening the panel made Nimbalyst unreachable from the app switcher,
    // with the panel's own "Open Nimbalyst" button the only way back to a
    // project window. `alwaysOnTop` at the floating level plus
    // `visibleOnFullScreen` below covers the float-over behaviour; the panel
    // activating the app when opened is the accepted cost.
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: getPreloadPath(),
      webviewTag: false,
    },
  });

  // Keeps the theme sweep from calling setBackgroundColor here, which would
  // replace the `popover` vibrancy with a flat opaque colour (#4817).
  markWindowTransparent(window);

  // On macOS, `visibleOnFullScreen: true` makes Electron call its own
  // DockHide() -- transforming the whole process to a UI-element app, which
  // strips the Dock icon and the Cmd+Tab entry -- unless
  // `skipTransformProcessType` is set. That transform is what kept demoting the
  // app after `type: 'panel'` was dropped.
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  window.setAlwaysOnTop(true, 'floating');

  // Backstop for any other path that demotes the app to the accessory
  // activation policy. Electron exposes no `getActivationPolicy` to test
  // against, and nothing in the app ever wants a non-regular policy (the one
  // `dock.hide()` is for ELECTRON_RUN_AS_NODE, which has no tray at all).
  //
  // Setting a policy rebuilds the Dock tile and discards the runtime icon, so
  // the icon has to go back immediately after or dev reverts to the stock
  // Electron icon. The two calls belong together; neither works alone.
  if (process.platform === 'darwin') {
    app.setActivationPolicy('regular');
    applyDockIcon();
  }

  window.on('blur', () => {
    if (window.isDestroyed() || !window.isVisible()) return;
    lastAutoHideAt = Date.now();
    window.hide();
  });

  window.on('closed', () => {
    trayPanelWindow = null;
  });

  loadPanelRenderer(window);
  return window;
}

/**
 * Open the panel anchored to the tray icon, or hide it if it is already showing.
 *
 * `getFeed` is called at open time rather than passed as a value so the panel
 * always paints the current cache, even if no state event has fired since the
 * last debounced push.
 */
export function toggleTrayPanelWindow(
  trayBounds: Rectangle,
  getFeed: () => TrayPanelFeed,
): void {
  if (!isTrayPanelSupported()) return;

  if (trayPanelWindow && !trayPanelWindow.isDestroyed() && trayPanelWindow.isVisible()) {
    lastAutoHideAt = Date.now();
    trayPanelWindow.hide();
    return;
  }

  // The blur that the tray click itself caused already closed the panel; this
  // click is the close, not a request to re-open.
  if (Date.now() - lastAutoHideAt < REOPEN_SUPPRESSION_MS) return;

  latestFeed = getFeed();

  if (!trayPanelWindow || trayPanelWindow.isDestroyed()) {
    // Created lazily on the first tray click -- an unopened panel costs nothing.
    trayPanelWindow = createTrayPanelWindow(resolvePanelBounds(trayBounds));
    trayPanelWindow.once('ready-to-show', () => {
      if (!trayPanelWindow || trayPanelWindow.isDestroyed()) return;
      // `type: 'panel'` gives key-window status without activating Nimbalyst,
      // so the panel can take Escape and lose focus to hide without pulling the
      // user out of whatever app was frontmost.
      trayPanelWindow.show();
      trayPanelWindow.focus();
    });
    return;
  }

  trayPanelWindow.setBounds(resolvePanelBounds(trayBounds));
  pushTrayPanelFeed(latestFeed);
  trayPanelWindow.show();
  trayPanelWindow.focus();
}

/** Push a new feed to an open panel. No-op when the panel has never been opened. */
export function pushTrayPanelFeed(feed: TrayPanelFeed): void {
  latestFeed = feed;
  if (!trayPanelWindow || trayPanelWindow.isDestroyed()) return;
  trayPanelWindow.webContents.send(TRAY_PANEL_CHANNELS.sessions, feed);
}

/**
 * Whether this is the tray panel.
 *
 * The panel is a `BrowserWindow`, so it shows up in `getAllWindows()` alongside
 * project windows. Anything that means "a window the user works in" -- picking a
 * window to focus, deciding whether the app is in the foreground -- has to
 * exclude it, or the panel answers for the app.
 */
export function isTrayPanelWindow(window: BrowserWindow): boolean {
  return !!trayPanelWindow && !trayPanelWindow.isDestroyed() && window === trayPanelWindow;
}

export function hideTrayPanelWindow(): void {
  if (trayPanelWindow && !trayPanelWindow.isDestroyed()) trayPanelWindow.hide();
}

export function closeTrayPanelWindow(): void {
  if (trayPanelWindow && !trayPanelWindow.isDestroyed()) trayPanelWindow.destroy();
  trayPanelWindow = null;
}

export interface TrayPanelHandlerDependencies {
  getFeed: () => TrayPanelFeed;
  onSelectSession: (sessionId: string, workspacePath: string) => void;
  onNewSession: () => void;
  onOpenApp: () => void;
  onClearAllUnread: () => void;
}

/** Only the panel's own renderer may drive these actions. */
function isPanelSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return !!(
    trayPanelWindow
    && !trayPanelWindow.isDestroyed()
    && event.sender === trayPanelWindow.webContents
  );
}

export function setupTrayPanelHandlers(dependencies: TrayPanelHandlerDependencies): void {
  safeHandle(TRAY_PANEL_CHANNELS.requestSessions, async (event) => {
    if (!isPanelSender(event)) return emptyTrayPanelFeed();
    latestFeed = dependencies.getFeed();
    return latestFeed;
  });

  safeOn(TRAY_PANEL_CHANNELS.selectSession, (event, payload: { sessionId?: string; workspacePath?: string }) => {
    if (!isPanelSender(event)) return;
    const { sessionId, workspacePath } = payload ?? {};
    if (!sessionId || !workspacePath) {
      logger.main.warn('[TrayPanel] Ignoring select-session without a session and workspace');
      return;
    }
    hideTrayPanelWindow();
    dependencies.onSelectSession(sessionId, workspacePath);
  });

  safeOn(TRAY_PANEL_CHANNELS.newSession, (event) => {
    if (!isPanelSender(event)) return;
    hideTrayPanelWindow();
    dependencies.onNewSession();
  });

  safeOn(TRAY_PANEL_CHANNELS.openApp, (event) => {
    if (!isPanelSender(event)) return;
    hideTrayPanelWindow();
    dependencies.onOpenApp();
  });

  safeOn(TRAY_PANEL_CHANNELS.clearAllUnread, (event) => {
    if (!isPanelSender(event)) return;
    dependencies.onClearAllUnread();
  });

  safeOn(TRAY_PANEL_CHANNELS.close, (event) => {
    if (!isPanelSender(event)) return;
    hideTrayPanelWindow();
  });

  safeOn('tray-panel:set-width', (event, width: number) => {
    if (!isPanelSender(event) || typeof width !== 'number' || Number.isNaN(width)) return;
    const clamped = Math.round(Math.min(Math.max(width, MIN_WIDTH), MAX_WIDTH));
    setTrayPanelWidth(clamped);
    if (trayPanelWindow && !trayPanelWindow.isDestroyed()) {
      const bounds = trayPanelWindow.getBounds();
      trayPanelWindow.setBounds({ ...bounds, width: clamped });
    }
  });
}
