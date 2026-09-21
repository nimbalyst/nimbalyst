import { useRef } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CanvasCommandTooltips } from '../CanvasCommandTooltips';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('shows delayed hover and focus help, dismisses on click, and preserves the action', async () => {
  vi.useFakeTimers();
  const action = vi.fn();
  function Harness() {
    const surface = useRef<HTMLDivElement>(null);
    return (
      <div ref={surface}>
        <button data-canvas-help="canvas-tool-pan-tool" onClick={action}>
          Hand
        </button>
        <CanvasCommandTooltips surfaceRef={surface} />
      </div>
    );
  }
  render(<Harness />);
  const button = screen.getByRole('button');
  fireEvent.mouseOver(button);
  await act(() => vi.advanceTimersByTimeAsync(499));
  expect(screen.queryByRole('tooltip')).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(2));
  expect(screen.getByRole('tooltip').textContent).toContain('Pan the board');
  expect(button.getAttribute('aria-describedby')).toBe(
    screen.getByRole('tooltip').id
  );
  fireEvent.pointerDown(button);
  fireEvent.click(button);
  expect(action).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(button.hasAttribute('aria-describedby')).toBe(false);
  fireEvent.focusIn(button);
  await act(() => vi.advanceTimersByTimeAsync(600));
  expect(screen.queryByRole('tooltip')).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  fireEvent.focusIn(button);
  await act(() => vi.advanceTimersByTimeAsync(501));
  screen.getByRole('tooltip');
  fireEvent.keyDown(button, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
});
