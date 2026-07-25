/**
 * Tests for createPerKeyDebouncer -- the per-session coalescing used by the
 * file-state listeners to collapse the git-status refresh that
 * session-files:updated triggers once per file edit (hundreds/sec during active
 * AI tool execution) into a single trailing refresh per session.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPerKeyDebouncer } from '../perKeyDebounce';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createPerKeyDebouncer', () => {
  it('collapses a burst of same-key schedules into a single trailing call', () => {
    const d = createPerKeyDebouncer(250);
    const fn = vi.fn();

    for (let i = 0; i < 100; i++) d.schedule('s1', fn);
    expect(fn).not.toHaveBeenCalled(); // nothing runs until the window elapses

    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(1); // 100 edits -> 1 refresh
  });

  it('runs the most recently scheduled fn for a key', () => {
    const d = createPerKeyDebouncer(100);
    const order: string[] = [];
    d.schedule('s1', () => order.push('stale'));
    d.schedule('s1', () => order.push('latest'));

    vi.advanceTimersByTime(100);
    expect(order).toEqual(['latest']);
  });

  it('debounces keys independently', () => {
    const d = createPerKeyDebouncer(200);
    const a = vi.fn();
    const b = vi.fn();

    d.schedule('a', a);
    d.schedule('b', b);
    vi.advanceTimersByTime(200);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('re-arms after firing (a later edit schedules a fresh refresh)', () => {
    const d = createPerKeyDebouncer(150);
    const fn = vi.fn();

    d.schedule('s1', fn);
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);

    d.schedule('s1', fn);
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancelAll drops every pending refresh (teardown safety)', () => {
    const d = createPerKeyDebouncer(300);
    const fn = vi.fn();

    d.schedule('s1', fn);
    d.schedule('s2', fn);
    d.cancelAll();

    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel(key) drops only that key', () => {
    const d = createPerKeyDebouncer(300);
    const a = vi.fn();
    const b = vi.fn();

    d.schedule('a', a);
    d.schedule('b', b);
    d.cancel('a');
    vi.advanceTimersByTime(300);

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
