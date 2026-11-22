/**
 * Pure geometry and hover logic for the menu bar island.
 *
 * Kept out of `MenuBarIslandWindow` so the fiddly part -- deciding when the
 * island is hovered -- is testable without Electron, a display, or a cursor.
 *
 * Hover is decided by polling the cursor in main rather than by `mouseleave` in
 * the renderer. Entry via forwarded `mousemove` is reliable; exit is not,
 * because the window stops receiving events the moment the cursor leaves it. A
 * poll answers both with one implementation. Proven on a real machine in
 * `nimbalyst-local/spikes/menu-bar-island/`.
 */

import {
  DEFAULT_ISLAND_PANEL_SIZE,
  ISLAND_CANVAS_PAD,
  ISLAND_FOOTER_ALLOWANCE,
  ISLAND_LIST_MAX_HEIGHT,
  ISLAND_PANEL_MAX_WIDTH,
  ISLAND_STRIP_HEIGHT,
  type IslandAnchor,
  type IslandPanelSize,
  type IslandDisplayPreference,
  type IslandRect,
} from '../../shared/menuBarIsland';

/**
 * Window size.
 *
 * Fixed, and large enough for the widest expanded panel: the island is a `div`
 * inside it that animates with CSS. Resizing the *window* to expand jitters and
 * cannot be transitioned, which is the whole reason for the oversized canvas.
 * The window is click-through everywhere the island is not.
 */
export const ISLAND_WINDOW_WIDTH = 760;
export const ISLAND_WINDOW_HEIGHT = 460;

/**
 * Window size for a given panel size.
 *
 * Never smaller than the original fixed canvas, and grown when the user has
 * dragged the panel larger than that canvas holds. While a resize is in
 * progress the canvas is the largest the panel can become, capped at the
 * display's height, so the panel has room to grow under the cursor; it shrinks
 * back to fit when the drag ends, because the open panel captures every click
 * on the canvas and a needlessly large one blocks the screen beneath it.
 */
export function islandCanvasSize(
  panel: IslandPanelSize,
  displayHeight: number,
  resizing = false,
): { width: number; height: number } {
  const panelWidth = resizing ? ISLAND_PANEL_MAX_WIDTH : panel.width;
  const listHeight = resizing ? ISLAND_LIST_MAX_HEIGHT : panel.listHeight;
  const width = Math.max(ISLAND_WINDOW_WIDTH, panelWidth + ISLAND_CANVAS_PAD * 2);
  const wanted = Math.max(
    ISLAND_WINDOW_HEIGHT,
    ISLAND_STRIP_HEIGHT + listHeight + ISLAND_FOOTER_ALLOWANCE + ISLAND_CANVAS_PAD,
  );
  const height = Math.max(ISLAND_WINDOW_HEIGHT, Math.min(wanted, displayHeight));
  return { width, height };
}

/** Don't collapse the instant the cursor clips an edge mid-transition. */
export const ISLAND_EXIT_GRACE_MS = 260;

/**
 * Aspect ratio below which an *internal* display is called notched.
 *
 * Electron exposes no notch API -- there is no binding for `NSScreen`'s
 * `safeAreaInsets` or `auxiliaryTopLeftArea` -- so the camera housing has to be
 * inferred from the geometry we do get.
 *
 * Menu bar height, the obvious signal, does not work. It reads 30pt on a
 * notched MacBook Pro built-in panel and *also* 30pt on a Studio Display next
 * to it: current macOS grew the ordinary bar to meet the housing rather than
 * growing the bar only where there is one. A height threshold therefore either
 * misses every notched display or claims every unnotched one.
 *
 * Aspect ratio separates them cleanly, because the notch is a strip of panel
 * *added above* an otherwise 16:10 screen. Every Mac without a housing is
 * exactly 16:10 (1.600); every Mac with one is shorter and wider-looking in
 * reverse -- 14" 3024x1964 is 1.540, 16" 3456x2234 is 1.547, 13" Air 2560x1664
 * is 1.538, 15" Air 2880x1864 is 1.545. The gap between 1.547 and 1.600 is
 * wide, and it survives scaling: macOS's scaled modes preserve the panel's
 * ratio, so this reads the same in every resolution the user can pick.
 */
export const NOTCH_MAX_ASPECT_RATIO = 1.57;

/**
 * Notch width as a fraction of the display's logical width.
 *
 * A fraction rather than a point count because the notch scales with the
 * display mode: the same housing is ~175pt wide at a 14" panel's default
 * scaling and ~200pt at a 16"'s, and both land near this ratio. A hardcoded
 * width would be wrong on every setting except the one it was measured at.
 *
 * Deliberately generous. Overshooting shifts the island a few points further
 * from the notch; undershooting tucks its edge underneath.
 */
export const NOTCH_WIDTH_RATIO = 0.13;

/** Breathing room between the island's right edge and the notch. */
export const NOTCH_CLEARANCE = 10;

/**
 * How far the cursor may travel before a press stops being a click.
 *
 * The pill is both the drag handle and the pin toggle, so one gesture has to
 * resolve into two meanings. Generous rather than tight: a press that wobbles
 * by a couple of points is a click that the user's hand failed to hold still,
 * and reading it as a drag would move the island for no reason.
 */
export const DRAG_SLOP = 6;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IslandPlacement extends Rect {
  anchor: IslandAnchor;
}

/**
 * The parts of an Electron `Display` the placement needs.
 *
 * Narrowed to a structural type so the geometry stays testable without a real
 * display, which is the whole reason this module is separate from the window.
 */
export interface DisplayInfo {
  bounds: Rect;
  workArea: Rect;
  /** `false` for every external monitor. */
  internal: boolean;
}

