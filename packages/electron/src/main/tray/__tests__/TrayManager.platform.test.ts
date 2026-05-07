import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted mocks. The vi.mock factories below reference these handles, so they
// must come from vi.hoisted() to be available before module resolution.
const {
  trayInstance,
  nativeThemeOn,
  nativeThemeRemoveListener,
  systemPrefsSubscribe,
  systemPrefsUnsubscribe,
  loggerInfo,
  loggerError,
  loggerWarn,
  loggerDebug,
  managerSubscribe,
} = vi.hoisted(() => ({
  trayInstance: {
    setImage: vi.fn(),
    setTitle: vi.fn(),
    setContextMenu: vi.fn(),
    setToolTip: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn(),
  },
  nativeThemeOn: vi.fn(),
  nativeThemeRemoveListener: vi.fn(),
  systemPrefsSubscribe: vi.fn().mockReturnValue(42),
  systemPrefsUnsubscribe: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
  managerSubscribe: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('electron', () => ({
  Tray: vi.fn().mockImplementation(() => trayInstance),
  Menu: { buildFromTemplate: vi.fn().mockReturnValue({}) },
  app: {
    dock: undefined,
    on: vi.fn(),
    isReady: () => true,
  },
  nativeImage: {
    createFromPath: vi.fn().mockReturnValue({ isEmpty: () => false, setTemplateImage: vi.fn() }),
    createFromBuffer: vi.fn().mockReturnValue({ isEmpty: () => false, setTemplateImage: vi.fn() }),
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
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: vi.fn(() => ({ subscribe: managerSubscribe })),
}));

vi.mock('../../window/WindowManager', () => ({
  findWindowByWorkspace: vi.fn(),
}));

vi.mock('../../utils/appPaths', () => ({
  getPackageRoot: vi.fn(() => '/fake/package/root'),
}));

vi.mock('../../utils/store', () => ({
  isShowTrayIcon: vi.fn(() => false), // skip createTray for simplicity
  setShowTrayIcon: vi.fn(),
  getSessionSyncConfig: vi.fn(() => ({})),
  setSessionSyncConfig: vi.fn(),
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
}));

// Suppress the database-seed query in initialize() by stubbing it.
vi.mock('../TrayManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../TrayManager')>();
  return actual; // we want the real TrayManager; nothing to override at module level
});

import { TrayManager } from '../TrayManager';

function resetSingleton() {
  // Reset the private singleton between tests so each it() runs against a
  // fresh instance. The TrayManager class uses a static `instance` field,
  // so we have to clear it via the constructor cache.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (TrayManager as any).instance = undefined;
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
