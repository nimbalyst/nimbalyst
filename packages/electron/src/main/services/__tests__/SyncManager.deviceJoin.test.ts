// @vitest-environment node
import { afterEach, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  joined: undefined as undefined | ((devices: unknown[]) => void),
  settings: vi.fn(() => ({})), refresh: vi.fn(async () => {}), warn: vi.fn(),
  sentSettings: vi.fn(async (_settings: { version: number }) => {}),
  persisted: new Map<string, unknown>(),
  failWrite: false,
  credentials: vi.fn(() => ({ encryptionKeySeed: 'seed' })),
  hostname: 'original-host', member: 'member', userData: '',
  deviceInfo: undefined as undefined | (() => {deviceId: string}),
}));
vi.mock('@nimbalyst/runtime/sync', () => ({
  setSyncImageCompressor: vi.fn(), setSyncClientInfo: vi.fn(),
  deriveEncryptionKey: vi.fn(async () => ({})), personalSyncEncryptionSalt: vi.fn(),
  createCollabV3Sync: (config: {getDeviceInfo: typeof h.deviceInfo}) => { h.deviceInfo = config.getDeviceInfo; return ({ onDeviceStatusChange: (cb: typeof h.joined) => { h.joined = cb; }, syncSettings: h.sentSettings }); },
  createSyncedSessionStore: (store: unknown) => store, createMessageSyncHandler: vi.fn(),
}));
vi.mock('../sync/projectConfigSync', () => ({ createProjectConfigSync: () => ({ refresh: h.refresh, stop: vi.fn() }) }));
vi.mock('../sync/projectConfigSources', () => ({ projectConfigSources: {} }));
vi.mock('../../utils/store', () => ({
  getSessionSyncConfig: () => ({ enabled: true }), setSessionSyncConfig: vi.fn(),
  getReleaseChannel: () => 'stable', getAlphaFeatures: h.settings, getDefaultAIModel: vi.fn(),
  getPreferredAgentLanguage: vi.fn(), store: { get: (key: string) => h.persisted.get(key), set: (key: string, value: unknown) => { if (h.failWrite) throw new Error('disk full'); h.persisted.set(key, value); } },
}));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), debug: vi.fn(), warn: h.warn, error: vi.fn() } } }));
vi.mock('../../utils/privateSettingsStore', () => ({ default: class { get(_key: string, fallback?: unknown) { return fallback; } } }));
vi.mock('../credentials/providerCredentials', () => ({ subscribeProviderCredentialChanges: vi.fn(), getProviderCredentials: () => ({ availableKeys: () => ({}), mobileOpenAIKey: vi.fn() }) }));
vi.mock('../CredentialService', () => ({ getCredentials: h.credentials }));
vi.mock('../StytchAuthService', () => ({ isAuthenticated: () => true, getStytchUserId: () => 'member', resolvePersonalUserId: async () => h.member, getPersonalOrgId: () => 'org' }));
vi.mock('../ai/remoteSessions', () => ({ remoteSessions: { setProvider: vi.fn() } }));
vi.mock('../ProjectFileSyncService', () => ({ getProjectFileSyncService: vi.fn() }));
vi.mock('../../file/WorkspaceWatcher', () => ({ startProjectFileSync: vi.fn(), stopAllProjectFileSync: vi.fn() }));
vi.mock('../../window/WindowManager', () => ({ windowStates: new Map() }));
vi.mock('../../utils/gitUtils', () => ({ getGitRemoteIdentities: vi.fn() }));
vi.mock('../AgentWorkflowService', () => ({ getAgentWorkflowService: vi.fn() }));
vi.mock('../ActionPromptService', () => ({ getActionPromptService: vi.fn() }));
vi.mock('../PowerSaveService', () => ({ setSleepPreventionMode: vi.fn(), setSyncConnected: vi.fn(), shutdownSleepPrevention: vi.fn() }));
vi.mock('../TrackerSyncManager', () => ({ reconnectAllTrackerSyncs: vi.fn() }));
vi.mock('../../mcp/mcpImageCompression', () => ({ compressImageIfNeeded: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server/ModelRegistry', () => ({ ModelRegistry: { getAllModels: async () => [] } }));
vi.mock('electron', () => ({ app: { getVersion: () => 'test', getPath: () => h.userData }, BrowserWindow: { getAllWindows: () => [] } }));

vi.mock('os', async importOriginal => ({...await importOriginal<typeof import('os')>(), hostname: () => h.hostname }));

const identityRoot = mkdtempSync(join(tmpdir(), 'nimbalyst-identity-test-'));
afterAll(() => rmSync(identityRoot, {recursive: true, force: true}));

import { initializeSync, syncSettingsToMobile, triggerIncrementalSync } from '../SyncManager';

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.settings.mockImplementation(() => ({}));
  h.refresh.mockResolvedValue(undefined);
  h.joined = undefined;
  h.persisted.clear();
  h.failWrite = false;
  h.credentials.mockReset().mockReturnValue({ encryptionKeySeed: 'seed' });
  h.userData = mkdtempSync(join(identityRoot, 'profile-'));
  h.member = 'member'; h.hostname = 'original-host';
  await initializeSync({} as never);
  expect(h.joined).toBeTypeOf('function');
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('preserves unreadable credentials, reports sync failure, and keeps the local store usable', async () => {
  vi.resetModules();
  const credentials = await vi.importActual<typeof import('../CredentialService')>('../CredentialService');
  h.credentials.mockImplementation(credentials.getCredentials);
  const credentialPath = join(h.userData, 'sync-credentials.enc');
  const originalBytes = Buffer.from('{damaged credential json');
  writeFileSync(credentialPath, originalBytes);
  const manager = await import('../SyncManager');
  const listener = vi.fn();
  const unsubscribe = manager.onSyncStatusChange(listener);
  const baseStore = { local: true };
  h.joined = undefined;
  try {
    await expect(manager.initializeSync(baseStore as never)).resolves.toBe(baseStore);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ connected: false, syncing: false, error: expect.any(String) }));
    expect(manager.getSyncProvider()).toBeNull();
    expect(h.joined).toBeUndefined();
    expect(readFileSync(credentialPath)).toEqual(originalBytes);
  } finally {
    unsubscribe();
  }
});

