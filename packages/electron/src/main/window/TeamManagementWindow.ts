import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { safeHandle } from '../utils/ipcRegistry';
import { getPreloadPath } from '../utils/appPaths';
import { getTheme } from '../utils/store';
import { getBackgroundColor } from '../theme/ThemeManager';

/**
 * Org-management ("Team") window.
 *
 * Org administration is a dedicated OS window, not a mode inside the project
 * window (see the 2026-07-17 decision-log correction in
 * multi-account-identity-settings-redesign.md). It loads the same renderer SPA
 * with `?mode=team-management`, which early-returns the TeamManagementApp root.
 *
 * Single reusable window: opening it for a different org focuses the existing
 * window and retargets it via the `team-window:set-target` event rather than
 * spawning a second window.
 */

let teamManagementWindow: BrowserWindow | null = null;

interface TeamWindowTarget {
  /** Org to manage. Omitted for the "new organization" / picker entry. */
  orgId?: string;
  /** Opener's active workspace, when one exists, so the workspace-sharing tab works. */
  workspacePath?: string;
}

export function createTeamManagementWindow(target?: TeamWindowTarget): BrowserWindow {
  // Reuse the existing window; just focus and retarget it at the new org.
  if (teamManagementWindow && !teamManagementWindow.isDestroyed()) {
    teamManagementWindow.focus();
    teamManagementWindow.webContents.send('team-window:set-target', {
      orgId: target?.orgId ?? null,
      workspacePath: target?.workspacePath ?? null,
    });
    return teamManagementWindow;
  }

  teamManagementWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    title: 'Organization',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: getPreloadPath(),
      webviewTag: false,
    },
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 10, y: 10 },
    vibrancy: 'sidebar',
    backgroundColor: getBackgroundColor(),
  });

  const currentTheme = getTheme();
  const query: Record<string, string> = { mode: 'team-management', theme: currentTheme };
  if (target?.orgId) query.orgId = target.orgId;
  if (target?.workspacePath) query.workspacePath = target.workspacePath;

  if (process.env.NODE_ENV === 'development') {
    const devPort = process.env.VITE_PORT || '5273';
    const search = new URLSearchParams(query).toString();
    teamManagementWindow.loadURL(`http://localhost:${devPort}/?${search}`);
  } else {
    const appPath = app.getAppPath();
    let htmlPath: string;
    if (app.isPackaged) {
      htmlPath = join(appPath, 'out/renderer/index.html');
    } else if (appPath.includes('/out/main') || appPath.includes('\\out\\main')) {
      htmlPath = join(appPath, '../renderer/index.html');
    } else {
      htmlPath = join(appPath, 'out/renderer/index.html');
    }
    teamManagementWindow.loadFile(htmlPath, { query });
  }

  teamManagementWindow.once('ready-to-show', () => {
    teamManagementWindow?.show();
  });

  teamManagementWindow.on('closed', () => {
    teamManagementWindow = null;
  });

  return teamManagementWindow;
}

export function updateTeamManagementWindowTheme(): void {
  if (teamManagementWindow && !teamManagementWindow.isDestroyed()) {
    teamManagementWindow.setBackgroundColor(getBackgroundColor());
  }
}

/**
 * Register the renderer-facing IPC opener. Called once during main-process
 * handler setup (index.ts), matching setupWorkspaceManagerHandlers().
 */
export function setupTeamManagementHandlers(): void {
  safeHandle('team-window:open', async (_event, target?: TeamWindowTarget) => {
    createTeamManagementWindow(target);
    return { success: true };
  });
}
