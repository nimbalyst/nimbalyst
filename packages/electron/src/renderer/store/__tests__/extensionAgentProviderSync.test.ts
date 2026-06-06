// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Controllable fake extension loader. Declared via vi.hoisted so the vi.mock
// factory (hoisted above imports) can reference it without a TDZ error.
const h = vi.hoisted(() => {
  const state = {
    extensions: [] as Array<{ manifest: { contributions?: { aiAgentProviders?: Array<{ id: string }> } } }>,
    cb: null as null | (() => void),
  };
  const loader = {
    getLoadedExtensions: () => state.extensions,
    subscribe: (fn: () => void) => {
      state.cb = fn;
      return () => {};
    },
  };
  return { state, loader };
});

// Stub the runtime barrel rather than importOriginal: the real barrel pulls
// ExtensionLoader -> @nimbalyst/collab-adapters, which is not resolvable in the
// unit-test env. The module under test only needs getExtensionLoader from it.
vi.mock('@nimbalyst/runtime', () => ({
  getExtensionLoader: () => h.loader,
}));

function geminiExt() {
  return {
    manifest: {
      contributions: { aiAgentProviders: [{ id: 'antigravity-gemini-agent' }] },
    },
  };
}

async function loadFresh() {
  // resetModules so the module-level `initialized` guard and ModelIdentifier's
  // provider set are fresh per test.
  vi.resetModules();
  const sync = await import('../extensionAgentProviderSync');
  const { ModelIdentifier } = await import('@nimbalyst/runtime/ai/server/types');
  return { sync, ModelIdentifier };
}

describe('extensionAgentProviderSync (#558, point 3)', () => {
  beforeEach(() => {
    h.state.extensions = [];
    h.state.cb = null;
  });

  it('registers contributed provider ids from already-loaded extensions on init', async () => {
    const { sync, ModelIdentifier } = await loadFresh();
    h.state.extensions = [geminiExt()];

    sync.initializeExtensionAgentProviderSync();

    expect(ModelIdentifier.isExtensionProvider('antigravity-gemini-agent')).toBe(true);
  });

  it('registers a provider contributed by an extension that loads after startup', async () => {
    const { sync, ModelIdentifier } = await loadFresh();
    // No agent extension loaded yet at init.
    sync.initializeExtensionAgentProviderSync();
    expect(ModelIdentifier.isExtensionProvider('antigravity-gemini-agent')).toBe(false);

    // Extension enabled/loaded after startup -> loader notifies.
    h.state.extensions = [geminiExt()];
    h.state.cb?.();

    expect(ModelIdentifier.isExtensionProvider('antigravity-gemini-agent')).toBe(true);
  });

  it('deregisters a provider when its extension is disabled/unloaded', async () => {
    const { sync, ModelIdentifier } = await loadFresh();
    h.state.extensions = [geminiExt()];
    sync.initializeExtensionAgentProviderSync();
    expect(ModelIdentifier.isExtensionProvider('antigravity-gemini-agent')).toBe(true);

    h.state.extensions = [];
    h.state.cb?.();

    expect(ModelIdentifier.isExtensionProvider('antigravity-gemini-agent')).toBe(false);
  });
});
