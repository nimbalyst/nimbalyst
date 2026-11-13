// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ISLAND_EXPANDED_WIDTH } from '../../../shared/menuBarIsland';
import {
  ISLAND_WINDOW_HEIGHT,
  ISLAND_WINDOW_WIDTH,
  NOTCH_WIDTH_RATIO,
  islandCanvasSize,
  islandPlacement,
  isCursorOverIsland,
  isDragGesture,
  isNotchedDisplay,
  nextHoverState,
  resolveIslandDisplay,
} from '../islandGeometry';

/**
 * A Studio Display driving the menu bar. Measured, not invented, and the 30pt
 * menu bar is the point: it is identical to the notched panel's below.
 */
const studioDisplay = {
  bounds: { x: 0, y: 0, width: 2048, height: 1152 },
  workArea: { x: 0, y: 30, width: 2048, height: 1122 },
  internal: false,
};

/**
 * A notched 14" MacBook Pro built-in panel, sitting left of and below the
 * Studio Display. Every number here was read off a real two-display Mac -- and
 * the menu bar really is 30pt, the same as the unnotched display it is next to,
 * which is why placement cannot be decided from that height.
 */
const notchedDisplay = {
  bounds: { x: -1352, y: 274, width: 1352, height: 878 },
  workArea: { x: -1352, y: 304, width: 1352, height: 848 },
  internal: true,
};

describe('isNotchedDisplay', () => {
  it('separates a notched built-in from an external display with the same menu bar', () => {
    // The regression guard, and the reason this is measured on shape rather
    // than on menu bar height: both displays report 30pt, so any height
    // threshold either misses the notch entirely -- centring the island behind
    // the camera housing, where it is invisible while running perfectly -- or
    // shoves it off-centre on a screen that has no housing at all.
    expect(notchedDisplay.workArea.y - notchedDisplay.bounds.y)
      .toBe(studioDisplay.workArea.y - studioDisplay.bounds.y);
    expect(isNotchedDisplay(studioDisplay)).toBe(false);
    expect(isNotchedDisplay(notchedDisplay)).toBe(true);
  });

  it('leaves an unnotched built-in alone', () => {
    // An Air or a pre-2021 Pro is internal, but its panel is exactly 16:10.
    expect(isNotchedDisplay({
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 30, width: 1440, height: 870 },
      internal: true,
    })).toBe(false);
  });

  it('never calls an external display notched, whatever its shape', () => {
    // An ultrawide is further from 16:10 than any notched laptop. `internal` is
    // what stops the ratio speaking for a display that cannot have a housing.
    expect(isNotchedDisplay({
      bounds: { x: 0, y: 0, width: 3440, height: 1440 },
      workArea: { x: 0, y: 30, width: 3440, height: 1410 },
      internal: false,
    })).toBe(false);
  });
});

