import { describe, expect, it, vi } from 'vitest';

// SettingsControlService imports from many other modules (electron, store,
// StytchAuthService, WindowManager). For these invariants we only need the
// exported constants, so stub the heavy modules to keep the test fast.

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../utils/store', () => ({
  ALLOWED_APP_KEYS: undefined, // not used here
  addToRecentItems: vi.fn(),
  clearPendingThemeFallback: vi.fn(),
  getAppSetting: vi.fn(() => undefined),
  getAppStore: vi.fn(() => ({ set: vi.fn(), get: vi.fn(() => undefined) })),
  getDefaultAIModel: vi.fn(() => undefined),
  getReleaseChannel: vi.fn(() => 'stable'),
  getSessionSyncConfig: vi.fn(() => undefined),
  getTheme: vi.fn(() => 'dark'),
  getWorkspaceState: vi.fn(() => ({})),
  getWorkspaceWindowState: vi.fn(() => undefined),
  isAnalyticsEnabled: vi.fn(() => false),
  isSettingsAgentToolsDisabled: vi.fn(() => false),
  setAnalyticsEnabled: vi.fn(),
  setAppSetting: vi.fn(),
  setDefaultAIModel: vi.fn(),
  setPreferredAgentLanguage: vi.fn(),
  setSessionSyncConfig: vi.fn(),
  setTheme: vi.fn(),
  setWorkspaceTrusted: vi.fn(),
  updateWorkspaceState: vi.fn(),
}));

vi.mock('../StytchAuthService', () => ({
  isAuthenticated: vi.fn(() => false),
  getUserEmail: vi.fn(() => null),
  getPersonalOrgId: vi.fn(() => null),
  getPersonalUserId: vi.fn(() => null),
}));

vi.mock('../SessionNamingService', () => ({
  SessionNamingService: {
    getInstance: () => ({ setLanguage: vi.fn() }),
  },
}));

vi.mock('../../theme/ThemeManager', () => ({
  updateNativeTheme: vi.fn(),
  updateWindowTitleBars: vi.fn(),
}));

vi.mock('../../window/WindowManager', () => ({
  createWindow: vi.fn(),
  findWindowByWorkspace: vi.fn(() => null),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    store: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

const { startExtensionBackendModules, stopExtensionBackendModules } = vi.hoisted(() => ({
  startExtensionBackendModules: vi.fn().mockResolvedValue(undefined),
  stopExtensionBackendModules: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../extensions/backendModuleLifecycle', () => ({
  startExtensionBackendModules,
  stopExtensionBackendModules,
  getDefaultBackendModuleLifecycleDeps: vi.fn(() => ({})),
}));

import {
  ALLOWED_APP_KEYS,
  ALLOWED_WORKSPACE_KEYS,
  DENIED_APP_KEYS,
  SettingsControlService,
} from '../SettingsControlService';

describe('SettingsControlService allowlist invariants', () => {
  it('does not include any DENIED_APP_KEYS in ALLOWED_APP_KEYS', () => {
    // The whole point of the deny list: if anyone ever adds, say, `apiKeys` to
    // the allow list (intentionally or via a bad merge), this fails in CI.
    const allow = new Set<string>(ALLOWED_APP_KEYS);
    for (const denied of DENIED_APP_KEYS) {
      expect(allow.has(denied), `denied key "${denied}" must NOT be in ALLOWED_APP_KEYS`).toBe(false);
    }
  });

  it('explicitly denies known secret-bearing keys', () => {
    // Sanity check the deny list itself didn't get accidentally emptied.
    const denied = new Set<string>(DENIED_APP_KEYS);
    expect(denied.has('apiKeys')).toBe(true);
    expect(denied.has('globalApiKeys')).toBe(true);
    expect(denied.has('stytchAuth')).toBe(true);
    expect(denied.has('shareKeys')).toBe(true);
  });

  it('only allows curated app-level keys', () => {
    // If you intentionally add a new allowed key, update this assertion. The
    // point is to make new additions a deliberate, visible diff.
    expect([...ALLOWED_APP_KEYS].sort()).toEqual(
      [
        'alphaFeatures',
        'analyticsEnabled',
        'betaFeatures',
        'completionSoundEnabled',
        'defaultAIModel',
        'developerFeatures',
        'extensionSettings',
        'osNotificationsEnabled',
        'preferredAgentLanguage',
        'sessionSync',
        'settingsAgentToolsDisabled',
        'spellcheckEnabled',
        'theme',
        'voiceMode',
      ].sort(),
    );
  });

  it('only allows curated workspace-level keys', () => {
    expect([...ALLOWED_WORKSPACE_KEYS].sort()).toEqual(
      ['agentPermissions', 'issueKeyPrefix', 'trackerSyncPolicies'].sort(),
    );
  });
});

describe('SettingsControlService.setExtensionEnabled', () => {
  it('starts backend modules when enabling, mirroring the Settings UI IPC path', async () => {
    const service = SettingsControlService.getInstance();
    await service.setExtensionEnabled('session-1', {
      extensionId: 'com.nimbalyst.github-issues-importer',
      enabled: true,
    });
    expect(startExtensionBackendModules).toHaveBeenCalledWith(
      'com.nimbalyst.github-issues-importer',
      expect.anything(),
    );
    expect(stopExtensionBackendModules).not.toHaveBeenCalled();
  });

  it('stops backend modules when disabling', async () => {
    const service = SettingsControlService.getInstance();
    await service.setExtensionEnabled('session-1', {
      extensionId: 'com.nimbalyst.github-issues-importer',
      enabled: false,
    });
    expect(stopExtensionBackendModules).toHaveBeenCalledWith(
      'com.nimbalyst.github-issues-importer',
      expect.anything(),
    );
  });
});
