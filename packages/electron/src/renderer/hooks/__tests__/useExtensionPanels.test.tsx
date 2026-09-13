// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { activeExtensionPanelAtom, extensionPanelStateAtomFamily } from '../../store/atoms/extensionPanels';
import { resetWindowMode, setWindowModeAtom } from '../../store/atoms/windowMode';
import { useExtensionPanels } from '../useExtensionPanels';

vi.mock('../../extensions/panels/PanelRegistry', () => ({
  getPanelById: (id: string) => ({ placement: id === 'sidebar' ? 'sidebar' : 'fullscreen' }),
}));
vi.mock('../../services/document-model/DocumentModelRegistry', () => ({
  DocumentModelRegistry: { flushAll: vi.fn(async () => undefined) },
}));

afterEach(() => {
  cleanup();
  resetWindowMode();
  vi.unstubAllGlobals();
});

function harness() {
  const store = createStore();
  store.set(activeWorkspacePathAtom, '/workspace');
  let resolve!: (state: { activeExtensionPanel: string }) => void;
  const pending = new Promise<{ activeExtensionPanel: string }>((r) => { resolve = r; });
  const invoke = vi.fn((channel: string) => channel === 'workspace:get-state' ? pending : Promise.resolve());
  vi.stubGlobal('window', { electronAPI: { invoke } });
  const hook = renderHook(({ ready }) => useExtensionPanels('/workspace', ready), {
    initialProps: { ready: false },
    wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
  });
  return { store, resolve, invoke, ...hook };
}

describe('extension panel restoration', () => {
  it('waits for extensions, restores a sidebar, and persists dismissal without erasing it on mount', async () => {
    const h = harness();
    expect(h.invoke).not.toHaveBeenCalled();
    h.rerender({ ready: true });
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('workspace:get-state', '/workspace');
    await act(async () => h.resolve({ activeExtensionPanel: 'sidebar' }));
    expect(h.result.current.activeExtensionPanel).toBe('sidebar');
    act(() => h.store.set(setWindowModeAtom, 'files'));
    expect(h.result.current.activeExtensionPanel).toBeNull();
    expect(h.invoke).toHaveBeenLastCalledWith('workspace:update-state', '/workspace', { activeExtensionPanel: null });
  });

  it.each(['before extensions', 'during load'])(
    'does not reopen a saved panel after navigation %s',
    async (when) => {
      const h = harness();
      if (when === 'during load') h.rerender({ ready: true });
      act(() => h.store.set(setWindowModeAtom, 'files'));
      h.rerender({ ready: true });
      await act(async () => h.resolve({ activeExtensionPanel: 'sidebar' }));
      expect(h.result.current.activeExtensionPanel).toBeNull();
      expect(h.store.get(extensionPanelStateAtomFamily('/workspace')).hydrated).toBe(true);
      expect(h.invoke).toHaveBeenLastCalledWith('workspace:update-state', '/workspace', { activeExtensionPanel: null });
    },
  );

  it('preserves a panel selected during loading and isolates another workspace', async () => {
    const h = harness();
    h.rerender({ ready: true });
    act(() => h.result.current.setActiveExtensionPanel('fullscreen'));
    await act(async () => h.resolve({ activeExtensionPanel: 'sidebar' }));
    expect(h.result.current.activeExtensionPanel).toBe('fullscreen');
    act(() => {
      h.store.set(activeWorkspacePathAtom, '/other');
      h.store.set(activeExtensionPanelAtom, 'other-panel');
      h.store.set(setWindowModeAtom, 'files');
      h.store.set(activeWorkspacePathAtom, '/workspace');
    });
    expect(h.result.current.activeExtensionPanel).toBe('fullscreen');
  });
});
