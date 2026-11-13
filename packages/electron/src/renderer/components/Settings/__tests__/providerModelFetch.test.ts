// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { fetchProviderModels } from '../providerModelFetch';

describe('fetchProviderModels', () => {
  it('does not flip the loading flag on a background refresh, so model lists stay mounted', async () => {
    // Every model checkbox toggle triggers a debounced save that refreshes models
    // in the background. If that refresh sets loading, panels swap the list for
    // "Loading models...", the page shrinks, and the scroll position jumps.
    const setLoading = vi.fn();
    const setAvailableModels = vi.fn();
    const grouped = { 'claude-code': [{ id: 'claude-code:opus', name: 'Opus' }] };

    await fetchProviderModels('claude-code', {
      background: true,
      setLoading,
      setAvailableModels,
      getAllModels: async () => ({ success: true, grouped }),
    });

    expect(setLoading).not.toHaveBeenCalled();
    expect(setAvailableModels).toHaveBeenCalledWith(grouped);
  });

  it('sets and clears the loading flag for an explicit fetch, even when it fails', async () => {
    const loading: Record<string, boolean> = {};
    const setLoading = vi.fn((updater: (prev: Record<string, boolean>) => Record<string, boolean>) => {
      Object.assign(loading, updater(loading));
    });
    const seen: boolean[] = [];

    await fetchProviderModels('openai', {
      setLoading,
      setAvailableModels: vi.fn(),
      getAllModels: async () => {
        seen.push(loading.openai);
        throw new Error('network');
      },
    });

    expect(seen).toEqual([true]);
    expect(loading.openai).toBe(false);
  });
});
