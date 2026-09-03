/**
 * Wire contract between TrayManager (main) and the menu bar island renderer.
 *
 * The island is the second render style for the same `StripView` the tray
 * bitmap strip draws -- see `trayStripStyle` in the app store. It is its own
 * renderer (`?mode=menu-bar-island`) with an empty Jotai store, so like the tray
 * panel it takes its whole dataset from the main process.
 *
 * It carries the tray panel's `TrayPanelFeed` verbatim rather than a shape of
 * its own, so the expanded rows are the same rows the popover renders.
 */

import type { TrayIdleSummary, TrayPanelFeed } from './traySessions';

/**
 * Width of the expanded panel.
 *
 * Lives here rather than only in the renderer's Tailwind class because main
 * needs it too: on a notched display the island is right-anchored just left of
 * the notch, and the placement has to know how far left the *open* panel will
 * reach to keep it on screen.
 */
export const ISLAND_EXPANDED_WIDTH = 420;

/**
 * Which edge of the island window the island itself is pinned to.
 *
 * `center` is the ordinary menu bar. `notch-left` is a display with a camera
 * housing: the island is placed against the right edge of its window, which
 * main has positioned so that edge lands just left of the notch, and it grows
 * leftward as it expands. Centering there would draw the collapsed strip -- the
 * only thing normally on screen -- entirely behind the notch.
 */
export type IslandAnchor = 'center' | 'notch-left';

/**
 * Which display the user dragged the island onto.
 *
 * Both fields are recorded because neither is dependable alone. Electron's
 * `id` is unique but not durable -- unplugging a monitor and plugging it back
 * in can renumber it -- while `label` survives that but is not guaranteed
 * unique, and two identical monitors will share one. Matching id first and
 * falling back to label gets the common cases right without ever hard-failing:
 * see `resolveIslandDisplay`, which drops back to the primary display rather
 * than leaving the island on a screen that is gone.
 */
export interface IslandDisplayPreference {
  id: number;
  label: string;
}

/**
 * Which surface draws the fleet status.
 *
 * `island` is this window; `image` is the bitmap the tray item draws. They are
 * mutually exclusive, and in island mode there is no tray item at all -- which
 * is why the settings below have to be reachable from inside the panel.
 */
export type FleetStatusStyle = 'image' | 'island';

export type PreventSleepMode = 'off' | 'always' | 'pluggedIn';

/**
 * The settings the island's own gear panel controls.
 *
 * This is the whole of it, not a slice of app settings: in island mode the tray
 * item is gone, so this panel is the only place these can be reached without
 * opening a project window. Everything else still lives in app Settings.
 */
export interface MenuBarIslandSettings {
  style: FleetStatusStyle;
  /** Off falls the menu bar back to the plain tray icon. */
  showFleetStatus: boolean;
  osNotifications: boolean;
  /** Null when sync is not configured -- the tray menu omits it in that case too. */
  preventSleep: PreventSleepMode | null;
}

export type MenuBarIslandSettingChange =
  | { key: 'style'; value: FleetStatusStyle }
  | { key: 'showFleetStatus'; value: boolean }
  | { key: 'osNotifications'; value: boolean }
  | { key: 'preventSleep'; value: PreventSleepMode };

