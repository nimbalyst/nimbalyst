// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';

/**
 * The debounced sync persist used to capture the config at SCHEDULE time.
 * Prevent-sleep / idle-timeout changes ride that 500ms debounce while the
 * mobile project multi-select writes `syncConfigAtom` directly, so a checkbox
 * flipped inside the window was erased on main by the stale snapshot while the
 * UI still showed it enabled. The persist must re-read at FIRE time.
 */

import { syncConfigAtom, setSyncConfigAtom } from '../appSettings';

const invoke = vi.fn();

describe('sync config debounced persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
    store.set(syncConfigAtom, {
      enabled: true,
      serverUrl: 'wss://sync.test',
      enabledProjects: [],
      docSyncEnabledProjects: [],
      idleTimeoutMinutes: 5,
    } as any);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('persists the latest config, not the snapshot taken when it was scheduled', () => {
    // Prevent-sleep change: debounced.
    store.set(setSyncConfigAtom, { preventSleepMode: 'always' } as any);

    // Project checkbox lands inside the debounce window via the direct path.
    store.set(syncConfigAtom, {
      ...store.get(syncConfigAtom),
      enabledProjects: ['/project-a'],
    });

    vi.advanceTimersByTime(500);

    expect(invoke).toHaveBeenCalledTimes(1);
    const [channel, persisted] = invoke.mock.calls[0];
    expect(channel).toBe('sync:set-config');
    expect(persisted.preventSleepMode).toBe('always');
    // The membership must survive the debounced write.
    expect(persisted.enabledProjects).toEqual(['/project-a']);
  });

  it('coalesces rapid debounced updates into a single write', () => {
    store.set(setSyncConfigAtom, { idleTimeoutMinutes: 1 } as any);
    store.set(setSyncConfigAtom, { idleTimeoutMinutes: 2 } as any);
    store.set(setSyncConfigAtom, { idleTimeoutMinutes: 10 } as any);

    vi.advanceTimersByTime(500);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1].idleTimeoutMinutes).toBe(10);
  });

  it('clears the persisted config when sync ends up disabled', () => {
    store.set(setSyncConfigAtom, { enabled: false } as any);

    vi.advanceTimersByTime(500);

    expect(invoke).toHaveBeenCalledWith('sync:set-config', null);
  });
});
