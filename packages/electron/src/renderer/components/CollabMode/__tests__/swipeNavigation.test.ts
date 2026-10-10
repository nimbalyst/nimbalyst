// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SwipeNavigationRecognizer, type SwipeSample, type SwipeUpdate } from '../swipeNavigation';

type SampleOptions = { deltaY?: number; contentScrolls?: boolean };
const sample = (deltaX: number, time: number, { deltaY = 0, contentScrolls = false }: SampleOptions = {}): SwipeSample => ({
  deltaX, deltaY, time, contentScrolls: () => contentScrolls,
});

/** A gesture of `count` events, 16ms apart, starting at `start`. */
function feedRun(recognizer: SwipeNavigationRecognizer, deltaX: number, count: number, start = 0, extra: SampleOptions = {}): SwipeUpdate[] {
  return Array.from({ length: count }, (_, index) => recognizer.feed(sample(deltaX, start + index * 16, extra)));
}

const navigations = (updates: SwipeUpdate[]) => updates.filter((update) => update.kind === 'navigate');

describe('SwipeNavigationRecognizer', () => {
  it('fingers moving right go Back once per gesture, momentum included', () => {
    const recognizer = new SwipeNavigationRecognizer({ canNavigate: () => true });
    // 30 events x 20px = 600px: far past the threshold, still one gesture.
    expect(navigations(feedRun(recognizer, -20, 30))).toEqual([{ kind: 'navigate', direction: -1 }]);
    // After a pause, a new gesture can navigate again.
    expect(navigations(feedRun(recognizer, -20, 30, 2000))).toHaveLength(1);
  });

  it('ignores a gesture that is vertical, scrolls content, has nowhere to go, or swipes back', () => {
    const forwardOnly = new SwipeNavigationRecognizer({ canNavigate: (direction) => direction === 1 });
    // A diagonal scroll is not a swipe, even when it drifts sideways later.
    expect(navigations([...feedRun(forwardOnly, 8, 3, 0, { deltaY: 10 }), ...feedRun(forwardOnly, 30, 20, 48)])).toEqual([]);
    // A wide table that can still scroll keeps the whole gesture, edge included.
    expect(navigations([...feedRun(forwardOnly, 20, 3, 1000, { contentScrolls: true }), ...feedRun(forwardOnly, 20, 20, 1048)])).toEqual([]);
    // No Back history.
    expect(navigations(feedRun(forwardOnly, -20, 30, 2000))).toEqual([]);
    // Most of the way, then back: cancelled, no navigation.
    const cancelled = [...feedRun(forwardOnly, 20, 6, 3000), ...feedRun(forwardOnly, -20, 6, 3096), ...feedRun(forwardOnly, 1, 10, 3192)];
    expect(navigations(cancelled)).toEqual([]);
    expect(cancelled.at(-1)).toMatchObject({ kind: 'progress', direction: 1 });
  });
});
