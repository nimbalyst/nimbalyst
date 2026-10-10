/**
 * Cell and column formatting: the two format dialogs' open state, range
 * styling, and column type detection.
 */

import { useCallback, useState } from 'react';
import type { CellStyle, ColumnFormat } from '../types';
import type { UseSpreadsheetMetadataResult } from '../hooks/useSpreadsheetMetadata';
import { columnIndexToLetter } from '../utils/csvParser';
import { detectColumnType, getDefaultFormatForType } from '../utils/formatters';
import { applyStyleToRange, rangeKeyOf, type CellStyleIndex } from '../cells/cellStyles';
import { ColumnFormatDialog } from '../components/ColumnFormatDialog';
import { CellFormatDialog } from '../components/CellFormatDialog';
import type { EditorCore } from './editorCore';
import { formatTargetColumns } from './editorUtils';

/** `formats` with `columns` set to `format`, or cleared when it is null. */
export function withColumnFormats(
  formats: Readonly<Record<number, ColumnFormat>>,
  columns: readonly number[],
  format: ColumnFormat | null,
): Record<number, ColumnFormat> {
  const next = { ...formats };
  for (const column of columns) {
    if (format === null) delete next[column];
    else next[column] = format;
  }
  return next;
}

export function useFormatting(core: EditorCore) {
  const { gridOpsRef, selectionRangeRef } = core;
  const [formatDialogColumn, setFormatDialogColumn] = useState<number | null>(null);
  const [cellFormatOpen, setCellFormatOpen] = useState(false);

  /**
   * Infer a column's type from its data and apply the matching default format.
   *
   * Deliberately an explicit action rather than something that runs on open: a
   * wrong auto-format applied to someone's data without asking is worse than no
   * format at all. Mixed columns come back as text and leave the column alone.
   */
  const applyDetectedColumnType = useCallback(async (colIndex: number): Promise<void> => {
    const gridOps = gridOpsRef.current;
    if (!gridOps) return;

    const { source } = await gridOps.getData();
    const prop = columnIndexToLetter(colIndex);
    const samples: (string | number | null)[] = [];
    for (const row of source) {
      const value = row[prop];
      if (value === null || value === undefined || value === '') continue;
      samples.push(typeof value === 'number' ? value : String(value));
      // A few hundred rows is plenty to characterize a column, and keeps the
      // scan bounded on large sheets.
      if (samples.length >= 200) break;
    }

    const detected = detectColumnType(samples);
    await gridOps.setMeta((meta) => ({
      columnFormats: withColumnFormats(meta.columnFormats, [colIndex], detected === 'text' ? null : getDefaultFormatForType(detected)),
    }));
  }, [gridOpsRef]);

  /**
   * Apply a styling change to the current selection. Styling is presentation
   * only: it never touches cell values, so it is safe on a formula or a date.
   */
  const applyCellStyle = useCallback((change: CellStyle) => {
    const selection = selectionRangeRef.current;
    if (!selection) return;
    void gridOpsRef.current?.setMeta((meta) => ({ cellStyles: applyStyleToRange(meta.cellStyles, selection, change) }));
  }, [gridOpsRef, selectionRangeRef]);

  return {
    formatDialogColumn,
    setFormatDialogColumn,
    cellFormatOpen,
    setCellFormatOpen,
    applyDetectedColumnType,
    applyCellStyle,
  };
}

export type Formatting = ReturnType<typeof useFormatting>;

export function SpreadsheetFormatDialogs({ core, formatting, spreadsheetMeta, cellStyleIndex }: {
  core: EditorCore;
  formatting: Formatting;
  spreadsheetMeta: UseSpreadsheetMetadataResult;
  cellStyleIndex: CellStyleIndex;
}) {
  const { selectionRangeRef } = core;
  const { formatDialogColumn, setFormatDialogColumn, cellFormatOpen, setCellFormatOpen, applyCellStyle } = formatting;
  const columnFormats = spreadsheetMeta.metadata.columnFormats;

  return (
    <>
      <CellFormatDialog
        isOpen={cellFormatOpen}
        rangeLabel={selectionRangeRef.current ? rangeKeyOf(selectionRangeRef.current) : ''}
        currentStyle={selectionRangeRef.current
          ? cellStyleIndex.styleAt(selectionRangeRef.current.startRow, selectionRangeRef.current.startCol)
          : null}
        onSave={(style) => applyCellStyle(style)}
        onClose={() => setCellFormatOpen(false)}
      />

      <ColumnFormatDialog
        isOpen={formatDialogColumn !== null}
        columnIndex={formatDialogColumn ?? 0}
        columnLetter={formatDialogColumn !== null ? columnIndexToLetter(formatDialogColumn) : ''}
        currentFormat={formatDialogColumn !== null ? columnFormats[formatDialogColumn] : undefined}
        onSave={(format) => {
          if (formatDialogColumn === null) return;
          // Formatting one column at a time is tedious for a wide sheet, so when
          // the click landed inside a multi-column selection the format applies
          // to all of them.
          const targets = formatTargetColumns(selectionRangeRef.current, formatDialogColumn);
          void core.gridOpsRef.current?.setMeta((meta) => ({
            columnFormats: withColumnFormats(meta.columnFormats, targets, format),
          }));
        }}
        onClose={() => setFormatDialogColumn(null)}
      />
    </>
  );
}
