import { app, BrowserWindow, screen } from 'electron';
import { join } from 'path';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { getPreloadPath } from '../utils/appPaths';
import { getIslandDisplay, getTheme, setIslandDisplay } from '../utils/store';
import { logger } from '../utils/logger';
import { applyDockIcon } from '../utils/dockIcon';
import { loadTrayGlyphDataUri } from '../tray/trayGlyph';
import {
  MENU_BAR_ISLAND_CHANNELS,
  type IslandRect,
  type MenuBarIslandSettingChange,
  type MenuBarIslandState,
} from '../../shared/menuBarIsland';
import {
  ISLAND_WINDOW_HEIGHT,
  ISLAND_WINDOW_WIDTH,
  islandPlacement,
  isCursorOverIsland,
  isDragGesture,
  nextHoverState,
  resolveIslandDisplay,
  type HoverState,
  type IslandPlacement,
} from './islandGeometry';
import { markWindowTransparent } from './transparentWindows';

/**
 * The menu bar island: the second render style for the fleet strip.
 *
 * A transparent, click-through window drawn *inside* the menu bar row, which
 * expands downward into the same session rows the tray panel shows. The tray
 * bitmap strip (`TrayStripRenderer`) is the other style; `trayStripStyle`
 * picks between them and TrayManager routes to one or the other.
 *
 * The window recipe below is not a matter of taste -- every line was measured
 * against a real compositor in `nimbalyst-local/spikes/menu-bar-island/`, and
 * the two annotated ones are load-bearing. macOS only: it draws over the menu
 * bar, which Windows and Linux have no equivalent of.
 */

/** Cursor poll. Fast enough that hover feels instant, cheap enough to leave on. */
const POLL_MS = 90;
/** Keep Vite's full-page development overlay off the island's oversized canvas. */
const HIDE_VITE_ERROR_OVERLAY_CSS = 'vite-error-overlay { display: none !important; }';

let islandWindow: BrowserWindow | null = null;
let islandRendererReady = false;
let pollTimer: NodeJS.Timeout | null = null;
let islandRect: IslandRect = { left: 0, top: 0, width: 0, height: 0 };
let hover: HoverState = { hovered: false, outsideSince: 0 };
let pinned = false;
/**
 * The in-flight press on the pill, or null.
 *
 * `origin` is where the cursor was when the press began; comparing it to the
 * release decides whether the user meant to move the island or to pin it. The
 * pill is the only handle the island has, so it has to carry both.
 */
let dragging: { origin: { x: number; y: number }; displayId: number } | null = null;
let ignoringMouse = true;
/** The fleet's half of the frame. `expanded` and `anchor` are main's, added on push. */
let latestState: Omit<MenuBarIslandState, 'expanded' | 'anchor'> | null = null;
let onSelectSession: ((sessionId: string, workspacePath: string) => void) | null = null;
let onNewSession: (() => void) | null = null;
let onOpenApp: (() => void) | null = null;
let onSettingChange: ((change: MenuBarIslandSettingChange) => void) | null = null;
let onClearAllUnread: (() => void) | null = null;
/**
 * Told whenever the panel opens or closes, so the owner can fetch the per-row
 * snippets only while they are on screen. Nothing else needs them.
 */
let onExpandedChange: ((expanded: boolean) => void) | null = null;

export function isMenuBarIslandSupported(): boolean {
  return process.platform === 'darwin';
}