describe('islandPlacement', () => {
  it('centres on an unnotched display, at its top edge rather than its work area', () => {
    // y must be the display's own top: the island draws *inside* the menu bar.
    // Returning workArea.y here would put it below the menu bar and the feature
    // silently becomes an ordinary floating panel.
    expect(islandPlacement(studioDisplay)).toEqual({
      x: 1024 - ISLAND_WINDOW_WIDTH / 2,
      y: 0,
      width: ISLAND_WINDOW_WIDTH,
      height: ISLAND_WINDOW_HEIGHT,
      anchor: 'center',
    });
  });

  it('respects a display with a negative origin', () => {
    const placement = islandPlacement({
      bounds: { x: -1352, y: 274, width: 1352, height: 878 },
      workArea: { x: -1352, y: 304, width: 1352, height: 848 },
      internal: false,
    });
    expect(placement.x).toBe(Math.round(-1352 + 676 - ISLAND_WINDOW_WIDTH / 2));
    expect(placement.y).toBe(274);
  });

  it('clears the notch, keeping the whole island left of the camera housing', () => {
    // Centred, the collapsed strip lands behind the notch and the island is
    // invisible while running perfectly -- there is nothing on screen to
    // diagnose, which is what makes this worth a test rather than an eyeball.
    const placement = islandPlacement(notchedDisplay);
    expect(placement.anchor).toBe('notch-left');
    expect(placement.y).toBe(notchedDisplay.bounds.y);

    const { x, width } = notchedDisplay.bounds;
    const notchLeft = x + (width - width * NOTCH_WIDTH_RATIO) / 2;
    // The island is pinned to the window's right edge, so that edge is what has
    // to clear the notch.
    expect(placement.x + ISLAND_WINDOW_WIDTH).toBeLessThan(notchLeft);
  });

  it('keeps the expanded panel on screen when the notch leaves little room', () => {
    // The window itself may hang off the left edge -- that overhang is
    // transparent click-through canvas. What must not is the island, and the
    // island is at its widest expanded.
    const narrow = {
      bounds: { x: 0, y: 0, width: 700, height: 455 },
      workArea: { x: 0, y: 30, width: 700, height: 425 },
      internal: true,
    };
    const placement = islandPlacement(narrow);
    const islandLeft = placement.x + ISLAND_WINDOW_WIDTH - ISLAND_EXPANDED_WIDTH;
    expect(islandLeft).toBeGreaterThanOrEqual(narrow.bounds.x);
  });
});

describe('island canvas sizing', () => {
  it('grows the canvas to fit a panel larger than the default', () => {
    // The panel is a div inside a fixed canvas; a saved size the canvas cannot
    // hold would be clipped at the window edge.
    const canvas = islandCanvasSize({ width: 740, listHeight: 700 }, 1152);
    expect(canvas.width).toBeGreaterThanOrEqual(740 + 80);
    expect(canvas.height).toBeGreaterThanOrEqual(30 + 700 + 40);
  });

  it('never exceeds the display height, even mid-resize', () => {
    const canvas = islandCanvasSize({ width: 420, listHeight: 340 }, 600, true);
    expect(canvas.height).toBe(600);
  });

  it('keeps the island right edge in place by the notch when a resize enlarges the canvas', () => {
    // The island hugs the canvas's right edge there; if that edge moved when
    // the canvas grew, the panel would jump sideways under the cursor.
    const panel = { width: 420, listHeight: 340 };
    const resting = islandPlacement(notchedDisplay, panel);
    const resizing = islandPlacement(notchedDisplay, panel, true);
    expect(resizing.x + resizing.width).toBe(resting.x + resting.width);
  });

  it('keeps a centred island centred when a resize enlarges the canvas', () => {
    const panel = { width: 420, listHeight: 340 };
    const resting = islandPlacement(studioDisplay, panel);
    const resizing = islandPlacement(studioDisplay, panel, true);
    expect(resizing.x + resizing.width / 2).toBe(resting.x + resting.width / 2);
  });
});

describe('resolveIslandDisplay', () => {
  const studio = { ...studioDisplay, id: 1, label: 'Studio Display' };
  const builtIn = { ...notchedDisplay, id: 2, label: 'Built-in Retina Display' };
  const all = [studio, builtIn];

  it('follows the primary when the user has never dragged the island', () => {
    // Not "the display that was primary when we saved" -- no preference has to
    // keep tracking the primary as the user rearranges their monitors.
    expect(resolveIslandDisplay(all, studio, null)).toBe(studio);
  });

  it('honours the dragged choice over the primary', () => {
    expect(resolveIslandDisplay(all, studio, { id: 2, label: 'Built-in Retina Display' }))
      .toBe(builtIn);
  });

  it('falls back to the primary when the chosen display is unplugged', () => {
    // The failure this prevents is not a misplaced island but an invisible one:
    // placed on a screen that is not there, it cannot report its own absence.
    expect(resolveIslandDisplay([studio], studio, { id: 2, label: 'Built-in Retina Display' }))
      .toBe(studio);
  });

  it('recognises a display whose id changed but whose label did not', () => {
    // Unplugging a monitor and plugging it back in can renumber it. Dropping to
    // the primary there would quietly undo the user's choice on every reconnect.
    expect(resolveIslandDisplay(all, studio, { id: 99, label: 'Built-in Retina Display' }))
      .toBe(builtIn);
  });

  it('does not match a blank label against a display that has none', () => {
    const unlabelled = { ...studio, id: 7, label: '' };
    expect(resolveIslandDisplay([unlabelled], unlabelled, { id: 99, label: '' }))
      .toBe(unlabelled);
  });
});

