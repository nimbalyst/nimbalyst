// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime', () => ({
  createEditorAPIOwnerToken: (label?: string) => Symbol(label),
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
  it('reports reload APIs to the owning host without crossing same-file editor instances', () => {
    const first = vi.fn(), second = vi.fn();
    const a = createEditorHost(baseOptions({ onEditorAPIChange: first }));
    const b = createEditorHost(baseOptions({ onEditorAPIChange: second }));
    const apiA = { getContent: () => 'a' }, apiB = { getContent: () => 'b' };
    a.registerEditorAPI(apiA);
    b.registerEditorAPI(apiB);
    a.registerEditorAPI(null);
    expect(first.mock.calls).toEqual([[apiA], [null]]);
    expect(second.mock.calls).toEqual([[apiB]]);
  });
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

describe('createEditorHost getAssetUrl', () => {
  it('encodes the file path so an editor element can load it same-origin', () => {
    const host = createEditorHost(baseOptions({ filePath: '/tmp/clip.mp4' }));

    const url = host.getAssetUrl!();

    // The path must survive as an opaque segment -- a raw path here would break
    // on the first space or non-ASCII character in a filename.
    expect(url).toBe(`nim-asset://local/${Buffer.from('/tmp/clip.mp4').toString('base64url')}`);
  });

  it('returns null for a virtual tab rather than a URL to nothing', () => {
    // Virtual tabs have no file behind them. Handing back a well-formed URL
    // that 404s would make an editor render a broken player instead of its
    // "unavailable" state.
    const host = createEditorHost(baseOptions({ filePath: 'virtual://shared-home' }));

    expect(host.getAssetUrl!()).toBeNull();
  });
});
