/**
 * Bridge between the live application menu and the renderer-drawn menu bar.
 *
 * Windows/Linux workspace windows are frameless (`windowChrome.ts`), which
 * hides the native menu strip. The application menu is still installed — it is
 * what makes the accelerators work — so the renderer mirrors it instead of
 * owning a second copy of the template.
 *
 * On macOS this serves an empty model: the system menu bar already shows it.
 */

import { app, BrowserWindow, Menu, type MenuItem } from 'electron';
import { WINDOW_MENU_CHANNELS, type SerializedMenuBar } from '../../shared/menuBar';
import { findMenuItemByPath, serializeMenuBar, type MenuLike } from './menuBarSerialization';
import { logger } from '../utils/logger';

let revision = 0;

/**
 * Role items carry no `click` handler, so invoking one has to perform the role
 * ourselves. Only roles reachable from a non-mac window need an entry; the
 * mac-only roles (hide/unhide/front) never render in this strip.
 */
const ROLE_ACTIONS: Record<string, (window: BrowserWindow | null) => void> = {
  undo: (window) => window?.webContents.undo(),
  redo: (window) => window?.webContents.redo(),
  cut: (window) => window?.webContents.cut(),
  copy: (window) => window?.webContents.copy(),
  paste: (window) => window?.webContents.paste(),
  pasteandmatchstyle: (window) => window?.webContents.pasteAndMatchStyle(),
  delete: (window) => window?.webContents.delete(),
  selectall: (window) => window?.webContents.selectAll(),
  reload: (window) => window?.webContents.reload(),
  forcereload: (window) => window?.webContents.reloadIgnoringCache(),
  toggledevtools: (window) => window?.webContents.toggleDevTools(),
  resetzoom: (window) => {
    if (window) window.webContents.setZoomLevel(0);
  },
  zoomin: (window) => {
    if (window) window.webContents.setZoomLevel(window.webContents.getZoomLevel() + 0.5);
  },
  zoomout: (window) => {
    if (window) window.webContents.setZoomLevel(window.webContents.getZoomLevel() - 0.5);
  },
  togglefullscreen: (window) => window?.setFullScreen(!window.isFullScreen()),
  minimize: (window) => window?.minimize(),
  close: (window) => window?.close(),
  quit: () => app.quit(),
};

function currentMenu(): MenuLike | null {
  return (Menu.getApplicationMenu() as unknown as MenuLike | null) ?? null;
}

export function getWindowMenuBar(): SerializedMenuBar {
  return serializeMenuBar(currentMenu(), process.platform, revision);
}

/**
 * Called after every `Menu.setApplicationMenu`. Bumps the revision (which
 * invalidates in-flight item ids) and pushes the fresh model to every window.
 */
export function notifyWindowMenuChanged(): void {
  revision += 1;

  const payload = getWindowMenuBar();
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send(WINDOW_MENU_CHANNELS.changed, payload);
    } catch (error) {
      logger.menu.error('Failed to push menu bar model to window:', error);
    }
  }
}

export interface InvokeWindowMenuItemResult {
  invoked: boolean;
  /** Set when the caller's model was stale and should be refreshed. */
  staleRevision?: boolean;
}

/**
 * Run the application-menu item at `id` as if the native menu had been used.
 */
export function invokeWindowMenuItem(
  id: string,
  itemRevision: number,
  senderWindow: BrowserWindow | null,
): InvokeWindowMenuItemResult {
  if (itemRevision !== revision) {
    return { invoked: false, staleRevision: true };
  }

  const item = findMenuItemByPath(currentMenu(), id);
  if (!item || item.enabled === false || item.type === 'separator') {
    return { invoked: false };
  }

  const window = senderWindow && !senderWindow.isDestroyed()
    ? senderWindow
    : BrowserWindow.getFocusedWindow();

  try {
    // Native clicks flip the checked state before dispatching; mirror that so
    // handlers reading `menuItem.checked` see what they would natively.
    if (item.type === 'checkbox') {
      item.checked = item.checked !== true;
    } else if (item.type === 'radio') {
      item.checked = true;
    }

    if (typeof item.click === 'function') {
      (item.click as (
        menuItem: MenuItem,
        browserWindow: BrowserWindow | undefined,
        event: Record<string, unknown>,
      ) => void)(item as unknown as MenuItem, window ?? undefined, {});
      return { invoked: true };
    }

    const role = item.role?.toLowerCase();
    const roleAction = role ? ROLE_ACTIONS[role] : undefined;
    if (roleAction) {
      roleAction(window);
      return { invoked: true };
    }
  } catch (error) {
    logger.menu.error(`Failed to invoke menu item ${id}:`, error);
    return { invoked: false };
  }

  return { invoked: false };
}

export function resetWindowMenuRevisionForTests(): void {
  revision = 0;
}
