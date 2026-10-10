// @vitest-environment jsdom
/**
 * Search's page-text query: it asks again while the index is still reading
 * pages (a bounded number of times), and again when the section's pages
 * change, so a partial answer does not stand for good.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { PageSearchRequest, PageSearchResponse } from '@nimbalyst/collab-protocol';
import { PAGES_BODY_PARTIAL_RETRIES, PAGES_BODY_PARTIAL_RETRY_MS, usePagesBodyHits } from '../usePagesBodyHits';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const response = (status: PageSearchResponse['status']): PageSearchResponse => ({ hits: [], status });

/** Let the debounce fire and the answer settle. */
async function settle(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('usePagesBodyHits', () => {
  it('asks again while the index is partial, a bounded number of times, and stops once it is ready', async () => {
    const searchPages = vi.fn(async (_request: PageSearchRequest) => response('partial'));
    const { result } = renderHook(() => usePagesBodyHits('sync', searchPages, { typeIds: ['module'], pagesRevision: 'r1' }));
    await settle(500);
    expect(searchPages).toHaveBeenCalledTimes(1);
    expect(searchPages.mock.calls[0]![0]).toMatchObject({ query: 'sync', typeIds: ['module'] });
    expect(result.current?.status).toBe('partial');

    await settle(PAGES_BODY_PARTIAL_RETRY_MS * (PAGES_BODY_PARTIAL_RETRIES + 3));
    expect(searchPages).toHaveBeenCalledTimes(1 + PAGES_BODY_PARTIAL_RETRIES);

    const ready = vi.fn(async (_request: PageSearchRequest) => response('ready'));
    renderHook(() => usePagesBodyHits('sync', ready, { typeIds: [], pagesRevision: 'r1' }));
    await settle(PAGES_BODY_PARTIAL_RETRY_MS * 3);
    expect(ready).toHaveBeenCalledTimes(1);
    // [] asks for no typed pages; undefined asks for every type.
    expect(ready.mock.calls[0]![0].typeIds).toEqual([]);
    const everyType = vi.fn(async (_request: PageSearchRequest) => response('ready'));
    renderHook(() => usePagesBodyHits('sync', everyType, { typeIds: undefined, pagesRevision: 'r1' }));
    await settle(500);
    expect(everyType.mock.calls[0]![0]).not.toHaveProperty('typeIds');
  });

  it('asks again when the section\'s pages change', async () => {
    const searchPages = vi.fn(async (_request: PageSearchRequest) => response('ready'));
    const { rerender } = renderHook(({ revision }) => usePagesBodyHits('sync', searchPages, { typeIds: [], pagesRevision: revision }), {
      initialProps: { revision: 'r1' },
    });
    await settle(500);
    expect(searchPages).toHaveBeenCalledTimes(1);
    rerender({ revision: 'r2' });
    await settle(500);
    expect(searchPages).toHaveBeenCalledTimes(2);
  });
});
