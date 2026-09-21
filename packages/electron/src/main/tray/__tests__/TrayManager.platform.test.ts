import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted mocks. The vi.mock factories below reference these handles, so they
// must come from vi.hoisted() to be available before module resolution.
const {
  trayInstance,
  menuBuildFromTemplate,
  nativeThemeOn,
  nativeThemeRemoveListener,
  systemPrefsSubscribe,
  systemPrefsUnsubscribe,
  browserGetAllWindows,
  findWindowByWorkspaceMock,
  loggerInfo,
  loggerError,
  loggerWarn,
  loggerDebug,
  managerSubscribe,
  updateMetadataMock,
  syncPushChange,
  syncProvider,
  setShowTrayIconMock,
  isShowTrayIconMock,
  isShowTrayStripMock,
  getTrayStripStyleMock,
  showMenuBarIslandMock,
  closeMenuBarIslandMock,
  toggleTrayPanelWindowMock,
} = vi.hoisted(() => ({
  trayInstance: {
    setImage: vi.fn(),
    setTitle: vi.fn(),
    setContextMenu: vi.fn(),
    setToolTip: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 24, height: 24 })),
    on: vi.fn(),
    destroy: vi.fn(),
  },
  menuBuildFromTemplate: vi.fn().mockReturnValue({}),
  nativeThemeOn: vi.fn(),
  nativeThemeRemoveListener: vi.fn(),
  systemPrefsSubscribe: vi.fn().mockReturnValue(42),
  systemPrefsUnsubscribe: vi.fn(),
  browserGetAllWindows: vi.fn<() => unknown[]>(() => []),
  findWindowByWorkspaceMock: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
  managerSubscribe: vi.fn().mockReturnValue(() => {}),
  updateMetadataMock: vi.fn().mockResolvedValue(undefined),
  syncPushChange: vi.fn(),
  syncProvider: { pushChange: vi.fn() },
  setShowTrayIconMock: vi.fn(),
  // Off by default so `refreshMenuBar` skips creating a real Tray; the tests
  // that need one assign `internals.tray` directly or opt in.
  isShowTrayIconMock: vi.fn(() => false),
  // The strip is a rendered bitmap needing a real BrowserWindow; these tests
  // exercise the icon/menu path, so keep it off unless a test opts in.
  isShowTrayStripMock: vi.fn(() => false),
  getTrayStripStyleMock: vi.fn(() => 'image'),
  showMenuBarIslandMock: vi.fn(),
  closeMenuBarIslandMock: vi.fn(),
  toggleTrayPanelWindowMock: vi.fn(),
}));

syncProvider.pushChange = syncPushChange;

function createNativeImageMock() {
  return {
    isEmpty: () => false,
    setTemplateImage: vi.fn(),
    toBitmap: vi.fn(() => Buffer.alloc(32 * 32 * 4)),
  };
}

vi.mock('electron', () => ({
  Tray: vi.fn(function () {
    return trayInstance;
  }),
  Menu: { buildFromTemplate: menuBuildFromTemplate },
  app: {
    dock: undefined,
    on: vi.fn(),
    isReady: () => true,
  },
  nativeImage: {
    createFromPath: vi.fn().mockImplementation(() => createNativeImageMock()),
    createFromBuffer: vi.fn().mockImplementation(() => createNativeImageMock()),
  },
  nativeTheme: {
    on: nativeThemeOn,
    removeListener: nativeThemeRemoveListener,
    shouldUseDarkColors: false,
  },
  systemPreferences: {
    subscribeNotification: systemPrefsSubscribe,
    unsubscribeNotification: systemPrefsUnsubscribe,
  },
  BrowserWindow: { getAllWindows: browserGetAllWindows },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: vi.fn(() => ({ subscribe: managerSubscribe })),
}));

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: {
    updateMetadata: updateMetadataMock,
  },
}));

vi.mock('../../window/WindowManager', () => ({
  findWindowByWorkspace: findWindowByWorkspaceMock,
}));

