import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import envPaths from 'env-paths';

// Mock electron BEFORE importing the service, so `new Store({ name: 'ai-settings' })`
// resolves to a writable temp dir and BrowserWindow.getAllWindows() is empty.
//
// One tmpDir per *test file run* -- electron-store / Conf resolves cwd at
// Store construction time and we reset the SettingsService singleton between
// tests via vi.resetModules(), but disk state still persists across tests
// within one run. So each test must isolate by writing to keys it owns.
let tmpDir: string;

vi.mock('electron', () => {
  // electron-store's main-process branch needs both `app` and `ipcMain` to
  // resolve `defaultCwd` -- without ipcMain it silently falls back to the
  // global userData dir and our test writes leak into the real config.
  return {
    app: {
      getPath: () => tmpDir,
      getName: () => 'nimbalyst-test',
      getVersion: () => '0.0.0-test',
    },
    ipcMain: {
      on: () => {},
      handle: () => {},
    },
    ipcRenderer: undefined,
    BrowserWindow: {
      getAllWindows: () => [],
    },
  };
});

// SettingsService logs via main.log; stub the logger so tests don't try to
// write to ~/Library.
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

// Where electron-store writes when app.getPath is unavailable. Tests run
// against the bundled `electron-store` module imported via `require('electron')`,
// which vitest's vi.mock for ES imports doesn't intercept; electron-store
// then falls back to Conf's default location. Compute that location with
// `env-paths` (the same library electron-store uses) so it is correct on every
// platform -- a hardcoded macOS path made existsSync false on Linux CI and let
// state leak across tests there. We clean it between tests so state never leaks
// across runs (and the user's real Nimbalyst config is never touched).
const STORE_FALLBACK = path.join(
  envPaths('electron-store', { suffix: 'nodejs' }).config,
  'ai-settings.json',
);

