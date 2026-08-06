// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  resolveWindowControlsZones,
  clearWindowControls,
  windowControlsClearance,
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
  it('derives a left band from the macOS titlebar area', () => {
    expect(resolveWindowControlsZones(MACOS_TITLEBAR_RECT, MACOS_VIEWPORT_WIDTH)).toEqual([
      { left: 0, right: 80, bottom: 38 },
    ]);
  });

  it('derives a right band when the controls sit on the right', () => {
    expect(resolveWindowControlsZones(WINDOWS_TITLEBAR_RECT, MACOS_VIEWPORT_WIDTH)).toEqual([
      { left: 1848, right: 2048, bottom: 38 },
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

  it('clears the project rail add menu that #1096 reported', () => {
    // The `+` menu with >=2 recents is clamped by shift() to (56, 8) and its
    // left 24px land in the controls band.
    expect(clearWindowControls(56, 8, 260, zones)).toBe(38);
  });

  it('leaves popovers that do not reach the band alone', () => {
    // Same column, but already below the title bar.
    expect(clearWindowControls(56, 120, 260, zones)).toBe(120);
    // Top-clamped, but far to the right of the macOS controls.
    expect(clearWindowControls(900, 8, 260, zones)).toBe(8);
  });

  it('does not move an element whose right edge stops short of the band', () => {
    expect(clearWindowControls(1900, 8, 100, resolveWindowControlsZones(WINDOWS_TITLEBAR_RECT, 2048))).toBe(38);
    expect(clearWindowControls(1700, 8, 100, resolveWindowControlsZones(WINDOWS_TITLEBAR_RECT, 2048))).toBe(8);
  });
});

describe('windowControlsClearance middleware', () => {
  const zones = resolveWindowControlsZones(MACOS_TITLEBAR_RECT, MACOS_VIEWPORT_WIDTH);

  it('pushes an overlapping menu below the controls and reports the push', () => {
    const result = runMiddleware(56, 8, { width: 260, height: 475 }, zones);
    expect(result.y).toBe(38);
    expect(result.data).toEqual({ pushed: 30 });
  });

  it('is inert when nothing overlaps', () => {
    expect(runMiddleware(56, 120, { width: 260, height: 475 }, zones)).toEqual({});
  });

  it('is inert when the window has no controls overlay', () => {
    expect(runMiddleware(56, 8, { width: 260, height: 475 }, [])).toEqual({});
  });
});
