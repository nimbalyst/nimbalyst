import type { BrowserWindow } from 'electron';
import { getMultiProjectMode } from '../utils/store';
import {
  findWindowByWorkspace,
  getMostRecentlyFocusedWorkspaceWindow,
  getWindowId,
  windowStates,
} from './WindowManager';
import {
  MAX_OPEN_PROJECT_TABS,
  OPEN_PROJECT_TAB_CHANNEL,
} from '../../shared/projectTabs';
import { ensureWorkspaceTabServices } from '../services/WorkspaceTabServices';
import { initializeWorkspaceTabBackground } from '../services/WorkspaceTabBackground';

export interface ProjectTabRouteOptions {
  preferredWindow?: BrowserWindow | null;
  focus?: boolean;
}

export type ProjectTabRouteResult =
  | { status: 'routed'; window: BrowserWindow }
  | { status: 'fallback'; reason: 'tabs-disabled' | 'no-host' }
  | { status: 'rejected'; reason: 'tab-cap' | 'registration-failed'; error: string };

function isWorkspaceHost(window: BrowserWindow | null | undefined): window is BrowserWindow {
  if (!window || window.isDestroyed()) return false;
  const windowId = getWindowId(window);
  if (windowId === null) return false;
  const state = windowStates.get(windowId);
  return state?.mode === 'workspace' || state?.mode === 'agentic-coding';
}

function referencesExactWorkspace(
  window: BrowserWindow | null | undefined,
  workspacePath: string,
): window is BrowserWindow {
  if (!isWorkspaceHost(window)) return false;
  const windowId = getWindowId(window);
  if (windowId === null) return false;
  const state = windowStates.get(windowId);
  return state?.workspacePath === workspacePath ||
    state?.additionalWorkspacePaths?.includes(workspacePath) === true;
}

/**
 * Route a normal project-open request into a tab in an existing workspace
 * window. A rejected result must not fall through to a new BrowserWindow:
 * doing so at the tab cap would violate the tab-by-default contract.
 */
export function routeWorkspaceToProjectTab(
  workspacePath: string,
  options: ProjectTabRouteOptions = {},
): ProjectTabRouteResult {
  const existingHost = findWindowByWorkspace(workspacePath);
  if (!getMultiProjectMode()) {
    if (referencesExactWorkspace(existingHost, workspacePath)) {
      if (options.focus !== false) existingHost.focus();
      return { status: 'routed', window: existingHost };
    }
    return { status: 'fallback', reason: 'tabs-disabled' };
  }

  const preferredHost = isWorkspaceHost(options.preferredWindow)
    ? options.preferredWindow
    : null;
  const host = existingHost ?? preferredHost ?? getMostRecentlyFocusedWorkspaceWindow();
  if (!isWorkspaceHost(host)) return { status: 'fallback', reason: 'no-host' };

  const windowId = getWindowId(host);
  if (windowId === null) return { status: 'fallback', reason: 'no-host' };
  const state = windowStates.get(windowId);
  if (!state) return { status: 'fallback', reason: 'no-host' };

  const referencedPaths = new Set<string>();
  if (state.workspacePath) referencedPaths.add(state.workspacePath);
  state.additionalWorkspacePaths?.forEach((path) => referencedPaths.add(path));

  if (!referencedPaths.has(workspacePath) && referencedPaths.size >= MAX_OPEN_PROJECT_TABS) {
    return {
      status: 'rejected',
      reason: 'tab-cap',
      error: `You can have at most ${MAX_OPEN_PROJECT_TABS} project tabs open in one window.`,
    };
  }

  if (!referencedPaths.has(workspacePath)) {
    const serviceResult = ensureWorkspaceTabServices(host, workspacePath);
    if (!serviceResult.success) {
      return {
        status: 'rejected',
        reason: 'registration-failed',
        error: serviceResult.error || 'Unable to initialize project tab services',
      };
    }
    state.additionalWorkspacePaths = [
      ...(state.additionalWorkspacePaths ?? []),
      workspacePath,
    ];
    initializeWorkspaceTabBackground(workspacePath);
  }

  // Keep a pull-based copy until the renderer consumes it. The live event
  // gives an already-mounted renderer an immediate switch, while the queue
  // covers renderer startup/reload races where no listener exists yet.
  state.pendingProjectTabPaths = [
    ...new Set([...(state.pendingProjectTabPaths ?? []), workspacePath]),
  ];
  host.webContents.send(OPEN_PROJECT_TAB_CHANNEL, { workspacePath });
  if (options.focus !== false) host.focus();
  return { status: 'routed', window: host };
}
