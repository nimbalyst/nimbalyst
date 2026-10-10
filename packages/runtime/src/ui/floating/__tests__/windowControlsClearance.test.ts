// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  resolveWindowControlsZones,
  clearWindowControls,
  windowControlsClearance,
  TITLE_BAR_BUFFER,
  type WindowControlsZone,
} from '../windowControlsClearance';

/**
 * Geometry measured in a running macOS dev window (GitHub #1096):
 * `navigator.windowControlsOverlay.getTitlebarAreaRect()` reports
 * `{x: 80, y: 0, width: 1968, height: 38}` in a 2048px-wide viewport, so the
 * traffic lights occupy x 0..80, y 0..38.
 */
const MACOS_TITLEBAR_RECT = { x: 80, y: 0, width: 1968, height: 38 };
const MACOS_VIEWPORT_WIDTH = 2048;

/** Windows/Linux put the controls on the right instead. */
const WINDOWS_TITLEBAR_RECT = { x: 0, y: 0, width: 1848, height: 38 };

function runMiddleware(
  x: number,
  y: number,
  floating: { width: number; height: number },
  zones: WindowControlsZone[]
) {
  const middleware = windowControlsClearance(() => zones);
  return middleware.fn({
    x,
    y,
    rects: { floating, reference: { x: 0, y: 0, width: 0, height: 0 } },
    // The middleware only reads x/y/rects; the rest of the floating-ui state
    // is irrelevant here.
  } as never) as { y?: number; data?: { pushed: number } };
}

describe('resolveWindowControlsZones', () => {
  it('reserves the full title-bar strip plus a buffer on macOS', () => {
    expect(resolveWindowControlsZones(MACOS_TITLEBAR_RECT, MACOS_VIEWPORT_WIDTH)).toEqual([
      { left: 0, right: 2048, bottom: 38 + TITLE_BAR_BUFFER },
    ]);
  });

  it('reserves the same strip when the controls sit on the right', () => {
    expect(resolveWindowControlsZones(WINDOWS_TITLEBAR_RECT, MACOS_VIEWPORT_WIDTH)).toEqual([
      { left: 0, right: 2048, bottom: 38 + TITLE_BAR_BUFFER },
    ]);
  });

  it('reserves nothing when there is no custom title bar', () => {
    expect(resolveWindowControlsZones(null, MACOS_VIEWPORT_WIDTH)).toEqual([]);
    expect(
      resolveWindowControlsZones({ x: 0, y: 0, width: MACOS_VIEWPORT_WIDTH, height: 0 }, MACOS_VIEWPORT_WIDTH)
    ).toEqual([]);
  });
});

describe('clearWindowControls', () => {
  const zones = resolveWindowControlsZones(MACOS_TITLEBAR_RECT, MACOS_VIEWPORT_WIDTH);
  const floor = 38 + TITLE_BAR_BUFFER;

  it('clears the project rail add menu that #1096 reported', () => {
    // The `+` menu with >=2 recents is clamped by shift() to (56, 8) and its
    // left 24px land in the controls band.
    expect(clearWindowControls(56, 8, 260, zones)).toBe(floor);
  });

  it('clears a top-clamped menu far from the window controls', () => {
    // The file tree's folder menu, right-clicked near the bottom of a short
    // window, is clamped to (184, 8). On macOS the mousedown on its first item
    // reached the renderer but the mouseup never did, so the item never fired.
    expect(clearWindowControls(184, 8, 246, zones)).toBe(floor);
    expect(clearWindowControls(900, 40, 260, zones)).toBe(floor);
  });

  it('leaves popovers already below the buffer alone', () => {
    expect(clearWindowControls(56, 120, 260, zones)).toBe(120);
    expect(clearWindowControls(900, floor, 260, zones)).toBe(floor);
  });
});

describe('windowControlsClearance middleware', () => {
  const zones = resolveWindowControlsZones(MACOS_TITLEBAR_RECT, MACOS_VIEWPORT_WIDTH);

  it('pushes an overlapping menu below the strip and reports the push', () => {
    const result = runMiddleware(56, 8, { width: 260, height: 475 }, zones);
    expect(result.y).toBe(38 + TITLE_BAR_BUFFER);
    expect(result.data).toEqual({ pushed: 30 + TITLE_BAR_BUFFER });
  });

  it('is inert when nothing overlaps', () => {
    expect(runMiddleware(56, 120, { width: 260, height: 475 }, zones)).toEqual({});
  });

  it('is inert when the window has no controls overlay', () => {
    expect(runMiddleware(56, 8, { width: 260, height: 475 }, [])).toEqual({});
  });
});
