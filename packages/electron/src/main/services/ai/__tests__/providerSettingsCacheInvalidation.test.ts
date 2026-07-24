import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import envPaths from 'env-paths';

// Mirror SettingsService.test.ts's electron mock so `new Store()` resolves to a
// writable temp dir and BrowserWindow.getAllWindows() is empty.
let tmpDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
    getName: () => 'nimbalyst-test',
    getVersion: () => '0.0.0-test',
  },
  ipcMain: { on: () => {}, handle: () => {} },
  ipcRenderer: undefined,
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const STORE_FALLBACK = path.join(
  envPaths('electron-store', { suffix: 'nodejs' }).config,
  'ai-settings.json',
);

describe('subscribeProviderSettingsInvalidation', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-cache-inval-'));
    vi.resetModules();
    try { fs.unlinkSync(STORE_FALLBACK); } catch { /* ok if missing */ }
  });

  it('is provider-key predicate: only `ai.provider.*` keys match', async () => {
    const { isProviderSettingsKey } = await import('../providerSettingsCacheInvalidation');
    expect(isProviderSettingsKey('ai.provider.claude-code-cli')).toBe(true);
    expect(isProviderSettingsKey('ai.provider.claude-code')).toBe(true);
    expect(isProviderSettingsKey('ai.defaultProvider')).toBe(false);
    expect(isProviderSettingsKey('ai.apiKey.anthropic')).toBe(false);
  });

  it('fires the callback when a provider config changes via the per-key SettingsService path', async () => {
    const { getSettingsService } = await import('../../SettingsService');
    const { subscribeProviderSettingsInvalidation } = await import(
      '../providerSettingsCacheInvalidation'
    );
    const svc = getSettingsService();

    // Simulate AIService's memoized cache being warm.
    let cache: unknown = { 'claude-code-cli': { enabled: true } };
    const changedKeys: string[] = [];
    subscribeProviderSettingsInvalidation(svc, (key) => {
      cache = null;
      changedKeys.push(key);
    });

    // Renderer settings panel toggles the provider off through the per-key path.
    svc.set('ai.provider.claude-code-cli', {
      enabled: false,
      hiddenModels: [],
    } as any);

    // Cache must be invalidated so the next read reflects enabled:false.
    expect(cache).toBeNull();
    expect(changedKeys).toContain('ai.provider.claude-code-cli');
  });

  it('ignores non-provider setting changes', async () => {
    const { getSettingsService } = await import('../../SettingsService');
    const { subscribeProviderSettingsInvalidation } = await import(
      '../providerSettingsCacheInvalidation'
    );
    const svc = getSettingsService();

    let invalidated = false;
    subscribeProviderSettingsInvalidation(svc, () => {
      invalidated = true;
    });

    svc.set('ai.defaultProvider', 'claude-code');
    expect(invalidated).toBe(false);
  });
});