/** Everything the island needs to paint one frame. */
export interface MenuBarIslandState {
  /**
   * The strip line, as a plain wire shape.
   *
   * `StripView` itself lives in the main-process tray module; duplicating the
   * two variants here keeps the renderer from importing main-process code.
   */
  strip:
    | {
        mode: 'counts';
        needsApproval: number;
        needsDecision: number;
        running: number;
        failed: number;
        stalled: number;
        unread: number;
        age: { label: string; hot: boolean } | null;
      }
    | {
        mode: 'named';
        sessionId: string;
        /** Carried because the title is clickable: opening a session needs both. */
        workspacePath: string;
        title: string;
        state: 'approval' | 'decision' | 'failed' | 'running' | 'completed' | 'stalled';
        age: { label: string; hot: boolean };
      };
  /** The same buckets the tray panel renders. */
  feed: TrayPanelFeed;
  /**
   * Present only when every bucket is empty, and consumed only by the panel.
   *
   * The island collapses to a bare glyph in this state rather than vanishing,
   * because in island mode it is the only thing in the menu bar -- so this is
   * what opening the quiet pill shows.
   */
  idle?: TrayIdleSummary;
  /** What the gear panel renders. Pushed with every frame so it cannot go stale. */
  settings: MenuBarIslandSettings;
  /**
   * sessionId -> one line of what that session last said.
   *
   * Only populated while the island is expanded: the resting strip has no use
   * for it and it costs a database read. Absent for a session that has not said
   * anything yet, which the row renders by simply omitting the line.
   */
  snippets: Record<string, string>;
  /** Main owns the hit test (see islandGeometry), so it owns the open state too. */
  expanded: boolean;
  /**
   * Where inside the window to draw the island.
   *
   * Derived from the display, so main attaches it on the way out rather than
   * TrayManager carrying it -- the fleet has no opinion about the notch.
   */
  anchor: IslandAnchor;
}

export const MENU_BAR_ISLAND_CHANNELS = {
  /** main → island: a full frame. */
  state: 'menu-bar-island:state',
  /**
   * island → main (invoke): the glyph and the current frame, on mount.
   *
   * Pulled rather than pushed. Main finishes loading the window and would
   * naturally send on `did-finish-load`, but React has not mounted by then and
   * the renderer's IPC listener does not exist yet, so a one-shot push is
   * dropped on the floor. The state self-heals on the next repaint; the glyph
   * never changes, so it would simply never arrive -- which is exactly how it
   * failed. Same fix the tray panel uses for its initial feed.
   */
  requestInit: 'menu-bar-island:request-init',
  /** island → main: the island's laid-out rect, for the cursor hit test. */
  rect: 'menu-bar-island:rect',
  /** island → main: open this session's workspace window and navigate to it. */
  selectSession: 'menu-bar-island:select-session',
  /**
   * island → main: a press started on the pill.
   *
   * The pill is both the drag handle and the pin toggle, so the renderer does
   * not decide which happened -- it reports the press and the release, and main
   * measures how far the cursor travelled in between. Main also samples the
   * cursor itself rather than trusting `screenX`/`screenY`: those are CSS
   * pixels, and dragging between displays of different scale factors is exactly
   * where that conversion goes wrong.
   */
  dragStart: 'menu-bar-island:drag-start',
  /** island → main: the pointer moved during a press. Main re-samples the cursor. */
  dragMove: 'menu-bar-island:drag-move',
  /** island → main: the press ended. Main decides: a move, or a pin toggle. */
  dragEnd: 'menu-bar-island:drag-end',
  /**
   * island → main: close the panel.
   *
   * Sent for Escape, and for a click that lands inside the island's window but
   * outside the island itself. That second case is not hypothetical: the window
   * is a large transparent canvas, and while the panel is open the whole canvas
   * captures the mouse, so a click just beside the panel is delivered here
   * rather than to the app underneath.
   */
  dismiss: 'menu-bar-island:dismiss',
  /**
   * island → main: hold the panel open, or let go of it.
   *
   * Distinct from the pill's press/release, which *toggles* the pin. Opening the
   * gear panel has to assert it: a settings form that collapses because the
   * cursor drifted off the island for a quarter of a second is unusable.
   */
  setPinned: 'menu-bar-island:set-pinned',
  /** island → main: one settings change, applied and echoed back on the next frame. */
  setSetting: 'menu-bar-island:set-setting',
  /** island → main: the footer's two app actions, same as the tray panel's. */
  newSession: 'menu-bar-island:new-session',
  openApp: 'menu-bar-island:open-app',
  /**
   * island → main: mark every unread session read.
   *
   * Same action as the tray panel's channel of the same name, on its own channel
   * because each window only accepts IPC from its own renderer.
   */
  clearAllUnread: 'menu-bar-island:clear-all-unread',
} as const;

/** Island rect in window coordinates, as the renderer measured it. */
export interface IslandRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
