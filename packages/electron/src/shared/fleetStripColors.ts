/**
 * The one palette the menu bar fleet strip is painted from.
 *
 * Two surfaces render that strip -- the bitmap tray image (`main/tray/
 * stripMarkup.ts`) and the island renderer (`MenuBarIsland/MenuBarIslandApp
 * .tsx`) -- and only one of the two can ever be on screen, so a divergence
 * between them is invisible until someone switches `FleetStatusStyle`. They both
 * import from here rather than each keeping a copy.
 *
 * These are literal hex values, not `--nim-*` vars, because the bitmap strip is
 * built in an offscreen window that never loads the app's theme sheet, and the
 * menu bar has no theme of its own to follow. They are the brighter tints of the
 * panel's semantic colours, tuned to stay legible against a translucent menu bar
 * over a dark wallpaper.
 *
 * The strip and the panel below it are visible at the same time, so the two must
 * agree on what a colour *means*: green is a running session, blue is a finished
 * one you have not read. The panel spells the same pairing as `--nim-success`
 * and `--nim-primary` in `TrayPanel/traySessionSections.tsx`.
 */

/** Mirrors `PriorityState` in `main/tray/fleetSnapshot.ts`. */
export type FleetStripState =
  | 'approval'
  | 'decision'
  | 'failed'
  | 'running'
  | 'completed'
  | 'stalled';

export const FLEET_STRIP_COLORS: Record<FleetStripState, string> = {
  approval: '#fbbf24',
  decision: '#f0abfc',
  failed: '#ef4444',
  running: '#4ade80',
  /** Finished and unread -- the state the panel's blue Unread section holds. */
  completed: '#60a5fa',
  // Running, drained. Deliberately a neutral rather than a sixth hue: the strip
  // already spends amber on both approvals and the hot age, and a stalled
  // session is not a new kind of emergency -- it is a running one that stopped
  // talking. The panel says the same thing with `--nim-text-faint`.
  stalled: '#94a3b8',
};
