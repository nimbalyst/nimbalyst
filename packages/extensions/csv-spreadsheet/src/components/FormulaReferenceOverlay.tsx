/**
 * FormulaReferenceOverlay
 *
 * The grid-side half of formula editing, mounted once inside the grid
 * container:
 *
 * - Runs point mode (`useFormulaPointMode`): click or drag cells to insert
 *   references while a formula is being edited, in either surface.
 * - Outlines every reference in the formula being edited, in the color the
 *   formula bar tints it (`referenceHighlights` assigns both).
 * - Shows autocomplete and signature help for the in-cell editor (the formula
 *   bar mounts its own).
 * - Explains an error value when the pointer rests on an error cell.
 *
 * Outlines are measured off RevoGrid's rendered cells the way
 * `CollabPresenceOverlay` does, so scroll, frozen panes, filters and
 * virtualization need no coordinate math of our own: a range's outline is the
 * union of its rendered cells, each clipped to its own viewport section. The
 * layer is `pointer-events: none`.
 */

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { EditorCore } from '../editor/editorCore';
import { logicalCellOfElement, useFormulaPointMode } from '../editor/useFormulaPointMode';
import { useFormulaAssist } from '../formula/editSurface';
import { referenceOutlines, type ReferenceOutline } from '../formula/pointMode';
import { FormulaAssistPopover } from './FormulaAssistPopover';
import { FormulaErrorHoverCard } from './FormulaErrorHoverCard';

interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

interface PositionedOutline {
  color: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

function contains(outline: ReferenceOutline, cell: { row: number; col: number }): boolean {
  const inRows = outline.startRow === null || (cell.row >= outline.startRow && cell.row <= (outline.endRow ?? cell.row));
  const inCols = outline.startCol === null || (cell.col >= outline.startCol && cell.col <= (outline.endCol ?? cell.col));
  return inRows && inCols;
}

function measureOutlines(container: HTMLElement, outlines: ReferenceOutline[], core: EditorCore): PositionedOutline[] {
  const unions: Array<Rect | null> = outlines.map(() => null);
  const clipCache = new Map<Element, DOMRect>();
  const cells = container.querySelectorAll('revogr-data:not([col-type="rowHeaders"]) [data-rgrow][data-rgcol]');
  for (const cell of cells) {
    const position = logicalCellOfElement(cell, core);
    if (!position) continue;
    let rect: Rect | null = null;
    outlines.forEach((outline, index) => {
      if (!contains(outline, position)) return;
      if (!rect) {
        const cellRect = cell.getBoundingClientRect();
        // Clip to the cell's own section, so a cell scrolled under a pinned
        // header or frozen column does not draw over it.
        const scroller = cell.closest('revogr-viewport-scroll') ?? container;
        let clip = clipCache.get(scroller);
        if (!clip) {
          clip = scroller.getBoundingClientRect();
          clipCache.set(scroller, clip);
        }
        rect = {
          top: Math.max(cellRect.top, clip.top),
          left: Math.max(cellRect.left, clip.left),
          right: Math.min(cellRect.right, clip.right),
          bottom: Math.min(cellRect.bottom, clip.bottom),
        };
        if (rect.right <= rect.left || rect.bottom <= rect.top) rect = null;
      }
      if (!rect) return;
      const union = unions[index];
      unions[index] = union
        ? {
          top: Math.min(union.top, rect.top),
          left: Math.min(union.left, rect.left),
          right: Math.max(union.right, rect.right),
          bottom: Math.max(union.bottom, rect.bottom),
        }
        : rect;
    });
  }
  const origin = container.getBoundingClientRect();
  const positioned: PositionedOutline[] = [];
  unions.forEach((union, index) => {
    if (!union) return;
    positioned.push({
      color: outlines[index].color,
      top: union.top - origin.top,
      left: union.left - origin.left,
      width: union.right - union.left,
      height: union.bottom - union.top,
    });
  });
  return positioned;
}

/** Re-measure on any scroll inside the grid and on resize, once per frame. */
function useRepaintTick(container: HTMLElement | null, active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!container || !active) return;
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setTick((value) => value + 1);
      });
    };
    container.addEventListener('scroll', schedule, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(container);
    return () => {
      container.removeEventListener('scroll', schedule, true);
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [container, active]);
  return tick;
}

export interface FormulaReferenceOverlayProps {
  core: EditorCore;
  /** The grid is rendered and the tab is active. */
  enabled: boolean;
}

export function FormulaReferenceOverlay({ core, enabled }: FormulaReferenceOverlayProps): React.JSX.Element {
  const { surface, snapshot } = useFormulaPointMode(core, enabled);
  const outlines = useMemo(() => (snapshot ? referenceOutlines(snapshot.text) : []), [snapshot?.text]);
  const container = core.gridContainerRef.current;
  const tick = useRepaintTick(container, outlines.length > 0);
  const [positioned, setPositioned] = useState<PositionedOutline[]>([]);

  useLayoutEffect(() => {
    setPositioned(container && outlines.length > 0 ? measureOutlines(container, outlines, core) : []);
  }, [container, outlines, core, tick]);

  const cellEditor = surface instanceof HTMLTextAreaElement ? surface : null;
  const assist = useFormulaAssist(cellEditor, cellEditor ? snapshot : null, core.getNamedRanges);

  return (
    <>
      {positioned.length > 0 && (
        <div className="csv-formula-reference-overlay absolute inset-0 overflow-hidden pointer-events-none z-[6]" aria-hidden="true">
          {positioned.map((outline, index) => (
            <div
              key={index}
              className="csv-formula-reference-outline absolute box-border rounded-[1px]"
              style={{
                top: outline.top,
                left: outline.left,
                width: outline.width,
                height: outline.height,
                border: `2px dashed ${outline.color}`,
                backgroundColor: `color-mix(in srgb, ${outline.color} 8%, transparent)`,
              }}
            />
          ))}
        </div>
      )}
      <FormulaAssistPopover
        anchor={cellEditor}
        // The editor root, not the textarea: its capture listener has to run
        // ahead of the grid key controller's, which sits on the grid container.
        keyTarget={core.editorRef.current}
        autocomplete={assist.autocomplete}
        signatureHelp={assist.signatureHelp}
        onAccept={assist.accept}
        onDismiss={assist.dismiss}
      />
      <FormulaErrorHoverCard core={core} enabled={enabled} />
    </>
  );
}
