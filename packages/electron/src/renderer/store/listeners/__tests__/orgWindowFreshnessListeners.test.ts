// @vitest-environment jsdom
import { createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { windowFocusedAtom } from '../../atoms/windowFocus';
import { initOrgWindowFreshnessListeners } from '../orgWindowFreshnessListeners';

describe('organization window freshness listeners', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refreshes on open, focus gain, and visibility without project-window sync', async () => {
    const targetStore = createStore();
    targetStore.set(windowFocusedAtom, false);
    const refreshDirectory = vi.fn(async () => {});
    const refreshSettings = vi.fn(async () => {});
    let clock = 0;

    const cleanup = initOrgWindowFreshnessListeners({
      getOrgId: () => 'org-a',
      targetStore,
      refreshDirectory,
      refreshSettings,
      now: () => clock,
    });

    await vi.waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(1));
    expect(refreshSettings).toHaveBeenCalledTimes(1);

    clock += 60_000;
    targetStore.set(windowFocusedAtom, true);
    await vi.waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(2));
    expect(refreshSettings).toHaveBeenCalledTimes(2);

    clock += 60_000;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(3));
    expect(refreshSettings).toHaveBeenCalledTimes(3);

    cleanup();
    clock += 60_000;
    targetStore.set(windowFocusedAtom, false);
    targetStore.set(windowFocusedAtom, true);
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(refreshDirectory).toHaveBeenCalledTimes(3);
  });

  // Bringing the window forward fires both the focus transition and
  // `visibilitychange`; re-reading twice for one user action is pure churn.
  it('coalesces the signals a single window activation fires', async () => {
    const targetStore = createStore();
    targetStore.set(windowFocusedAtom, false);
    const refreshDirectory = vi.fn(async () => {});
    const refreshSettings = vi.fn(async () => {});
    let clock = 0;

    const cleanup = initOrgWindowFreshnessListeners({
      getOrgId: () => 'org-a',
      targetStore,
      refreshDirectory,
      refreshSettings,
      now: () => clock,
    });
    await vi.waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(1));

    clock += 60_000;
    targetStore.set(windowFocusedAtom, true);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(2));

    // Alt-tabbing away and straight back is still one read.
    clock += 200;
    targetStore.set(windowFocusedAtom, false);
    targetStore.set(windowFocusedAtom, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshDirectory).toHaveBeenCalledTimes(2);
    expect(refreshSettings).toHaveBeenCalledTimes(2);

    cleanup();
  });
});