/** A display we can both place the island on and recognise again later. */
export interface IdentifiedDisplay extends DisplayInfo {
  id: number;
  label: string;
}

/**
 * Pick the display to draw on, honouring a saved choice when it still exists.
 *
 * The fallback is the point of this function. A preference outlives the monitor
 * it names -- the user parks the island on an external display, goes to a
 * meeting, and opens the laptop somewhere else -- and an island placed on a
 * disconnected screen is not merely misplaced, it is invisible, which is the
 * one failure this whole surface cannot signal.
 */
export function resolveIslandDisplay<T extends IdentifiedDisplay>(
  displays: T[],
  primary: T,
  preference: IslandDisplayPreference | null,
): T {
  if (!preference) return primary;
  return displays.find((display) => display.id === preference.id)
    ?? displays.find((display) => !!display.label && display.label === preference.label)
    ?? primary;
}

/** Did this press travel far enough to mean "move me" rather than "toggle me"? */
export function isDragGesture(
  start: { x: number; y: number },
  end: { x: number; y: number },
  slop: number = DRAG_SLOP,
): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) > slop;
}

/**
 * Does this display have a camera housing interrupting its menu bar?
 *
 * `internal` is a fact rather than a guess: the notch is a property of a
 * built-in Apple panel, so no external monitor has one whatever its shape.
 * That clause alone keeps an ultrawide -- which is nowhere near 16:10 either --
 * from being read as a notched laptop.
 *
 * The ratio then separates a notched built-in from an unnotched one (an Air, a
 * pre-2021 Pro), which are exactly 16:10. See `NOTCH_MAX_ASPECT_RATIO` for why
 * this is shape rather than the menu bar height it replaced.
 */
export function isNotchedDisplay(display: DisplayInfo): boolean {
  if (!display.internal || display.bounds.height <= 0) return false;
  return display.bounds.width / display.bounds.height < NOTCH_MAX_ASPECT_RATIO;
}

/**
 * Place the island window on the top edge of a display.
 *
 * `y` is the display's own top, *inside* the menu bar. That only survives if the
 * window is created with `enableLargerThanScreen: true`: without it AppKit's
 * `constrainFrameRect:` snaps `y` down to the bottom of the menu bar the moment
 * the window becomes visible, and no window level overrides it.
 *
 * `x` is the centre of the display, *except* on a notched one. There the centre
 * is the camera housing, and since the island draws inside the menu bar row the
 * collapsed strip would be entirely behind it -- which is how this presented:
 * the island was running and painting, and simply could not be seen. In that
 * case the window is shifted left so its right edge clears the notch, and the
 * returned `anchor` tells the renderer to draw against that edge and expand
 * leftward. The window may then start left of the display; the overhang is
 * transparent click-through canvas, and `enableLargerThanScreen` is what lets
 * the frame keep the negative origin.
 */
export function islandPlacement(
  display: DisplayInfo,
  panel: IslandPanelSize = DEFAULT_ISLAND_PANEL_SIZE,
  resizing = false,
): IslandPlacement {
  const displayBounds = display.bounds;
  const y = displayBounds.y;
  const canvas = islandCanvasSize(panel, displayBounds.height, resizing);

  if (!isNotchedDisplay(display)) {
    return {
      x: Math.round(displayBounds.x + displayBounds.width / 2 - canvas.width / 2),
      y,
      width: canvas.width,
      height: canvas.height,
      anchor: 'center',
    };
  }

  const notchWidth = displayBounds.width * NOTCH_WIDTH_RATIO;
  const notchLeft = displayBounds.x + (displayBounds.width - notchWidth) / 2;
  // Clamped against the *expanded* width, not the collapsed strip: the panel is
  // the wider of the two and is what would run off the left edge on a narrow
  // display. On a very narrow one the clamp wins and the island ends up nearer
  // the notch than the clearance asks for, which is still visible.
  //
  // Uses the saved width even mid-resize, not the enlarged canvas width, so the
  // island does not jump sideways when a drag starts.
  const islandRight = Math.max(
    displayBounds.x + panel.width,
    notchLeft - NOTCH_CLEARANCE,
  );

  return {
    x: Math.round(islandRight - canvas.width),
    y,
    width: canvas.width,
    height: canvas.height,
    anchor: 'notch-left',
  };
}

/** Is the cursor over the island itself, as opposed to the transparent canvas? */
export function isCursorOverIsland(
  cursor: { x: number; y: number },
  windowBounds: Rect,
  island: IslandRect,
): boolean {
  if (island.width <= 0 || island.height <= 0) return false;
  const x = cursor.x - windowBounds.x;
  const y = cursor.y - windowBounds.y;
  return x >= island.left
    && x <= island.left + island.width
    && y >= island.top
    && y <= island.top + island.height;
}

export interface HoverState {
  hovered: boolean;
  /** When the cursor first went outside, or 0 while it is inside. */
  outsideSince: number;
}

/**
 * Advance the hover state for one poll tick.
 *
 * Opening is immediate; closing waits out `graceMs`. Pinning holds it open
 * regardless of the cursor, which is what the click-the-pill affordance sets.
 */
export function nextHoverState(
  previous: HoverState,
  input: { inside: boolean; pinned: boolean; now: number; graceMs?: number },
): HoverState {
  const graceMs = input.graceMs ?? ISLAND_EXIT_GRACE_MS;

  if (input.inside) return { hovered: true, outsideSince: 0 };
  if (input.pinned) return { hovered: true, outsideSince: 0 };
  if (!previous.hovered) return { hovered: false, outsideSince: 0 };

  const outsideSince = previous.outsideSince || input.now;
  if (input.now - outsideSince >= graceMs) return { hovered: false, outsideSince: 0 };
  return { hovered: true, outsideSince };
}
