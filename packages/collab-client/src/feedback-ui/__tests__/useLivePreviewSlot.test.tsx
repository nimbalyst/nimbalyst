// @vitest-environment jsdom
/**
 * The cap is invisible when it works and invisible when it breaks.
 *
 * A regression here does not throw and does not look wrong: every preview still
 * appears, the Inbox just quietly mounts an unbounded number of collaborative
 * editors. That is exactly the class of failure a unit test is for, and the
 * reason this file exists when the surrounding surface is covered by render
 * tests.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import {
  MAX_CONCURRENT_LIVE_PREVIEWS,
  livePreviewSlotsInUse,
  resetLivePreviewSlots,
  useLivePreviewSlot,
} from '../useLivePreviewSlot';

/**
 * The shared jsdom setup installs an inert IntersectionObserver that never
 * calls back, which would leave every preview gated forever and make this file
 * assert the stub rather than the hook. This one records its observations so a
 * test can report them, the way a browser does after `observe()`.
 */
const originalObserver = globalThis.IntersectionObserver;
let pending: Array<() => void> = [];

function revealAll() {
  const callbacks = pending;
  pending = [];
  act(() => {
    for (const report of callbacks) report();
  });
}

beforeEach(() => {
  pending = [];
  class RecordingObserver {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      pending.push(() =>
        this.callback(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        ));
    }
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  globalThis.IntersectionObserver = RecordingObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  cleanup();
  resetLivePreviewSlots();
  globalThis.IntersectionObserver = originalObserver;
});

const Preview: React.FC<{ enabled?: boolean }> = ({ enabled = true }) => {
  const { ref, mounted } = useLivePreviewSlot<HTMLDivElement>(enabled);
  return <div ref={ref} data-testid={mounted ? 'mounted' : 'gated'} />;
};

describe('live preview slots', () => {
  it('mounts up to the cap and gates the rest', () => {
    const overCap = MAX_CONCURRENT_LIVE_PREVIEWS + 3;
    render(
      <>
        {Array.from({ length: overCap }, (_, index) => <Preview key={index} />)}
      </>,
    );
    revealAll();

    expect(screen.getAllByTestId('mounted')).toHaveLength(MAX_CONCURRENT_LIVE_PREVIEWS);
    expect(screen.getAllByTestId('gated')).toHaveLength(overCap - MAX_CONCURRENT_LIVE_PREVIEWS);
  });

  it('holds nothing until a preview is actually on screen', () => {
    render(<Preview />);

    // No observation reported yet, so the editor has not been built.
    expect(livePreviewSlotsInUse()).toBe(0);
    expect(screen.getByTestId('gated')).toBeDefined();
  });

  it('returns slots on unmount so a later request is not starved', () => {
    // The counter is module-level and outlives any one tree. If unmount leaked,
    // the second Inbox selection in a session would show no previews at all.
    const { unmount } = render(<Preview />);
    revealAll();
    expect(livePreviewSlotsInUse()).toBe(1);

    unmount();
    expect(livePreviewSlotsInUse()).toBe(0);
  });

  it('hands a released slot to an already-visible waiting preview', async () => {
    const previews = Array.from({ length: MAX_CONCURRENT_LIVE_PREVIEWS + 1 }, (_, index) => index);
    const { rerender } = render(
      <>{previews.map((index) => <Preview key={index} />)}</>,
    );
    revealAll();
    expect(screen.getAllByTestId('mounted')).toHaveLength(MAX_CONCURRENT_LIVE_PREVIEWS);

    rerender(<>{previews.slice(1).map((index) => <Preview key={index} />)}</>);

    await waitFor(() => {
      expect(screen.getAllByTestId('mounted')).toHaveLength(MAX_CONCURRENT_LIVE_PREVIEWS);
      expect(screen.queryByTestId('gated')).toBeNull();
    });
  });

  it('releases a slot when a preview becomes disabled without unmounting', async () => {
    const { rerender } = render(<Preview />);
    revealAll();
    expect(livePreviewSlotsInUse()).toBe(1);

    rerender(<Preview enabled={false} />);

    await waitFor(() => expect(livePreviewSlotsInUse()).toBe(0));
  });

  it('takes no slot for a preview that has nothing to mount', () => {
    render(<Preview enabled={false} />);
    revealAll();

    expect(livePreviewSlotsInUse()).toBe(0);
    expect(screen.getByTestId('gated')).toBeDefined();
  });
});
