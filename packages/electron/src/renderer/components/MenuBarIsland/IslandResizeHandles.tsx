import React, { useRef } from 'react';
import {
  ISLAND_CANVAS_PAD,
  ISLAND_FOOTER_ALLOWANCE,
  ISLAND_LIST_MAX_HEIGHT,
  ISLAND_LIST_MIN_HEIGHT,
  ISLAND_PANEL_MAX_WIDTH,
  ISLAND_PANEL_MIN_WIDTH,
  ISLAND_STRIP_HEIGHT,
  MENU_BAR_ISLAND_CHANNELS,
  type IslandAnchor,
  type IslandPanelSize,
} from '../../../shared/menuBarIsland';

/**
 * Grips on the open island panel that resize it.
 *
 * The panel hangs from the menu bar, so there is no top grip. A centred panel
 * grows from both sides at once, so a side drag counts double; a panel anchored
 * beside the notch grows leftward only, so it has no right-hand grips.
 *
 * The renderer sizes the panel live and tells main only at the start (so main
 * holds the panel open and enlarges the canvas) and the end (so main saves the
 * size and fits the canvas back around it). The live size is clamped to the
 * canvas as it is during the drag, which main has already grown to the largest
 * the display allows.
 */

type Edge = 'left' | 'right' | 'bottom' | 'bottom-left' | 'bottom-right';

interface DragStart {
  edge: Edge;
  pointerId: number;
  screenX: number;
  screenY: number;
  size: IslandPanelSize;
}

export function resizeIslandPanel(
  start: { edge: Edge; screenX: number; screenY: number; size: IslandPanelSize },
  pointer: { screenX: number; screenY: number },
  anchor: IslandAnchor,
  canvas: { width: number; height: number },
): IslandPanelSize {
  const dx = pointer.screenX - start.screenX;
  const dy = pointer.screenY - start.screenY;
  const centred = anchor === 'center';
  const sides = centred ? 2 : 1;

  let width = start.size.width;
  if (start.edge === 'left' || start.edge === 'bottom-left') width -= dx * sides;
  if (start.edge === 'right' || start.edge === 'bottom-right') width += dx * sides;

  let listHeight = start.size.listHeight;
  if (start.edge === 'bottom' || start.edge === 'bottom-left' || start.edge === 'bottom-right') listHeight += dy;

  const maxWidth = Math.min(ISLAND_PANEL_MAX_WIDTH, canvas.width - ISLAND_CANVAS_PAD * (centred ? 2 : 1));
  const maxList = Math.min(
    ISLAND_LIST_MAX_HEIGHT,
    canvas.height - ISLAND_STRIP_HEIGHT - ISLAND_FOOTER_ALLOWANCE - ISLAND_CANVAS_PAD,
  );
  return {
    width: Math.round(Math.max(ISLAND_PANEL_MIN_WIDTH, Math.min(width, maxWidth))),
    listHeight: Math.round(Math.max(ISLAND_LIST_MIN_HEIGHT, Math.min(listHeight, maxList))),
  };
}

const EDGE_TINT = 'hover:bg-white/25';

const HANDLES: Array<{ edge: Edge; className: string; centredOnly?: boolean }> = [
  { edge: 'left', className: `left-0 top-[30px] bottom-3 w-1.5 cursor-ew-resize ${EDGE_TINT}` },
  { edge: 'right', className: `right-0 top-[30px] bottom-3 w-1.5 cursor-ew-resize ${EDGE_TINT}`, centredOnly: true },
  { edge: 'bottom', className: `bottom-0 left-3 right-3 h-1.5 cursor-ns-resize ${EDGE_TINT}` },
  { edge: 'bottom-left', className: 'bottom-0 left-0 h-4 w-4 cursor-nesw-resize' },
  { edge: 'bottom-right', className: 'bottom-0 right-0 h-4 w-4 cursor-nwse-resize', centredOnly: true },
];

export function IslandResizeHandles({
  anchor,
  size,
  onLiveSize,
}: {
  anchor: IslandAnchor;
  size: IslandPanelSize;
  /** The size to draw right now, or null once the drag has ended. */
  onLiveSize: (size: IslandPanelSize | null, final: boolean) => void;
}) {
  const dragRef = useRef<DragStart | null>(null);
  const centred = anchor === 'center';
  // The visible grip sits in the corner that can actually grow.
  const gripEdge: Edge = centred ? 'bottom-right' : 'bottom-left';

  const sizeAt = (start: DragStart, event: React.PointerEvent) => resizeIslandPanel(
    start,
    { screenX: event.screenX, screenY: event.screenY },
    anchor,
    { width: window.innerWidth, height: window.innerHeight },
  );

  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const finalSize = sizeAt(start, event);
    onLiveSize(finalSize, true);
    // Always sent, even for a cancelled pointer: main holds the panel open and
    // the canvas enlarged until it hears this.
    window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.resizeEnd, finalSize);
  };

  return (
    <>
      {HANDLES.filter((handle) => centred || !handle.centredOnly).map(({ edge, className }) => (
        <div
          key={edge}
          aria-hidden="true"
          className={`menu-bar-island-resize-handle menu-bar-island-resize-handle--${edge} absolute z-10 ${className}`}
          data-testid={`menu-bar-island-resize-${edge}`}
          onPointerDown={(event) => {
            if (event.button > 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = {
              edge,
              pointerId: event.pointerId,
              screenX: event.screenX,
              screenY: event.screenY,
              size,
            };
            window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.resizeStart);
          }}
          onPointerMove={(event) => {
            const start = dragRef.current;
            if (!start || start.pointerId !== event.pointerId) return;
            onLiveSize(sizeAt(start, event), false);
          }}
          onPointerUp={end}
          onPointerCancel={end}
        >
          {edge === gripEdge && (
            <svg
              className={`pointer-events-none absolute bottom-1 text-nim-faint ${centred ? 'right-1' : 'left-1 -scale-x-100'}`}
              width="9"
              height="9"
              viewBox="0 0 9 9"
            >
              <path d="M8 1L1 8M8 4.5L4.5 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          )}
        </div>
      ))}
    </>
  );
}
