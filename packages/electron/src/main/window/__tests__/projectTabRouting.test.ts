import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowState } from '../../types';

const mocks = vi.hoisted(() => ({
  multiProjectMode: true,
  windowStates: new Map<number, WindowState>(),
  windowIds: new Map<any, number>(),
  existingWindow: null as any,
  recentWindow: null as any,
  ensureWorkspaceTabServices: vi.fn((): { success: boolean; error?: string } => ({ success: true })),
  initializeWorkspaceTabBackground: vi.fn(),
}));

vi.mock('../../utils/store', () => ({
  getMultiProjectMode: () => mocks.multiProjectMode,
}));

vi.mock('../WindowManager', () => ({
  windowStates: mocks.windowStates,
  findWindowByWorkspace: () => mocks.existingWindow,
  getMostRecentlyFocusedWorkspaceWindow: () => mocks.recentWindow,
  getWindowId: (window: any) => mocks.windowIds.get(window) ?? null,
}));

vi.mock('../../services/WorkspaceTabServices', () => ({
  ensureWorkspaceTabServices: mocks.ensureWorkspaceTabServices,
}));

vi.mock('../../services/WorkspaceTabBackground', () => ({
  initializeWorkspaceTabBackground: mocks.initializeWorkspaceTabBackground,
}));

import { routeWorkspaceToProjectTab } from '../projectTabRouting';

function makeWindow(id: number) {
  const window = {
    isDestroyed: vi.fn(() => false),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  };
  mocks.windowIds.set(window, id);
  return window;
}

function makeState(partial: Partial<WindowState> = {}): WindowState {
  return {
    mode: 'workspace',
    filePath: null,
    workspacePath: '/ws/a',
    documentEdited: false,
    ...partial,
  };
}

describe('routeWorkspaceToProjectTab', () => {
  beforeEach(() => {
    mocks.multiProjectMode = true;
    mocks.windowStates.clear();
    mocks.windowIds.clear();
    mocks.existingWindow = null;
    mocks.recentWindow = null;
    mocks.ensureWorkspaceTabServices.mockReset();
    mocks.ensureWorkspaceTabServices.mockReturnValue({ success: true });
    mocks.initializeWorkspaceTabBackground.mockReset();
  });

  it('routes a new project to the invoking workspace window', () => {
    const preferred = makeWindow(1);
    mocks.windowStates.set(1, makeState());

    const result = routeWorkspaceToProjectTab('/ws/b', { preferredWindow: preferred as any });

    expect(result).toEqual({ status: 'routed', window: preferred });
    expect(preferred.webContents.send).toHaveBeenCalledWith(
      'workspace:open-project-tab',
      { workspacePath: '/ws/b' },
    );
    expect(preferred.focus).toHaveBeenCalled();
    expect(mocks.windowStates.get(1)?.additionalWorkspacePaths).toEqual(['/ws/b']);
    expect(mocks.windowStates.get(1)?.pendingProjectTabPaths).toEqual(['/ws/b']);
  });

  it('activates the window that already hosts the project', () => {
    const existing = makeWindow(2);
    mocks.existingWindow = existing;
    mocks.windowStates.set(2, makeState({ additionalWorkspacePaths: ['/ws/b'] }));

    const result = routeWorkspaceToProjectTab('/ws/b');

    expect(result).toEqual({ status: 'routed', window: existing });
    expect(existing.webContents.send).toHaveBeenCalledOnce();
  });

  it('falls back to the most recently focused workspace window', () => {
    const recent = makeWindow(3);
    mocks.recentWindow = recent;
    mocks.windowStates.set(3, makeState());

    expect(routeWorkspaceToProjectTab('/ws/c')).toEqual({ status: 'routed', window: recent });
  });

  it('focuses an exact already-open workspace when project tabs are disabled', () => {
    mocks.multiProjectMode = false;
    const existing = makeWindow(2);
    mocks.existingWindow = existing;
    mocks.windowStates.set(2, makeState({ workspacePath: '/ws/b' }));

    expect(routeWorkspaceToProjectTab('/ws/b')).toEqual({
      status: 'routed',
      window: existing,
    });
    expect(existing.focus).toHaveBeenCalledOnce();
    expect(existing.webContents.send).not.toHaveBeenCalled();
  });

  it('does not mistake a related worktree window for the exact workspace when tabs are disabled', () => {
    mocks.multiProjectMode = false;
    const related = makeWindow(2);
    mocks.existingWindow = related;
    mocks.windowStates.set(2, makeState({ workspacePath: '/ws/related' }));

    expect(routeWorkspaceToProjectTab('/ws/b')).toEqual({
      status: 'fallback',
      reason: 'tabs-disabled',
    });
    expect(related.focus).not.toHaveBeenCalled();
    expect(related.webContents.send).not.toHaveBeenCalled();
  });

  it('falls back to a new window when tabs are disabled and the workspace is not open', () => {
    mocks.multiProjectMode = false;
    const preferred = makeWindow(1);
    mocks.windowStates.set(1, makeState());

    expect(routeWorkspaceToProjectTab('/ws/b', { preferredWindow: preferred as any })).toEqual({
      status: 'fallback',
      reason: 'tabs-disabled',
    });
    expect(preferred.webContents.send).not.toHaveBeenCalled();
  });

  it('rejects instead of opening a surprise window when the host has eight tabs', () => {
    const preferred = makeWindow(1);
    mocks.windowStates.set(1, makeState({
      additionalWorkspacePaths: Array.from({ length: 7 }, (_, index) => `/ws/${index + 1}`),
    }));

    expect(routeWorkspaceToProjectTab('/ws/overflow', { preferredWindow: preferred as any })).toMatchObject({
      status: 'rejected',
      reason: 'tab-cap',
    });
    expect(preferred.webContents.send).not.toHaveBeenCalled();
  });

  it('rejects transactionally when workspace services cannot be initialized', () => {
    const preferred = makeWindow(1);
    mocks.windowStates.set(1, makeState());
    mocks.ensureWorkspaceTabServices.mockReturnValueOnce({
      success: false,
      error: 'service failed',
    });

    const result = routeWorkspaceToProjectTab('/ws/b', { preferredWindow: preferred as any });

    expect(result).toEqual({
      status: 'rejected',
      reason: 'registration-failed',
      error: 'service failed',
    });
    expect(mocks.windowStates.get(1)?.additionalWorkspacePaths).toBeUndefined();
    expect(preferred.webContents.send).not.toHaveBeenCalled();
  });
});
