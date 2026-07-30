import { app, BrowserWindow, screen, type Rectangle } from 'electron';
import { join } from 'path';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { getPreloadPath } from '../utils/appPaths';
import {
  getTeamManagementWindowState,
  getTheme,
  saveTeamManagementWindowState,
} from '../utils/store';
import { getBackgroundColor } from '../theme/ThemeManager';
import { windows, windowStates } from './windowState';
import {
  ORG_WINDOW_COMMAND_CHANNEL,
  type OrgWindowCommand,
} from '../../shared/orgWindowCommands';

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
let teamManagementRouteState: TeamWindowRouteState | null = null;
/**
 * Notified whenever this window gains or loses focus, or goes away.
 *
 * The Messages menu only exists while the org window is focused — its
 * accelerators are shared with commands the project window owns — so the menu
 * has to be rebuilt on the transition. ApplicationMenu registers itself here at
 * module load; nothing else may claim the slot.
 */
let teamManagementFocusChangeListener: (() => void) | null = null;
/** Last value handed to the listener, so an unchanged focus state is not rebuilt. */
let lastNotifiedFocusState: boolean | null = null;

export interface TeamWindowTarget {
  /** Org to manage. Omitted for the "new organization" / picker entry. */
  orgId?: string;
  /** Opener's active workspace, when one exists, so the workspace-sharing tab works. */
  workspacePath?: string;
  /** Room or DM to display after the target organization is active. */
  conversationId?: string;
}

interface TeamWindowRouteState {
  orgId: string;
  view: string;
  conversationId?: string;
}

const DEFAULT_SIZE = {
  width: 1100,
  height: 750,
};

function intersectionArea(a: Rectangle, b: Rectangle): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

/**
 * Keep restored bounds on a currently connected display. When the saved
 * display has gone away, use the primary display; otherwise keep the window on
 * the display where most of it was saved. The selected work area also constrains
 * oversized or partly off-screen bounds so the title bar remains reachable.
 */
export function clampTeamManagementWindowBounds(
  bounds: Rectangle,
  displayWorkAreas: Rectangle[],
  primaryWorkArea: Rectangle,
): Rectangle {
  const intersecting = displayWorkAreas
    .map((workArea) => ({ workArea, area: intersectionArea(bounds, workArea) }))
    .filter(({ area }) => area > 0)
    .sort((a, b) => b.area - a.area)[0]?.workArea;
  const workArea = intersecting ?? primaryWorkArea;
  const width = Math.min(Math.max(1, bounds.width), workArea.width);
  const height = Math.min(Math.max(1, bounds.height), workArea.height);

  return {
    x: Math.min(
      Math.max(bounds.x, workArea.x),
      workArea.x + workArea.width - width,
    ),
    y: Math.min(
      Math.max(bounds.y, workArea.y),
      workArea.y + workArea.height - height,
    ),
    width,
    height,
  };
}

function getMostRecentlyFocusedWorkspaceWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) {
    for (const [windowId, window] of windows) {
      const state = windowStates.get(windowId);
      if (
        window === focused
        && (state?.mode === 'workspace' || state?.mode === 'agentic-coding')
      ) {
        return focused;
      }
    }
  }
  for (const [windowId, state] of windowStates) {
    if (state.mode !== 'workspace' && state.mode !== 'agentic-coding') continue;
    const window = windows.get(windowId);
    if (window && !window.isDestroyed()) return window;
  }
  return null;
}

