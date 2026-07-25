import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWindow: vi.fn(),
  getSessionState: vi.fn(),
  clearSessionState: vi.fn(),
  runWhenAppIsActive: vi.fn(),
  updateTrackerSchemaWorkspace: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: class BrowserWindow {},
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

vi.mock('../../window/WindowManager', () => ({
  windows: new Map(),
  windowStates: new Map(),
  windowFocusOrder: new Map(),
  windowDevToolsState: new Map(),
  createWindow: mocks.createWindow,
  getWindowId: vi.fn(),
}));

vi.mock('../../file/FileOperations', () => ({ loadFileIntoWindow: vi.fn() }));
vi.mock('../../file/WorkspaceWatcher.ts', () => ({ startWorkspaceWatcher: vi.fn() }));
vi.mock('../../utils/FileTree', () => ({ getFolderContents: vi.fn() }));

vi.mock('../../utils/store', () => ({
  getSessionState: mocks.getSessionState,
  saveSessionState: vi.fn(),
  clearSessionState: mocks.clearSessionState,
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    session: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: {
    getInstance: () => ({ sendEvent: vi.fn() }),
  },
}));

vi.mock('../../services/GitStatusService', () => ({
  GitStatusService: class GitStatusService {
    isGitRepo = vi.fn(async () => false);
    hasGitHubRemote = vi.fn(async () => false);
  },
}));

vi.mock('../../services/TeamService', () => ({
  autoMatchTeamForWorkspace: vi.fn(async () => undefined),
}));

vi.mock('../../services/TrackerSchemaService', () => ({
  updateTrackerSchemaWorkspace: mocks.updateTrackerSchemaWorkspace,
}));

vi.mock('../../window/AppActivationGuard', () => ({
  runWhenAppIsActive: mocks.runWhenAppIsActive,
}));

import { restoreSessionState } from '../SessionState';

describe('restoreSessionState window activation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.createWindow.mockReset();
    mocks.getSessionState.mockReset();
    mocks.clearSessionState.mockReset();
    mocks.runWhenAppIsActive.mockReset();
    mocks.updateTrackerSchemaWorkspace.mockReset();

    mocks.createWindow.mockImplementation(() => ({
      webContents: { once: vi.fn(), openDevTools: vi.fn() },
    }));
  });

  it('shows every restored workspace window without activating the app', async () => {
    mocks.getSessionState.mockReturnValue({
      windows: [
        { mode: 'workspace', workspacePath: '/workspace/older', focusOrder: 1 },
        { mode: 'workspace', workspacePath: '/workspace/newer', focusOrder: 2 },
      ],
      lastUpdated: Date.now(),
    });

    const restorePromise = restoreSessionState();
    await vi.runAllTimersAsync();

    await expect(restorePromise).resolves.toBe(true);
    expect(mocks.createWindow).toHaveBeenCalledTimes(2);
    expect(mocks.createWindow).toHaveBeenNthCalledWith(
      1,
      false,
      true,
      '/workspace/older',
      undefined,
      { showInactive: true, deferShowUntilAppActive: true },
    );
    expect(mocks.createWindow).toHaveBeenNthCalledWith(
      2,
      false,
      true,
      '/workspace/newer',
      undefined,
      { showInactive: true, deferShowUntilAppActive: true },
    );
  });

  it('defers saved DevTools restoration until Nimbalyst is active', async () => {
    mocks.getSessionState.mockReturnValue({
      windows: [
        {
          mode: 'workspace',
          workspacePath: '/workspace/devtools',
          focusOrder: 1,
          devToolsOpen: true,
        },
      ],
      lastUpdated: Date.now(),
    });

    const restorePromise = restoreSessionState();
    await vi.runAllTimersAsync();
    await restorePromise;

    const restoredWindow = mocks.createWindow.mock.results[0].value;
    const didFinishLoad = restoredWindow.webContents.once.mock.calls.find(
      ([event]: [string]) => event === 'did-finish-load',
    )?.[1];
    expect(didFinishLoad).toBeTypeOf('function');
    didFinishLoad();

    expect(mocks.runWhenAppIsActive).toHaveBeenCalledWith(
      restoredWindow,
      expect.any(Function),
    );
    expect(restoredWindow.webContents.openDevTools).not.toHaveBeenCalled();

    const deferredOpen = mocks.runWhenAppIsActive.mock.calls[0][1];
    deferredOpen();
    expect(restoredWindow.webContents.openDevTools).toHaveBeenCalledTimes(1);
  });
});
