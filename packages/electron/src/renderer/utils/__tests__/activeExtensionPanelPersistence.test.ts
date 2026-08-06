/**
 * Regression test for "the session tree panel's visibility isn't restored
 * after a window reload."
 *
 * `activeExtensionPanel` in App.tsx used to be a plain useState with no
 * round-trip through workspace state -- unlike `extensionPanelWidth`, which
 * already persists. So a sidebar extension panel open at reload time was
 * always lost. These helpers are the round-trip; `resolveActiveExtensionPanel`
 * is the pure restore-decision used by the hydration effect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadActiveExtensionPanel,
  persistActiveExtensionPanel,
  resolveActiveExtensionPanel,
} from '../activeExtensionPanelPersistence';

interface MockState {
  activeExtensionPanel?: string | null;
}

function installMockElectronAPI(initialState: MockState = {}) {
  let state: MockState = { ...initialState };
  const invoke = vi.fn(async (channel: string, _workspacePath: string, patch?: MockState) => {
    if (channel === 'workspace:get-state') return state;
    if (channel === 'workspace:update-state' && patch) {
      state = { ...state, ...patch };
      return undefined;
    }
    throw new Error(`unexpected channel ${channel}`);
  });
  (globalThis as any).window = { electronAPI: { invoke } };
  return {
    invoke,
    getState: () => state,
  };
}

describe('activeExtensionPanelPersistence', () => {
  beforeEach(() => {
    delete (globalThis as any).window;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).window;
  });

  it('round-trips a sidebar panel id across a save/load cycle', async () => {
    installMockElectronAPI();
    const isSidebarPanel = () => true;

    await persistActiveExtensionPanel('/ws', 'com.nimbalyst.session-tree.tree');
    const loaded = await loadActiveExtensionPanel('/ws', isSidebarPanel);

    expect(loaded).toBe('com.nimbalyst.session-tree.tree');
  });

  it('round-trips closing the panel back to null', async () => {
    const harness = installMockElectronAPI({ activeExtensionPanel: 'com.nimbalyst.session-tree.tree' });

    await persistActiveExtensionPanel('/ws', null);

    expect(harness.getState().activeExtensionPanel).toBeNull();
    expect(await loadActiveExtensionPanel('/ws', () => true)).toBeNull();
  });

  it('does not restore a panel whose id no longer resolves to a sidebar placement', () => {
    // Covers an extension that was disabled/removed, or a panel that changed
    // placement to fullscreen/bottom since it was last persisted.
    const restored = resolveActiveExtensionPanel(
      { activeExtensionPanel: 'com.nimbalyst.removed-extension.panel' },
      () => false,
    );
    expect(restored).toBeNull();
  });

  it('returns null when nothing was ever persisted', () => {
    expect(resolveActiveExtensionPanel(undefined, () => true)).toBeNull();
    expect(resolveActiveExtensionPanel({}, () => true)).toBeNull();
  });

  it('ignores a malformed stored value instead of restoring garbage', () => {
    expect(resolveActiveExtensionPanel(
      { activeExtensionPanel: 42 as any },
      () => true,
    )).toBeNull();
  });
});
