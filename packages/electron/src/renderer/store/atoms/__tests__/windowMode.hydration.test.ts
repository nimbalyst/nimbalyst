import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  initWindowMode,
  resetWindowMode,
  setWindowModeAtom,
  windowModeAtom,
  type ContentMode,
} from '../windowMode';
import { activeExtensionPanelAtom, activeExtensionBottomPanelAtom } from '../extensionPanels';
import { activeWorkspacePathAtom } from '../openProjects';

vi.mock('../../../services/document-model/DocumentModelRegistry', () => ({
  DocumentModelRegistry: { flushAll: vi.fn(async () => undefined) },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('window mode hydration', () => {
  beforeEach(() => {
    resetWindowMode();
  });

  afterEach(() => {
    resetWindowMode();
    store.set(activeExtensionPanelAtom, null);
    store.set(activeExtensionBottomPanelAtom, null);
    store.set(activeWorkspacePathAtom, null);
    vi.unstubAllGlobals();
  });

  it.each(['before', 'during'])('keeps a deep-link mode selected %s workspace hydration', async (when) => {
    const state = deferred<{ activeMode: 'files' }>();
    vi.stubGlobal('window', { electronAPI: { invoke: vi.fn(() => state.promise) } });
    store.set(activeWorkspacePathAtom, '/workspace-link');
    if (when === 'before') store.set(setWindowModeAtom, 'agent');
    const loading = initWindowMode('/workspace-link');
    if (when === 'during') store.set(setWindowModeAtom, 'agent');
    state.resolve({ activeMode: 'files' });
    await loading;
    expect(store.get(windowModeAtom)).toBe('agent');
  });

  it.each<ContentMode>(['files', 'agent', 'tracker', 'collab', 'org', 'pr-review', 'settings'])(
    'reveals %s through fullscreen, sidebar, and bottom panels even when already selected',
    (mode) => {
      vi.stubGlobal('window', { electronAPI: { featureUsage: { record: vi.fn(async () => undefined) } } });
      for (const previousMode of ['files', mode] as ContentMode[]) {
        for (const panelId of ['com.nimbalyst.project-graph.graph', 'extension.sidebar']) {
          store.set(windowModeAtom, previousMode);
          store.set(activeExtensionPanelAtom, panelId);
          store.set(activeExtensionBottomPanelAtom, 'extension.bottom');
          store.set(setWindowModeAtom, mode);
          expect(store.get(windowModeAtom)).toBe(mode);
          expect(store.get(activeExtensionPanelAtom)).toBeNull();
          expect(store.get(activeExtensionBottomPanelAtom)).toBeNull();
        }
      }
    },
  );

  it('does not let a stale workspace response replace the active workspace mode', async () => {
    const workspaceA = deferred<{ activeMode: 'agent' }>();
    const workspaceB = deferred<{ activeMode: 'tracker' }>();
    const invoke = vi.fn((_channel: string, workspacePath: string) => (
      workspacePath === '/workspace-a' ? workspaceA.promise : workspaceB.promise
    ));
    vi.stubGlobal('window', { electronAPI: { invoke } });

    const loadA = initWindowMode('/workspace-a');
    const loadB = initWindowMode('/workspace-b');

    workspaceB.resolve({ activeMode: 'tracker' });
    await loadB;
    expect(store.get(windowModeAtom)).toBe('tracker');

    workspaceA.resolve({ activeMode: 'agent' });
    await loadA;
    expect(store.get(windowModeAtom)).toBe('tracker');

    await initWindowMode('/workspace-a');
    expect(store.get(windowModeAtom)).toBe('agent');
  });
});
