/**
 * Electron wiring for `consoleLinkRouter`: the one router instance, the
 * window's answer channel, and the deep-link entry.
 */
import { shell, type BrowserWindow, type WebContents } from 'electron';

import { safeOn } from '../../utils/ipcRegistry';
import {
  CONSOLE_LINK_RESULT_CHANNEL,
  createConsoleLinkRouter,
  type ConsoleLinkResult,
} from './consoleLinkRouter';

const router = createConsoleLinkRouter({
  openExternal: (url) => {
    void shell.openExternal(url);
  },
});

export function registerConsoleLinkHandlers(): void {
  safeOn(CONSOLE_LINK_RESULT_CHANNEL, (_event, result: ConsoleLinkResult) => {
    router.settle(result?.requestId, result?.handled === true);
  });
}

/** True when `url` is a console link, now on its way to `contents` (or the browser if it cannot open it). */
export function routeConsoleLink(url: string, contents: WebContents | null): boolean {
  return router.route(url, contents);
}

/** True when `deepLink` is `nimbalyst://console/...`; it opens in `window`, never the browser. */
export function openConsoleDeepLink(deepLink: string, window: BrowserWindow | null): boolean {
  if (!deepLink.startsWith('nimbalyst://console/')) return false;
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
  return router.routeDeepLink(deepLink, window && !window.isDestroyed() ? window.webContents : null);
}