describe('SettingsService', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-service-'));
    vi.resetModules();
    try { fs.unlinkSync(STORE_FALLBACK); } catch { /* ok if missing */ }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try { fs.unlinkSync(STORE_FALLBACK); } catch { /* ok if missing */ }
  });

  it('returns descriptor defaults for keys never written', async () => {
    const { getSettingsService } = await import('../SettingsService');
    const svc = getSettingsService();
    // claude-code defaults to enabled=true per the registry
    expect(svc.get('ai.provider.claude-code')).toMatchObject({ enabled: true });
    // openai defaults to enabled=false
    expect(svc.get('ai.provider.openai')).toMatchObject({ enabled: false });
    expect(svc.get('ai.defaultProvider')).toBe('claude-code');
    expect(svc.get('ai.chatShowToolCalls')).toBe(true);
    expect(svc.get('ai.apiKey.anthropic')).toBe('');
    // Subscription CLI is a registered provider key, default-enabled like the SDK.
    expect(svc.get('ai.provider.claude-code-cli')).toMatchObject({ enabled: true });
  });

  it('persists a claude-code-cli hidden-model denylist round-trip', async () => {
    const { getSettingsService } = await import('../SettingsService');
    const svc = getSettingsService();

    // The picker-trim feature stores hidden model ids per provider. Persisting
    // the CLI provider must not be rejected as an unknown key, and hiddenModels
    // must survive the round-trip.
    svc.set('ai.provider.claude-code-cli', {
      enabled: false,
      hiddenModels: ['claude-code-cli:haiku'],
    } as any);
    expect(svc.get('ai.provider.claude-code-cli')).toMatchObject({
      enabled: false,
      hiddenModels: ['claude-code-cli:haiku'],
    });
    // Independent from the SDK provider.
    expect(svc.get('ai.provider.claude-code')).toMatchObject({ enabled: true });
  });

  it('round-trips a per-key write without touching other keys', async () => {
    const { getSettingsService } = await import('../SettingsService');
    const svc = getSettingsService();

    // Establish a baseline for openai (default: disabled).
    expect(svc.get('ai.provider.openai')).toMatchObject({ enabled: false });

    // Write claude provider config. The whole point of the refactor: this
    // must NOT mutate openai (the NIM-801 class of bug).
    svc.set('ai.provider.claude', { enabled: true });
    expect(svc.get('ai.provider.claude')).toMatchObject({ enabled: true });
    expect(svc.get('ai.provider.openai')).toMatchObject({ enabled: false });

    // Toggle openai. Claude must stay set.
    svc.set('ai.provider.openai', { enabled: true });
    expect(svc.get('ai.provider.openai')).toMatchObject({ enabled: true });
    expect(svc.get('ai.provider.claude')).toMatchObject({ enabled: true });
  });

  it('strips transient UI fields from provider configs before persisting', async () => {
    const { getSettingsService } = await import('../SettingsService');
    const svc = getSettingsService();

    // testStatus / testMessage are renderer-only UI state. Even if a caller
    // (legitimate writer, future useSetting consumer, malicious payload) sends
    // them, SettingsService must strip them at the boundary so disk never
    // carries transient state. The broadcast that follows must also be
    // clean -- subscribers expect the broadcast to equal the persisted truth.
    const events: Array<{ key: string; value: unknown }> = [];
    const unsub = svc.subscribe((key, value) => events.push({ key, value }));

    svc.set('ai.provider.claude', {
      enabled: true,
      testStatus: 'success',
      testMessage: 'looks good',
    } as any);

    expect(svc.get('ai.provider.claude')).toMatchObject({ enabled: true });
    expect(svc.get('ai.provider.claude')).not.toHaveProperty('testStatus');
    expect(svc.get('ai.provider.claude')).not.toHaveProperty('testMessage');

    // Broadcast must match what's on disk -- not what the caller passed.
    expect(events).toHaveLength(1);
    expect(events[0].value).not.toHaveProperty('testStatus');
    expect(events[0].value).not.toHaveProperty('testMessage');

    unsub();
  });

  it('strips the models field from dynamic-model providers', async () => {
    const { getSettingsService } = await import('../SettingsService');
    const svc = getSettingsService();

    // openai-codex and copilot-cli use dynamic model discovery: persisting
    // a `models` array would let stale lists outlive the user's actual
    // entitlements. SettingsService must strip them at the boundary.
    svc.set('ai.provider.openai-codex', {
      enabled: true,
      models: ['gpt-stale-1', 'gpt-stale-2'],
    } as any);
    expect(svc.get('ai.provider.openai-codex')).not.toHaveProperty('models');

    svc.set('ai.provider.copilot-cli', {
      enabled: true,
      models: ['old-model'],
    } as any);
    expect(svc.get('ai.provider.copilot-cli')).not.toHaveProperty('models');

    // Static-model providers keep their `models` field.
    svc.set('ai.provider.claude', {
      enabled: true,
      models: ['claude-opus-4-7'],
    });
    expect(svc.get('ai.provider.claude')).toMatchObject({
      enabled: true,
      models: ['claude-opus-4-7'],
    });
  });

  it('rejects writes that fail Zod validation', async () => {
    const { getSettingsService } = await import('../SettingsService');
    const svc = getSettingsService();
    // showToolCalls is z.boolean(); a string must be rejected.
    expect(() => svc.set('ai.showToolCalls', 'yes' as any)).toThrow(
      /schema validation failed/,
    );
  });

  it('notifies in-process subscribers on set', async () => {
    const { getSettingsService } = await import('../SettingsService');
    const svc = getSettingsService();
    const events: Array<{ key: string; value: unknown }> = [];
    const unsub = svc.subscribe((key, value) => events.push({ key, value }));

    svc.set('ai.showToolCalls', true);
    svc.set('ai.apiKey.openai', 'sk-test');

    expect(events).toEqual([
      { key: 'ai.showToolCalls', value: true },
      { key: 'ai.apiKey.openai', value: 'sk-test' },
    ]);

    unsub();
    svc.set('ai.showToolCalls', false);
    // No new event after unsubscribe.
    expect(events).toHaveLength(2);
  });

  it('getAll returns every registered key (with defaults for unset)', async () => {
    const { getSettingsService } = await import('../SettingsService');
    const { SETTING_KEYS } = await import('../../../shared/settings/keys');
    const svc = getSettingsService();

    svc.set('ai.showToolCalls', true);
    const snapshot = svc.getAll();

    // Every key in the registry is present in the snapshot.
    for (const k of SETTING_KEYS) {
      expect(snapshot[k]).not.toBeUndefined();
    }
    expect(snapshot['ai.showToolCalls']).toBe(true);
    expect(snapshot['ai.defaultProvider']).toBe('claude-code');
  });

  it('delete reverts a key to its descriptor default and notifies', async () => {
    const { getSettingsService } = await import('../SettingsService');
    const svc = getSettingsService();
    svc.set('ai.defaultProvider', 'openai');
    expect(svc.get('ai.defaultProvider')).toBe('openai');

    const events: string[] = [];
    const unsub = svc.subscribe((key) => events.push(key));
    svc.delete('ai.defaultProvider');
    unsub();

    expect(svc.get('ai.defaultProvider')).toBe('claude-code');
    expect(events).toEqual(['ai.defaultProvider']);
  });

  it('round-trips the optional opencode API key (was missing from the registry)', async () => {
    const { getSettingsService, isSettingKey } = await import('../SettingsService');
    const svc = getSettingsService();

    // OpenCodePanel exposes an optional API key via onApiKeyChange('opencode',...).
    // Without a registry entry the per-key flush was rejected as an unknown key,
    // so the field looked editable but never persisted.
    expect(isSettingKey('ai.apiKey.opencode')).toBe(true);
    expect(svc.get('ai.apiKey.opencode')).toBe('');
    svc.set('ai.apiKey.opencode', 'sk-opencode-test');
    expect(svc.get('ai.apiKey.opencode')).toBe('sk-opencode-test');
  });

  it('preserves the existing on-disk shape (providerSettings.<id> path)', async () => {
    const { getSettingsService } = await import('../SettingsService');
    const svc = getSettingsService();
    svc.set('ai.provider.claude', { enabled: true });

    // The flat key `ai.provider.claude` is stored at `providerSettings.claude`
    // inside ai-settings.json so legacy AIService reads (which still go
    // through `getSettingsStore().get('providerSettings.<id>')`) keep working
    // unchanged during the migration.
    expect(fs.existsSync(STORE_FALLBACK)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(STORE_FALLBACK, 'utf8'));
    expect(onDisk.providerSettings.claude).toMatchObject({ enabled: true });
  });
});
