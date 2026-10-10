// @vitest-environment node
/**
 * NIM-3963: a window fell back to Standard Mode while main still held
 * developerMode=true. The window must re-adopt main's value on focus, apply
 * other windows' broadcasts, and never undo a local toggle that has not been
 * persisted yet.
 */
import { beforeEach, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

let mainValue: boolean;
let broadcast: (p: { key: string; value: unknown }) => void;
let focus: () => void;

beforeEach(() => {
  vi.resetModules();
  mainValue = true;
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      invoke: async (channel: string) => (channel === 'developer-mode:get' ? mainValue : undefined),
      onAppSettingsChanged: (cb: typeof broadcast) => {
        broadcast = cb;
        return () => {};
      },
    },
    addEventListener: (type: string, cb: () => void) => {
      if (type === 'focus') focus = cb;
    },
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

async function load() {
  const { store } = await import('@nimbalyst/runtime/store');
  const settings = await import('../../atoms/appSettings');
  const listeners = await import('../developerModeListeners');
  listeners.registerDeveloperModeListener();
  return { store, settings, listeners };
}

it('adopts main on focus, applies broadcasts, and leaves an unpersisted toggle alone', async () => {
  const { store, settings, listeners } = await load();

  // Window drifted to Standard Mode while main still says Developer Mode.
  expect(store.get(settings.developerModeAtom)).toBe(false);
  focus();
  await vi.waitFor(() => expect(store.get(settings.developerModeAtom)).toBe(true));

  broadcast({ key: 'developerMode', value: false });
  expect(store.get(settings.developerModeAtom)).toBe(false);

  // A local toggle in its persist debounce must survive a focus reconcile.
  store.set(settings.setDeveloperFeatureSettingsAtom, { developerMode: true });
  mainValue = false;
  await listeners.reconcileDeveloperMode();
  expect(store.get(settings.developerModeAtom)).toBe(true);
});
