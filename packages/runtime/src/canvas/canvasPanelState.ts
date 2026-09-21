/**
 * Per-user, per-board chrome preferences for the canvas.
 *
 * These are *view* preferences, not board content: whether this reader wants a
 * minimap, whether their pointer snaps to the grid, whether alignment guides
 * appear, and which pointer tool they left armed. None of it belongs in the
 * document -- a teammate turning the minimap off must not turn it off for
 * everyone, exactly as with the saved viewport.
 *
 * They ride the same seam the viewport already uses: `host.storage` in
 * CanvasEditor, keyed by board. The surface never touches storage itself, so
 * this module stays host-agnostic and the web console gets the same behaviour
 * the moment its adapter implements `storage` (complication 8 in the plan).
 *
 * Everything here is defensive on read. A board stored before a preference
 * existed -- or a hand-edited value -- comes back missing fields or carrying the
 * wrong type, and the answer is always the default rather than `undefined`
 * leaking into a React Flow prop.
 */
import { useCallback, useRef, useState } from 'react';

import type { CanvasTool } from './canvasCommands';

/**
 * Which pointer gesture the board is armed for.
 *
 * A narrowing of the registry's `CanvasTool` rather than a parallel type, so
 * the two can never drift -- but deliberately only the two members that are a
 * *mode*. The registry's other tools (`sticky`, `text`, `frame`, `edge`,
 * `pin`) are one-shot actions in this slice's rail: they create a card and
 * leave the pointer alone, so persisting one as "the armed tool" would restore
 * a board into a state `panOnDrag` cannot express. Phase 2 can widen this the
 * day an armed creation mode exists.
 */
export type CanvasPointerTool = Extract<CanvasTool, 'select' | 'hand'>;

export interface CanvasPanelState {
  /** Draw the minimap. On by default, as the board has always behaved. */
  minimap: boolean;
  /** Snap card geometry to the 20px grid while dragging and placing. */
  gridSnap: boolean;
  /** Magnetic alignment and spacing guides during a single-card drag. */
  smartGuides: boolean;
  tool: CanvasPointerTool;
}

export const CANVAS_PANEL_DEFAULTS: Readonly<CanvasPanelState> = Object.freeze({
  minimap: true,
  gridSnap: true,
  smartGuides: true,
  tool: 'select',
});

/** Storage key for one board's chrome preferences. Mirrors `canvas.viewport:`. */
export function canvasPanelStateKey(filePath: string): string {
  return `canvas.panel:${filePath}`;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Merge whatever the host had stored with the current defaults.
 *
 * Accepts anything: `undefined` from a host with no storage, a partial object
 * written by an older build, a string somebody put there by hand.
 */
export function canvasPanelStateFrom(stored: unknown): CanvasPanelState {
  if (typeof stored !== 'object' || stored === null) {
    return { ...CANVAS_PANEL_DEFAULTS };
  }
  const candidate = stored as Record<string, unknown>;
  return {
    minimap: booleanOr(candidate.minimap, CANVAS_PANEL_DEFAULTS.minimap),
    gridSnap: booleanOr(candidate.gridSnap, CANVAS_PANEL_DEFAULTS.gridSnap),
    smartGuides: booleanOr(
      candidate.smartGuides,
      CANVAS_PANEL_DEFAULTS.smartGuides
    ),
    tool:
      candidate.tool === 'hand' || candidate.tool === 'select'
        ? candidate.tool
        : CANVAS_PANEL_DEFAULTS.tool,
  };
}

/** The preferences that are plain on/off switches, for a generic toggle. */
export type CanvasPanelToggle = 'minimap' | 'gridSnap' | 'smartGuides';

export interface CanvasPanelStateModel {
  state: CanvasPanelState;
  /** Flip one switch. */
  toggle(pref: CanvasPanelToggle): void;
  setTool(tool: CanvasPointerTool): void;
}

/**
 * Hold the preferences for one board and report every change outward.
 *
 * `initial` is read once, at mount, for the same reason the viewport is: a host
 * without storage answers `undefined` forever, and a surface that re-reads on
 * render would put an IPC-shaped call in the middle of a drag.
 */
export function useCanvasPanelState(
  initial: unknown,
  onChange?: (next: CanvasPanelState) => void
): CanvasPanelStateModel {
  const [state, setState] = useState<CanvasPanelState>(() =>
    canvasPanelStateFrom(initial)
  );

  // The callback identity changes on every host render; reading it through a
  // ref keeps `toggle` and `setTool` stable, so the rail and the zoom widget do
  // not re-render because a parent did.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const apply = useCallback((patch: Partial<CanvasPanelState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      if (
        next.minimap === current.minimap &&
        next.gridSnap === current.gridSnap &&
        next.smartGuides === current.smartGuides &&
        next.tool === current.tool
      ) {
        return current;
      }
      onChangeRef.current?.(next);
      return next;
    });
  }, []);

  const toggle = useCallback(
    (pref: CanvasPanelToggle) =>
      setState((current) => {
        const next = { ...current, [pref]: !current[pref] };
        onChangeRef.current?.(next);
        return next;
      }),
    []
  );

  const setTool = useCallback(
    (tool: CanvasPointerTool) => apply({ tool }),
    [apply]
  );

  return { state, toggle, setTool };
}
