// @vitest-environment jsdom
/**
 * The listener that tells open chat windows the Claude account model list changed.
 *
 * Main sends `claude-code:account-models-changed` after a successful "Detect account models".
 * The listener must turn that into a counter bump that the model picker reloads on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// A real Jotai store stands in for the app store, so the test reads the real counter.
vi.mock('@nimbalyst/runtime/store', async () => {
  const { createStore } = await import('jotai');
  return { store: createStore() };
});

import { store } from '@nimbalyst/runtime/store';
import { claudeAccountModelsVersionAtom } from '../../atoms/claudeAccountModels';
import { initClaudeAccountModelsListeners } from '../claudeAccountModelsListeners';

/** A stand-in for `window.electronAPI.on` that remembers each handler and its unsubscribe. */
function installFakeIpc() {
  const handlers = new Map<string, () => void>();
  const unsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
  (window as any).electronAPI = {
    on: (channel: string, handler: () => void) => {
      handlers.set(channel, handler);
      const unsubscribe = vi.fn();
      unsubscribes.set(channel, unsubscribe);
      return unsubscribe;
    },
  };
  return { handlers, unsubscribes };
}

describe('initClaudeAccountModelsListeners', () => {
  beforeEach(() => {
    store.set(claudeAccountModelsVersionAtom, 0);
  });

  it('adds one to the counter each time main says the account model list changed', () => {
    const { handlers } = installFakeIpc();
    const dispose = initClaudeAccountModelsListeners();

    expect(store.get(claudeAccountModelsVersionAtom)).toBe(0);
    handlers.get('claude-code:account-models-changed')?.();
    expect(store.get(claudeAccountModelsVersionAtom)).toBe(1);
    handlers.get('claude-code:account-models-changed')?.();
    expect(store.get(claudeAccountModelsVersionAtom)).toBe(2);

    dispose();
  });

  it('stops listening when it is disposed', () => {
    const { unsubscribes } = installFakeIpc();
    const dispose = initClaudeAccountModelsListeners();

    dispose();

    expect(unsubscribes.get('claude-code:account-models-changed')).toHaveBeenCalledTimes(1);
  });
});
