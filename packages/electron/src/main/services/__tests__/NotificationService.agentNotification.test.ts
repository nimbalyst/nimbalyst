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
  findWindowByWorkspace: vi.fn(() => null),
}));

import { notificationService } from '../NotificationService';

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
});
