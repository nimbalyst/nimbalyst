/**
 * The roster and desk panel behave like a built-in mode's side panes: drag the
 * edge to resize, and hide them from the title bar, Toggle Sidebar, the
 * right-pane toggle, or by re-clicking the Crew gutter button. The host relays
 * those toggles; this owns and persists the state.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { PanelHost, PanelPaneSide } from '@nimbalyst/extension-sdk';
import {
  clampPaneWidth,
  DESK_PANEL_WIDTH,
  PANE_LAYOUT_KEY,
  readCrewPaneLayout,
  ROSTER_WIDTH,
  type CrewPaneLayout,
} from './crewPaneLayout';

export interface CrewPanesValue {
  layout: CrewPaneLayout;
  /** Sets a pane's width while dragging; persisted by `endResize`. */
  resize: (side: PanelPaneSide, width: number) => void;
  endResize: () => void;
  /** Pane widths as CSS custom properties, for the panel root. */
  style: CSSProperties;
}

export const CrewPanesContext = createContext<CrewPanesValue | null>(null);

function useCrewPanesContext(): CrewPanesValue {
  const value = useContext(CrewPanesContext);
  if (!value) throw new Error('useCrewPanes must be used inside CrewPanesContext');
  return value;
}

export function useCrewPanes(): CrewPaneLayout {
  return useCrewPanesContext().layout;
}

/**
 * Owns the pane state for the panel root, which provides it through
 * `CrewPanesContext`. The right pane only exists while a member's desk shows.
 */
export function useCrewPaneState(host: PanelHost, hasDeskPanel: boolean): CrewPanesValue {
  const [layout, setLayout] = useState(() => readCrewPaneLayout(host.storage.get(PANE_LAYOUT_KEY)));
  const dragging = useRef(false);
  const latest = useRef(layout);
  latest.current = layout;

  // Written on every change except mid-drag, so a drag is one write.
  useEffect(() => {
    if (!dragging.current) void host.storage.set(PANE_LAYOUT_KEY, layout);
  }, [host, layout]);

  const resize = useCallback((side: PanelPaneSide, width: number) => {
    dragging.current = true;
    setLayout((current) => side === 'left'
      ? { ...current, rosterWidth: clampPaneWidth(width, ROSTER_WIDTH) }
      : { ...current, deskPanelWidth: clampPaneWidth(width, DESK_PANEL_WIDTH) });
  }, []);

  const endResize = useCallback(() => {
    dragging.current = false;
    void host.storage.set(PANE_LAYOUT_KEY, latest.current);
  }, [host]);

  // Subscribe before declaring: the host drops the declaration with the last
  // subscriber, so on a host change the old subscription's cleanup runs first.
  useEffect(() => host.onPaneToggle?.((side) => {
    setLayout((current) => side === 'left'
      ? { ...current, rosterCollapsed: !current.rosterCollapsed }
      : { ...current, deskPanelCollapsed: !current.deskPanelCollapsed });
  }), [host]);

  useEffect(() => {
    host.setPanes?.({
      left: { label: 'Crew roster', collapsed: layout.rosterCollapsed },
      right: hasDeskPanel ? { label: 'Crew desk panel', collapsed: layout.deskPanelCollapsed } : undefined,
    });
  }, [host, hasDeskPanel, layout.rosterCollapsed, layout.deskPanelCollapsed]);

  return useMemo(() => ({
    layout,
    resize,
    endResize,
    style: {
      '--crew-roster-width': `${layout.rosterWidth}px`,
      '--crew-desk-panel-width': `${layout.deskPanelWidth}px`,
    } as CSSProperties,
  }), [layout, resize, endResize]);
}

/** Drag handle on the inner edge of a side pane. */
export function CrewPaneResizer({ side }: { side: PanelPaneSide }) {
  const { layout, resize, endResize } = useCrewPanesContext();
  const bounds = side === 'left' ? ROSTER_WIDTH : DESK_PANEL_WIDTH;
  const width = side === 'left' ? layout.rosterWidth : layout.deskPanelWidth;
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [active, setActive] = useState(false);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // Capture keeps the drag on this handle over the transcript and off-panel.
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
    setActive(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = event.clientX - drag.current.startX;
    resize(side, drag.current.startWidth + (side === 'left' ? delta : -delta));
  };
  const onEnd = () => {
    if (!drag.current) return;
    drag.current = null;
    setActive(false);
    endResize();
  };

  return (
    <div
      className="crew-pane-resizer"
      data-side={side}
      data-dragging={active}
      data-testid={`crew-pane-resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? 'Resize crew roster' : 'Resize desk panel'}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onEnd}
      onPointerCancel={onEnd}
      onLostPointerCapture={onEnd}
    />
  );
}
