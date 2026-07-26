import { describe, expect, it } from 'vitest';
import { AnalyticsEmissionThrottle } from '../analyticsThrottle';

describe('AnalyticsEmissionThrottle', () => {
  it('collapses repeated occurrences of one key inside the window', () => {
    let now = 0;
    const throttle = new AnalyticsEmissionThrottle(10_000, 500, () => now);

    expect(throttle.shouldEmit('item-1:field_changed')).toBe(true);
    now = 500;
    expect(throttle.shouldEmit('item-1:field_changed')).toBe(false);
    now = 9_999;
    expect(throttle.shouldEmit('item-1:field_changed')).toBe(false);
    now = 10_000;
    expect(throttle.shouldEmit('item-1:field_changed')).toBe(true);
  });

  it('throttles each key independently', () => {
    const now = 0;
    const throttle = new AnalyticsEmissionThrottle(10_000, 500, () => now);

    expect(throttle.shouldEmit('item-1:field_changed')).toBe(true);
    expect(throttle.shouldEmit('item-2:field_changed')).toBe(true);
    expect(throttle.shouldEmit('item-1:status_changed')).toBe(true);
    expect(throttle.shouldEmit('item-1:field_changed')).toBe(false);
  });

  it('lets forget() reopen a key before its window expires', () => {
    let now = 0;
    const throttle = new AnalyticsEmissionThrottle(10_000, 500, () => now);

    expect(throttle.shouldEmit('doc-1')).toBe(true);
    now = 100;
    expect(throttle.shouldEmit('doc-1')).toBe(false);
    throttle.forget('doc-1');
    expect(throttle.shouldEmit('doc-1')).toBe(true);
  });

  it('bounds memory by evicting the least recently emitted key', () => {
    let now = 0;
    const throttle = new AnalyticsEmissionThrottle(10_000, 2, () => now);

    throttle.shouldEmit('a');
    now = 1;
    throttle.shouldEmit('b');
    now = 2;
    // Tracking 'c' evicts 'a', the least recently emitted key.
    throttle.shouldEmit('c');

    now = 3;
    // 'b' and 'c' are still tracked and stay throttled.
    expect(throttle.shouldEmit('b')).toBe(false);
    expect(throttle.shouldEmit('c')).toBe(false);
    // 'a' was evicted, so it emits again despite being inside the window.
    expect(throttle.shouldEmit('a')).toBe(true);
  });
});
