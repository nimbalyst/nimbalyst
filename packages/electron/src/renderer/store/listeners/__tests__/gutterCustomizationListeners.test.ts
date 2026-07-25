/**
 * Cross-window lockstep for navigation-gutter customization.
 *
 * Gutter hide/show/reorder (and the usage-indicator "Disable" buttons and
 * Settings-panel toggles that route through it) persist via the generic
 * `app-settings:set` store, which now broadcasts `app-settings:changed` to
 * every other window. This listener mirrors those broadcasts into
 * `gutterCustomizationAtom` so a change in one window updates the rail and the
 * Settings-panel toggles in the others without a reload.
 *
 * We exercise broadcast -> handler -> atom here. The main -> every-window IPC
 * hop (webContents.send) is Electron's and is not covered by this test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The listener pulls in the heavy `appSettings` module graph; give the async
// dynamic imports headroom under the full concurrent suite (see the sibling
// settingsLockstep.test.ts for the rationale).
vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

describe('gutter customization cross-window lockstep', () => {
  let fireBroadcast: (payload: { key: string; value: unknown }) => void;
  let subscribeCount: number;

  beforeEach(() => {
    vi.resetModules();
    subscribeCount = 0;
    let captured: ((p: { key: string; value: unknown }) => void) | null = null;
    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        onAppSettingsChanged: (cb: (p: { key: string; value: unknown }) => void) => {
          subscribeCount += 1;
          captured = cb;
          return () => {};
        },
      },
    };
    fireBroadcast = (payload) => {
      if (!captured) throw new Error('registerGutterCustomizationListener never subscribed');
      captured(payload);
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('mirrors a hiddenGutterItems broadcast into gutterCustomizationAtom', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { gutterCustomizationAtom } = await import('../../atoms/appSettings');
    const { registerGutterCustomizationListener } = await import('../gutterCustomizationListeners');

    registerGutterCustomizationListener();

    expect(store.get(gutterCustomizationAtom).hiddenItems).toEqual([]);
    fireBroadcast({ key: 'hiddenGutterItems', value: ['codex-usage'] });
    expect(store.get(gutterCustomizationAtom).hiddenItems).toEqual(['codex-usage']);
  });

  it('mirrors a gutterItemOrder broadcast into gutterCustomizationAtom', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { gutterCustomizationAtom } = await import('../../atoms/appSettings');
    const { registerGutterCustomizationListener } = await import('../gutterCustomizationListeners');

    registerGutterCustomizationListener();

    expect(store.get(gutterCustomizationAtom).order).toEqual({});
    fireBroadcast({ key: 'gutterItemOrder', value: { indicators: ['claude-usage', 'codex-usage'] } });
    expect(store.get(gutterCustomizationAtom).order).toEqual({
      indicators: ['claude-usage', 'codex-usage'],
    });
  });

  it('preserves the untouched half of the state when only one key is broadcast', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { gutterCustomizationAtom } = await import('../../atoms/appSettings');
    const { registerGutterCustomizationListener } = await import('../gutterCustomizationListeners');

    registerGutterCustomizationListener();

    fireBroadcast({ key: 'gutterItemOrder', value: { indicators: ['claude-usage'] } });
    fireBroadcast({ key: 'hiddenGutterItems', value: ['gemini-usage'] });

    expect(store.get(gutterCustomizationAtom)).toEqual({
      hiddenItems: ['gemini-usage'],
      order: { indicators: ['claude-usage'] },
    });
  });

  it('coerces a malformed hiddenGutterItems payload to an empty array', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { gutterCustomizationAtom } = await import('../../atoms/appSettings');
    const { registerGutterCustomizationListener } = await import('../gutterCustomizationListeners');

    registerGutterCustomizationListener();

    fireBroadcast({ key: 'hiddenGutterItems', value: 'not-an-array' });
    expect(store.get(gutterCustomizationAtom).hiddenItems).toEqual([]);
  });

  it('ignores a broadcast for an unrelated app-settings key', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { gutterCustomizationAtom } = await import('../../atoms/appSettings');
    const { registerGutterCustomizationListener } = await import('../gutterCustomizationListeners');

    registerGutterCustomizationListener();
    const before = store.get(gutterCustomizationAtom);

    fireBroadcast({ key: 'spellcheckEnabled', value: false });
    expect(store.get(gutterCustomizationAtom)).toBe(before);
  });

  it('subscribes only once across repeated register calls', async () => {
    const { registerGutterCustomizationListener } = await import('../gutterCustomizationListeners');

    registerGutterCustomizationListener();
    registerGutterCustomizationListener();

    expect(subscribeCount).toBe(1);
  });
});
