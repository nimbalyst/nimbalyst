/**
 * Diff review splices the AI's deleted rows back into the grid as phantom rows
 * at their original positions, so a reviewer sees what was removed in place.
 * That shifts every grid index after a phantom, so the cell-level diff keys are
 * remapped onto the spliced row order here.
 */

import type { CellDiff, DiffState, SpreadsheetData } from '../types';
import type { GridSourceData } from '../utils/gridOperations';
import { columnIndexToLetter } from '../utils/csvParser';
import { pinnedRowCount } from '../sheetMeta/formatting';

/**
 * The grid source to show for a diff. Rewrites `diff.cells` in place to the
 * spliced row indices when there are phantom rows.
 */
export function buildDiffGridSource(
  gridData: GridSourceData,
  modifiedData: SpreadsheetData,
  diff: DiffState,
): GridSourceData {
  if (diff.phantomRows.length === 0) return gridData;

  const pinned = pinnedRowCount(modifiedData);
  const actualDataRowCount = modifiedData.rows.length - pinned;
  const dataRows = gridData.source.slice(0, actualDataRowCount);
  const bufferRows = gridData.source.slice(actualDataRowCount);

  type RowEntry = { row: Record<string, string | number>; isPhantom: boolean; position: number };
  const entries: RowEntry[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    entries.push({ row: dataRows[i], isPhantom: false, position: i });
  }

  for (let i = 0; i < diff.phantomRows.length; i++) {
    const phantomRow = diff.phantomRows[i];
    const position = diff.phantomRowPositions[i] - pinned;

    const rowData: Record<string, string | number> = {};
    phantomRow.forEach((cell, colIdx) => {
      const colKey = columnIndexToLetter(colIdx);
      rowData[colKey] = cell.raw || '';
    });
    rowData._rowClass = 'row-diff-deleted';
    entries.push({ row: rowData, isPhantom: true, position: position + 0.5 });
  }

  entries.sort((a, b) => a.position - b.position);

  const indexMapping = new Map<number, number>();
  let gridIdx = 0;
  for (const entry of entries) {
    if (!entry.isPhantom) {
      indexMapping.set(Math.floor(entry.position), gridIdx);
    }
    gridIdx++;
  }

  const newCells = new Map<string, CellDiff>();
  for (const [key, value] of diff.cells.entries()) {
    if (key.startsWith('data:')) {
      const parts = key.split(':');
      const oldIdx = parseInt(parts[1], 10);
      const colProp = parts[2];
      const newIdx = indexMapping.get(oldIdx);
      if (newIdx !== undefined) {
        newCells.set(`data:${newIdx}:${colProp}`, value);
      }
    } else {
      newCells.set(key, value);
    }
  }

  gridIdx = 0;
  for (const entry of entries) {
    if (entry.isPhantom) {
      const rowData = entry.row;
      for (const [key, value] of Object.entries(rowData)) {
        if (key !== '_rowClass' && value !== '') {
          newCells.set(`data:${gridIdx}:${key}`, {
            type: 'deleted',
            previousValue: String(value),
          });
        }
      }
    }
    gridIdx++;
  }

  diff.cells.clear();
  for (const [key, value] of newCells.entries()) {
    diff.cells.set(key, value);
  }

  const finalDataRows = entries.map(e => e.row);
  return { ...gridData, source: [...finalDataRows, ...bufferRows] };
}
