// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElementVisibilityTracker } from '../editorVisibility';

type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

let observerCallback: IOCallback | null = null;
let observedElements: Element[] = [];
let disconnectCount = 0;

class MockIntersectionObserver {
  constructor(callback: IOCallback) {
    observerCallback = callback;
  }
  observe(el: Element) {
    observedElements.push(el);
  }
  disconnect() {
    disconnectCount++;
  }
  unobserve() {}
}

describe('createElementVisibilityTracker', () => {
  beforeEach(() => {
    observerCallback = null;
    observedElements = [];
    disconnectCount = 0;
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fire = (isIntersecting: boolean) => {
    observerCallback?.([{ isIntersecting }]);
  };

  it('observes the element and reports transitions to subscribers', () => {
    const el = document.createElement('div');
    const tracker = createElementVisibilityTracker(el);
    expect(observedElements).toContain(el);

    const seen: boolean[] = [];
    tracker.subscribe((v) => seen.push(v));

    fire(false);
    expect(seen).toEqual([false]);
    expect(tracker.getVisible()).toBe(false);

    fire(true);
    expect(seen).toEqual([false, true]);
    expect(tracker.getVisible()).toBe(true);
  });

  it('does not notify when the state does not change', () => {
    const tracker = createElementVisibilityTracker(document.createElement('div'));
    const seen: boolean[] = [];
    tracker.subscribe((v) => seen.push(v));

    fire(false);
    fire(false);
    expect(seen).toEqual([false]);
  });

  it('uses the latest entry when the observer batches several', () => {
    const tracker = createElementVisibilityTracker(document.createElement('div'));
    observerCallback?.([{ isIntersecting: false }, { isIntersecting: true }]);
    expect(tracker.getVisible()).toBe(true);
  });

  it('stops notifying after unsubscribe', () => {
    const tracker = createElementVisibilityTracker(document.createElement('div'));
    const seen: boolean[] = [];
    const unsubscribe = tracker.subscribe((v) => seen.push(v));

    fire(false);
    unsubscribe();
    fire(true);
    expect(seen).toEqual([false]);
  });

  it('keeps delivering to other subscribers when one throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tracker = createElementVisibilityTracker(document.createElement('div'));
    const seen: boolean[] = [];
    tracker.subscribe(() => {
      throw new Error('boom');
    });
    tracker.subscribe((v) => seen.push(v));

    fire(false);
    expect(seen).toEqual([false]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('disconnects the observer and clears subscribers', () => {
    const tracker = createElementVisibilityTracker(document.createElement('div'));
    const seen: boolean[] = [];
    tracker.subscribe((v) => seen.push(v));

    tracker.disconnect();
    expect(disconnectCount).toBe(1);
    fire(false);
    expect(seen).toEqual([]);
  });

  it('defaults to visible when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const tracker = createElementVisibilityTracker(document.createElement('div'));
    expect(tracker.getVisible()).toBe(true);
  });
});
