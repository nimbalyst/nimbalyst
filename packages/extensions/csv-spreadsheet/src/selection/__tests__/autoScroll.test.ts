// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { autoScrollDelta, clampPointToBounds } from '../autoScroll';

const bounds = { left: 100, top: 200, right: 500, bottom: 600 };

describe('autoScrollDelta', () => {
  it('does not scroll while the pointer is inside the cell area', () => {
    expect(autoScrollDelta({ clientX: 300, clientY: 400 }, bounds)).toEqual({ x: 0, y: 0 });
    // Exactly on an edge still counts as inside, so a drag along the last
    // visible column doesn't creep.
    expect(autoScrollDelta({ clientX: 500, clientY: 600 }, bounds)).toEqual({ x: 0, y: 0 });
  });

  it('scrolls toward the pointer, faster the further out it is', () => {
    const near = autoScrollDelta({ clientX: 300, clientY: 610 }, bounds);
    const far = autoScrollDelta({ clientX: 300, clientY: 700 }, bounds);

    expect(near.y).toBeGreaterThan(0);
    expect(far.y).toBeGreaterThan(near.y);
    expect(near.x).toBe(0);

    // The same overshoot above/left of the area scrolls the other way.
    expect(autoScrollDelta({ clientX: 90, clientY: 190 }, bounds)).toEqual({
      x: -near.y,
      y: -near.y,
    });
  });

  it('saturates rather than accelerating without limit', () => {
    const far = autoScrollDelta({ clientX: 300, clientY: 800 }, bounds);
    const absurd = autoScrollDelta({ clientX: 300, clientY: 100_000 }, bounds);
    expect(absurd.y).toBe(far.y);
  });

  it('scrolls both axes at once for a diagonal overshoot', () => {
    const delta = autoScrollDelta({ clientX: 900, clientY: 1000 }, bounds);
    expect(delta.x).toBeGreaterThan(0);
    expect(delta.y).toBeGreaterThan(0);
  });
});

describe('clampPointToBounds', () => {
  it('pulls an outside pointer just inside the nearest edge', () => {
    // Inset by a pixel: a probe exactly on the boundary can hit the neighbour.
    expect(clampPointToBounds({ clientX: 900, clientY: 50 }, bounds)).toEqual({
      clientX: 499,
      clientY: 201,
    });
  });

  it('leaves a pointer that is already inside alone', () => {
    expect(clampPointToBounds({ clientX: 300, clientY: 400 }, bounds)).toEqual({
      clientX: 300,
      clientY: 400,
    });
  });
});
