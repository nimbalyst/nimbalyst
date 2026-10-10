/**
 * Pins discoverability for setup, loading, and usage errors.
 */
import { describe, expect, it } from 'vitest';
import { createStore } from 'jotai';
import { ollamaUsageAtom, ollamaUsageAvailableAtom, OllamaUsageData } from '../ollamaUsageAtoms';

function baseData(overrides: Partial<OllamaUsageData> = {}): OllamaUsageData {
  return {
    limitsAvailable: false,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

describe('ollamaUsageAvailableAtom', () => {
  it('remains discoverable before the first fetch', () => {
    const store = createStore();
    expect(store.get(ollamaUsageAvailableAtom)).toBe(true);
  });

  it('keeps setup guidance discoverable when no key is configured', () => {
    const store = createStore();
    store.set(ollamaUsageAtom, baseData({ error: 'Ollama API key not configured in settings.' }));
    expect(store.get(ollamaUsageAvailableAtom)).toBe(true);
  });

  it('becomes visible on a transient failure once a key IS configured', () => {
    const store = createStore();
    store.set(ollamaUsageAtom, baseData({ error: 'Ollama usage API returned HTTP 503' }));
    expect(store.get(ollamaUsageAvailableAtom)).toBe(true);
  });

  it('is visible once real session/weekly usage comes back', () => {
    const store = createStore();
    store.set(
      ollamaUsageAtom,
      baseData({
        limitsAvailable: true,
        session: { utilization: 0, resetsAt: null, models: [] },
        weekly: { utilization: 5.1, resetsAt: null, models: [] },
      })
    );
    expect(store.get(ollamaUsageAvailableAtom)).toBe(true);
  });

  it('is visible when account data is unavailable', () => {
    const store = createStore();
    store.set(ollamaUsageAtom, baseData());
    expect(store.get(ollamaUsageAvailableAtom)).toBe(true);
  });
});
