import { BrowserWindow } from 'electron';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { setResolvedTitleBarOverlayColors } from '../window/windowChrome';
import { getWindowMenuBar, invokeWindowMenuItem } from '../menu/menuBarBridge';
import { WINDOW_MENU_CHANNELS } from '../../shared/menuBar';
import { WINDOW_FULL_SCREEN_CHANNELS, readCssColor } from '../../shared/windowChrome';
import { setThemeBackgroundColor } from '../utils/store';

let handlersRegistered = false;

export function registerWindowChromeHandlers(): void {
  if (handlersRegistered) return;

  safeOn('window-chrome:set-overlay-colors', (_event, payload: unknown) => {
    setResolvedTitleBarOverlayColors(payload);

    // The same report carries the theme's resolved --nim-bg. Persisting it is
    // what lets the next launch open on the real colour instead of a base
    // light/dark stand-in.
    const backgroundColor = readCssColor((payload as { backgroundColor?: unknown } | null)?.backgroundColor);
    if (backgroundColor) {
      // A listener that throws becomes Electron's native main-process error
      // dialog; losing one launch-colour write is harmless.
      try {
        setThemeBackgroundColor(backgroundColor);
      } catch (error) {
        console.warn('[WindowChrome] Could not persist theme background colour:', error);
      }
    }
  });

  safeHandle(WINDOW_MENU_CHANNELS.get, () => getWindowMenuBar());

  safeHandle(WINDOW_MENU_CHANNELS.invoke, (event, id: unknown, revision: unknown) => {
    if (typeof id !== 'string' || typeof revision !== 'number') {
      return { invoked: false };
    }
    return invokeWindowMenuItem(id, revision, BrowserWindow.fromWebContents(event.sender));
  });

  safeHandle(WINDOW_FULL_SCREEN_CHANNELS.get, (event) =>
    BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false);

  safeOn(WINDOW_FULL_SCREEN_CHANNELS.exit, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) {
      window.setFullScreen(false);
    }
  });

  handlersRegistered = true;
}
