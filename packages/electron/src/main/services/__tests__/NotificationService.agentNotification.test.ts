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
  createWindow: vi.fn(),
  getMostRecentlyFocusedWorkspaceWindow: vi.fn(),
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
  createWindow: mocks.createWindow,
  getMostRecentlyFocusedWorkspaceWindow: mocks.getMostRecentlyFocusedWorkspaceWindow,
}));

import { notificationService } from '../NotificationService';

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
    mocks.createWindow.mockReturnValue(makeFakeWindow());
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

    expect(mocks.createWindow).toHaveBeenCalledTimes(1);
    expect(mocks.createWindow).toHaveBeenCalledWith(
      false,
      true,
      '/workspace/unloaded',
    );
    expect(
      (notificationService as any).consumePendingNavigation('/workspace/unloaded'),
    ).toEqual({
      sessionId: 'session-unloaded',
      workspacePath: '/workspace/unloaded',
      sourceLabel: 'Build release',
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
    mocks.notificationListeners.get('click')?.();

    await notificationService.showNotification({
      title: 'Second task -- Response Ready',
      body: 'Second response',
      sessionId: 'session-second',
      workspacePath: '/workspace/opening',
      sourceLabel: 'Second task',
    });
    mocks.notificationListeners.get('click')?.();

    expect(mocks.createWindow).toHaveBeenCalledTimes(1);
    expect(notificationService.consumePendingNavigation('/workspace/opening')).toEqual({
      sessionId: 'session-second',
      workspacePath: '/workspace/opening',
      sourceLabel: 'Second task',
    });
  });

  it('re-opens the workspace after the opening window is lost before draining', async () => {
    const opened = makeFakeWindow();
    mocks.createWindow.mockReturnValue(opened);

    await clickNotification({
      sessionId: 'session-lost',
      workspacePath: '/workspace/lost',
      sourceLabel: 'Lost task',
    });
    expect(mocks.createWindow).toHaveBeenCalledTimes(1);

    // The window dies before its renderer ever drains the queued target.
    opened.lifecycleListeners.get('closed')?.();

    await clickNotification({
      sessionId: 'session-lost-again',
      workspacePath: '/workspace/lost',
      sourceLabel: 'Lost task',
    });

    expect(mocks.createWindow).toHaveBeenCalledTimes(2);
    expect(notificationService.consumePendingNavigation('/workspace/lost')).toEqual({
      sessionId: 'session-lost-again',
      workspacePath: '/workspace/lost',
      sourceLabel: 'Lost task',
    });
  });

  it('keeps the queued navigation when only a sub-frame fails to load', async () => {
    const opened = makeFakeWindow();
    mocks.createWindow.mockReturnValue(opened);

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
      expect(mocks.createWindow).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_000 + 120_000);
      expect(notificationService.consumePendingNavigation('/workspace/stale')).toBeNull();

      await clickNotification({
        sessionId: 'session-fresh',
        workspacePath: '/workspace/stale',
        sourceLabel: 'Stale task',
      });
      expect(mocks.createWindow).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reports an open failure to a workspace window instead of an arbitrary one', async () => {
    const offscreen = { isVisible: () => false, isFocused: () => false };
    mocks.browserWindows = [offscreen];
    const workspaceWindow = makeFakeWindow();
    mocks.getMostRecentlyFocusedWorkspaceWindow.mockReturnValue(workspaceWindow);
    mocks.createWindow.mockImplementation(() => {
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
    mocks.createWindow.mockImplementation(() => {
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
    expect(mocks.createWindow).not.toHaveBeenCalled();
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
