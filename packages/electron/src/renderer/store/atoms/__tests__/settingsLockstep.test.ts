/**
 * Cross-window lockstep for the legacy settings atoms.
 *
 * The atoms that still own their own state (autoCommit, diffPeek,
 * trackerAutomation, AI debug toggles, usage indicators) register an
 * `onSettingChanged(key, handler)` callback that piggybacks on the single
 * `settings:changed` broadcast wired up by `registerSettingsChangeListener`.
 *
 * This is the renderer side of the cross-window claim: when main broadcasts a
 * `settings:changed` for a key, the corresponding legacy atom updates without a
 * reload. We exercise broadcast -> handler -> atom here. The main -> every-window
 * IPC hop (webContents.send) is Electron's and is not covered by this test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each test dynamically imports the large `appSettings` module graph. Under the
// full 444-file concurrent suite (run via the ROOT vitest config, whose default
// testTimeout is 5s -- the electron config's 10s does not apply at root), that
// import can exceed 5s on a busy machine and time out. A timed-out test is also
// interrupted mid-flow, which can leak a pending debounce timer into the next
// test's shared `window` mock. Give these heavy async tests real headroom.
vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

describe('settings cross-window lockstep (legacy atoms)', () => {
  let fireBroadcast: (payload: { key: string; value: unknown }) => void;

  beforeEach(() => {
    vi.resetModules();
    let captured: ((p: { key: string; value: unknown }) => void) | null = null;
    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        onSettingsChanged: (cb: (p: { key: string; value: unknown }) => void) => {
          captured = cb;
          return () => {};
        },
      },
    };
    fireBroadcast = (payload) => {
      if (!captured) throw new Error('registerSettingsChangeListener never subscribed');
      captured(payload);
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('mirrors ai.showUsageIndicator into its settingAtom (used via useSetting)', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { settingAtom, registerSettingsChangeListener } = await import('../settingAtomFamily');

    registerSettingsChangeListener();

    expect(store.get(settingAtom('ai.showUsageIndicator'))).toBe(true);
    fireBroadcast({ key: 'ai.showUsageIndicator', value: false });
    expect(store.get(settingAtom('ai.showUsageIndicator'))).toBe(false);
  });

  it('mirrors ai.showCodexUsageIndicator into its settingAtom (used via useSetting)', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { settingAtom, registerSettingsChangeListener } = await import('../settingAtomFamily');

    registerSettingsChangeListener();

    expect(store.get(settingAtom('ai.showCodexUsageIndicator'))).toBe(true);
    fireBroadcast({ key: 'ai.showCodexUsageIndicator', value: false });
    expect(store.get(settingAtom('ai.showCodexUsageIndicator'))).toBe(false);
  });

  it('mirrors ai.autoCommitEnabled into autoCommitEnabledAtom', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { autoCommitEnabledAtom } = await import('../autoCommitAtoms');
    const { registerSettingsChangeListener } = await import('../settingAtomFamily');

    registerSettingsChangeListener();

    expect(store.get(autoCommitEnabledAtom)).toBe(false);
    fireBroadcast({ key: 'ai.autoCommitEnabled', value: true });
    expect(store.get(autoCommitEnabledAtom)).toBe(true);
  });

  it('mirrors ai.diffPeekSize into diffPeekSizeAtom', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { diffPeekSizeAtom } = await import('../diffPeekSizeAtoms');
    const { registerSettingsChangeListener } = await import('../settingAtomFamily');

    registerSettingsChangeListener();

    expect(store.get(diffPeekSizeAtom)).toBeNull();
    fireBroadcast({ key: 'ai.diffPeekSize', value: { width: 800, height: 500 } });
    expect(store.get(diffPeekSizeAtom)).toEqual({ width: 800, height: 500 });
  });

  it('mirrors ai.trackerAutomation into trackerAutomationAtom', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { trackerAutomationAtom } = await import('../trackerAutomationAtoms');
    const { registerSettingsChangeListener } = await import('../settingAtomFamily');

    registerSettingsChangeListener();

    expect(store.get(trackerAutomationAtom)).toEqual({ enabled: false, autoCloseOnCommit: true });
    fireBroadcast({ key: 'ai.trackerAutomation', value: { enabled: true, autoCloseOnCommit: false } });
    expect(store.get(trackerAutomationAtom)).toEqual({ enabled: true, autoCloseOnCommit: false });
  });

  it('mirrors each ai debug toggle into the composite aiDebugSettingsAtom', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { aiDebugSettingsAtom } = await import('../appSettings');
    const { registerSettingsChangeListener } = await import('../settingAtomFamily');

    registerSettingsChangeListener();

    fireBroadcast({ key: 'ai.showToolCalls', value: true });
    fireBroadcast({ key: 'ai.chatShowToolCalls', value: false });
    fireBroadcast({ key: 'ai.aiDebugLogging', value: true });
    fireBroadcast({ key: 'ai.showPromptAdditions', value: true });

    expect(store.get(aiDebugSettingsAtom)).toMatchObject({
      showToolCalls: true,
      chatShowToolCalls: false,
      aiDebugLogging: true,
      showPromptAdditions: true,
    });
  });

  it('updates the settingAtom family for a registered key on broadcast', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { settingAtom, registerSettingsChangeListener } = await import('../settingAtomFamily');

    registerSettingsChangeListener();

    expect(store.get(settingAtom('ai.defaultProvider'))).toBe('claude-code');
    fireBroadcast({ key: 'ai.defaultProvider', value: 'openai' });
    expect(store.get(settingAtom('ai.defaultProvider'))).toBe('openai');
  });

  it('ignores a broadcast for an unknown key without throwing', async () => {
    const { registerSettingsChangeListener } = await import('../settingAtomFamily');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registerSettingsChangeListener();

    expect(() => fireBroadcast({ key: 'ai.totallyMadeUp', value: 1 })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown key'));
    warn.mockRestore();
  });
});