function loadIslandRenderer(window: BrowserWindow): void {
  const query: Record<string, string> = { mode: 'menu-bar-island', theme: getTheme() };

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

/**
 * The display the island belongs on: the user's dragged choice, or the primary.
 *
 * Resolved on every read rather than cached, because the answer changes without
 * anyone telling us -- unplugging the chosen monitor has to fall back to the
 * primary, and it is `resolveIslandDisplay` that guarantees we never place the
 * island on a screen that is no longer there.
 */
function targetDisplay(): Electron.Display {
  return resolveIslandDisplay(
    screen.getAllDisplays(),
    screen.getPrimaryDisplay(),
    getIslandDisplay(),
  );
}

/**
 * Where the island sits. Follows the menu bar the user put it on.
 *
 * Recomputed rather than cached because it also decides the anchor, and a
 * display change (external monitor, scaling) has to be able to move the island
 * out from behind a notch that was not there before.
 */
function targetPlacement(): IslandPlacement {
  return islandPlacement(targetDisplay());
}

/** Move the window onto a display, and tell the renderer which edge to hug. */
function applyPlacement(display: Electron.Display): void {
  if (!islandWindow || islandWindow.isDestroyed()) return;
  const { anchor: _anchor, ...bounds } = islandPlacement(display);
  islandWindow.setBounds(bounds);
  // The anchor rides on the frame, and crossing onto a notched display changes
  // it -- so this push is not merely cosmetic, it is what stops the island
  // landing under the camera housing on arrival.
  pushState();
}

function createIslandWindow(): BrowserWindow {
  const { anchor: _anchor, ...bounds } = targetPlacement();
  islandRendererReady = false;

  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Never takes key focus, so hovering the island cannot pull the user out of
    // whatever app is frontmost. Unlike `type: 'panel'` -- which the tray panel
    // documents as demoting the whole app to the accessory activation policy,
    // stripping the Dock icon and the Cmd+Tab entry -- this does not.
    focusable: false,
    acceptFirstMouse: true,
    // REQUIRED, and the single non-obvious line here. Without it AppKit's
    // `constrainFrameRect:` snaps y from the display top down to the bottom of
    // the menu bar the moment the window becomes visible, and no window level
    // overrides that. The island would silently become an ordinary panel
    // floating under the menu bar.
    enableLargerThanScreen: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: getPreloadPath(),
      webviewTag: false,
    },
  });

  // Keeps the theme sweep from painting this window opaque, which is what put a
  // dark 760x460 slab over the top of the screen on every theme change (#4817).
  markWindowTransparent(window);

  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setIgnoreMouseEvents(true, { forward: true });

  screen.on('display-metrics-changed', handleDisplayChange);
  screen.on('display-added', handleDisplayChange);
  screen.on('display-removed', handleDisplayChange);

  window.on('closed', () => {
    screen.removeListener('display-metrics-changed', handleDisplayChange);
    screen.removeListener('display-added', handleDisplayChange);
    screen.removeListener('display-removed', handleDisplayChange);
    islandWindow = null;
    stopPolling();
  });

  // The other half of "click anywhere else to close". Pinning focuses the
  // window precisely so that this can fire; without it a click outside the
  // window's own bounds is never delivered to us at all and the panel stays
  // open forever.
  window.on('blur', () => {
    if (pinned) setPinned(false);
  });

  loadIslandRenderer(window);

  window.webContents.once('did-finish-load', () => {
    void finishIslandLoad(window);
  });

  async function finishIslandLoad(loadedWindow: BrowserWindow): Promise<void> {
    if (process.env.NODE_ENV === 'development') {
      try {
        await loadedWindow.webContents.insertCSS(HIDE_VITE_ERROR_OVERLAY_CSS);
      } catch (error) {
        logger.main.error('[MenuBarIsland] Refusing to show without the Vite overlay guard:', error);
        return;
      }
    }

    if (loadedWindow.isDestroyed() || islandWindow !== loadedWindow) return;
    islandRendererReady = true;
    // NSStatusWindowLevel. Enough to clear the menu bar and to stay visible over
    // another app's full-screen space; screen-saver level is not needed.
    loadedWindow.setAlwaysOnTop(true, 'status');
    // Re-assert the bounds now that the level is above the menu bar.
    const { anchor: _anchor, ...bounds } = targetPlacement();
    loadedWindow.setBounds(bounds);
    loadedWindow.showInactive();
    // The renderer pulls the glyph and its first frame itself once mounted --
    // see `requestInit`. Pushing here would land before React subscribes.
  }

  // The tray panel found that creating a window with this shape can demote the
  // app's activation policy, which strips the Dock icon and the Cmd+Tab entry
  // for the whole app. Setting a policy rebuilds the Dock tile and discards the
  // runtime icon, so the two calls belong together.
  if (process.platform === 'darwin') {
    app.setActivationPolicy('regular');
    applyDockIcon();
  }

  return window;
}