vi.mock('../../utils/appPaths', () => ({
  getPackageRoot: vi.fn(() => '/fake/package/root'),
}));

vi.mock('../../utils/store', () => ({
  isShowTrayIcon: isShowTrayIconMock,
  setShowTrayIcon: setShowTrayIconMock,
  isShowTrayStrip: isShowTrayStripMock,
  // Fed back into the getter: `setStripVisible` reads its own write back to
  // decide which surface the menu bar gets, so a setter that goes nowhere makes
  // the reconciliation untestable.
  setShowTrayStrip: vi.fn((value: boolean) => { isShowTrayStripMock.mockReturnValue(value); }),
  getTrayStripStyle: getTrayStripStyleMock,
  setTrayStripStyle: vi.fn(),
  getSessionSyncConfig: vi.fn(() => ({})),
  setSessionSyncConfig: vi.fn(),
  isOSNotificationsEnabled: vi.fn(() => true),
  setOSNotificationsEnabled: vi.fn(),
  getTheme: vi.fn(() => 'dark'),
  getTrayPanelWidth: vi.fn(() => undefined),
  setTrayPanelWidth: vi.fn(),
}));

// The tray panel is macOS-only; these tests run on whatever platform CI uses, so
// pin it off unless a test opts in. That keeps the native-menu assertions below
// exercising the `setContextMenu` path they were written against.
vi.mock('../../window/TrayPanelWindow', () => ({
  isTrayPanelSupported: vi.fn(() => false),
  isTrayPanelWindow: vi.fn(() => false),
  toggleTrayPanelWindow: toggleTrayPanelWindowMock,
  pushTrayPanelFeed: vi.fn(),
  closeTrayPanelWindow: vi.fn(),
}));

vi.mock('../../window/MenuBarIslandWindow', () => ({
  isMenuBarIslandSupported: vi.fn(() => true),
  isMenuBarIslandWindow: vi.fn(() => false),
  showMenuBarIsland: showMenuBarIslandMock,
  closeMenuBarIsland: closeMenuBarIslandMock,
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: loggerInfo,
      error: loggerError,
      warn: loggerWarn,
      debug: loggerDebug,
    },
  },
}));

vi.mock('../../services/PowerSaveService', () => ({
  isPreventingSleep: vi.fn(() => false),
  getSleepPreventionMode: vi.fn(() => 'auto'),
}));

vi.mock('../../services/SyncManager', () => ({
  updateSleepPrevention: vi.fn(),
  resolvePreventSleepMode: vi.fn(() => 'auto'),
  getSyncProvider: vi.fn(() => syncProvider),
}));

// Suppress the database-seed query in initialize() by stubbing it.
vi.mock('../TrayManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../TrayManager')>();
  return actual; // we want the real TrayManager; nothing to override at module level
});

import { TrayManager, groupTraySessions } from '../TrayManager';
import { STALL_AFTER_MS } from '../fleetSnapshot';

function resetSingleton() {
  // Reset the private singleton between tests so each it() runs against a
  // fresh instance. The TrayManager class uses a static `instance` field,
  // so we have to clear it via the constructor cache.
  (TrayManager as unknown as { instance?: TrayManager }).instance = undefined;
}

function stubPlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => Object.defineProperty(process, 'platform', original);
}

