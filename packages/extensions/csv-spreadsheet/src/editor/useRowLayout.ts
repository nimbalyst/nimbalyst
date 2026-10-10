/**
 * Row layout: per-row heights (explicit or fitted to wrapped text) applied as
 * RevoGrid `rowDefinitions`, the row header (true row numbers, hidden-row
 * markers), dragging a row header's bottom edge to resize, and double-click
 * auto-fit on a row edge or a column's resize handle.
 *
 * Heights are kept in logical rows and re-mapped to visible indexes whenever
 * the row space is rebuilt, so filters and hidden rows never shift a height
 * onto the wrong row. Overlays that measure cell rects from the DOM
 * (presence, point mode) keep working because RevoGrid lays the rows out.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ColumnRegular } from '@revolist/react-datagrid';
import type { RevoGridElement } from '../revogrid-types';
import type { SpreadsheetMetadata } from '../hooks/useSpreadsheetMetadata';
import { parseRangeKey } from '../cells/cellStyles';
import { columnIndexToLetter } from '../utils/csvParser';
import { cellDisplayText } from '../utils/formatters';
import { readHeaderColumnTarget, resolveHeaderColumnIndex } from '../selection/crossSectionSelection';
import { setColumnWidths, setRowHeights } from '../format/formatActions';
import { MIN_ROW_HEIGHT } from '../sheetMeta/formatting';
import {
  autoFitWidth, createTextMeasurer, DEFAULT_ROW_HEIGHT, rowDefinitionsFor, rowHeightsFor,
} from '../layout/rowSizing';
import { DEFAULT_COLUMN_WIDTH } from './gridColumns';
import type { EditorCore } from './editorCore';
import type { RowView } from './useRowView';
import type { SheetPaint } from './useSheetPaint';

const EDGE_PX = 4;
type RowModel = Record<string, unknown>;

export function useRowLayout(
  core: EditorCore,
  metadata: SpreadsheetMetadata,
  paint: SheetPaint,
  rowView: Pick<RowView, 'translateRowIndex'>,
  enabled: boolean,
  zoom: number,
) {
  const measure = useMemo(() => createTextMeasurer(), []);
  const latest = useRef({ paint, rowView });
  latest.current = { paint, rowView };
  // RevoGrid starts with no row definitions; assigning even an equal list
  // re-lays out every row and closes an open cell editor, so only real
  // changes are assigned.
  const lastDefinitions = useRef('[]');

  /** The text a cell shows, formatted the way the template draws it. */
  const shownText = useCallback((model: RowModel | undefined, row: number, col: number): string => {
    if (!model) return '';
    const prop = columnIndexToLetter(col);
    const shown = core.formulaViewState.getDisplayValue(model, prop) ?? model[prop];
    const value = typeof shown === 'string' || typeof shown === 'number' ? shown : null;
    const format = latest.current.paint.decorations.formatAt(row, col);
    return cellDisplayText(value, format);
  }, [core]);

  const applyRowHeights = useCallback(() => {
    const grid = core.revoGridRef.current as (RevoGridElement & { rowDefinitions?: unknown }) | null;
    const rows = latest.current.paint.rows;
    const data = rows.revisionKey;
    if (!grid || !data) return;
    const meta = core.spreadsheetMetaRef.current.getMetadata();
    const total = data.pinnedTop.length + data.source.length;
    const wrapped = function* () {
      for (const key of meta.wrap) {
        const bounds = parseRangeKey(key);
        if (!bounds) continue;
        for (let row = bounds.startRow; row <= Math.min(bounds.endRow, total - 1); row++) {
          const model = rows.modelAt(row);
          for (let col = bounds.startCol; col <= Math.min(bounds.endCol, meta.columnCount - 1); col++) {
            const text = shownText(model, row, col);
            if (text !== '') yield { row, text, width: meta.columnWidths[col] ?? DEFAULT_COLUMN_WIDTH };
          }
        }
      }
    };
    const heights = rowHeightsFor(meta.rowHeights, wrapped(), measure);
    const mapping = core.rowSpaceRef.current;
    const zoom = core.zoomRef.current;
    const definitions = rowDefinitionsFor(heights, data.pinnedTop.length, (row) => mapping.logicalToVisible(row))
      .map((definition) => ({ ...definition, size: Math.round(definition.size * zoom) }));
    const serialized = JSON.stringify(definitions);
    if (serialized === lastDefinitions.current) return;
    lastDefinitions.current = serialized;
    grid.rowDefinitions = definitions;
  }, [core, measure, shownText]);

  useEffect(() => {
    core.rowSpaceListeners.add(applyRowHeights);
    return () => { core.rowSpaceListeners.delete(applyRowHeights); };
  }, [core, applyRowHeights]);

  const { rowHeights, wrap, columnWidths, cellFormats, columnFormats } = metadata;
  useEffect(() => {
    if (enabled) applyRowHeights();
  }, [enabled, applyRowHeights, rowHeights, wrap, columnWidths, cellFormats, columnFormats, zoom]);

  // Real row numbers (RevoGrid numbers visible rows, which skips hidden and
  // filtered ones) and a marker under a row that has hidden rows after it.
  const hiddenRef = useRef(new Set<number>());
  hiddenRef.current = new Set(metadata.hiddenRows);
  const rowHeaders = useMemo((): ColumnRegular => ({
    // RevoGrid needs a prop; the header renders its own text, not model data.
    prop: '__rowHeader',
    cellTemplate: (h, props) => {
      const row = paint.rows.rowOf(props.model);
      return h('span', {}, String((row ?? props.rowIndex) + 1));
    },
    cellProperties: (props) => {
      const row = paint.rows.rowOf(props.model);
      return row !== undefined && hiddenRef.current.has(row + 1) ? { class: { 'csv-row-before-hidden': true } } : {};
    },
  }), [paint.rows]);

  useEffect(() => {
    const container = core.gridContainerRef.current;
    if (!enabled || !container) return;

    const rowHeaderCell = (target: EventTarget | null) => {
      const cell = (target as HTMLElement | null)?.closest?.('.rowHeaders revogr-data [data-rgrow]') as HTMLElement | null;
      if (!cell) return null;
      const gridRow = Number(cell.dataset.rgrow);
      if (!Number.isInteger(gridRow)) return null;
      const pinned = cell.closest('revogr-data')?.getAttribute('type') === 'rowPinStart';
      return { cell, row: latest.current.rowView.translateRowIndex(gridRow, pinned) };
    };
    const nearBottom = (cell: HTMLElement, y: number) => y >= cell.getBoundingClientRect().bottom - EDGE_PX;
    /** The rows a resize applies to: the whole selected block when the row is in it. */
    const targetRows = (row: number) => {
      const range = core.selectionRangeRef.current;
      if (range && row >= range.startRow && row <= range.endRow && range.startRow !== range.endRow) {
        return core.rowSpaceRef.current.expandLogicalRange(range.startRow, range.endRow).logicalRows;
      }
      return [row];
    };
    const runPatch = (patch: Parameters<NonNullable<typeof core.gridOpsRef.current>['setMeta']>[0]) => {
      if (!core.editingLockedRef.current) void core.gridOpsRef.current?.setMeta(patch);
    };

    const onMouseMove = (event: MouseEvent) => {
      const hit = rowHeaderCell(event.target);
      if (hit) hit.cell.classList.toggle('csv-row-resize-edge', nearBottom(hit.cell, event.clientY));
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || event.detail > 1) return;
      const hit = rowHeaderCell(event.target);
      if (!hit || !nearBottom(hit.cell, event.clientY)) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = hit.cell.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const guide = document.createElement('div');
      guide.className = 'csv-row-resize-guide';
      guide.style.top = `${rect.bottom - containerRect.top}px`;
      container.appendChild(guide);
      const startY = event.clientY;
      let height = rect.height;
      const move = (e: MouseEvent) => {
        height = Math.max(MIN_ROW_HEIGHT, rect.height + e.clientY - startY);
        guide.style.top = `${rect.top - containerRect.top + height}px`;
      };
      const up = () => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        guide.remove();
        if (Math.abs(height - rect.height) < 1) return;
        const rows = targetRows(hit.row);
        const stored = Math.max(MIN_ROW_HEIGHT, Math.round(height / core.zoomRef.current));
        runPatch((meta) => setRowHeights(meta, rows, stored === DEFAULT_ROW_HEIGHT ? null : stored));
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    };

    const onDoubleClick = (event: MouseEvent) => {
      const hit = rowHeaderCell(event.target);
      if (hit && nearBottom(hit.cell, event.clientY)) {
        event.preventDefault();
        event.stopPropagation();
        const rows = targetRows(hit.row);
        runPatch((meta) => setRowHeights(meta, rows, null));
        return;
      }
      const handle = (event.target as HTMLElement | null)?.closest?.('revogr-header .resizable-r');
      const header = handle?.closest('[data-rgcol]');
      if (!header) return;
      event.preventDefault();
      event.stopPropagation();
      const { frozenColumnCount } = core.spreadsheetMetaRef.current.getMetadata();
      const col = resolveHeaderColumnIndex(readHeaderColumnTarget(header), frozenColumnCount);
      const rows = latest.current.paint.rows;
      const data = rows.revisionKey;
      if (col === null || !data) return;
      const texts = function* () {
        const total = data.pinnedTop.length + data.source.length;
        for (let row = 0; row < total; row++) yield shownText(rows.modelAt(row), row, col);
      };
      const width = autoFitWidth(texts(), measure);
      runPatch((meta) => setColumnWidths(meta, [col], width));
    };

    container.addEventListener('mousemove', onMouseMove);
    container.addEventListener('mousedown', onMouseDown, true);
    container.addEventListener('dblclick', onDoubleClick, true);
    return () => {
      container.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('mousedown', onMouseDown, true);
      container.removeEventListener('dblclick', onDoubleClick, true);
    };
  }, [enabled, core, measure, shownText]);

  return { rowHeaders };
}
