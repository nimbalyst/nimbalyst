/**
 * Tailwind arbitrary-property classes for the title-bar drag region.
 *
 * `-webkit-app-region` is not an inherited property, and Blink only subtracts
 * rectangles that declare `no-drag` explicitly. Anything interactive painted
 * over the drag strip must opt out itself or the OS window manager consumes the
 * click before the renderer sees it (NIM-2243, GitHub #1052).
 *
 * These live in a module under `src/renderer` because that is what the Electron
 * package's Tailwind `content` globs scan — a constant in `src/shared` would not
 * emit the utility.
 */
export const DRAG_REGION = '[-webkit-app-region:drag]';
export const NO_DRAG_REGION = '[-webkit-app-region:no-drag]';
