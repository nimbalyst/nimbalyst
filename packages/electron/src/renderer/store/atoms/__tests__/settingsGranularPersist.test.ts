/**
 * Granular AI-provider persistence.
 *
 * The compatibility wrappers in SettingsView (setProviders / setApiKeys) hand
 * setAIProviderSettingsAtom the *full* providers / apiKeys object on every
 * change. The setter must persist only the slice that actually changed -- if it
 * scheduled every key (Object.keys of the full object), a single toggle would
 * rewrite every provider, and a stale window could replay old unrelated
 * provider / API-key values. This exercises that diff.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each test dynamically imports the large `appSettings` module graph. Under the
// full 444-file concurrent suite (run via the ROOT vitest config, whose default
// testTimeout is 5s -- the electron config's 10s does not apply at root), that
// import can exceed 5s on a busy machine and time out. A timed-out test is also
// interrupted before `flushPendingAIProviderPersist` clears its debounce timer,
// so that real timer fires into the next test's shared `window.settingsSet`
// mock (the spurious `ai.provider.openai` write). Real headroom fixes both.
vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

describe('granular AI provider persistence', () => {
  let settingsSet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    settingsSet = vi.fn().mockResolvedValue({ ok: true });
    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        settingsSet,
        onSettingsChanged: () => () => {},
        aiGetSettings: vi.fn().mockResolvedValue({ providerSettings: {}, apiKeys: {} }),
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('persists only the toggled provider, not every provider', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const mod = await import('../appSettings');

    // init flips the persist gate and gives us the hydrated baseline.
    const settings = await mod.initAIProviderSettings();
    store.set(mod.aiProviderSettingsAtom, settings);

    // Toggle a single provider via the full-object compatibility path.
    const providers = { ...store.get(mod.aiProviderSettingsAtom).providers };
    providers['openai'] = { ...providers['openai'], enabled: true };
    store.set(mod.setAIProviderSettingsAtom, { providers });

    await mod.flushPendingAIProviderPersist();

    const keys = settingsSet.mock.calls.map((c) => c[0]);
    expect(keys).toEqual(['ai.provider.openai']);
  });

  it('persists only the changed API key, not every key', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const mod = await import('../appSettings');

    const settings = await mod.initAIProviderSettings();
    store.set(mod.aiProviderSettingsAtom, settings);

    const apiKeys = { ...store.get(mod.aiProviderSettingsAtom).apiKeys };
    apiKeys['opencode'] = 'sk-opencode';
    store.set(mod.setAIProviderSettingsAtom, { apiKeys });

    await mod.flushPendingAIProviderPersist();

    expect(settingsSet.mock.calls).toEqual([['ai.apiKey.opencode', 'sk-opencode']]);
  });

  it('schedules nothing when the full object is handed back unchanged', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const mod = await import('../appSettings');

    const settings = await mod.initAIProviderSettings();
    store.set(mod.aiProviderSettingsAtom, settings);

    // Re-submit the same providers (fresh top-level object, identical values).
    const providers = { ...store.get(mod.aiProviderSettingsAtom).providers };
    store.set(mod.setAIProviderSettingsAtom, { providers });

    await mod.flushPendingAIProviderPersist();

    expect(settingsSet).not.toHaveBeenCalled();
  });
});