// ─── Hover, by polling the cursor ────────────────────────────────────────────

function pollCursor(): void {
  if (!islandWindow || islandWindow.isDestroyed()) return;

  const inside = isCursorOverIsland(
    screen.getCursorScreenPoint(),
    islandWindow.getBounds(),
    islandRect,
  );
  // A drag holds the island open exactly as pinning does. Without this the
  // cursor leaves the island the instant it starts moving, the poll collapses
  // it and makes the window click-through again, and the press the user is
  // still holding stops being delivered -- the drag dies a few pixels in.
  const next = nextHoverState(hover, { inside, pinned: pinned || !!dragging, now: Date.now() });
  const changed = next.hovered !== hover.hovered;
  hover = next;
  if (!changed) return;

  // Interactive only while the cursor is actually over the island, so the rest
  // of the menu bar keeps receiving its own clicks.
  setIgnoreMouse(!hover.hovered);
  pushState();
  onExpandedChange?.(hover.hovered);
}

/**
 * Pin the panel open, or release it.
 *
 * Pinning takes key focus, which the island otherwise never does. That is the
 * only mechanism that can notice a click landing somewhere else on screen: the
 * window is click-through and unfocused at rest, so nothing outside its own
 * bounds is ever delivered to it. The cost is that pinning activates Nimbalyst
 * -- the same trade the tray panel already makes, and here it follows a
 * deliberate click rather than a hover.
 */
function setPinned(next: boolean): void {
  if (next === pinned) return;
  pinned = next;
  if (!islandWindow || islandWindow.isDestroyed()) return;

  if (pinned) {
    islandWindow.setFocusable(true);
    islandWindow.focus();
    hover = { hovered: true, outsideSince: 0 };
  } else {
    // Back to never taking focus, so plain hovering cannot pull the user out of
    // whatever app is frontmost.
    islandWindow.setFocusable(false);
    // Hand the decision back to the poll rather than forcing a collapse: the
    // cursor may still be sitting on the island, in which case releasing the
    // pin should leave it open.
    const inside = isCursorOverIsland(
      screen.getCursorScreenPoint(),
      islandWindow.getBounds(),
      islandRect,
    );
    hover = { hovered: inside, outsideSince: inside ? 0 : Date.now() };
  }

  setIgnoreMouse(!hover.hovered);
  pushState();
  onExpandedChange?.(hover.hovered);
}

function setIgnoreMouse(ignore: boolean): void {
  if (ignore === ignoringMouse) return;
  ignoringMouse = ignore;
  islandWindow?.setIgnoreMouseEvents(ignore, { forward: true });
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(pollCursor, POLL_MS);
  // Nothing in the menu bar is worth keeping the event loop alive for.
  pollTimer.unref?.();
}

