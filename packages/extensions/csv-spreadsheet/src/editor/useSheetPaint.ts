/**
 * The paint-time lookups the column templates read: logical rows, the Phase 3
 * decorations (cell formats, wrap, borders, validation) and conditional
 * formats. Rebuilt only when the metadata they come from changes.
 */

import { useMemo } from 'react';
import type { SpreadsheetMetadata } from '../hooks/useSpreadsheetMetadata';
import { SheetDecorations } from '../cells/sheetDecorations';
import { ConditionalPainter, LogicalRowIndex, type GridRows } from '../cells/paintContext';
import type { EditorCore } from './editorCore';

export function useSheetPaint(core: EditorCore, metadata: SpreadsheetMetadata) {
  const rows = useMemo(() => new LogicalRowIndex(() => {
    const grid = core.revoGridRef.current as unknown as { source?: GridRows['source']; pinnedTopSource?: GridRows['pinnedTop'] } | null;
    if (!grid || !Array.isArray(grid.source) || !Array.isArray(grid.pinnedTopSource)) return null;
    return { source: grid.source, pinnedTop: grid.pinnedTopSource };
  }), [core]);

  const { columnFormats, cellFormats, wrap, borders, validation, conditionalFormats, columnCount } = metadata;
  const decorations = useMemo(
    () => new SheetDecorations({ columnFormats, cellFormats, wrap, borders, validation }),
    [columnFormats, cellFormats, wrap, borders, validation],
  );
  const conditional = useMemo(() => new ConditionalPainter(
    conditionalFormats,
    rows,
    (model, prop) => core.formulaViewState.getDisplayValue(model, prop),
    () => ({ rowCount: (rows.revisionKey?.pinnedTop.length ?? 0) + (rows.revisionKey?.source.length ?? 0), colCount: columnCount }),
  ), [conditionalFormats, rows, core, columnCount]);

  return useMemo(() => ({ rows, decorations, conditional }), [rows, decorations, conditional]);
}

export type SheetPaint = ReturnType<typeof useSheetPaint>;
