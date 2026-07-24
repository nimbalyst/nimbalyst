import { describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime', () => ({
  registerEditorAPI: vi.fn(),
  unregisterEditorAPI: vi.fn(),
}));

import { createEditorHost, type EditorHostOptions } from '../createEditorHost';

const noopStorage = {
  get: () => undefined,
  set: async () => {},
  delete: async () => {},
  getGlobal: () => undefined,
  setGlobal: async () => {},
  deleteGlobal: async () => {},
  getSecret: async () => undefined,
  setSecret: async () => {},
  deleteSecret: async () => {},
};

function baseOptions(overrides: Partial<EditorHostOptions> = {}): EditorHostOptions {
  return {
    filePath: '/tmp/test.md',
    fileName: 'test.md',
    getTheme: () => 'dark',
    subscribeToThemeChanges: () => () => {},
    isActive: true,
    readFile: async () => '',
    readBinaryFile: async () => new ArrayBuffer(0),
    subscribeToFileChanges: () => () => {},
    onDirtyChange: () => {},
    saveContent: async () => {},
    subscribeToSaveRequests: () => () => {},
    openHistory: () => {},
    storage: noopStorage,
    ...overrides,
  };
}

describe('createEditorHost visibility', () => {
  it('exposes live visibility from getVisible', () => {
    let visible = true;
    const host = createEditorHost(baseOptions({ getVisible: () => visible }));
    expect(host.visible).toBe(true);
    visible = false;
    expect(host.visible).toBe(false);
  });

  it('treats a host without visibility wiring as visible with no subscription', () => {
    const host = createEditorHost(baseOptions());
    expect(host.visible).toBe(true);
    expect(host.onVisibilityChanged).toBeUndefined();
  });

  it('forwards onVisibilityChanged subscriptions and unsubscribe', () => {
    const callbacks = new Set<(visible: boolean) => void>();
    const host = createEditorHost(
      baseOptions({
        getVisible: () => true,
        subscribeToVisibilityChanges: (cb) => {
          callbacks.add(cb);
          return () => callbacks.delete(cb);
        },
      })
    );

    const seen: boolean[] = [];
    const unsubscribe = host.onVisibilityChanged!((v) => seen.push(v));
    callbacks.forEach((cb) => cb(false));
    expect(seen).toEqual([false]);

    unsubscribe();
    expect(callbacks.size).toBe(0);
  });
});