it('publishes config at sync start without waiting for a composer or session reconciliation', async () => {
  expect(h.refresh).toHaveBeenCalledTimes(1);
});

it('does not refresh project config during turn-idle incremental session sync', async () => {
  h.refresh.mockClear();
  await triggerIncrementalSync();
  expect(h.refresh).not.toHaveBeenCalled();
});

it('seeds the first persisted settings revision above a pre-upgrade counter', async () => {
  await syncSettingsToMobile();
  expect(h.sentSettings.mock.calls.at(-1)![0].version).toBeGreaterThan(7);
  expect(h.persisted.get('mobileSettingsVersion')).toBeGreaterThanOrEqual(Date.now());
});

it('persists the settings version and advances it after a desktop module restart', async () => {
  h.persisted.set('mobileSettingsVersion', 100);
  await syncSettingsToMobile();
  const first = h.sentSettings.mock.calls.at(-1)![0].version;
  expect(first).toBeGreaterThan(100);
  expect(h.persisted.get('mobileSettingsVersion')).toBe(first);
  vi.resetModules();
  const restarted = await import('../SyncManager');
  await restarted.initializeSync({} as never);
  await restarted.syncSettingsToMobile();
  const second = h.sentSettings.mock.calls.at(-1)![0].version;
  expect(second).toBeGreaterThan(first);
  expect(h.persisted.get('mobileSettingsVersion')).toBe(second);
});

it('keeps concurrent settings snapshots on distinct revisions and heals an invalid persisted counter', async () => {
  await Promise.all([syncSettingsToMobile(), syncSettingsToMobile()]);
  expect(new Set(h.sentSettings.mock.calls.map(([settings]) => settings.version)).size).toBe(2);
  h.sentSettings.mockClear();
  h.persisted.set('mobileSettingsVersion', -1);
  await expect(syncSettingsToMobile()).resolves.toBeUndefined();
  expect(h.sentSettings.mock.calls.at(-1)![0].version).toBeGreaterThanOrEqual(Date.now());
  expect(h.persisted.get('mobileSettingsVersion')).toBe(h.sentSettings.mock.calls.at(-1)![0].version);
});

it.each(['settings', 'project config', 'both'])('runs both refreshes and identifies each rejection: %s', async (failure) => {
  h.refresh.mockClear();
  const settingsError = new Error('settings unavailable');
  const configError = new Error('config unavailable');
  if (failure !== 'project config') h.settings.mockImplementation(() => { throw settingsError; });
  if (failure !== 'settings') h.refresh.mockRejectedValue(configError);
  h.joined!([{ type: 'mobile', deviceId: 'phone', name: 'Phone' }]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.settings).toHaveBeenCalledTimes(1);
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.warn).toHaveBeenCalledTimes(failure === 'both' ? 2 : 1);
  if (failure !== 'project config') expect(h.warn).toHaveBeenCalledWith('[SyncManager] Failed to refresh mobile device settings:', settingsError);
  if (failure !== 'settings') expect(h.warn).toHaveBeenCalledWith('[SyncManager] Failed to refresh mobile device project config:', configError);
});

it('does not reject or send an unpersisted version when the settings store fails, and retries later', async () => {
  h.failWrite = true;
  await expect(syncSettingsToMobile()).resolves.toBeUndefined();
  await expect(syncSettingsToMobile()).resolves.toBeUndefined();
  expect(h.sentSettings).not.toHaveBeenCalled();
  expect(h.warn).toHaveBeenCalledTimes(1);
  h.failWrite = false;
  await syncSettingsToMobile();
  expect(h.sentSettings).toHaveBeenCalledTimes(1);
  expect(h.persisted.get('mobileSettingsVersion')).toBe(h.sentSettings.mock.calls[0][0].version);
  h.failWrite = true;
  await expect(syncSettingsToMobile()).resolves.toBeUndefined();
  await expect(syncSettingsToMobile()).resolves.toBeUndefined();
  expect(h.warn).toHaveBeenCalledTimes(2);
});

 it('keeps identity across hostname changes and module restarts, but separates accounts and data directories', async () => {
  const first = h.deviceInfo!().deviceId;
  h.hostname = 'renamed-host';
  vi.resetModules();
  const restarted = await import('../SyncManager');
  await restarted.initializeSync({} as never);
  expect(h.deviceInfo!().deviceId).toBe(first);
  h.member = 'second-member';
  await restarted.initializeSync({} as never);
  expect(h.deviceInfo!().deviceId).not.toBe(first);
  h.member = 'member';
  const directory = h.userData;
  h.userData = mkdtempSync(join(identityRoot, 'profile-'));
  await restarted.initializeSync({} as never);
  expect(h.deviceInfo!().deviceId).not.toBe(first);
  h.userData = directory;
  await restarted.initializeSync({} as never);
  expect(h.deviceInfo!().deviceId).toBe(first);
});
