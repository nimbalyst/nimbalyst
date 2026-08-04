import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  subscribeNewDelivery: vi.fn(),
  subscribeSnapshot: vi.fn(),
  subscribeSettings: vi.fn(),
  notify: vi.fn(async () => {}),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('../../services/TeamInboxNativeNotification', () => ({
  createTeamInboxNotificationService: vi.fn(() => ({
    notify: mocks.notify,
  })),
}));

vi.mock('../../services/TeamInboxService', () => ({
  getTeamInboxService: vi.fn(() => ({
    start: vi.fn(async () => ({})),
    refresh: vi.fn(async () => ({})),
    getSnapshot: vi.fn(() => ({})),
    markRead: vi.fn(async () => {}),
    dismiss: vi.fn(async () => {}),
    setPresenceStatus: vi.fn(),
    subscribeNewDelivery: mocks.subscribeNewDelivery,
    subscribe: mocks.subscribeSnapshot,
  })),
  shutdownTeamInboxService: vi.fn(),
}));

vi.mock('../../services/SettingsService', () => ({
  getSettingsService: vi.fn(() => ({
    subscribe: mocks.subscribeSettings,
  })),
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      warn: vi.fn(),
    },
  },
}));

import {
  registerTeamInboxHandlers,
  shutdownTeamInboxHandlers,
} from '../TeamInboxHandlers';

describe('registerTeamInboxHandlers', () => {
  beforeEach(() => {
    shutdownTeamInboxHandlers();
    vi.clearAllMocks();
    mocks.subscribeNewDelivery.mockReturnValue(vi.fn());
    mocks.subscribeSnapshot.mockReturnValue(vi.fn());
    mocks.subscribeSettings.mockReturnValue(vi.fn());
  });

  it('installs the main-process subscriptions only once', () => {
    const dependencies = {
      openInboxSource: vi.fn(async () => true),
    };

    registerTeamInboxHandlers(dependencies);
    registerTeamInboxHandlers(dependencies);

    expect(mocks.subscribeNewDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.subscribeSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.subscribeSettings).toHaveBeenCalledTimes(1);
  });

  it('releases every owned subscription during shutdown', () => {
    const unsubscribeDeliveries = vi.fn();
    const unsubscribeSnapshots = vi.fn();
    const unsubscribeSettings = vi.fn();
    mocks.subscribeNewDelivery.mockReturnValue(unsubscribeDeliveries);
    mocks.subscribeSnapshot.mockReturnValue(unsubscribeSnapshots);
    mocks.subscribeSettings.mockReturnValue(unsubscribeSettings);

    registerTeamInboxHandlers({
      openInboxSource: vi.fn(async () => true),
    });
    shutdownTeamInboxHandlers();
    shutdownTeamInboxHandlers();

    expect(unsubscribeDeliveries).toHaveBeenCalledTimes(1);
    expect(unsubscribeSnapshots).toHaveBeenCalledTimes(1);
    expect(unsubscribeSettings).toHaveBeenCalledTimes(1);
  });
});
