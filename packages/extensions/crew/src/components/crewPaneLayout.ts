/**
 * Widths and collapsed state of the Crew panel's two side panes: the roster
 * on the left and the desk panel (Inbox, Schedule, Delegated, Notes) on the
 * right. Persisted in extension storage, so a stored value may be missing
 * fields or come from an older build.
 */

export interface CrewPaneLayout {
  rosterWidth: number;
  rosterCollapsed: boolean;
  deskPanelWidth: number;
  deskPanelCollapsed: boolean;
}

export interface PaneWidthBounds {
  min: number;
  max: number;
  initial: number;
}

export const ROSTER_WIDTH: PaneWidthBounds = { min: 180, max: 420, initial: 248 };
export const DESK_PANEL_WIDTH: PaneWidthBounds = { min: 220, max: 560, initial: 280 };

export const PANE_LAYOUT_KEY = 'paneLayout';

export function clampPaneWidth(width: number, bounds: PaneWidthBounds): number {
  if (!Number.isFinite(width)) return bounds.initial;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

export function readCrewPaneLayout(stored: unknown): CrewPaneLayout {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<Record<keyof CrewPaneLayout, unknown>>;
  return {
    rosterWidth: clampPaneWidth(typeof s.rosterWidth === 'number' ? s.rosterWidth : ROSTER_WIDTH.initial, ROSTER_WIDTH),
    rosterCollapsed: s.rosterCollapsed === true,
    deskPanelWidth: clampPaneWidth(typeof s.deskPanelWidth === 'number' ? s.deskPanelWidth : DESK_PANEL_WIDTH.initial, DESK_PANEL_WIDTH),
    deskPanelCollapsed: s.deskPanelCollapsed === true,
  };
}