describe('TrayManager - cross-platform initialisation (#39)', () => {
  let restorePlatform: () => void = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
    resetSingleton();
    delete process.env.PLAYWRIGHT;
  });

  afterEach(() => {
    restorePlatform();
  });

  it('does not return early on Linux', async () => {
    restorePlatform = stubPlatform('linux');
    const tm = TrayManager.getInstance();
    // Provide a database stub so seedUnreadFromDatabase doesn't blow up.
    tm.setDatabase({ query: vi.fn().mockResolvedValue({ rows: [] }) });

    await tm.initialize();

    // The "Skipping initialization on non-macOS platform" log used to fire
    // here. With the fix, only the routine "Initialized" line should land.
    const logged = loggerInfo.mock.calls.map(c => c[0]).join('\n');
    expect(logged).not.toContain('Skipping initialization on non-macOS platform');
    expect(logged).toContain('[TrayManager] Initialized');

    // Cross-platform listener is subscribed.
    expect(nativeThemeOn).toHaveBeenCalledWith('updated', expect.any(Function));
    // macOS-only listener is NOT subscribed on Linux.
    expect(systemPrefsSubscribe).not.toHaveBeenCalled();
  });

  it('warns with the session and reason when read state is not published', async () => {
    syncPushChange.mockResolvedValueOnce({ published: false, reason: 'index disconnected' });
    await (TrayManager.getInstance() as any).persistReadState('unpublished-session', 123);
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringMatching(/unpublished-session.*index disconnected/));
  });

  it('does not return early on Windows', async () => {
    restorePlatform = stubPlatform('win32');
    const tm = TrayManager.getInstance();
    tm.setDatabase({ query: vi.fn().mockResolvedValue({ rows: [] }) });

    await tm.initialize();

    const logged = loggerInfo.mock.calls.map(c => c[0]).join('\n');
    expect(logged).not.toContain('Skipping initialization on non-macOS platform');
    expect(logged).toContain('[TrayManager] Initialized');

    expect(nativeThemeOn).toHaveBeenCalledWith('updated', expect.any(Function));
    expect(systemPrefsSubscribe).not.toHaveBeenCalled();
  });

  it('still subscribes the macOS appearance notification on darwin', async () => {
    restorePlatform = stubPlatform('darwin');
    const tm = TrayManager.getInstance();
    tm.setDatabase({ query: vi.fn().mockResolvedValue({ rows: [] }) });

    await tm.initialize();

    expect(nativeThemeOn).toHaveBeenCalledWith('updated', expect.any(Function));
    expect(systemPrefsSubscribe).toHaveBeenCalledWith(
      'AppleInterfaceThemeChangedNotification',
      expect.any(Function),
    );
  });
});

