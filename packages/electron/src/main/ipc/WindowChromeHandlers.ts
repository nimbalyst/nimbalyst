import { safeOn } from '../utils/ipcRegistry';
import { setResolvedTitleBarOverlayColors } from '../window/windowChrome';

let handlersRegistered = false;

export function registerWindowChromeHandlers(): void {
  if (handlersRegistered) return;

  safeOn('window-chrome:set-overlay-colors', (_event, payload: unknown) => {
    setResolvedTitleBarOverlayColors(payload);
  });

  handlersRegistered = true;
}
