import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  initPrModeLayout,
  prModeLayoutAtom,
  setPrModeLayoutAtom,
} from '../pullRequests';

describe('PR mode layout persistence', () => {
  const invoke = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    vi.stubGlobal('window', { electronAPI: { invoke } });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hydrates new chat fields from defaults for an older persisted record', async () => {
    invoke.mockResolvedValueOnce({
      prModeLayout: {
        activeFilters: ['closed'],
        sidebarWidth: 280,
      },
    });

    await initPrModeLayout('/workspace');

    expect(store.get(prModeLayoutAtom)).toMatchObject({
      activeFilters: ['closed'],
      sidebarWidth: 280,
      chatWidth: 350,
      chatCollapsed: false,
    });
  });

  it('persists chat width and collapse state with the existing layout record', async () => {
    invoke.mockResolvedValueOnce({});
    await initPrModeLayout('/workspace');

    store.set(setPrModeLayoutAtom, {
      chatWidth: 420,
      chatCollapsed: true,
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(invoke).toHaveBeenCalledWith(
      'workspace:update-state',
      '/workspace',
      {
        prModeLayout: expect.objectContaining({
          chatWidth: 420,
          chatCollapsed: true,
        }),
      },
    );
  });
});