describe('TrayManager unread actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSingleton();
    browserGetAllWindows.mockReturnValue([]);
    findWindowByWorkspaceMock.mockReturnValue(undefined);
    // These assert on the NSMenu, which only exists when there is a tray item.
    isShowTrayIconMock.mockReturnValue(true);
  });

  afterEach(() => {
    isShowTrayIconMock.mockReturnValue(false);
  });

  it('adds a Clear All Unread menu item and clears unread sessions through the shared read-state path', async () => {
    const tm = TrayManager.getInstance();
    const unreadA = {
      sessionId: 's1',
      title: 'Unread One',
      workspacePath: '/workspace/a',
      status: 'completed',
      isStreaming: false,
      hasPendingPrompt: false,
      hasUnread: true,
    };
    const unreadB = {
      sessionId: 's2',
      title: 'Unread Two',
      workspacePath: '/workspace/b',
      status: 'completed',
      isStreaming: false,
      hasPendingPrompt: false,
      hasUnread: true,
    };

    (tm as any).sessionCache.set(unreadA.sessionId, unreadA);
    (tm as any).sessionCache.set(unreadB.sessionId, unreadB);

    tm.setVisible(true);

    const menuItems = menuBuildFromTemplate.mock.calls.at(-1)?.[0];
    const clearAllItem = menuItems.find((item: any) => item.label === 'Clear All Unread');

    expect(clearAllItem).toBeTruthy();

    clearAllItem.click();

    await vi.waitFor(() => {
      expect(updateMetadataMock).toHaveBeenCalledTimes(2);
    });

    expect(updateMetadataMock).toHaveBeenNthCalledWith(1, 's1', {
      metadata: expect.objectContaining({ hasUnread: false, lastReadAt: expect.any(Number) }),
    });
    expect(updateMetadataMock).toHaveBeenNthCalledWith(2, 's2', {
      metadata: expect.objectContaining({ hasUnread: false, lastReadAt: expect.any(Number) }),
    });
    expect(syncPushChange).toHaveBeenCalledTimes(2);
    expect((tm as any).sessionCache.size).toBe(0);
    expect(browserGetAllWindows).toHaveBeenCalled();
  });

  it('clears unread when clicking a tray session and notifies the renderer immediately', async () => {
    const tm = TrayManager.getInstance();
    const targetWindow = {
      isDestroyed: vi.fn(() => false),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    };
    browserGetAllWindows.mockReturnValue([targetWindow as any]);
    findWindowByWorkspaceMock.mockReturnValue(targetWindow);

    (tm as any).sessionCache.set('s1', {
      sessionId: 's1',
      title: 'Unread One',
      workspacePath: '/workspace/a',
      status: 'completed',
      isStreaming: false,
      hasPendingPrompt: false,
      hasUnread: true,
    });

    tm.setVisible(true);

    const menuItems = menuBuildFromTemplate.mock.calls.at(-1)?.[0];
    const unreadItem = menuItems.find((item: any) => item.label === 'Unread One');

    unreadItem.click();

    await vi.waitFor(() => {
      expect(updateMetadataMock).toHaveBeenCalledWith('s1', {
        metadata: expect.objectContaining({ hasUnread: false, lastReadAt: expect.any(Number) }),
      });
    });

    expect(targetWindow.show).toHaveBeenCalled();
    expect(targetWindow.focus).toHaveBeenCalled();
    expect(targetWindow.webContents.send).toHaveBeenNthCalledWith(1, 'tray:navigate-to-session', {
      sessionId: 's1',
      workspacePath: '/workspace/a',
    });
    expect(targetWindow.webContents.send).toHaveBeenNthCalledWith(2, 'tray:clear-unread', {
      sessions: [
        {
          sessionId: 's1',
          workspacePath: '/workspace/a',
          lastReadAt: expect.any(Number),
        },
      ],
    });
    expect((tm as any).sessionCache.size).toBe(0);
  });
});

