/**
 * Keeps the Window menu's window list in sync with the real windows.
 *
 * The list is a snapshot taken each time the application menu is built, so
 * without a rebuild a closed project stays listed (and the checkmark stays on
 * whichever window was focused at the last build). This rebuilds the menu when
 * any window is created, closed, or focused, coalescing bursts (e.g. a restore
 * opening several windows) into one rebuild.
 */

interface WindowLike {
  once(event: 'closed', listener: () => void): unknown;
}

interface AppLike {
  on(event: 'browser-window-created', listener: (event: unknown, window: WindowLike) => void): unknown;
  on(event: 'browser-window-focus', listener: () => void): unknown;
  on(event: 'before-quit', listener: () => void): unknown;
}

export function installWindowListMenuRefresh(
  appLike: AppLike,
  rebuild: () => void,
  delayMs = 50,
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let quitting = false;

  const schedule = () => {
    if (quitting || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!quitting) rebuild();
    }, delayMs);
  };

  appLike.on('browser-window-created', (_event, window) => {
    window.once('closed', schedule);
    schedule();
  });
  appLike.on('browser-window-focus', schedule);
  appLike.on('before-quit', () => {
    quitting = true;
  });
}
