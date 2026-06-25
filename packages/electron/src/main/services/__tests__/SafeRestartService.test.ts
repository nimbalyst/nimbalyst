import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: {
    quit: vi.fn(),
    relaunch: vi.fn(),
  },
  browserWindow: {
    getAllWindows: vi.fn(),
  },
  saveSessionState: vi.fn(),
  setRestarting: vi.fn(),
  getSessionStateManager: vi.fn(),
}));

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: mocks.browserWindow,
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: mocks.getSessionStateManager,
}));

vi.mock('../../index', () => ({
  setRestarting: mocks.setRestarting,
}));

vi.mock('../../session/SessionState', () => ({
  saveSessionState: mocks.saveSessionState,
}));

vi.mock('../../utils/appPaths', () => ({
  getRestartSignalPath: () => '/tmp/nimbalyst-restart-signal-test',
}));

import { restartNimbalystSafely } from '../SafeRestartService';

function setActiveSessionStates(states: Record<string, any>): void {
  mocks.getSessionStateManager.mockReturnValue({
    getTrackedSessionIds: () => Object.keys(states),
    getSessionState: (sessionId: string) => states[sessionId],
  });
}

describe('SafeRestartService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ELECTRON_RENDERER_URL;
    process.env.NODE_ENV = 'test';
  });

  it('reloads windows without relaunching main when sessions are busy', async () => {
    const windowA = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        reloadIgnoringCache: vi.fn(),
      },
    };
    const windowB = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        reloadIgnoringCache: vi.fn(),
      },
    };

    mocks.browserWindow.getAllWindows.mockReturnValue([windowA, windowB]);
    setActiveSessionStates({
      busy: { status: 'running', isStreaming: false },
    });

    const result = await restartNimbalystSafely('test');

    expect(result.action).toBe('ui-reloaded');
    expect(result.busySessionIds).toEqual(['busy']);
    expect(result.reloadedWindowCount).toBe(2);
    expect(mocks.saveSessionState).toHaveBeenCalledTimes(1);
    expect(windowA.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(windowB.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(mocks.app.relaunch).not.toHaveBeenCalled();
    expect(mocks.app.quit).not.toHaveBeenCalled();
    expect(mocks.setRestarting).not.toHaveBeenCalled();
  });

  it('performs a full relaunch when no sessions are busy', async () => {
    setActiveSessionStates({});

    const result = await restartNimbalystSafely('test');

    expect(result.action).toBe('restarting');
    expect(result.busySessionIds).toEqual([]);
    expect(mocks.setRestarting).toHaveBeenCalledWith(true);
    expect(mocks.saveSessionState).toHaveBeenCalledTimes(1);
    expect(mocks.app.relaunch).toHaveBeenCalledTimes(1);
    expect(mocks.app.quit).toHaveBeenCalledTimes(1);
  });
});
