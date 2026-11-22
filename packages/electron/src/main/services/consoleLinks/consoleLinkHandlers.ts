/**
 * Electron wiring for `consoleLinkRouter`: the one router instance, the
 * window's answer channel, and the deep-link entry.
 */
import type { BrowserWindow, WebContents } from 'electron';

import { safeOn } from '../../utils/ipcRegistry';
import { openExternalInBackground } from '../../utils/systemShell';
import {
  CONSOLE_LINK_RESULT_CHANNEL,
  createConsoleLinkRouter,
  type ConsoleLinkResult,
} from './consoleLinkRouter';

type FeedbackRequestOpener = (target: { orgId: string; requestId: string }) => Promise<boolean>;

/** Set by the deep-link routing; until then a feedback link goes to the browser. */
let feedbackRequestOpener: FeedbackRequestOpener | null = null;

export function setConsoleFeedbackRequestOpener(opener: FeedbackRequestOpener): void {
  feedbackRequestOpener = opener;
}

const router = createConsoleLinkRouter({
  openExternal: (url) => {
    openExternalInBackground(url);
  },
  openFeedbackRequest: (target) => (feedbackRequestOpener ? feedbackRequestOpener(target) : Promise.resolve(false)),
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
