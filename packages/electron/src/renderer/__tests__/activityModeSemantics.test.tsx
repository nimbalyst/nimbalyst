// @vitest-environment jsdom
/**
 * Pins the React <Activity> semantics App.tsx relies on for hidden top-level
 * modes (TrackerMode, PullRequestMode):
 *
 * 1. Hiding does NOT destroy React state or the DOM (scroll/selection survive).
 * 2. Hiding unmounts effects (subscriptions/loops in the hidden tree stop).
 * 3. Revealing re-runs effects and keeps prior state.
 *
 * If a React upgrade changes any of these, hidden-mode behavior changes with
 * it — this test fails first.
 */
import React, { Activity, useEffect, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const effectLog: string[] = [];

function StatefulChild() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    effectLog.push('mount');
    return () => {
      effectLog.push('cleanup');
    };
  }, []);
  return (
    <button data-testid="counter" onClick={() => setCount((c) => c + 1)}>
      {count}
    </button>
  );
}

function Harness({ visible }: { visible: boolean }) {
  return (
    <Activity mode={visible ? 'visible' : 'hidden'}>
      <StatefulChild />
    </Activity>
  );
}

describe('Activity mode semantics for hidden modes', () => {
  afterEach(() => {
    cleanup();
    effectLog.length = 0;
  });

  it('preserves state and DOM while hidden, unmounts effects, re-runs them on reveal', async () => {
    const { rerender } = render(<Harness visible={true} />);
    expect(effectLog).toEqual(['mount']);

    // Accumulate state while visible
    act(() => {
      screen.getByTestId('counter').click();
      screen.getByTestId('counter').click();
    });
    expect(screen.getByTestId('counter').textContent).toBe('2');

    // Hide: effects clean up, but DOM and state stay
    rerender(<Harness visible={false} />);
    expect(effectLog).toEqual(['mount', 'cleanup']);
    const hiddenEl = screen.getByTestId('counter');
    expect(hiddenEl).toBeTruthy();
    expect(hiddenEl.textContent).toBe('2');

    // Reveal: state preserved, effect remounted
    rerender(<Harness visible={true} />);
    expect(screen.getByTestId('counter').textContent).toBe('2');
    expect(effectLog).toEqual(['mount', 'cleanup', 'mount']);
  });
});
