/**
 * Console links open in the app.
 *
 * Page content links to pages, typed pages, types, views and citations with
 * `https://console.nimbalyst.com/...` URLs. When one is about to leave for the
 * browser (the `open-external` IPC, or a `window.open` from an editor), it is
 * handed to the window instead, which opens the target when it is in this
 * workspace (`renderer/utils/openConsoleLink.ts`). The window answers; if it
 * cannot open it, or does not answer in time, the link goes to the browser as
 * before, where the console shows it.
 *
 * A link that arrived from the console as `nimbalyst://console/...` is never
 * sent back to the browser: the console only redirects links it cannot show,
 * so that would bounce between the two. The window says why it did not open.
 *
 * No Electron imports, so the routing is tested with fake windows.
 */
import { consoleLinkFromDeepLink, isConsoleLink } from '@nimbalyst/collab-protocol';

export const CONSOLE_LINK_OPEN_CHANNEL = 'console-link:open';
export const CONSOLE_LINK_RESULT_CHANNEL = 'console-link:result';

export interface ConsoleLinkOpenRequest {
  requestId: string;
  url: string;
  fromDeepLink: boolean;
}

export interface ConsoleLinkResult {
  requestId: string;
  handled: boolean;
}

interface WindowTarget {
  send(channel: string, payload: ConsoleLinkOpenRequest): void;
  isDestroyed(): boolean;
}

export interface ConsoleLinkRouterOptions {
  openExternal: (url: string) => void;
  /** How long a window gets to answer before the browser opens the link. */
  ackTimeoutMs?: number;
}

export function createConsoleLinkRouter({ openExternal, ackTimeoutMs = 3000 }: ConsoleLinkRouterOptions) {
  const pending = new Map<string, { url: string; fromDeepLink: boolean; timer: ReturnType<typeof setTimeout> }>();
  let counter = 0;

  function settle(requestId: string | undefined, handled: boolean): void {
    const entry = requestId ? pending.get(requestId) : undefined;
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(requestId!);
    if (!handled && !entry.fromDeepLink) openExternal(entry.url);
  }

  function send(url: string, target: WindowTarget | null, fromDeepLink: boolean): void {
    if (!target || target.isDestroyed()) {
      if (fromDeepLink) console.warn('[ConsoleLinks] No window to open a console link in:', url);
      else openExternal(url);
      return;
    }
    const requestId = `console-link-${Date.now()}-${++counter}`;
    const timer = setTimeout(() => settle(requestId, false), ackTimeoutMs);
    pending.set(requestId, { url, fromDeepLink, timer });
    target.send(CONSOLE_LINK_OPEN_CHANNEL, { requestId, url, fromDeepLink });
  }

  return {
    /** True when `url` is a console link; it then opens in `target` or, failing that, the browser. */
    route(url: string, target: WindowTarget | null): boolean {
      if (!isConsoleLink(url)) return false;
      send(url, target, false);
      return true;
    },
    /** True when `deepLink` is `nimbalyst://console/...`; it then opens in `target` only. */
    routeDeepLink(deepLink: string, target: WindowTarget | null): boolean {
      const url = consoleLinkFromDeepLink(deepLink);
      if (!url) return false;
      send(url, target, true);
      return true;
    },
    settle,
  };
}
