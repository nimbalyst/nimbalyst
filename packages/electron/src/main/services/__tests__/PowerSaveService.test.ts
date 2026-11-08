// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { blocker, powerMonitorMock } = vi.hoisted(() => {
  const active = new Set<number>();
  let nextId = 1;
  return {
    blocker: {
      active,
      start: vi.fn(() => { const id = nextId++; active.add(id); return id; }),
      stop: vi.fn((id: number) => { active.delete(id); }),
      isStarted: vi.fn((id: number) => active.has(id)),
    },
    powerMonitorMock: { on: vi.fn(), isOnBatteryPower: vi.fn(() => false) },
  };
});

vi.mock('electron', () => ({ powerSaveBlocker: blocker, powerMonitor: powerMonitorMock }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));

import {
  isPreventingSleep,
  setSleepPreventionMode,
  setSyncConnected,
  shutdownSleepPrevention,
} from '../PowerSaveService';

/**
 * A sync socket that drops and reconnects within seconds must not release the
 * hold. With the display off and the idle timer already expired, macOS sleeps
 * the moment the assertion is gone, and a blocker restarted a few seconds later
 * cannot wake it.
 */
describe('PowerSaveService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shutdownSleepPrevention();
    vi.clearAllMocks();
    blocker.active.clear();
  });

  afterEach(() => {
    shutdownSleepPrevention();
    vi.useRealTimers();
  });

  it('keeps the blocker through a brief sync disconnect and reconnect', () => {
    setSleepPreventionMode('always');
    setSyncConnected(true);
    expect(isPreventingSleep()).toBe(true);

    setSyncConnected(false);
    vi.advanceTimersByTime(5_000);
    expect(isPreventingSleep()).toBe(true);

    setSyncConnected(true);
    vi.advanceTimersByTime(120_000);

    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(blocker.stop).not.toHaveBeenCalled();
    expect(isPreventingSleep()).toBe(true);
  });

  it('releases the blocker once sync stays down past the grace period', () => {
    setSleepPreventionMode('always');
    setSyncConnected(true);

    setSyncConnected(false);
    vi.advanceTimersByTime(10 * 60_000);

    expect(isPreventingSleep()).toBe(false);
  });

  it('releases immediately when the user turns the mode off', () => {
    setSleepPreventionMode('always');
    setSyncConnected(true);

    setSleepPreventionMode('off');

    expect(isPreventingSleep()).toBe(false);
  });
});
