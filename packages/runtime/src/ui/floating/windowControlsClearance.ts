/**
 * Window-controls clearance for floating elements.
 *
 * On macOS the app windows are `hiddenInset` with `titleBarOverlay: true`, so
 * the traffic lights are painted by the OS in a native view *above* the
 * WebContents. No `z-index` can put a popover in front of them: whatever
 * floating-ui clamps into that band is partly covered, and clicks in the
 * covered area land on the OS zoom button instead of the menu.
 *
 * `shift({ padding: 8 })` clamps an upward-growing menu to y=8, which is
 * squarely inside the band — see GitHub #1096, where the project rail's `+`
 * menu (`placement: 'right-end'`) lands at (56, 8) with the green light on
 * top of its corner.
 *
 * The reserved band is read from the Window Controls Overlay API rather than
 * hardcoded, so it stays correct on macOS (controls on the left) and on
 * Windows/Linux (controls on the right) without the renderer knowing the
 * platform. When the API reports nothing the window has no custom title bar,
 * the viewport already starts below the OS chrome, and there is nothing to
 * reserve — so this middleware is inert and no popover moves.
 */

import type { Middleware } from '@floating-ui/react';

/**
 * A horizontal span of the viewport, from y=0 down to `bottom`, that the OS
 * paints window controls into.
 */
export interface WindowControlsZone {
  left: number;
  right: number;
  bottom: number;
}

export interface TitlebarAreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Derive the control bands from the *available* titlebar area.
 *
 * The WCO API reports the region left over for app content, so the controls
 * are whatever sits outside it: a left band on macOS (`rect.x > 0`) and a
 * right band on Windows/Linux (`rect.x + rect.width < viewportWidth`).
 */
export function resolveWindowControlsZones(
  rect: TitlebarAreaRect | null,
  viewportWidth: number
): WindowControlsZone[] {
  if (!rect || rect.height <= 0) return [];

  const zones: WindowControlsZone[] = [];
  const bottom = rect.y + rect.height;

  if (rect.x > 0) {
    zones.push({ left: 0, right: rect.x, bottom });
  }

  const rightEdge = rect.x + rect.width;
  if (rightEdge < viewportWidth) {
    zones.push({ left: rightEdge, right: viewportWidth, bottom });
  }

  return zones;
}

/**
 * Smallest y that keeps a floating element of `width`/`height` clear of every
 * control band it would otherwise intersect. Returns `y` unchanged when the
 * element does not overlap any band — popovers away from the window corners
 * must not move.
 */
export function clearWindowControls(
  x: number,
  y: number,
  width: number,
  zones: WindowControlsZone[]
): number {
  let cleared = y;

  for (const zone of zones) {
    const overlapsHorizontally = x < zone.right && x + width > zone.left;
    if (!overlapsHorizontally) continue;
    // Bands start at the top of the viewport, so an element intersects one
    // whenever its top edge is above the band's bottom.
    if (y < zone.bottom) cleared = Math.max(cleared, zone.bottom);
  }

  return cleared;
}

function readTitlebarAreaRect(): TitlebarAreaRect | null {
  if (typeof navigator === 'undefined') return null;
  const overlay = (
    navigator as Navigator & {
      windowControlsOverlay?: {
        visible: boolean;
        getTitlebarAreaRect: () => DOMRect;
      };
    }
  ).windowControlsOverlay;

  if (!overlay?.visible) return null;

  const rect = overlay.getTitlebarAreaRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** Control bands for the current window, empty when there is no custom title bar. */
export function getWindowControlsZones(): WindowControlsZone[] {
  if (typeof window === 'undefined') return [];
  return resolveWindowControlsZones(readTitlebarAreaRect(), window.innerWidth);
}

export interface WindowControlsClearanceData {
  /** Pixels this middleware pushed the element down; 0 when it did not move. */
  pushed: number;
}

/**
 * floating-ui middleware that pushes a floating element below the OS window
 * controls when — and only when — it would otherwise overlap them.
 *
 * Place it *after* `shift()` (it corrects what shift clamps) and *before*
 * `size()`, so a height constraint can subtract the push via
 * `middlewareData.windowControlsClearance.pushed`.
 */
export function windowControlsClearance(
  resolveZones: () => WindowControlsZone[] = getWindowControlsZones
): Middleware {
  return {
    name: 'windowControlsClearance',
    fn({ x, y, rects }) {
      const zones = resolveZones();
      if (zones.length === 0) return {};

      const cleared = clearWindowControls(x, y, rects.floating.width, zones);
      if (cleared === y) return {};

      return { y: cleared, data: { pushed: cleared - y } satisfies WindowControlsClearanceData };
    },
  };
}
