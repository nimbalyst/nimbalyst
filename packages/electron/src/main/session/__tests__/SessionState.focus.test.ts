import { beforeEach, describe, expect, it, vi } from 'vitest';
// Type-only: erased at compile time, so it is safe to reference inside the
// `vi.hoisted` factory below, which runs before runtime imports.
import type { RailSeedOutcome } from '../../window/railSeeding';

const mocks = vi.hoisted(() => ({
  createWindow: vi.fn(),
  getSessionState: vi.fn(),
  clearSessionState: vi.fn(),
  onStartupActivated: vi.fn(),
  updateTrackerSchemaWorkspace: vi.fn(),
  getMultiProjectMode: vi.fn(() => false),
  autoMatchTeamForWorkspace: vi.fn(async () => undefined),
  saveToStore: vi.fn(),
  // Typed against the real `RailSeedOutcome` union, not inferred from the
  // default return -- inference would narrow the mock to `'added'` and make
  // `mockResolvedValueOnce('at-cap')` a type error in the refusal cases.
  seedProjectIntoWindow: vi.fn<(...args: never[]) => Promise<RailSeedOutcome>>(
    async () => 'added',
  ),
  setPendingRailSeeds: vi.fn(),
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
  // Returns a real id: rail seeds are parked under it, so a bare `vi.fn()`
  // returning undefined would silently defeat the parking assertions.
  getWindowId: vi.fn(() => 1),
}));

vi.mock('../../file/FileOperations', () => ({ loadFileIntoWindow: vi.fn() }));
vi.mock('../../file/WorkspaceWatcher.ts', () => ({ startWorkspaceWatcher: vi.fn() }));
vi.mock('../../utils/FileTree', () => ({ getFolderContents: vi.fn() }));

vi.mock('../../utils/store', () => ({
  getSessionState: mocks.getSessionState,
  saveSessionState: mocks.saveToStore,
  clearSessionState: mocks.clearSessionState,
  getMultiProjectMode: mocks.getMultiProjectMode,
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
  autoMatchTeamForWorkspace: mocks.autoMatchTeamForWorkspace,
}));

vi.mock('../../services/TrackerSchemaService', () => ({
  updateTrackerSchemaWorkspace: mocks.updateTrackerSchemaWorkspace,
}));

vi.mock('../../window/StartupActivation', () => ({
  onStartupActivated: mocks.onStartupActivated,
}));

vi.mock('../../window/railSeeding', () => ({
  seedProjectIntoWindow: mocks.seedProjectIntoWindow,
  setPendingRailSeeds: mocks.setPendingRailSeeds,
}));

import { restoreSessionState, computeSessionRestorePlan, saveSessionState, SESSION_RESTORE_RAIL_CAP } from '../SessionState';
import { windows, windowStates, windowFocusOrder } from '../../window/WindowManager';
import { logger } from '../../utils/logger';
import type { SessionWindow } from '../../types';

function workspaceWindow(workspacePath: string, focusOrder: number, additionalWorkspacePaths?: string[]): SessionWindow {
  return {
    mode: 'workspace',
    workspacePath,
    focusOrder,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    ...(additionalWorkspacePaths ? { additionalWorkspacePaths } : {}),
  };
}

function documentWindow(filePath: string, focusOrder: number): SessionWindow {
  return {
    mode: 'document',
    filePath,
    focusOrder,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  };
}

