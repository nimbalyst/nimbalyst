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
export declare function resolveWindowControlsZones(rect: TitlebarAreaRect | null, viewportWidth: number): WindowControlsZone[];
/**
 * Smallest y that keeps a floating element of `width`/`height` clear of every
 * control band it would otherwise intersect. Returns `y` unchanged when the
 * element does not overlap any band — popovers away from the window corners
 * must not move.
 */
export declare function clearWindowControls(x: number, y: number, width: number, zones: WindowControlsZone[]): number;
/** Control bands for the current window, empty when there is no custom title bar. */
export declare function getWindowControlsZones(): WindowControlsZone[];
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
export declare function windowControlsClearance(resolveZones?: () => WindowControlsZone[]): Middleware;
