import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  browserWindows: [] as Array<{
    isVisible: () => boolean;
    isFocused: () => boolean;
  }>,
  notificationConstructor: vi.fn(),
  notificationIsSupported: vi.fn(() => true),
  notificationShow: vi.fn(),
  notificationOn: vi.fn(),
  notificationRemoveListener: vi.fn(),
  notificationClose: vi.fn(),
  notificationListeners: new Map<string, (...args: unknown[]) => void>(),
  notificationOutcome: 'show' as 'show' | 'failed' | 'none',
  notificationFailure: 'OS rejected notification',
  osNotificationsEnabled: vi.fn(() => true),
  notifyWhenFocusedEnabled: vi.fn(() => false),
  sessionBlockedNotificationsEnabled: vi.fn(() => true),
  findWindowByWorkspace: vi.fn(),
  getMostRecentlyFocusedWorkspaceWindow: vi.fn(),
  openOrFocusWorkspaceWindowAwaitingRailSeed: vi.fn(),
}));

vi.mock('electron', () => {
  class MockNotification {
    static isSupported = mocks.notificationIsSupported;

    constructor(options: unknown) {
      mocks.notificationConstructor(options);
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      mocks.notificationOn(event, listener);
      mocks.notificationListeners.set(event, listener);
      return this;
    }

    removeListener(event: string, listener: (...args: unknown[]) => void) {
      mocks.notificationRemoveListener(event, listener);
      if (mocks.notificationListeners.get(event) === listener) {
        mocks.notificationListeners.delete(event);
      }
      return this;
    }

    show() {
      mocks.notificationShow();
      queueMicrotask(() => {
        if (mocks.notificationOutcome === 'show') {
          mocks.notificationListeners.get('show')?.({});
        } else if (mocks.notificationOutcome === 'failed') {
          mocks.notificationListeners.get('failed')?.({}, mocks.notificationFailure);
        }
      });
    }

    close = mocks.notificationClose;
  }

  return {
    Notification: MockNotification,
    BrowserWindow: {
      getAllWindows: () => mocks.browserWindows,
    },
    app: {
      getPath: () => 'C:\\Program Files\\Nimbalyst\\Nimbalyst.exe',
      isPackaged: false,
    },
    ipcMain: {
      once: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    shell: {
      openExternal: vi.fn(),
    },
  };
});

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('../../utils/store', () => ({
  isOSNotificationsEnabled: mocks.osNotificationsEnabled,
  isNotifyWhenFocusedEnabled: mocks.notifyWhenFocusedEnabled,
  isSessionBlockedNotificationsEnabled: mocks.sessionBlockedNotificationsEnabled,
}));

vi.mock('../../window/WindowManager', () => ({
  findWindowByWorkspace: mocks.findWindowByWorkspace,
  getMostRecentlyFocusedWorkspaceWindow: mocks.getMostRecentlyFocusedWorkspaceWindow,
}));

// Resolve icons against the real resources/ directory so the assertions below
// also prove the assets exist on disk.
vi.mock('../../utils/appPaths', () => ({
  getPackageRoot: () => fileURLToPath(new URL('../../../../', import.meta.url)),
}));

// Mocks the ref module, which is what NotificationService actually imports.
// Pointing this at `window/WorkspaceManagerWindow` would be a silent no-op
// (CLAUDE.md: a vi.mock whose specifier the module no longer imports does
// nothing) AND would let the real heavy module load.
vi.mock('../../window/workspaceOpenRef', () => ({
  openWorkspaceAwaitingRailSeed: mocks.openOrFocusWorkspaceWindowAwaitingRailSeed,
}));

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { notificationService, type BlockingType } from '../NotificationService';
import {
  clearNotificationIconCache,
  getNotificationIconsDir,
  NOTIFICATION_KINDS,
  notificationIconFileName,
  resolveNotificationIcon,
} from '../notificationIcons';

interface FakeWindow {
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  webContents: {
    send: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  lifecycleListeners: Map<string, () => void>;
}

function makeFakeWindow(): FakeWindow {
  const lifecycleListeners = new Map<string, () => void>();
  const record = (event: string, listener: () => void) => {
    lifecycleListeners.set(event, listener);
  };
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    focus: vi.fn(),
    show: vi.fn(),
    once: vi.fn(record),
    webContents: {
      send: vi.fn(),
      once: vi.fn(record),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        lifecycleListeners.set(event, listener as () => void);
      }),
    },
    lifecycleListeners,
  };
}

