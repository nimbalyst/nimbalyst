import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockApp = {
  quit: vi.fn(),
  relaunch: vi.fn(),
};

const mockBrowserWindow = {
  getAllWindows: vi.fn(),
};

const mockSaveSessionState = vi.fn();
const mockSetRestarting = vi.fn();
const mockGetSessionStateManager = vi.fn();

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: mockGetSessionStateManager,
}));

vi.mock('../../index', () => ({
  setRestarting: mockSetRestarting,
}));

vi.mock('../../session/SessionState', () => ({
  saveSessionState: mockSaveSessionState,
}));

vi.mock('../../utils/appPaths', () => ({
  getRestartSignalPath: () => '/tmp/nimbalyst-restart-signal-test',
}));

import { restartNimbalystSafely } from '../SafeRestartService';

function setActiveSessionStates(states: Record<string, any>): void {
  mockGetSessionStateManager.mockReturnValue({
    getActiveSessionIds: () => Object.keys(states),
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

    mockBrowserWindow.getAllWindows.mockReturnValue([windowA, windowB]);
    setActiveSessionStates({
      busy: { status: 'running', isStreaming: false },
    });

    const result = await restartNimbalystSafely('test');

    expect(result.action).toBe('ui-reloaded');
    expect(result.busySessionIds).toEqual(['busy']);
    expect(result.reloadedWindowCount).toBe(2);
    expect(mockSaveSessionState).toHaveBeenCalledTimes(1);
    expect(windowA.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(windowB.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(mockApp.relaunch).not.toHaveBeenCalled();
    expect(mockApp.quit).not.toHaveBeenCalled();
    expect(mockSetRestarting).not.toHaveBeenCalled();
  });

  it('performs a full relaunch when no sessions are busy', async () => {
    setActiveSessionStates({});

    const result = await restartNimbalystSafely('test');

    expect(result.action).toBe('restarting');
    expect(result.busySessionIds).toEqual([]);
    expect(mockSetRestarting).toHaveBeenCalledWith(true);
    expect(mockSaveSessionState).toHaveBeenCalledTimes(1);
    expect(mockApp.relaunch).toHaveBeenCalledTimes(1);
    expect(mockApp.quit).toHaveBeenCalledTimes(1);
  });
});
