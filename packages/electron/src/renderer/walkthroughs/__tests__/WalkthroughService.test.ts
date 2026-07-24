// @vitest-environment jsdom

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { calculateCalloutPosition, shouldShowWalkthrough } from '../WalkthroughService';
import type { WalkthroughDefinition, WalkthroughState } from '../types';

/**
 * Build a fake target element whose `getBoundingClientRect()` returns the given rect.
 * Tests don't actually need a real DOM-mounted element since the callout-position
 * code only reads bounding-rect geometry plus `window.innerWidth`/`innerHeight`.
 */
function fakeTarget(rect: { top: number; left: number; width: number; height: number }): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    x: rect.left,
    y: rect.top,
    top: rect.top,
    left: rect.left,
    bottom: rect.top + rect.height,
    right: rect.left + rect.width,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({}),
  });
  return el;
}

describe('calculateCalloutPosition', () => {
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1280, writable: true, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, writable: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, writable: true, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, writable: true, configurable: true });
  });

  describe('default (non-wide) callout', () => {
    it('clamps left to viewport when target is near the right edge', () => {
      // Target hugs the right edge of a 1280px-wide viewport (rect.right = 1280, spaceRight = 0).
      // 320px callout + 12px arrow + 16px margin = 348px needed on the right, none available.
      // Should fall back to a placement that fits, with left clamped inside the viewport.
      const target = fakeTarget({ top: 400, left: 1200, width: 80, height: 30 });
      const pos = calculateCalloutPosition(target, 'right');
      expect(pos.left).toBeGreaterThanOrEqual(16); // VIEWPORT_MARGIN
      expect(pos.left + 320).toBeLessThanOrEqual(1280 - 16);
    });

    it('places callout to the right when there is room', () => {
      const target = fakeTarget({ top: 400, left: 100, width: 50, height: 30 });
      const pos = calculateCalloutPosition(target, 'right');
      // 100 + 50 + 12 = 162 (rect.right + ARROW_SIZE)
      expect(pos.left).toBe(162);
      expect(pos.arrowPosition).toBe('left');
    });
  });

  describe('wide callout', () => {
    it('uses 420 (not 320) when computing fitsRight', () => {
      // Viewport = 1280. Target.right = 800. spaceRight = 480.
      // For default (320): 480 >= 320+12+16 = 348 -> fitsRight = true.
      // For wide (420):    480 >= 420+12+16 = 448 -> fitsRight = true.
      // Make a tighter case where wide=false fits but wide=true does not.
      // Target at left=400, width=50 -> right=450, spaceRight=830.
      // Both fit. Use a tighter case: target.right = 900, spaceRight = 380.
      // Default: 380 >= 348 -> fits.  Wide: 380 < 448 -> does NOT fit.
      const target = fakeTarget({ top: 400, left: 850, width: 50, height: 30 });
      const widePos = calculateCalloutPosition(target, 'right', true);
      // Wide should NOT place to the right because 380 < 448. Should fall back to 'bottom' (fits).
      expect(widePos.arrowPosition).not.toBe('left');
    });

    it('clamps left for wide callouts using 420 width', () => {
      // Place target near the right edge.
      // For wide=true, viewport-clamp uses 420: max-left = 1280 - 420 - 16 = 844.
      // For wide=false, viewport-clamp uses 320: max-left = 1280 - 320 - 16 = 944.
      // Pick a target whose unclamped left would exceed 844 but stay below 944.
      // bottom placement: left = targetCenterX - calloutWidth/2.
      // targetCenterX = 1100, wide left = 1100 - 210 = 890; clamped to 844.
      // wide=false left = 1100 - 160 = 940; clamped to 940 (under 944, no clamp).
      const target = fakeTarget({ top: 100, left: 1080, width: 40, height: 30 });
      const narrow = calculateCalloutPosition(target, 'bottom', false);
      const wide = calculateCalloutPosition(target, 'bottom', true);
      expect(narrow.left).toBe(940);
      expect(wide.left).toBe(844);
      expect(wide.left + 420).toBeLessThanOrEqual(1280 - 16);
    });

    it('arrow offset uses calloutWidth bound for wide callouts', () => {
      // For bottom placement with wide=true, arrowOffset is clamped to <= calloutWidth - ARROW_MIN_OFFSET = 420 - 24 = 396.
      // Default would clamp to 320 - 24 = 296.
      // Build a case where targetCenter is far right of the clamped left so the arrow would be near the right edge.
      const target = fakeTarget({ top: 100, left: 1000, width: 100, height: 30 });
      const wide = calculateCalloutPosition(target, 'bottom', true);
      expect(wide.arrowPosition).toBe('top');
      // arrowOffset must be within the wide callout (>= 24, <= 420 - 24).
      expect(wide.arrowOffset).toBeGreaterThanOrEqual(24);
      expect(wide.arrowOffset).toBeLessThanOrEqual(420 - 24);
    });
  });

  describe('default parameter behavior', () => {
    it('omitting wide is equivalent to wide=false', () => {
      const target = fakeTarget({ top: 400, left: 100, width: 50, height: 30 });
      const omitted = calculateCalloutPosition(target, 'right');
      const explicit = calculateCalloutPosition(target, 'right', false);
      expect(omitted).toEqual(explicit);
    });
  });
});

describe('shouldShowWalkthrough', () => {
  const state: WalkthroughState = {
    enabled: true,
    completed: ['walkthrough-test'],
    dismissed: ['walkthrough-test'],
    history: {
      'walkthrough-test': {
        shownAt: 1,
        completedAt: 2,
        dismissedAt: 3,
        version: 1,
      },
    },
  };

  const walkthrough: WalkthroughDefinition = {
    id: 'walkthrough-test',
    name: 'Test Walkthrough',
    version: 2,
    trigger: {},
    steps: [],
  };

  it('re-shows a walkthrough when the version changes', () => {
    expect(shouldShowWalkthrough(state, walkthrough)).toBe(true);
  });
});
