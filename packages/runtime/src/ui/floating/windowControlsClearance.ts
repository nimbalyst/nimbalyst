/**
 * Title-bar clearance for floating elements.
 *
 * App windows with a custom title bar (`hiddenInset` + `titleBarOverlay` on
 * macOS, `hidden` + overlay on Windows/Linux) have a 38px strip across the top
 * that no popover can work in:
 *
 * - The OS paints the window controls above the WebContents, so a popover
 *   clamped into their corner is partly covered and clicks land on the zoom
 *   button (GitHub #1096).
 * - Across the rest of the strip, clicks on a popover item are unreliable on
 *   macOS: the mousedown reaches the renderer but the mouseup never does, so
 *   the item's click handler never fires (the file tree's folder menu, clamped
 *   to y=8 in a short window, lost its first item this way).
 *
 * `shift({ padding: 8 })` clamps an upward-growing or tall menu to y=8, so this
 * middleware keeps every floating element below the whole strip plus
 * `TITLE_BAR_BUFFER`, not just below the controls.
 *
 * The strip is read from the Window Controls Overlay API rather than
 * hardcoded. When the API reports nothing the window has no custom title bar,
 * the viewport already starts below the OS chrome, and there is nothing to
 * reserve, so this middleware is inert and no popover moves.
 */

import type { Middleware } from '@floating-ui/react';

/** Gap kept between the bottom of the title-bar strip and any floating element. */
export const TITLE_BAR_BUFFER = 8;

/**
 * A horizontal span of the viewport, from y=0 down to `bottom`, that floating
 * elements must stay out of.
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
 * Derive the reserved zone from the titlebar area: the full viewport width,
 * down to the bottom of the strip plus `TITLE_BAR_BUFFER`. The controls sit
 * inside the strip on every platform, so one full-width band covers them too.
 */
export function resolveWindowControlsZones(
  rect: TitlebarAreaRect | null,
  viewportWidth: number
): WindowControlsZone[] {
  if (!rect || rect.height <= 0) return [];
  return [{ left: 0, right: viewportWidth, bottom: rect.y + rect.height + TITLE_BAR_BUFFER }];
}

/**
 * Smallest y that keeps a floating element of `width` clear of every zone it
 * would otherwise intersect. Returns `y` unchanged when the element does not
 * overlap any zone, so popovers already below the strip never move.
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

/** Reserved zones for the current window, empty when there is no custom title bar. */
export function getWindowControlsZones(): WindowControlsZone[] {
  if (typeof window === 'undefined') return [];
  return resolveWindowControlsZones(readTitlebarAreaRect(), window.innerWidth);
}

export interface WindowControlsClearanceData {
  /** Pixels this middleware pushed the element down; 0 when it did not move. */
  pushed: number;
}

/**
 * floating-ui middleware that pushes a floating element below the title-bar
 * strip when, and only when, it would otherwise reach into it.
 *
 * Place it *after* `shift()` (it corrects what shift clamps) and *before*
 * `size()`, so a height constraint can subtract the push via
 * `middlewareData.windowControlsClearance.pushed`. That only works for
 * top-anchored placements: with a bottom-anchored one (`*-end`, `top`) y
 * depends on height, so subtracting the last push loops. Reserve a fixed band
 * instead, as the project rail's add menu does.
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
