import React from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlacedViewResizeFrame } from '../PlacedViewResizeFrame';

// jsdom has no CSS zoom, so the real reading is NaN.
vi.mock('@lexical/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@lexical/utils')>(),
  calculateZoomLevel: () => 1,
}));

const COLUMN = 800;

function renderFrame(onAttrsChange?: (patch: Readonly<Record<string, string | null>>) => void) {
  const result = render(
    <LexicalComposer initialConfig={{ namespace: 'placed-view-resize', onError: (error) => { throw error; } }}>
      <PlacedViewResizeFrame attrs={{}} onAttrsChange={onAttrsChange}>
        <div className="card">
          <div data-placed-view-body="" style={{ height: 300 }} />
        </div>
      </PlacedViewResizeFrame>
    </LexicalComposer>,
  );
  const frame = result.container.querySelector<HTMLElement>('.placed-view-resize-frame')!;
  const body = frame.querySelector<HTMLElement>('[data-placed-view-body]')!;
  // jsdom lays nothing out: a 600x400 frame whose body is 300 tall (100px of header and footer).
  frame.getBoundingClientRect = () => ({ width: 600, height: 400 } as DOMRect);
  Object.defineProperty(frame, 'offsetHeight', { configurable: true, value: 400 });
  Object.defineProperty(body, 'offsetHeight', { configurable: true, value: 300 });
  return { ...result, frame, body };
}

// jsdom has no PointerEvent, and its fallback drops clientX/clientY.
const pointer = (type: string, clientX = 0, clientY = 0) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });

function drag(grip: HTMLElement, dx: number, dy: number) {
  fireEvent(grip, pointer('pointerdown'));
  fireEvent(document, pointer('pointermove', dx, dy));
  fireEvent(document, pointer('pointerup'));
}

describe('PlacedViewResizeFrame', () => {
  let clientWidth: PropertyDescriptor | undefined;
  beforeEach(() => {
    clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => COLUMN });
  });
  afterEach(() => {
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
  });

  it('drags the corner grip to a free width and body height, fills the column at its edge, and resets on double-click', () => {
    const change = vi.fn();
    const { body } = renderFrame(change);
    const grip = screen.getByTestId('block-resizer-grip');

    // Width and height move independently: no aspect lock on the grip.
    drag(grip, 100, -50);
    expect(change).toHaveBeenLastCalledWith({ width: '700', height: '250' });
    expect(body.style.height).toBe('250px');

    // Dragged to the column's edge means "fill the column", not a fixed width.
    drag(grip, 400, 0);
    expect(change).toHaveBeenLastCalledWith({ width: null, height: '300' });

    fireEvent.doubleClick(grip);
    expect(change).toHaveBeenLastCalledWith({ width: null, height: null });
  });

  it('has no grip on a read-only page', () => {
    renderFrame(undefined);
    expect(screen.queryByTestId('block-resizer-grip')).toBeNull();
  });
});
