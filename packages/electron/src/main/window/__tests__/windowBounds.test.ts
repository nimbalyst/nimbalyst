// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  cascadeWindowBounds,
  restoreVisibleWindowBounds,
} from "../windowBounds";

const PRIMARY = { x: 0, y: 0, width: 1536, height: 960 };
const SECONDARY = { x: 1920, y: 0, width: 1920, height: 1200 };

describe("restoreVisibleWindowBounds", () => {
  it("moves the reported disconnected-monitor bounds onto the nearest work area", () => {
    expect(
      restoreVisibleWindowBounds(
        { x: -312, y: -1449, width: 1310, height: 805, isMaximized: true },
        [PRIMARY, SECONDARY],
        PRIMARY
      )
    ).toEqual({
      x: 0,
      y: 0,
      width: 1310,
      height: 805,
      isMaximized: true,
    });
  });

  it("preserves negative coordinates when that display is still connected", () => {
    const upperDisplay = { x: -400, y: -1200, width: 1600, height: 1200 };
    const saved = { x: -312, y: -1100, width: 1310, height: 805 };

    expect(
      restoreVisibleWindowBounds(saved, [PRIMARY, upperDisplay], PRIMARY)
    ).toEqual(saved);
  });

  it("preserves a slightly off-screen window with a usable title-bar region", () => {
    const saved = { x: -7, y: -7, width: 1310, height: 805 };

    expect(restoreVisibleWindowBounds(saved, [PRIMARY], PRIMARY)).toEqual(
      saved
    );
  });

  it("relocates a window when only its body intersects a display", () => {
    expect(
      restoreVisibleWindowBounds(
        { x: 200, y: -700, width: 900, height: 800 },
        [PRIMARY],
        PRIMARY
      )
    ).toEqual({ x: 200, y: 0, width: 900, height: 800 });
  });

  it("relocates a window saved inside a gap between displays", () => {
    expect(
      restoreVisibleWindowBounds(
        { x: 1600, y: 100, width: 100, height: 100 },
        [PRIMARY, SECONDARY],
        PRIMARY
      )
    ).toEqual({ x: 1436, y: 100, width: 100, height: 100 });
  });

  it("caps relocated windows to the target work area", () => {
    expect(
      restoreVisibleWindowBounds(
        { x: 3000, y: 2000, width: 2000, height: 1400 },
        [PRIMARY],
        PRIMARY
      )
    ).toEqual(PRIMARY);
  });
});

describe("cascadeWindowBounds", () => {
  it("places a new window relative to the selected display", () => {
    expect(
      cascadeWindowBounds(SECONDARY, 40, { width: 1024, height: 768 })
    ).toEqual({
      x: 2060,
      y: 140,
      width: 1024,
      height: 768,
    });
  });

  it("wraps an overflowing cascade back to the display inset", () => {
    expect(
      cascadeWindowBounds(PRIMARY, 500, { width: 1024, height: 768 })
    ).toEqual({
      x: 100,
      y: 100,
      width: 1024,
      height: 768,
    });
  });
});
