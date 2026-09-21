// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ channel: 'stable' }));
vi.mock('../../utils/store', () => ({ getReleaseChannel: () => settings.channel, store: {} }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn(), safeOn: vi.fn() }));
vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {} }));
vi.mock('electron-log/main', () => ({ default: { transports: { file: {} }, info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../analytics/AnalyticsService', () => ({ AnalyticsService: {} }));
vi.mock('../../ipc/SessionStateHandlers', () => ({ hasActiveStreamingSessions: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: vi.fn() }));
vi.mock('../../database/initialize', () => ({ getDatabase: vi.fn() }));
vi.mock('../electronUpdaterPatch', () => ({ installAtomFeedFilter: vi.fn() }));
vi.mock('electron-updater', async () => {
  // Keep the dependency's REAL channel setter and semver admission logic.
  const { AppUpdater } = await import('electron-updater/out/AppUpdater');
  class TestUpdater extends AppUpdater {
    constructor() {
      super(undefined, { version: '0.78.1', name: 'test', isPackaged: true } as never);
    }
    protected async doDownloadUpdate(): Promise<string[]> { return []; }
    quitAndInstall(): void { throw new Error('This test must never install an update'); }
  }
  const updater = new TestUpdater();
  updater.setFeedURL = vi.fn();
  updater.isUpdateSupported = async () => true;
  updater.isUserWithinRollout = async () => true;
  return { autoUpdater: updater };
});

import { autoUpdater } from 'electron-updater';
import { AutoUpdaterService } from '../autoUpdater';

beforeEach(() => {
  autoUpdater.removeAllListeners();
  settings.channel = 'stable';
});

it('refuses older releases through launch, repeated checks, and channel changes', async () => {
  const dependency = autoUpdater as unknown as { isUpdateAvailable(info: { version: string }): Promise<boolean> };
  for (let launch = 0; launch < 2; launch++) {
    const service = new AutoUpdaterService();
    for (const channel of ['stable', 'alpha', 'stable', 'stable']) {
      settings.channel = channel;
      service.reconfigureFeedURL();
      expect(autoUpdater.allowDowngrade).toBe(false);
      expect(await dependency.isUpdateAvailable({ version: '0.77.5' })).toBe(false);
      expect(await dependency.isUpdateAvailable({ version: '0.78.2' })).toBe(true);
    }
    autoUpdater.removeAllListeners();
  }
});