describe('restoreSessionState window activation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.createWindow.mockReset();
    mocks.getSessionState.mockReset();
    mocks.clearSessionState.mockReset();
    mocks.onStartupActivated.mockReset();
    mocks.updateTrackerSchemaWorkspace.mockReset();
    mocks.getMultiProjectMode.mockReset();
    mocks.getMultiProjectMode.mockReturnValue(false);
    mocks.autoMatchTeamForWorkspace.mockReset();
    mocks.autoMatchTeamForWorkspace.mockResolvedValue(undefined);
    mocks.seedProjectIntoWindow.mockReset();
    mocks.setPendingRailSeeds.mockReset();
    mocks.seedProjectIntoWindow.mockResolvedValue('added');
    (logger.session.warn as ReturnType<typeof vi.fn>).mockReset();
    (logger.session.info as ReturnType<typeof vi.fn>).mockReset();

    mocks.createWindow.mockImplementation(() => ({
      isDestroyed: () => false,
      webContents: { once: vi.fn(), send: vi.fn(), openDevTools: vi.fn() },
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

  it('Multi-Project Mode: collapses saved workspace windows into one window plus rail seeds', async () => {
    mocks.getMultiProjectMode.mockReturnValue(true);
    mocks.getSessionState.mockReturnValue({
      windows: [
        { mode: 'workspace', workspacePath: '/workspace/older', focusOrder: 1 },
        { mode: 'workspace', workspacePath: '/workspace/newest', focusOrder: 3 },
        { mode: 'workspace', workspacePath: '/workspace/middle', focusOrder: 2 },
      ],
      lastUpdated: Date.now(),
    });

    const restorePromise = restoreSessionState();
    await vi.runAllTimersAsync();
    await expect(restorePromise).resolves.toBe(true);

    // Only one BrowserWindow -- for the previously-active (highest focusOrder) project.
    expect(mocks.createWindow).toHaveBeenCalledTimes(1);
    expect(mocks.createWindow).toHaveBeenCalledWith(
      false,
      true,
      '/workspace/newest',
      undefined,
      { showInactive: true, startupReveal: true, startupFrontmost: true },
    );

    await vi.runAllTimersAsync();

    // REGRESSION GUARD (observed in a real profile): the two non-primary saved
    // workspaces must be PARKED for the renderer to collect, never pushed at
    // `did-finish-load`. The renderer registers its `rail:add-project` handler
    // in a React effect that runs strictly after `did-finish-load`, so a push
    // lands with nothing listening, the ack times out, and the project is lost
    // from the rail -- and then from the next save, compounding every restart.
    expect(mocks.setPendingRailSeeds).toHaveBeenCalledWith(
      expect.any(Number),
      ['/workspace/older', '/workspace/middle'],
    );
    // Nothing may be pushed during restore; pushing is only correct for
    // "Merge All Windows", whose target window is already listening.
    expect(mocks.seedProjectIntoWindow).not.toHaveBeenCalled();

    // Team-match/tracker-schema are project-scoped: they run for every
    // restored project, whether it got its own window or joined the rail.
    expect(mocks.autoMatchTeamForWorkspace).toHaveBeenCalledWith('/workspace/newest');
    expect(mocks.autoMatchTeamForWorkspace).toHaveBeenCalledWith('/workspace/older');
    expect(mocks.autoMatchTeamForWorkspace).toHaveBeenCalledWith('/workspace/middle');
    expect(mocks.updateTrackerSchemaWorkspace).toHaveBeenCalledWith('/workspace/newest');
    expect(mocks.updateTrackerSchemaWorkspace).toHaveBeenCalledWith('/workspace/older');
    expect(mocks.updateTrackerSchemaWorkspace).toHaveBeenCalledWith('/workspace/middle');
  });

  it('Multi-Project Mode: a single saved window carrying additionalWorkspacePaths restores all of them (restore shape b)', async () => {
    mocks.getMultiProjectMode.mockReturnValue(true);
    mocks.getSessionState.mockReturnValue({
      windows: [
        {
          mode: 'workspace',
          workspacePath: '/workspace/primary',
          focusOrder: 1,
          additionalWorkspacePaths: ['/workspace/rail-a', '/workspace/rail-b'],
        },
      ],
      lastUpdated: Date.now(),
    });

    const restorePromise = restoreSessionState();
    await vi.runAllTimersAsync();
    await expect(restorePromise).resolves.toBe(true);

    // A single saved SessionWindow -- the legacy "N separate windows collapse"
    // shape never applies here, only the rail-contents field does.
    expect(mocks.createWindow).toHaveBeenCalledTimes(1);

    expect(mocks.setPendingRailSeeds).toHaveBeenCalledWith(
      expect.any(Number),
      ['/workspace/rail-a', '/workspace/rail-b'],
    );
    expect(mocks.seedProjectIntoWindow).not.toHaveBeenCalled();
  });

  it('Multi-Project Mode: overflow past the rail cap is reported once, not once per dropped path', async () => {
    mocks.getMultiProjectMode.mockReturnValue(true);
    const extraCount = 15; // comfortably more than SESSION_RESTORE_RAIL_CAP - 1
    mocks.getSessionState.mockReturnValue({
      windows: [
        { mode: 'workspace', workspacePath: '/workspace/primary', focusOrder: 100 },
        ...Array.from({ length: extraCount }, (_, i) => ({
          mode: 'workspace' as const,
          workspacePath: `/workspace/extra-${i}`,
          focusOrder: i,
        })),
      ],
      lastUpdated: Date.now(),
    });

    const restorePromise = restoreSessionState();
    await vi.runAllTimersAsync();
    await expect(restorePromise).resolves.toBe(true);

    const overflowWarnings = (logger.session.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([message]) => typeof message === 'string' && message.includes('did not fit in the rail'),
    );
    expect(overflowWarnings).toHaveLength(1);
    expect(overflowWarnings[0][0]).toContain(String(extraCount - (SESSION_RESTORE_RAIL_CAP - 1)));

    // Only the capped set is ever parked for the renderer -- the rest were
    // dropped in the plan itself, not refused one-by-one at the rail.
    const parked = mocks.setPendingRailSeeds.mock.calls.at(-1)?.[1] as string[];
    expect(parked).toHaveLength(SESSION_RESTORE_RAIL_CAP - 1);
  });

  it('Multi-Project Mode: parks rail projects without waiting on did-finish-load', async () => {
    // The bug this pins, seen in a real profile: restore used to push
    // `rail:add-project` from the window's `did-finish-load` handler. The
    // renderer registers that handler later still (a React effect after
    // mount), so the push landed with nothing listening, the ack timed out
    // after 2s, and the project vanished from the rail -- then from the next
    // save, compounding on every restart.
    //
    // Parking must therefore be complete WITHOUT `did-finish-load` ever
    // firing. Deliberately never invoke it here.
    mocks.getMultiProjectMode.mockReturnValue(true);
    mocks.getSessionState.mockReturnValue({
      windows: [
        { mode: 'workspace', workspacePath: '/workspace/primary', focusOrder: 10 },
        { mode: 'workspace', workspacePath: '/workspace/rail-a', focusOrder: 2 },
        { mode: 'workspace', workspacePath: '/workspace/rail-b', focusOrder: 1 },
      ],
      lastUpdated: Date.now(),
    });

    const restorePromise = restoreSessionState();
    await vi.runAllTimersAsync();
    await expect(restorePromise).resolves.toBe(true);

    // Least-recently-focused first, so the most recent ends up adjacent to
    // the restored active project in the rail (rail-b focusOrder 1, then
    // rail-a focusOrder 2).
    expect(mocks.setPendingRailSeeds).toHaveBeenCalledWith(
      expect.any(Number),
      ['/workspace/rail-b', '/workspace/rail-a'],
    );

    // Stronger than "the handler never fired": rail seeding no longer
    // subscribes to `did-finish-load` at all, so there is no ready-moment left
    // to guess wrong. (Other features may subscribe for their own reasons;
    // this window has no devtools flag, so nothing registers one here.)
    const restoredWindow = mocks.createWindow.mock.results[0].value;
    const didFinishLoadSubscriptions = restoredWindow.webContents.once.mock.calls.filter(
      ([event]: [string]) => event === 'did-finish-load',
    );
    expect(didFinishLoadSubscriptions).toHaveLength(0);
    expect(mocks.seedProjectIntoWindow).not.toHaveBeenCalled();
  });

  it('Multi-Project Mode off: restores one window per saved workspace exactly as before', async () => {
    mocks.getMultiProjectMode.mockReturnValue(false);
    mocks.getSessionState.mockReturnValue({
      windows: [
        { mode: 'workspace', workspacePath: '/workspace/a', focusOrder: 1 },
        { mode: 'workspace', workspacePath: '/workspace/b', focusOrder: 2 },
      ],
      lastUpdated: Date.now(),
    });

    const restorePromise = restoreSessionState();
    await vi.runAllTimersAsync();
    await expect(restorePromise).resolves.toBe(true);

    expect(mocks.createWindow).toHaveBeenCalledTimes(2);
    expect(mocks.seedProjectIntoWindow).not.toHaveBeenCalled();
  });
});

describe('computeSessionRestorePlan', () => {
  it('Multi-Project Mode on: collapses N saved workspaces into one window plus N-1 rail seeds', () => {
    const windows = [
      workspaceWindow('/ws/a', 1),
      workspaceWindow('/ws/b', 3),
      workspaceWindow('/ws/c', 2),
    ];

    const plan = computeSessionRestorePlan(windows, true);

    expect(plan.windowsToCreate).toEqual([windows[1]]);
    expect(plan.railPathsToSeed).toEqual(['/ws/a', '/ws/c']);
    expect(plan.activeWorkspacePath).toBe('/ws/b');
    expect(plan.overflowCount).toBe(0);
  });

  it('Multi-Project Mode off: restores every saved window unchanged (byte-for-byte)', () => {
    const windows = [workspaceWindow('/ws/a', 1), workspaceWindow('/ws/b', 2)];

    const plan = computeSessionRestorePlan(windows, false);

    expect(plan.windowsToCreate).toBe(windows);
    expect(plan.railPathsToSeed).toEqual([]);
    expect(plan.activeWorkspacePath).toBe('/ws/b');
    expect(plan.overflowCount).toBe(0);
  });

  it('a single saved workspace window is left alone even with the mode on (nothing to seed)', () => {
    const windows = [workspaceWindow('/ws/only', 1)];

    const plan = computeSessionRestorePlan(windows, true);

    expect(plan.windowsToCreate).toBe(windows);
    expect(plan.railPathsToSeed).toEqual([]);
    expect(plan.activeWorkspacePath).toBe('/ws/only');
    expect(plan.overflowCount).toBe(0);
  });

  it('mixed workspace/document windows: documents keep their own window and position; only the primary workspace joins them', () => {
    const windows = [
      documentWindow('/docs/notes.md', 1),
      workspaceWindow('/ws/older', 2),
      workspaceWindow('/ws/newer', 4),
      documentWindow('/docs/todo.md', 3),
    ];

    const plan = computeSessionRestorePlan(windows, true);

    expect(plan.windowsToCreate).toEqual([windows[0], windows[2], windows[3]]);
    expect(plan.railPathsToSeed).toEqual(['/ws/older']);
    expect(plan.activeWorkspacePath).toBe('/ws/newer');
    expect(plan.overflowCount).toBe(0);
  });

  it('document-mode restore is unaffected by Multi-Project Mode when there are no saved workspace windows', () => {
    const windows = [documentWindow('/docs/a.md', 1), documentWindow('/docs/b.md', 2)];

    const planOn = computeSessionRestorePlan(windows, true);
    const planOff = computeSessionRestorePlan(windows, false);

    expect(planOn).toEqual({ windowsToCreate: windows, railPathsToSeed: [], activeWorkspacePath: null, overflowCount: 0 });
    expect(planOff).toEqual({ windowsToCreate: windows, railPathsToSeed: [], activeWorkspacePath: null, overflowCount: 0 });
  });

  it('empty saved-window list produces an empty plan regardless of mode', () => {
    expect(computeSessionRestorePlan([], true)).toEqual({
      windowsToCreate: [],
      railPathsToSeed: [],
      activeWorkspacePath: null,
      overflowCount: 0,
    });
    expect(computeSessionRestorePlan([], false)).toEqual({
      windowsToCreate: [],
      railPathsToSeed: [],
      activeWorkspacePath: null,
      overflowCount: 0,
    });
  });

  it('no saved window carries a workspace path ("active path missing"): activeWorkspacePath is null and nothing collapses', () => {
    const windows = [documentWindow('/docs/only.md', 1)];

    const plan = computeSessionRestorePlan(windows, true);

    expect(plan.activeWorkspacePath).toBeNull();
    expect(plan.railPathsToSeed).toEqual([]);
    expect(plan.windowsToCreate).toBe(windows);
    expect(plan.overflowCount).toBe(0);
  });

  it('restore shape (b): a single saved window carrying additionalWorkspacePaths seeds all of them', () => {
    const windows = [workspaceWindow('/ws/primary', 1, ['/ws/rail-a', '/ws/rail-b'])];

    const plan = computeSessionRestorePlan(windows, true);

    expect(plan.windowsToCreate).toEqual([windows[0]]);
    expect(plan.railPathsToSeed).toEqual(['/ws/rail-a', '/ws/rail-b']);
    expect(plan.activeWorkspacePath).toBe('/ws/primary');
    expect(plan.overflowCount).toBe(0);
  });

  it('legacy sessions with no additionalWorkspacePaths field on any window still restore (missing treated as none)', () => {
    // No entry sets additionalWorkspacePaths at all -- the shape every session
    // saved before this field existed has.
    const windows = [workspaceWindow('/ws/a', 1), workspaceWindow('/ws/b', 2)];

    const plan = computeSessionRestorePlan(windows, true);

    expect(plan.railPathsToSeed).toEqual(['/ws/a']);
    expect(plan.activeWorkspacePath).toBe('/ws/b');
    expect(plan.overflowCount).toBe(0);
  });

  it('dedupes a path that appears both as a legacy sibling window and inside another window\'s additionalWorkspacePaths', () => {
    const windows = [
      workspaceWindow('/ws/a', 1),
      workspaceWindow('/ws/b', 3, ['/ws/a', '/ws/c']),
      workspaceWindow('/ws/c', 2),
    ];

    const plan = computeSessionRestorePlan(windows, true);

    expect(plan.railPathsToSeed).toEqual(['/ws/a', '/ws/c']);
    expect(plan.activeWorkspacePath).toBe('/ws/b');
    expect(plan.overflowCount).toBe(0);
  });

  it('caps railPathsToSeed at SESSION_RESTORE_RAIL_CAP - 1 (primary occupies the remaining slot) and reports the remainder as overflowCount', () => {
    const extraCount = 15;
    const windows = [
      workspaceWindow('/ws/primary', 100),
      ...Array.from({ length: extraCount }, (_, i) => workspaceWindow(`/ws/extra-${i}`, i)),
    ];

    const plan = computeSessionRestorePlan(windows, true);

    expect(plan.railPathsToSeed).toHaveLength(SESSION_RESTORE_RAIL_CAP - 1);
    expect(plan.overflowCount).toBe(extraCount - (SESSION_RESTORE_RAIL_CAP - 1));
    expect(plan.activeWorkspacePath).toBe('/ws/primary');
  });
});

describe('saveSessionState persists rail contents onto SessionWindow', () => {
  function fakeBrowserWindow() {
    return {
      isDestroyed: () => false,
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      isMaximized: () => false,
    };
  }

  beforeEach(() => {
    mocks.saveToStore.mockReset();
    mocks.getSessionState.mockReset();
    windows.clear();
    windowStates.clear();
    windowFocusOrder.clear();
  });

  it('writes additionalWorkspacePaths from the live WindowState onto the saved SessionWindow (round trip source)', async () => {
    windows.set(1, fakeBrowserWindow() as any);
    windowStates.set(1, {
      mode: 'workspace',
      filePath: null,
      workspacePath: '/ws/primary',
      additionalWorkspacePaths: ['/ws/rail-a', '/ws/rail-b'],
      documentEdited: false,
    } as any);
    windowFocusOrder.set(1, 1);

    await saveSessionState();

    expect(mocks.saveToStore).toHaveBeenCalledTimes(1);
    const saved = mocks.saveToStore.mock.calls[0][0] as { windows: SessionWindow[] };
    expect(saved.windows).toHaveLength(1);
    expect(saved.windows[0].workspacePath).toBe('/ws/primary');
    expect(saved.windows[0].additionalWorkspacePaths).toEqual(['/ws/rail-a', '/ws/rail-b']);
  });

  it('omits additionalWorkspacePaths when the live WindowState has none (never writes an empty-array field)', async () => {
    windows.set(1, fakeBrowserWindow() as any);
    windowStates.set(1, {
      mode: 'workspace',
      filePath: null,
      workspacePath: '/ws/only',
      documentEdited: false,
    } as any);
    windowFocusOrder.set(1, 1);

    await saveSessionState();

    const saved = mocks.saveToStore.mock.calls[0][0] as { windows: SessionWindow[] };
    expect(saved.windows[0].additionalWorkspacePaths).toBeUndefined();
  });

  it('save-then-restore round trip: rail paths saved from live state come back out of computeSessionRestorePlan', async () => {
    windows.set(1, fakeBrowserWindow() as any);
    windowStates.set(1, {
      mode: 'workspace',
      filePath: null,
      workspacePath: '/ws/primary',
      additionalWorkspacePaths: ['/ws/rail-a', '/ws/rail-b'],
      documentEdited: false,
    } as any);
    windowFocusOrder.set(1, 1);

    await saveSessionState();

    const saved = mocks.saveToStore.mock.calls[0][0] as { windows: SessionWindow[] };
    const plan = computeSessionRestorePlan(saved.windows, true);

    expect(plan.railPathsToSeed).toEqual(['/ws/rail-a', '/ws/rail-b']);
    expect(plan.activeWorkspacePath).toBe('/ws/primary');
  });
});