describe('isDragGesture', () => {
  it('reads a press that barely moved as a click, not a drag', () => {
    // The pill is both the pin toggle and the drag handle, so a hand that
    // failed to hold still must not move the island to another screen.
    expect(isDragGesture({ x: 100, y: 10 }, { x: 103, y: 12 })).toBe(false);
    expect(isDragGesture({ x: 100, y: 10 }, { x: 140, y: 10 })).toBe(true);
  });

  it('measures distance rather than either axis alone', () => {
    // Dragging to a display above or below is as real as one to the side.
    expect(isDragGesture({ x: 100, y: 10 }, { x: 100, y: 60 })).toBe(true);
  });
});

describe('isCursorOverIsland', () => {
  const win = { x: 644, y: 0, width: ISLAND_WINDOW_WIDTH, height: ISLAND_WINDOW_HEIGHT };
  const island = { left: 280, top: 0, width: 200, height: 30 };

  it('converts the cursor into window coordinates', () => {
    expect(isCursorOverIsland({ x: 644 + 380, y: 14 }, win, island)).toBe(true);
    expect(isCursorOverIsland({ x: 644 + 100, y: 14 }, win, island)).toBe(false);
    expect(isCursorOverIsland({ x: 644 + 380, y: 90 }, win, island)).toBe(false);
  });

  it('is never hot before the renderer has reported a rect', () => {
    // The window spans 760x460 of transparent canvas. A zero-size island that
    // still answered "inside" for the origin would make the whole top-left
    // corner of the screen swallow clicks.
    expect(isCursorOverIsland({ x: 644, y: 0 }, win, { left: 0, top: 0, width: 0, height: 0 }))
      .toBe(false);
  });
});

describe('nextHoverState', () => {
  const closed = { hovered: false, outsideSince: 0 };

  it('opens immediately on entry', () => {
    expect(nextHoverState(closed, { inside: true, pinned: false, now: 1000 }))
      .toEqual({ hovered: true, outsideSince: 0 });
  });

  it('holds open through the exit grace, then closes', () => {
    const open = { hovered: true, outsideSince: 0 };
    const leaving = nextHoverState(open, { inside: false, pinned: false, now: 1000, graceMs: 260 });
    expect(leaving).toEqual({ hovered: true, outsideSince: 1000 });

    // Still inside the grace window.
    const stillOpen = nextHoverState(leaving, { inside: false, pinned: false, now: 1200, graceMs: 260 });
    expect(stillOpen.hovered).toBe(true);
    // The grace must be measured from when the cursor *first* left, not from
    // this tick -- carrying `now` forward each poll would hold it open forever.
    expect(stillOpen.outsideSince).toBe(1000);

    expect(nextHoverState(stillOpen, { inside: false, pinned: false, now: 1260, graceMs: 260 }))
      .toEqual({ hovered: false, outsideSince: 0 });
  });

  it('re-entering during the grace clears the pending close', () => {
    const leaving = { hovered: true, outsideSince: 1000 };
    expect(nextHoverState(leaving, { inside: true, pinned: false, now: 1100 }))
      .toEqual({ hovered: true, outsideSince: 0 });
  });

  it('stays open while pinned no matter where the cursor is', () => {
    expect(nextHoverState(closed, { inside: false, pinned: true, now: 5000 }))
      .toEqual({ hovered: true, outsideSince: 0 });
  });

  it('stays closed while the cursor is outside and nothing is pinned', () => {
    expect(nextHoverState(closed, { inside: false, pinned: false, now: 5000 }))
      .toEqual({ hovered: false, outsideSince: 0 });
  });
});