function stopPolling(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function pushState(): void {
  if (!islandWindow || islandWindow.isDestroyed() || !latestState) return;
  islandWindow.webContents.send(MENU_BAR_ISLAND_CHANNELS.state, currentFrame());
}

/** The frame as the renderer should see it: the fleet, plus what main owns. */
function currentFrame(): MenuBarIslandState | null {
  if (!latestState) return null;
  return { ...latestState, expanded: hover.hovered, anchor: targetPlacement().anchor };
}

/**
 * Follow the display the island is drawn on.
 *
 * Both halves of the placement can change under us: the bounds when a monitor
 * arrives or the resolution changes, and the *anchor* when the primary display
 * becomes (or stops being) a notched one -- docking a MacBook does both. The
 * window outlives those events, because an idle fleet hides it rather than
 * destroying it, so without this it would keep a placement chosen for a screen
 * that is no longer there.
 */
function handleDisplayChange(): void {
  if (!islandWindow || islandWindow.isDestroyed()) return;
  const { anchor: _anchor, ...bounds } = targetPlacement();
  islandWindow.setBounds(bounds);
  pushState();
}

// ─── Public surface ──────────────────────────────────────────────────────────

/**
 * Paint a frame, creating the window on first use.
 *
 * Created lazily so a user who never turns the island on never pays for it, and
 * so the window does not exist before the first fleet state arrives.
 *
 * There is no hidden state. The island used to disappear when the fleet went
 * quiet, on the reasoning that the tray icon was still there to open the panel
 * with -- and it is not, now that island mode removes the tray item. A quiet
 * fleet collapses the strip to a bare glyph instead, which is the same one small
 * mark the tray item was, in the place the user is now looking.
 */
export function showMenuBarIsland(state: Omit<MenuBarIslandState, 'expanded' | 'anchor'>): void {
  if (!isMenuBarIslandSupported()) return;

  latestState = state;

  if (!islandWindow || islandWindow.isDestroyed()) {
    islandWindow = createIslandWindow();
    startPolling();
    return;
  }
  if (islandRendererReady && !islandWindow.isVisible()) islandWindow.showInactive();
  startPolling();
  pushState();
}

/** Tear the island down -- style switched away, or fleet status turned off. */
export function closeMenuBarIsland(): void {
  stopPolling();
  hover = { hovered: false, outsideSince: 0 };
  pinned = false;
  dragging = null;
  ignoringMouse = true;
  islandRendererReady = false;
  islandRect = { left: 0, top: 0, width: 0, height: 0 };
  latestState = null;
  if (islandWindow && !islandWindow.isDestroyed()) islandWindow.destroy();
  islandWindow = null;
}

/**
 * Whether this is the island window.
 *
 * It is a `BrowserWindow`, so it shows up in `getAllWindows()` alongside project
 * windows. Anything that means "a window the user works in" has to exclude it,
 * exactly as it already excludes the tray panel.
 */
export function isMenuBarIslandWindow(window: BrowserWindow): boolean {
  return !!islandWindow && !islandWindow.isDestroyed() && window === islandWindow;
}

/** Only the island's own renderer may drive these actions. */
function isIslandSender(event: Electron.IpcMainEvent): boolean {
  return isIslandWebContents(event.sender);
}

function isIslandSenderInvoke(event: Electron.IpcMainInvokeEvent): boolean {
  return isIslandWebContents(event.sender);
}

function isIslandWebContents(sender: Electron.WebContents): boolean {
  return !!(
    islandWindow
    && !islandWindow.isDestroyed()
    && sender === islandWindow.webContents
  );
}

export function setupMenuBarIslandHandlers(dependencies: {
  onSelectSession: (sessionId: string, workspacePath: string) => void;
  onExpandedChange: (expanded: boolean) => void;
  onNewSession: () => void;
  onOpenApp: () => void;
  onSettingChange: (change: MenuBarIslandSettingChange) => void;
  onClearAllUnread: () => void;
}): void {
  onSelectSession = dependencies.onSelectSession;
  onExpandedChange = dependencies.onExpandedChange;
  onNewSession = dependencies.onNewSession;
  onOpenApp = dependencies.onOpenApp;
  onSettingChange = dependencies.onSettingChange;
  onClearAllUnread = dependencies.onClearAllUnread;

  safeHandle(MENU_BAR_ISLAND_CHANNELS.requestInit, async (event) => {
    if (!isIslandSenderInvoke(event)) return null;
    return {
      glyph: loadTrayGlyphDataUri(),
      state: currentFrame(),
    };
  });

  safeOn(MENU_BAR_ISLAND_CHANNELS.rect, (event, rect: IslandRect) => {
    if (!isIslandSender(event) || !rect) return;
    islandRect = rect;
  });

  safeOn(MENU_BAR_ISLAND_CHANNELS.dragStart, (event) => {
    if (!isIslandSender(event)) return;
    dragging = { origin: screen.getCursorScreenPoint(), displayId: targetDisplay().id };
    // Hold the panel open for the duration; see the note in `pollCursor`.
    hover = { hovered: true, outsideSince: 0 };
    setIgnoreMouse(false);
  });

  safeOn(MENU_BAR_ISLAND_CHANNELS.dragMove, (event) => {
    if (!isIslandSender(event) || !dragging) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    // Only the *display* is a degree of freedom. The island is pinned to the
    // menu bar row and its x is whatever the placement says, so there is
    // nothing to follow within a screen -- it hops when the cursor crosses.
    if (display.id === dragging.displayId) return;
    dragging.displayId = display.id;
    applyPlacement(display);
  });

  safeOn(MENU_BAR_ISLAND_CHANNELS.dragEnd, (event) => {
    if (!isIslandSender(event) || !dragging) return;
    const { origin } = dragging;
    dragging = null;

    const cursor = screen.getCursorScreenPoint();
    if (!isDragGesture(origin, cursor)) {
      // The press never really moved, so it was the pin toggle. Releasing the
      // drag hold first means `setPinned` sees the true resting state.
      setPinned(!pinned);
      return;
    }

    const display = screen.getDisplayNearestPoint(cursor);
    setIslandDisplay({ id: display.id, label: display.label });
    applyPlacement(display);
    // The drag was holding the panel open. Hand the decision back to the poll
    // rather than forcing either state: the cursor may have been released on
    // the island or well away from it.
    hover = { hovered: true, outsideSince: Date.now() };
  });

  safeOn(MENU_BAR_ISLAND_CHANNELS.dismiss, (event) => {
    if (!isIslandSender(event)) return;
    if (pinned) {
      setPinned(false);
      return;
    }
    // Not pinned, so there is no focus to drop -- just close and let the poll
    // re-open it if the cursor really is still on the island.
    hover = { hovered: false, outsideSince: 0 };
    setIgnoreMouse(true);
    pushState();
  });

  safeOn(MENU_BAR_ISLAND_CHANNELS.selectSession, (event, payload: { sessionId?: string; workspacePath?: string }) => {
    if (!isIslandSender(event)) return;
    const { sessionId, workspacePath } = payload ?? {};
    if (!sessionId || !workspacePath) {
      logger.main.warn('[MenuBarIsland] Ignoring select-session without a session and workspace');
      return;
    }
    // Acting on a row dismisses the panel; leaving it pinned open over the app
    // the user just jumped to would be in the way.
    setPinned(false);
    hover = { hovered: false, outsideSince: 0 };
    setIgnoreMouse(true);
    pushState();
    onSelectSession?.(sessionId, workspacePath);
  });

  safeOn(MENU_BAR_ISLAND_CHANNELS.setPinned, (event, payload: { pinned?: boolean }) => {
    if (!isIslandSender(event)) return;
    setPinned(!!payload?.pinned);
  });

  safeOn(MENU_BAR_ISLAND_CHANNELS.setSetting, (event, change: MenuBarIslandSettingChange) => {
    if (!isIslandSender(event) || !change?.key) return;
    // Switching the style away destroys this very window, so the pin has to be
    // released first -- `closeMenuBarIsland` resets the flag but the focused,
    // focusable window would already be gone by then.
    if (change.key === 'style' || change.key === 'showFleetStatus') setPinned(false);
    onSettingChange?.(change);
  });

  safeOn(MENU_BAR_ISLAND_CHANNELS.newSession, (event) => {
    if (!isIslandSender(event)) return;
    setPinned(false);
    onNewSession?.();
  });

  safeOn(MENU_BAR_ISLAND_CHANNELS.openApp, (event) => {
    if (!isIslandSender(event)) return;
    setPinned(false);
    onOpenApp?.();
  });

  /*
   * Unlike the footer's actions this one does not close the panel: the user is
   * still looking at the fleet, and the point of the button is to watch the
   * unread section go. The panel shrinks as it does, so the renderer republishes
   * its rect and the cursor poll re-tests hover against the new size.
   */
  safeOn(MENU_BAR_ISLAND_CHANNELS.clearAllUnread, (event) => {
    if (!isIslandSender(event)) return;
    onClearAllUnread?.();
  });
}

export const __testing = {
  ISLAND_WINDOW_WIDTH,
  ISLAND_WINDOW_HEIGHT,
};