describe('liveness ticks', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSingleton();
    // No project window is open, so a completion here flags the session unread
    // exactly as it would with the app in the background.
    browserGetAllWindows.mockReturnValue([]);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  function cacheRunning(tm: TrayManager, updatedAt: number) {
    (tm as any).sessionCache.set('s1', {
      sessionId: 's1',
      title: 'Working',
      workspacePath: '/workspace/a',
      status: 'running',
      isStreaming: true,
      hasPendingPrompt: false,
      hasUnread: false,
      updatedAt,
    });
  }

  // A tick a minute that says "still running" changes nothing on screen. The
  // island sits in peripheral vision; repainting it for a no-op is the cost this
  // early return exists to avoid.
  it('records liveness without repainting when nothing visible changed', async () => {
    const tm = TrayManager.getInstance();
    cacheRunning(tm, NOW - 60_000);
    const rebuild = vi.spyOn(tm as any, 'scheduleMenuRebuild');

    await (tm as any).onSessionStateEvent({ type: 'session:activity', sessionId: 's1', timestamp: new Date() });

    expect((tm as any).sessionCache.get('s1')).toMatchObject({ liveAt: NOW, turnInFlight: true });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('repaints when the tick pulls a session back out of Not responding', async () => {
    const tm = TrayManager.getInstance();
    cacheRunning(tm, NOW - STALL_AFTER_MS);
    const rebuild = vi.spyOn(tm as any, 'scheduleMenuRebuild');

    await (tm as any).onSessionStateEvent({ type: 'session:activity', sessionId: 's1', timestamp: new Date() });

    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('ends the turn on a terminal event, so nothing outlives the ticker', async () => {
    const tm = TrayManager.getInstance();
    cacheRunning(tm, NOW - 60_000);
    await (tm as any).onSessionStateEvent({ type: 'session:activity', sessionId: 's1', timestamp: new Date() });

    await (tm as any).onSessionStateEvent({ type: 'session:completed', sessionId: 's1', timestamp: new Date() });

    expect((tm as any).sessionCache.get('s1')).toMatchObject({ turnInFlight: false });
  });
});

/**
 * The cache freezes `phase` and `isArchived` at first sight, and both of them
 * decide whether a running session is shown at all. A session marked `complete`
 * on an earlier run and then re-prompted therefore stayed out of the running
 * bucket for its whole next turn -- status `running`, tray icon lit, strip count
 * zero.
 */
describe('cached session flags go stale', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSingleton();
    browserGetAllWindows.mockReturnValue([]);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  function cacheFinished(tm: TrayManager, phase: string) {
    (tm as any).sessionCache.set('s1', {
      sessionId: 's1',
      title: 'Was finished',
      workspacePath: '/workspace/a',
      status: 'completed',
      isStreaming: false,
      hasPendingPrompt: false,
      hasUnread: false,
      phase,
      isArchived: false,
      updatedAt: NOW - 60_000,
    });
  }

  function stubRow(tm: TrayManager, row: Record<string, unknown>) {
    tm.setDatabase({ query: vi.fn().mockResolvedValue({ rows: [row] }) } as any);
  }

  it('re-reads the phase when a stale-complete session starts a new turn', async () => {
    const tm = TrayManager.getInstance();
    cacheFinished(tm, 'complete');
    stubRow(tm, { is_archived: 0, metadata: JSON.stringify({ phase: 'implementing' }) });

    await (tm as any).onSessionStateEvent({
      type: 'session:started',
      sessionId: 's1',
      timestamp: new Date(),
    });

    expect((tm as any).sessionCache.get('s1')).toMatchObject({ status: 'running', phase: 'implementing' });
    expect(tm.buildPanelFeed().running).toHaveLength(1);
    expect(tm.buildFleetSnapshot(NOW).running).toBe(1);
  });

  // The guard's original purpose, which must survive the refresh: an agent sets
  // `complete` just before its closing output, and the session has to drop out
  // of Running at that moment rather than at the end of the turn.
  it('honours a phase change written while the turn is running', async () => {
    const tm = TrayManager.getInstance();
    cacheFinished(tm, 'implementing');
    stubRow(tm, { is_archived: 0, metadata: JSON.stringify({ phase: 'implementing' }) });
    await (tm as any).onSessionStateEvent({
      type: 'session:started',
      sessionId: 's1',
      timestamp: new Date(),
    });
    expect(tm.buildPanelFeed().running).toHaveLength(1);

    tm.onSessionPhaseChanged('s1', 'complete');

    expect(tm.buildPanelFeed().running).toHaveLength(0);
    expect(tm.buildFleetSnapshot(NOW).running).toBe(0);
  });

  it('re-reads archived state, so a session archived mid-run leaves the panel', async () => {
    const tm = TrayManager.getInstance();
    cacheFinished(tm, 'implementing');
    stubRow(tm, { is_archived: 1, metadata: JSON.stringify({ phase: 'implementing' }) });

    await (tm as any).onSessionStateEvent({
      type: 'session:started',
      sessionId: 's1',
      timestamp: new Date(),
    });

    expect(tm.buildPanelFeed().running).toHaveLength(0);
  });
});

describe('groupTraySessions', () => {
  /**
   * A clock just past the newest fixture, so nothing below reads as stalled.
   *
   * Required rather than defaulted for exactly this reason: these fixtures use
   * `updatedAt` values in the hundreds, and against the real wall clock every
   * running session here would be classified stalled by decades.
   */
  const GROUP_NOW = 1_000;
  const base = {
    workspacePath: '/Users/dev/projects/nimbalyst',
    isStreaming: false,
    hasPendingPrompt: false,
    hasUnread: false,
    provider: 'claude-code',
    model: 'claude-code:opus-1m',
  };

  it('buckets a mixed cross-workspace set the way the in-app popover does', () => {
    const feed = groupTraySessions([
      { ...base, sessionId: 'blocked', title: 'Blocked', status: 'running', hasPendingPrompt: true, updatedAt: 500 },
      { ...base, sessionId: 'errored', title: 'Errored', status: 'error', updatedAt: 400 },
      { ...base, sessionId: 'running', title: 'Running', status: 'running', isStreaming: true, updatedAt: 300 },
      { ...base, sessionId: 'unread', title: 'Unread', status: 'completed', hasUnread: true, updatedAt: 200 },
      { ...base, sessionId: 'quiet', title: 'Quiet', status: 'completed', updatedAt: 100 },
    ] as any, GROUP_NOW);

    // `error` folds into Needs Attention -- the tray's one intended divergence
    // from the popover, which has no error state of its own.
    expect(feed.needsAttention.map((s) => s.sessionId)).toEqual(['blocked', 'errored']);
    expect(feed.running.map((s) => s.sessionId)).toEqual(['running']);
    expect(feed.unread.map((s) => s.sessionId)).toEqual(['unread']);
    // A completed, read, unblocked session belongs in no bucket at all.
    expect(feed.needsAttention.concat(feed.running, feed.unread)
      .some((s) => s.sessionId === 'quiet')).toBe(false);
  });

  // An agent sets phase 'complete' just before its closing output, which is what
  // flags the session unread -- so `complete` may only suppress the running
  // bucket, never an unread or prompting one. Mirrors agentSessionAttentionAtom.
  it('excludes archived sessions, and lets complete-phase suppress only Running', () => {
    const feed = groupTraySessions([
      { ...base, sessionId: 'archived', title: 'Archived', status: 'completed', hasUnread: true, isArchived: true, updatedAt: 4 },
      { ...base, sessionId: 'done-streaming', title: 'Done streaming', status: 'running', phase: 'complete', updatedAt: 3 },
      { ...base, sessionId: 'done-prompting', title: 'Done prompting', status: 'running', hasPendingPrompt: true, phase: 'complete', updatedAt: 2 },
      { ...base, sessionId: 'done-unread', title: 'Done unread', status: 'completed', hasUnread: true, phase: 'complete', updatedAt: 1 },
    ] as any, GROUP_NOW);

    expect(feed.needsAttention.map((s) => s.sessionId)).toEqual(['done-prompting']);
    expect(feed.running).toEqual([]);
    expect(feed.unread.map((s) => s.sessionId)).toEqual(['done-unread']);
  });

  // The panel is the sentence form of the strip, so it has to split running the
  // same way `deriveFleetSnapshot` does -- via the same `isStalled`, not a
  // second copy of the rule that can drift.
  it('splits a silent running session into its own bucket', () => {
    const now = STALL_AFTER_MS * 2;
    const feed = groupTraySessions([
      { ...base, sessionId: 'busy', title: 'Busy', status: 'running', updatedAt: now - 1000 },
      { ...base, sessionId: 'silent', title: 'Silent', status: 'running', updatedAt: now - STALL_AFTER_MS },
      // Same two states the snapshot splits on: a turn whose last lifecycle
      // transition is ancient but which is still ticking is running, not silent.
      {
        ...base,
        sessionId: 'long-turn',
        title: 'Long turn',
        status: 'running',
        updatedAt: now - STALL_AFTER_MS,
        liveAt: now - 30_000,
        turnInFlight: true,
      },
    ] as any, now);

    expect(feed.running.map((s) => s.sessionId)).toEqual(['busy', 'long-turn']);
    expect(feed.stalled.map((s) => s.sessionId)).toEqual(['silent']);
  });

  it('sorts newest first and derives the workspace chip from the path', () => {
    const feed = groupTraySessions([
      { ...base, sessionId: 'older', title: 'Older', status: 'running', updatedAt: 10 },
      { ...base, sessionId: 'newer', title: 'Newer', status: 'running', workspacePath: '/Users/dev/projects/other', updatedAt: 99 },
    ] as any, GROUP_NOW);

    expect(feed.running.map((s) => s.sessionId)).toEqual(['newer', 'older']);
    expect(feed.running.map((s) => s.workspaceName)).toEqual(['other', 'nimbalyst']);
  });
});

describe('menu bar island render style', () => {
  // `isStripEnabled()` is darwin-gated, so without pinning the platform none of
  // this paints on a Linux CI runner and every assertion below sees zero calls.
  let restorePlatform: () => void = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
    resetSingleton();
    restorePlatform = stubPlatform('darwin');
    isShowTrayStripMock.mockReturnValue(true);
    getTrayStripStyleMock.mockReturnValue('island');
  });

  afterEach(() => {
    restorePlatform();
    isShowTrayStripMock.mockReturnValue(false);
    getTrayStripStyleMock.mockReturnValue('image');
  });

  it('keeps pushing session rows to the island when the strip line is unchanged', () => {
    const tm = TrayManager.getInstance();
    const internals = tm as unknown as { refreshMenuBar: () => void; teardownStrip: () => void };

    internals.refreshMenuBar();
    internals.refreshMenuBar();

    // The bitmap path deliberately skips an unchanged render via `stripViewKey`.
    // The island must not inherit that: its expanded panel shows live session
    // rows, and the strip line stays identical while rows change underneath it
    // (a session finishing does not alter a "2 running" count until the counts
    // themselves move). Short-circuiting here leaves the rows stale.
    expect(showMenuBarIslandMock).toHaveBeenCalledTimes(2);
    expect(showMenuBarIslandMock.mock.calls[1][0]).toHaveProperty('feed');

    internals.teardownStrip();
  });

  /*
   * The bug this style setting was supposed to prevent: the island drawing in
   * the middle of the menu bar while the tray item sat on the right with its own
   * state dot. Two presences for one fleet, and the style setting looking like
   * it had done nothing.
   */
  it('takes the tray item away, so only one surface is in the menu bar', () => {
    const tm = TrayManager.getInstance();
    const internals = tm as unknown as { tray: unknown; refreshMenuBar: () => void; teardownStrip: () => void };
    internals.tray = trayInstance;

    internals.refreshMenuBar();

    expect(trayInstance.destroy).toHaveBeenCalled();
    expect(internals.tray).toBeNull();
    expect(showMenuBarIslandMock).toHaveBeenCalled();

    internals.teardownStrip();
  });

  // An empty session cache is the idle fleet. The island still paints -- it is
  // the only thing left in the menu bar -- and carries the summary the panel
  // shows instead of live rows.
  it('still paints, and attaches the idle summary, when the fleet is quiet', () => {
    const tm = TrayManager.getInstance();
    const internals = tm as unknown as { refreshMenuBar: () => void; teardownStrip: () => void };

    internals.refreshMenuBar();

    const frame = showMenuBarIslandMock.mock.calls[0][0];
    expect(frame.idle).toBeDefined();
    expect(frame.settings).toMatchObject({ style: 'island', showFleetStatus: true });

    internals.teardownStrip();
  });

  /*
   * Turning the fleet status off is the way back when the island is the only
   * thing on screen, so it has to restore the tray item -- otherwise the setting
   * empties the menu bar and takes its own control with it.
   */
  it('brings the tray item back when the fleet status is switched off', () => {
    const tm = TrayManager.getInstance();
    const internals = tm as unknown as { tray: unknown; teardownStrip: () => void };

    isShowTrayIconMock.mockReturnValue(true);
    tm.setStripVisible(false);

    expect(internals.tray).toBe(trayInstance);
    expect(closeMenuBarIslandMock).toHaveBeenCalled();

    isShowTrayIconMock.mockReturnValue(false);
    internals.teardownStrip();
  });
});