/**
 * `openWorkspaceForNavigation` awaits `openOrFocusWorkspaceWindowAwaitingRailSeed`
 * (see Fix 2: sequencing the live `notification-clicked` send after the rail
 * seed lands instead of racing it) -- flush the microtask queue so mocked
 * promise resolutions settle before assertions run.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function clickNotification(options: {
  sessionId?: string;
  workspacePath: string;
  sourceLabel?: string;
}): Promise<void> {
  await notificationService.showNotification({
    title: 'Response Ready',
    body: 'Ready for review',
    ...options,
  });
  mocks.notificationListeners.get('click')?.();
  await flushMicrotasks();
}

describe('NotificationService agent notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.browserWindows = [];
    mocks.notificationListeners.clear();
    mocks.notificationOutcome = 'show';
    mocks.notificationFailure = 'OS rejected notification';
    mocks.notificationIsSupported.mockReturnValue(true);
    mocks.osNotificationsEnabled.mockReturnValue(true);
    mocks.notifyWhenFocusedEnabled.mockReturnValue(false);
    mocks.sessionBlockedNotificationsEnabled.mockReturnValue(true);
    mocks.findWindowByWorkspace.mockReturnValue(null);
    mocks.getMostRecentlyFocusedWorkspaceWindow.mockReturnValue(null);
    mocks.openOrFocusWorkspaceWindowAwaitingRailSeed.mockResolvedValue({ kind: 'new-window', window: makeFakeWindow() });
    clearNotificationIconCache();
  });

  it('reports a skipped result when OS notifications are disabled', async () => {
    mocks.osNotificationsEnabled.mockReturnValue(false);

    const result = await notificationService.showNotificationWithResult({
      title: 'Agent needs attention',
      body: 'Smoke test',
      sessionId: 'session-1',
      workspacePath: '/workspace',
      provider: 'agent',
    });

    expect(result).toMatchObject({
      success: true,
      attempted: false,
      shown: false,
      skippedReason: 'os_notifications_disabled',
      sessionId: 'session-1',
      workspacePath: '/workspace',
    });
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  });

  it('skips while the app is focused unless bypassFocusCheck is set', async () => {
    mocks.browserWindows = [
      {
        isVisible: () => true,
        isFocused: () => true,
      },
    ];

    const result = await notificationService.showNotificationWithResult({
      title: 'Agent needs attention',
      body: 'Smoke test',
      sessionId: 'session-1',
      workspacePath: '/workspace',
      provider: 'agent',
    });

    expect(result).toMatchObject({
      success: true,
      attempted: false,
      shown: false,
      skippedReason: 'app_focused',
    });
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  });

  it('shows when bypassFocusCheck is set even if the app is focused', async () => {
    mocks.browserWindows = [
      {
        isVisible: () => true,
        isFocused: () => true,
      },
    ];

    const result = await notificationService.showNotificationWithResult({
      title: 'Agent needs attention',
      body: 'Smoke test',
      sessionId: 'session-1',
      workspacePath: '/workspace',
      provider: 'agent',
      bypassFocusCheck: true,
    });

    expect(result).toMatchObject({
      success: true,
      attempted: true,
      shown: true,
      skippedReason: null,
    });
    expect(mocks.notificationConstructor).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Agent needs attention',
      body: 'Smoke test',
      urgency: 'normal',
      timeoutType: 'default',
    }));
    expect(mocks.notificationShow).toHaveBeenCalledTimes(1);
  });

  it('reports failure when Electron emits the failed outcome', async () => {
    mocks.notificationOutcome = 'failed';

    const result = await notificationService.showNotificationWithResult({
      title: 'Agent needs attention',
      body: 'Smoke test',
      sessionId: 'session-1',
      workspacePath: '/workspace',
      provider: 'agent',
    });

    expect(result).toMatchObject({
      success: false,
      attempted: true,
      shown: false,
      skippedReason: 'error',
      error: 'OS rejected notification',
    });
  });

  it('reports an unconfirmed outcome instead of claiming the notification was shown', async () => {
    vi.useFakeTimers();
    mocks.notificationOutcome = 'none';

    try {
      const resultPromise = notificationService.showNotificationWithResult({
        title: 'Agent needs attention',
        body: 'Smoke test',
        sessionId: 'session-1',
        workspacePath: '/workspace',
        provider: 'agent',
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(resultPromise).resolves.toMatchObject({
        success: false,
        attempted: true,
        shown: false,
        skippedReason: 'confirmation_timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes a click with immutable workspace and session identity', async () => {
    const send = vi.fn();
    mocks.findWindowByWorkspace.mockReturnValue({
      isDestroyed: () => false,
      isMinimized: () => false,
      focus: vi.fn(),
      show: vi.fn(),
      webContents: { send },
    });

    await notificationService.showNotification({
      title: 'Build release -- Response Ready',
      body: 'Ready for review',
      sessionId: 'session-1',
      workspacePath: '/workspace/alpha',
      sourceLabel: 'Build release',
    });
    mocks.notificationListeners.get('click')?.();

    expect(send).toHaveBeenCalledWith('notification-clicked', {
      sessionId: 'session-1',
      workspacePath: '/workspace/alpha',
      sourceLabel: 'Build release',
    });
  });

  it('queues navigation and opens an unloaded workspace once', async () => {
    await notificationService.showNotification({
      title: 'Build release -- Response Ready',
      body: 'Ready for review',
      sessionId: 'session-unloaded',
      workspacePath: '/workspace/unloaded',
      sourceLabel: 'Build release',
    });
    mocks.notificationListeners.get('click')?.();
    await flushMicrotasks();

    expect(mocks.openOrFocusWorkspaceWindowAwaitingRailSeed).toHaveBeenCalledTimes(1);
    expect(mocks.openOrFocusWorkspaceWindowAwaitingRailSeed).toHaveBeenCalledWith('/workspace/unloaded');
    expect(
      (notificationService as any).consumePendingNavigation('/workspace/unloaded'),
    ).toEqual({
      sessionId: 'session-unloaded',
      workspacePath: '/workspace/unloaded',
      sourceLabel: 'Build release',
    });
  });

  it('delivers the navigation live instead of queuing when Multi-Project Mode adds the project to an already-loaded rail window', async () => {
    const railWindow = makeFakeWindow();
    mocks.openOrFocusWorkspaceWindowAwaitingRailSeed.mockResolvedValue({ kind: 'add-to-rail', window: railWindow });

    await clickNotification({
      sessionId: 'session-rail',
      workspacePath: '/workspace/rail',
      sourceLabel: 'Rail task',
    });

    expect(railWindow.focus).toHaveBeenCalled();
    expect(railWindow.show).toHaveBeenCalled();
    expect(railWindow.webContents.send).toHaveBeenCalledWith('notification-clicked', {
      sessionId: 'session-rail',
      workspacePath: '/workspace/rail',
      sourceLabel: 'Rail task',
    });
    // No fresh mount to drain a queue entry from -- it must not be queued.
    expect(notificationService.consumePendingNavigation('/workspace/rail')).toBeNull();
  });

  it('does not deliver notification-clicked anywhere when the rail seed is refused at the project cap (Fix 2: avoids a duplicate "rail full" toast)', async () => {
    // `openOrFocusWorkspaceWindowAwaitingRailSeed` focuses the rail window
    // before seeding, so in production `getMostRecentlyFocusedWorkspaceWindow`
    // resolves to that SAME window once the seed is refused -- not some
    // other window. Modeling them as the same fake is what pins the bug:
    // `reportNavigationFailure` sending `notification-clicked` here would
    // land in the rail window whose renderer already showed the "rail full"
    // toast for this exact refused add.
    const railWindow = makeFakeWindow();
    mocks.openOrFocusWorkspaceWindowAwaitingRailSeed.mockResolvedValue({
      kind: 'blocked',
      reason: 'at-cap',
      window: railWindow,
    });
    mocks.getMostRecentlyFocusedWorkspaceWindow.mockReturnValue(railWindow);

    await clickNotification({
      sessionId: 'session-capped',
      workspacePath: '/workspace/capped',
      sourceLabel: 'Capped task',
    });

    // The renderer's own `rail:add-project` listener already showed the
    // "rail full" toast for the refused seed -- delivering
    // `notification-clicked` anywhere here would make `activateWorkspace()`
    // retry the same add and show a second, differently-worded toast for
    // one click. No window should receive it.
    expect(railWindow.webContents.send).not.toHaveBeenCalledWith(
      'notification-clicked',
      expect.anything(),
    );
    expect(notificationService.consumePendingNavigation('/workspace/capped')).toBeNull();
  });

  it('reports the failure once when the rail seed ack times out (Fix 2: distinct from at-cap, nothing was shown to the user)', async () => {
    const railWindow = makeFakeWindow();
    mocks.openOrFocusWorkspaceWindowAwaitingRailSeed.mockResolvedValue({
      kind: 'blocked',
      reason: 'timeout',
      window: railWindow,
    });
    const fallback = makeFakeWindow();
    mocks.getMostRecentlyFocusedWorkspaceWindow.mockReturnValue(fallback);

    await clickNotification({
      sessionId: 'session-timeout',
      workspacePath: '/workspace/timeout',
      sourceLabel: 'Timeout task',
    });

    expect(fallback.webContents.send).toHaveBeenCalledTimes(1);
    expect(fallback.webContents.send).toHaveBeenCalledWith('notification-clicked', {
      sessionId: 'session-timeout',
      workspacePath: '/workspace/timeout',
      sourceLabel: 'Timeout task',
    });
    expect(notificationService.consumePendingNavigation('/workspace/timeout')).toBeNull();
  });

  it('does not race a second rail seed when the same still-opening workspace is clicked again before the first seed resolves (Fix 2)', async () => {
    const railWindow = makeFakeWindow();
    let resolveSeed: (outcome: { kind: 'add-to-rail'; window: typeof railWindow }) => void;
    mocks.openOrFocusWorkspaceWindowAwaitingRailSeed.mockReturnValue(
      new Promise((resolve) => {
        resolveSeed = resolve;
      }),
    );

    await notificationService.showNotification({
      title: 'Response Ready',
      body: 'Ready for review',
      sessionId: 'session-first-click',
      workspacePath: '/workspace/racy',
      sourceLabel: 'Racy task',
    });
    // First click: the seed is in flight, unresolved.
    mocks.notificationListeners.get('click')?.();
    // Second click lands before the seed resolves -- the synchronous
    // `pendingNavigations` write from the first click must make this one a
    // no-op ("still opening") rather than firing a second seed.
    mocks.notificationListeners.get('click')?.();

    expect(mocks.openOrFocusWorkspaceWindowAwaitingRailSeed).toHaveBeenCalledTimes(1);

    resolveSeed!({ kind: 'add-to-rail', window: railWindow });
    await flushMicrotasks();

    expect(railWindow.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('delivers the LATEST clicked session, not the first, when a second click lands on the same still-opening rail add before the seed resolves (Fix 2)', async () => {
    const railWindow = makeFakeWindow();
    let resolveSeed: (outcome: { kind: 'add-to-rail'; window: typeof railWindow }) => void;
    mocks.openOrFocusWorkspaceWindowAwaitingRailSeed.mockReturnValue(
      new Promise((resolve) => {
        resolveSeed = resolve;
      }),
    );

    await notificationService.showNotification({
      title: 'First task -- Response Ready',
      body: 'First response',
      sessionId: 'session-first',
      workspacePath: '/workspace/racy-sessions',
      sourceLabel: 'First task',
    });
    mocks.notificationListeners.get('click')?.();

    await notificationService.showNotification({
      title: 'Second task -- Response Ready',
      body: 'Second response',
      sessionId: 'session-second',
      workspacePath: '/workspace/racy-sessions',
      sourceLabel: 'Second task',
    });
    // Still opening -- this click overwrites the queued target with
    // session-second instead of firing a second seed.
    mocks.notificationListeners.get('click')?.();
    expect(mocks.openOrFocusWorkspaceWindowAwaitingRailSeed).toHaveBeenCalledTimes(1);

    resolveSeed!({ kind: 'add-to-rail', window: railWindow });
    await flushMicrotasks();

    expect(railWindow.webContents.send).toHaveBeenCalledTimes(1);
    expect(railWindow.webContents.send).toHaveBeenCalledWith('notification-clicked', {
      sessionId: 'session-second',
      workspacePath: '/workspace/racy-sessions',
      sourceLabel: 'Second task',
    });
  });

  it('keeps only the latest clicked session while an unloaded workspace opens', async () => {
    await notificationService.showNotification({
      title: 'First task -- Response Ready',
      body: 'First response',
      sessionId: 'session-first',
      workspacePath: '/workspace/opening',
      sourceLabel: 'First task',
    });
    // `pendingNavigations` is written synchronously (before any await), so
    // the second click below sees "still opening" immediately -- no flush
    // needed between the two clicks.
    mocks.notificationListeners.get('click')?.();

    await notificationService.showNotification({
      title: 'Second task -- Response Ready',
      body: 'Second response',
      sessionId: 'session-second',
      workspacePath: '/workspace/opening',
      sourceLabel: 'Second task',
    });
    mocks.notificationListeners.get('click')?.();
    await flushMicrotasks();

    expect(mocks.openOrFocusWorkspaceWindowAwaitingRailSeed).toHaveBeenCalledTimes(1);
    expect(notificationService.consumePendingNavigation('/workspace/opening')).toEqual({
      sessionId: 'session-second',
      workspacePath: '/workspace/opening',
      sourceLabel: 'Second task',
    });
  });

  it('re-opens the workspace after the opening window is lost before draining', async () => {
    const opened = makeFakeWindow();
    mocks.openOrFocusWorkspaceWindowAwaitingRailSeed.mockResolvedValue({ kind: 'new-window', window: opened });

    await clickNotification({
      sessionId: 'session-lost',
      workspacePath: '/workspace/lost',
      sourceLabel: 'Lost task',
    });
    expect(mocks.openOrFocusWorkspaceWindowAwaitingRailSeed).toHaveBeenCalledTimes(1);

    // The window dies before its renderer ever drains the queued target.
    opened.lifecycleListeners.get('closed')?.();

    await clickNotification({
      sessionId: 'session-lost-again',
      workspacePath: '/workspace/lost',
      sourceLabel: 'Lost task',
    });

    expect(mocks.openOrFocusWorkspaceWindowAwaitingRailSeed).toHaveBeenCalledTimes(2);
    expect(notificationService.consumePendingNavigation('/workspace/lost')).toEqual({
      sessionId: 'session-lost-again',
      workspacePath: '/workspace/lost',
      sourceLabel: 'Lost task',
    });
  });

  it('keeps the queued navigation when only a sub-frame fails to load', async () => {
    const opened = makeFakeWindow();
    mocks.openOrFocusWorkspaceWindowAwaitingRailSeed.mockResolvedValue({ kind: 'new-window', window: opened });

    await clickNotification({
      sessionId: 'session-subframe',
      workspacePath: '/workspace/subframe',
      sourceLabel: 'Subframe task',
    });

    const onFailLoad = opened.lifecycleListeners.get('did-fail-load') as unknown as
      (...args: unknown[]) => void;
    onFailLoad({}, -3, 'ERR_ABORTED', 'about:blank', false);

    expect(notificationService.consumePendingNavigation('/workspace/subframe')).toEqual({
      sessionId: 'session-subframe',
      workspacePath: '/workspace/subframe',
      sourceLabel: 'Subframe task',
    });
  });

  it('discards a queued navigation that outlives the window-open window', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_000);
      await clickNotification({
        sessionId: 'session-stale',
        workspacePath: '/workspace/stale',
        sourceLabel: 'Stale task',
      });
      expect(mocks.openOrFocusWorkspaceWindowAwaitingRailSeed).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_000 + 120_000);
      expect(notificationService.consumePendingNavigation('/workspace/stale')).toBeNull();

      await clickNotification({
        sessionId: 'session-fresh',
        workspacePath: '/workspace/stale',
        sourceLabel: 'Stale task',
      });
      expect(mocks.openOrFocusWorkspaceWindowAwaitingRailSeed).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reports an open failure to a workspace window instead of an arbitrary one', async () => {
    const offscreen = { isVisible: () => false, isFocused: () => false };
    mocks.browserWindows = [offscreen];
    const workspaceWindow = makeFakeWindow();
    mocks.getMostRecentlyFocusedWorkspaceWindow.mockReturnValue(workspaceWindow);
    mocks.openOrFocusWorkspaceWindowAwaitingRailSeed.mockImplementation(() => {
      throw new Error('workspace is not trusted');
    });

    await clickNotification({
      sessionId: 'session-failed',
      workspacePath: '/workspace/failed',
      sourceLabel: 'Failed task',
    });

    expect(workspaceWindow.webContents.send).toHaveBeenCalledWith('notification-clicked', {
      sessionId: 'session-failed',
      workspacePath: '/workspace/failed',
      sourceLabel: 'Failed task',
    });
    expect(workspaceWindow.show).toHaveBeenCalled();
    // The queue entry must not survive a failed open, or later clicks no-op.
    expect(notificationService.consumePendingNavigation('/workspace/failed')).toBeNull();
  });

  it('falls back to an OS notification when no workspace window can report the failure', async () => {
    mocks.getMostRecentlyFocusedWorkspaceWindow.mockReturnValue(null);
    mocks.openOrFocusWorkspaceWindowAwaitingRailSeed.mockImplementation(() => {
      throw new Error('workspace is not trusted');
    });

    await clickNotification({
      sessionId: 'session-orphan',
      workspacePath: '/workspace/orphan',
      sourceLabel: 'Orphan task',
    });

    expect(mocks.notificationConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Orphan task -- could not be opened',
      }),
    );
  });

  it('still raises the window for a notification that carries no session id', async () => {
    const targetWindow = makeFakeWindow();
    mocks.findWindowByWorkspace.mockReturnValue(targetWindow);

    await clickNotification({ workspacePath: '/workspace/alpha' });

    expect(targetWindow.focus).toHaveBeenCalled();
    expect(targetWindow.show).toHaveBeenCalled();
    expect(targetWindow.webContents.send).not.toHaveBeenCalledWith(
      'notification-clicked',
      expect.anything(),
    );
    expect(mocks.openOrFocusWorkspaceWindowAwaitingRailSeed).not.toHaveBeenCalled();
  });

  it('bounds a blocked notification title built from a long session name', async () => {
    await notificationService.showBlockedNotification(
      'session-1',
      'S'.repeat(200),
      'question',
      '/workspace/alpha',
    );

    const title = mocks.notificationConstructor.mock.calls.at(-1)?.[0]?.title as string;
    expect(title).toHaveLength(120);
    expect(title.endsWith('...')).toBe(true);
  });

  it('ships artwork on disk for every kind on every platform', () => {
    // A missing asset degrades to the default app icon silently -- the toast
    // still shows, so nothing else in the suite would notice it went missing
    // from resources/ or from the packaged extraResources copy. Windows needs
    // its own file because the icon replaces the toast logo there, so a
    // Windows-only gap would never show up on a macOS dev machine.
    for (const kind of NOTIFICATION_KINDS) {
      for (const platform of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
        const file = path.join(
          getNotificationIconsDir(),
          notificationIconFileName(kind, platform),
        );
        expect(existsSync(file), `${file} does not exist`).toBe(true);
      }
      expect(resolveNotificationIcon(kind), `no icon resolved for ${kind}`).toBeDefined();
    }
  });

  it('sends the agent-complete artwork with a completion notification', async () => {
    await notificationService.showNotification({
      title: 'Build release -- Response Ready',
      body: 'Ready for review',
      kind: 'agent-complete',
      sessionId: 'session-1',
      workspacePath: '/workspace/alpha',
    });

    const icon = mocks.notificationConstructor.mock.calls.at(-1)?.[0]?.icon as string;
    expect(path.basename(icon)).toBe(notificationIconFileName('agent-complete'));
  });

  it('gives each blocking type the artwork that matches what it wants from the user', async () => {
    const iconFor = async (blockingType: BlockingType): Promise<string> => {
      await notificationService.showBlockedNotification(
        'session-1',
        'Build release',
        blockingType,
        '/workspace/alpha',
      );
      return mocks.notificationConstructor.mock.calls.at(-1)?.[0]?.icon as string;
    };

    // A question wants an answer only the user has; the rest want a yes/no on
    // work the agent already drafted.
    expect(path.basename(await iconFor('question')))
      .toBe(notificationIconFileName('agent-question'));
    for (const blockingType of ['permission', 'plan_approval', 'git_commit'] as BlockingType[]) {
      expect(path.basename(await iconFor(blockingType)))
        .toBe(notificationIconFileName('needs-input'));
    }
    expect(await iconFor('question')).not.toBe(resolveNotificationIcon('agent-complete'));
  });

  it('gives Windows its own logo-bearing artwork', () => {
    expect(notificationIconFileName('teams-message', 'win32')).toBe('teams-message-win.png');
    expect(notificationIconFileName('teams-message', 'darwin')).toBe('teams-message.png');
  });

  it('falls back to the default app icon when the artwork is missing', async () => {
    vi.resetModules();
    vi.doMock('../../utils/appPaths', () => ({
      getPackageRoot: () => '/nonexistent-package-root',
    }));
    const { resolveNotificationIcon: resolveMissing } = await import('../notificationIcons');

    expect(resolveMissing('teams-message')).toBeUndefined();

    vi.doUnmock('../../utils/appPaths');
    vi.resetModules();
  });

  it('prefixes blocked notifications with the originating session name', async () => {
    await notificationService.showBlockedNotification(
      'session-1',
      'Build release',
      'question',
      '/workspace/alpha',
    );

    expect(mocks.notificationConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Build release -- Question Waiting',
      }),
    );
  });
});
