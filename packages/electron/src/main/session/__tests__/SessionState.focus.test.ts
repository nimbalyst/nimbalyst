// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({
  createWindow: vi.fn(),
  getSessionState: vi.fn(),
  clearSessionState: vi.fn(),
  onStartupActivated: vi.fn(),
  updateTrackerSchemaWorkspace: vi.fn(),
  ensureTrackerSyncForWorkspace: vi.fn(async () => undefined),
  saveSessionState: vi.fn(),
  windows: new Map<number, {
    isDestroyed(): boolean;
    getBounds(): { x: number; y: number; width: number; height: number };
    isMaximized(): boolean;
  }>(),
  windowStates: new Map<number, { mode: 'workspace'; workspacePath: string }>(),
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
  windows: mocks.windows,
  windowStates: mocks.windowStates,
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
  saveSessionState: mocks.saveSessionState,
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

vi.mock('../../services/TrackerSyncManager', () => ({
  ensureTrackerSyncForWorkspace: mocks.ensureTrackerSyncForWorkspace,
}));

vi.mock('../../window/StartupActivation', () => ({
  onStartupActivated: mocks.onStartupActivated,
}));

import { restoreSessionState, saveSessionState } from '../SessionState';
import { createRestartShutdown } from '../restartShutdown';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe('restoreSessionState window activation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.createWindow.mockReset();
    mocks.getSessionState.mockReset();
    mocks.clearSessionState.mockReset();
    mocks.onStartupActivated.mockReset();
    mocks.updateTrackerSchemaWorkspace.mockReset();
    mocks.ensureTrackerSyncForWorkspace.mockClear();
    mocks.windows.clear();
    mocks.windowStates.clear();
    mocks.saveSessionState.mockReset();

    mocks.createWindow.mockImplementation(() => ({
      isDestroyed: () => false,
      webContents: { once: vi.fn(), openDevTools: vi.fn() },
    }));
  });

  it('restores every project after restart waits for readers and backups, even with repeated quit requests', async () => {
    const projects = ['/workspace/one', '/workspace/two', '/workspace/three'];
    for (const [id, workspacePath] of projects.entries()) {
      mocks.windowStates.set(id, { mode: 'workspace', workspacePath });
      mocks.windows.set(id, {
        isDestroyed: () => false,
        getBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }),
        isMaximized: () => false,
      });
    }
    mocks.saveSessionState.mockImplementation((state) => mocks.getSessionState.mockReturnValue(state));
    const drain = deferred();
    const backups = deferred();
    const app = new EventEmitter();
    const handlers: Promise<void>[] = [];
    const quit = vi.fn(() => {
      let prevented = false;
      // Electron emits synchronously; it does not await async listeners.
      app.emit('before-quit', { preventDefault: () => { prevented = true; } });
      if (!prevented) {
        mocks.windowStates.clear();
        mocks.windows.clear();
      }
    });
    const flushPendingBackups = vi.fn(() => backups.promise);
    const stopExternalSessions = vi.fn(() => drain.promise);
    const shutdown = createRestartShutdown({
      beginRestart: vi.fn(), stopExternalSessions, saveSessionState, flushPendingBackups, quit,
    });
    app.on('before-quit', (event) => { handlers.push(shutdown(event)); });

    quit();
    quit(); // Another request while the first is waiting must not tear down windows.
    const projectsDuringDrain = mocks.windowStates.size;
    drain.resolve();
    await vi.waitFor(() => expect(flushPendingBackups).toHaveBeenCalledOnce());
    const projectsDuringBackup = mocks.windowStates.size;
    backups.resolve();
    await Promise.all(handlers);

    const restore = restoreSessionState();
    await vi.runAllTimersAsync();
    await expect(restore).resolves.toBe(true);
    expect(mocks.createWindow.mock.calls.map((call) => call[2])).toEqual(projects);
    expect(projectsDuringDrain).toBe(3);
    expect(projectsDuringBackup).toBe(3);
    expect(mocks.windowStates.size).toBe(0);
    expect(stopExternalSessions).toHaveBeenCalledOnce();
    expect(mocks.saveSessionState).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledTimes(3); // Two requests and the final permitted quit.
  });

  it.each(['saveSessionState', 'stopExternalSessions', 'flushPendingBackups'] as const)(
    'keeps windows open when %s fails and allows an explicit retry',
    async (failedStep) => {
      const deps = {
        beginRestart: vi.fn(),
        stopExternalSessions: vi.fn(async () => undefined),
        saveSessionState: vi.fn(async () => undefined),
        flushPendingBackups: vi.fn(async () => undefined),
        quit: vi.fn(),
      };
      const error = new Error('Shutdown failed');
      deps[failedStep].mockRejectedValueOnce(error);
      const shutdown = createRestartShutdown(deps);
      const firstEvent = { preventDefault: vi.fn() };

      await expect(shutdown(firstEvent)).rejects.toBe(error);
      expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
      expect(deps.quit).not.toHaveBeenCalled();

      const retryEvent = { preventDefault: vi.fn() };
      await shutdown(retryEvent);
      expect(retryEvent.preventDefault).toHaveBeenCalledOnce();
      expect(deps.quit).toHaveBeenCalledOnce();

      const finalEvent = { preventDefault: vi.fn() };
      await shutdown(finalEvent);
      expect(finalEvent.preventDefault).not.toHaveBeenCalled();
      expect(deps.beginRestart).toHaveBeenCalledTimes(2);
    },
  );

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
      { showInactive: true, startupReveal: true, startupFrontmost: true },
    );
    expect(mocks.createWindow).toHaveBeenNthCalledWith(
      2,
      false,
      true,
      '/workspace/newer',
      undefined,
      { showInactive: true, startupReveal: true, startupFrontmost: true },
    );
    expect(mocks.ensureTrackerSyncForWorkspace).toHaveBeenCalledTimes(2);
    expect(mocks.ensureTrackerSyncForWorkspace).toHaveBeenNthCalledWith(1, '/workspace/older');
    expect(mocks.ensureTrackerSyncForWorkspace).toHaveBeenNthCalledWith(2, '/workspace/newer');
  });

  it('defers saved DevTools restoration until startup foregrounding is done', async () => {
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

    expect(mocks.onStartupActivated).toHaveBeenCalledWith(expect.any(Function));
    expect(restoredWindow.webContents.openDevTools).not.toHaveBeenCalled();

    const deferredOpen = mocks.onStartupActivated.mock.calls[0][0];
    deferredOpen();
    expect(restoredWindow.webContents.openDevTools).toHaveBeenCalledTimes(1);
  });
});
