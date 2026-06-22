import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  whenFirstUsable,
  signalFirstWindowLoaded,
  runWhenFirstUsable,
  __resetStartupMaintenanceGateForTests,
} from '../startupMaintenanceGate';

describe('startupMaintenanceGate', () => {
  afterEach(() => {
    __resetStartupMaintenanceGateForTests();
    vi.useRealTimers();
  });

  it('resolves whenFirstUsable after the first window loads + idle delay', async () => {
    vi.useFakeTimers();
    let resolved = false;
    void whenFirstUsable().then(() => {
      resolved = true;
    });

    signalFirstWindowLoaded();
    await vi.advanceTimersByTimeAsync(2499);
    expect(resolved).toBe(false); // idle delay not elapsed yet

    await vi.advanceTimersByTimeAsync(2);
    expect(resolved).toBe(true);
  });

  it('resolves via the ceiling timeout if no window ever loads', async () => {
    vi.useFakeTimers();
    let resolved = false;
    void whenFirstUsable().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(19_999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(resolved).toBe(true);
  });

  it('only the first window signal arms the idle countdown', async () => {
    vi.useFakeTimers();
    let resolved = false;
    void whenFirstUsable().then(() => {
      resolved = true;
    });

    signalFirstWindowLoaded();
    await vi.advanceTimersByTimeAsync(1000);
    // A later window signal must not reset/extend the countdown.
    signalFirstWindowLoaded();
    await vi.advanceTimersByTimeAsync(1501);
    expect(resolved).toBe(true);
  });

  it('runWhenFirstUsable runs the task after ready and isolates failures', async () => {
    vi.useFakeTimers();
    const ran: string[] = [];
    runWhenFirstUsable('boom', () => {
      throw new Error('intentional');
    });
    runWhenFirstUsable('ok', () => {
      ran.push('ok');
    });

    signalFirstWindowLoaded();
    await vi.advanceTimersByTimeAsync(2501);
    await Promise.resolve();

    // The throwing task does not prevent the sibling task from running.
    expect(ran).toContain('ok');
  });
});