export function createTeamManagementWindow(target?: TeamWindowTarget): BrowserWindow {
  // Reuse the existing window; just focus and retarget it at the new org.
  if (teamManagementWindow && !teamManagementWindow.isDestroyed()) {
    teamManagementRouteState = null;
    teamManagementWindow.focus();
    teamManagementWindow.webContents.send('team-window:set-target', {
      orgId: target?.orgId ?? null,
      workspacePath: target?.workspacePath ?? null,
      conversationId: target?.conversationId ?? null,
    });
    return teamManagementWindow;
  }

  const savedWindowState = getTeamManagementWindowState();
  const restoredBounds = savedWindowState
    ? clampTeamManagementWindowBounds(
      savedWindowState.bounds,
      screen.getAllDisplays().map((display) => display.workArea),
      screen.getPrimaryDisplay().workArea,
    )
    : DEFAULT_SIZE;

  teamManagementWindow = new BrowserWindow({
    ...restoredBounds,
    title: 'Organization',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: getPreloadPath(),
      webviewTag: false,
    },
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Centred in the renderer's 38px `.org-window-titlebar` strip, matching the
    // main window's title bar. Keep the two in step if either height changes.
    trafficLightPosition: { x: 10, y: 12 },
    vibrancy: 'sidebar',
    backgroundColor: getBackgroundColor(),
  });

  const currentTheme = getTheme();
  const query: Record<string, string> = { mode: 'team-management', theme: currentTheme };
  if (target?.orgId) query.orgId = target.orgId;
  if (target?.workspacePath) query.workspacePath = target.workspacePath;
  if (target?.conversationId) query.conversationId = target.conversationId;

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
    if (savedWindowState?.maximized) {
      teamManagementWindow?.maximize();
    }
    teamManagementWindow?.show();
  });

  teamManagementWindow.on('close', () => {
    if (!teamManagementWindow || teamManagementWindow.isDestroyed()) return;
    saveTeamManagementWindowState({
      bounds: teamManagementWindow.getNormalBounds(),
      maximized: teamManagementWindow.isMaximized(),
    });
  });

  teamManagementWindow.on('focus', notifyTeamManagementFocusChange);
  teamManagementWindow.on('blur', notifyTeamManagementFocusChange);

  teamManagementWindow.on('closed', () => {
    teamManagementWindow = null;
    teamManagementRouteState = null;
    notifyTeamManagementFocusChange();
  });

  return teamManagementWindow;
}

/**
 * Register the application menu's rebuild hook. Called once at module load by
 * ApplicationMenu; a second registration replaces the first rather than
 * accumulating listeners across hot reloads.
 */
export function registerTeamManagementFocusChange(listener: () => void): void {
  teamManagementFocusChangeListener = listener;
}

function notifyTeamManagementFocusChange(): void {
  const focused = isTeamManagementWindowFocused();
  if (focused === lastNotifiedFocusState) return;
  lastNotifiedFocusState = focused;
  teamManagementFocusChangeListener?.();
}

/** Whether the org window exists and is the focused window right now. */
export function isTeamManagementWindowFocused(): boolean {
  return !!(
    teamManagementWindow
    && !teamManagementWindow.isDestroyed()
    && teamManagementWindow.isFocused()
  );
}

/**
 * Deliver a Messages-menu command to the org window.
 *
 * Returns false when there is no live window to deliver to, which is what the
 * menu items check before claiming they did anything. The window is deliberately
 * not created on demand: a menu item that is only enabled while the org window
 * is focused can never fire without one.
 */
export function sendOrgWindowCommand(command: OrgWindowCommand): boolean {
  if (!teamManagementWindow || teamManagementWindow.isDestroyed()) return false;
  teamManagementWindow.webContents.send(ORG_WINDOW_COMMAND_CHANNEL, command);
  return true;
}

export function updateTeamManagementWindowTheme(): void {
  if (teamManagementWindow && !teamManagementWindow.isDestroyed()) {
    teamManagementWindow.setBackgroundColor(getBackgroundColor());
  }
}

export function isTeamManagementWindowFocusedOn(
  orgId: string,
  conversationId: string,
): boolean {
  return !!(
    teamManagementWindow
    && !teamManagementWindow.isDestroyed()
    && teamManagementWindow.isFocused()
    && teamManagementRouteState?.orgId === orgId
    && teamManagementRouteState.view === 'conversation'
    && teamManagementRouteState.conversationId === conversationId
  );
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
  safeHandle('app:open-account-settings', async () => {
    const workspaceWindow = getMostRecentlyFocusedWorkspaceWindow();
    if (!workspaceWindow || workspaceWindow.isDestroyed()) {
      return { success: false, error: 'No workspace window is available for account settings.' };
    }
    workspaceWindow.focus();
    workspaceWindow.webContents.send('open-settings-command', {
      category: 'account',
      scope: 'account',
      timestamp: Date.now(),
    });
    return { success: true };
  });
  safeOn('team-window:route-state', (event, state: TeamWindowRouteState) => {
    if (
      !teamManagementWindow
      || teamManagementWindow.isDestroyed()
      || event.sender !== teamManagementWindow.webContents
      || !state
      || typeof state.orgId !== 'string'
      || typeof state.view !== 'string'
    ) {
      return;
    }
    teamManagementRouteState = {
      orgId: state.orgId,
      view: state.view,
      ...(typeof state.conversationId === 'string'
        ? { conversationId: state.conversationId }
        : {}),
    };
  });
}
