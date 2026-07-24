// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useColdPaintFallback, type UseColdPaintFallbackOptions } from '../useColdPaintFallback';

/**
 * NIM-1589: the cold-paint fallback force-paints cached markdown into a
 * shared tracker's editor when the room still reads as empty after the
 * collab WebSocket connects. A single point-in-time read raced the async
 * Yjs->Lexical reconciliation on a large/slow-to-render doc, so a real,
 * non-empty room could still read as empty and get a duplicate copy of its
 * body painted straight into the shared Y.Doc -- repeatedly, since nothing
 * stopped it firing again on the next remount. These tests pin the two
 * fixes: a two-read confirmation window, and a once-per-epoch guard.
 */
describe('useColdPaintFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(overrides: Partial<UseColdPaintFallbackOptions> = {}) {
    const paint = vi.fn();
    let empty = true;
    const isVisuallyEmpty = vi.fn(() => empty);
    const props: UseColdPaintFallbackOptions = {
      collabStatus: 'connected',
      bodyCacheMarkdown: '# cached body',
      providerEpoch: 1,
      itemId: 'item-1',
      isVisuallyEmpty,
      paint,
      firstDelayMs: 600,
      secondDelayMs: 1200,
      ...overrides,
    };
    const { rerender } = renderHook((p: UseColdPaintFallbackOptions) => useColdPaintFallback(p), {
      initialProps: props,
    });
    return {
      paint,
      isVisuallyEmpty,
      setEmpty: (v: boolean) => { empty = v; },
      rerender,
      props,
    };
  }

  it('paints after two spaced-apart empty reads (genuinely empty room)', () => {
    const { paint } = setup();
    vi.advanceTimersByTime(600);
    expect(paint).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1200);
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('does NOT paint if the room reads non-empty by the second check (slow-render false positive)', () => {
    // Regression for NIM-1589: first read looks empty (render still in
    // flight), but by the second read the real content has rendered.
    const { paint, setEmpty } = setup();
    vi.advanceTimersByTime(600);
    setEmpty(false);
    vi.advanceTimersByTime(1200);
    expect(paint).not.toHaveBeenCalled();
  });

  it('does NOT paint if the first read is already non-empty', () => {
    const { paint, setEmpty } = setup();
    setEmpty(false);
    vi.advanceTimersByTime(600 + 1200);
    expect(paint).not.toHaveBeenCalled();
  });

  it('fires at most once per provider epoch even if the effect re-arms', () => {
    const { paint, rerender, props } = setup();
    vi.advanceTimersByTime(600 + 1200);
    expect(paint).toHaveBeenCalledTimes(1);

    // Simulate the effect re-arming because bodyCacheMarkdown changed (e.g.
    // the paint itself triggered a re-cache) while providerEpoch stays put.
    rerender({ ...props, bodyCacheMarkdown: '# cached body v2' });
    vi.advanceTimersByTime(600 + 1200);
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh paint on a new provider epoch', () => {
    const { paint, rerender, props } = setup();
    vi.advanceTimersByTime(600 + 1200);
    expect(paint).toHaveBeenCalledTimes(1);

    rerender({ ...props, providerEpoch: 2 });
    vi.advanceTimersByTime(600 + 1200);
    expect(paint).toHaveBeenCalledTimes(2);
  });

  it('does nothing until collabStatus is connected', () => {
    const { paint } = setup({ collabStatus: 'connecting' });
    vi.advanceTimersByTime(600 + 1200);
    expect(paint).not.toHaveBeenCalled();
  });

  it('does nothing without cached body markdown', () => {
    const { paint } = setup({ bodyCacheMarkdown: null });
    vi.advanceTimersByTime(600 + 1200);
    expect(paint).not.toHaveBeenCalled();
  });
});
