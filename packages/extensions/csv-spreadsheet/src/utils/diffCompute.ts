/**
 * Diff computation utilities for CSV AI edit review
 *
 * Uses the `diff` library's diffArrays to properly detect inserted/deleted rows
 * rather than naive positional comparison. This ensures that inserting a row
 * doesn't cause all subsequent rows to appear modified.
 *
 * Also handles column additions specially - when columns are added but rows
 * remain the same, only the new column cells are marked as added.
 */

import { diffArrays } from 'diff';

// Define ArrayChange type locally since it's not exported from diff@8.x main entry
interface ArrayChange<T> {
  value: T[];
  added?: boolean;
  removed?: boolean;
  count?: number;
}
import type { DiffState, CellDiff, RowDiff, Row } from '../types';
import { parseCSV, columnIndexToLetter } from './csvParser';

/**
 * Serialize a row to a string for comparison purposes.
 * Two rows are considered equal if their serialized forms match.
 *
 * @param row - The row to serialize
 * @param maxCols - Optional max columns to include (for comparing only shared columns)
 */
function serializeRow(row: Row, maxCols?: number): string {
  const cols = maxCols !== undefined ? row.slice(0, maxCols) : row;
  return cols.map(cell => cell.raw).join('\t');
}

/**
 * Compute the diff between original and modified CSV content.
 *
 * Uses diffArrays to properly detect inserted/deleted/unchanged rows,
 * then computes cell-level diffs within modified rows.
 *
 * Special handling for column additions: when columns are added but rows
 * remain structurally the same, we compare only the shared columns to
 * determine row matches, then mark new column cells as added.
 *
 * Row indices in the returned DiffState are GRID-RELATIVE:
 * - Header rows use "pinned:N" format since they're in pinnedTopSource
 * - Data rows use "data:N" format matching RevoGrid's source array
 *
 * @param originalContent - The CSV content before AI edits
 * @param modifiedContent - The CSV content after AI edits
 * @param tagId - History tag ID
 * @param sessionId - AI session ID
 * @returns DiffState with cell-level and row-level diff information
 */
export function computeDiff(
  originalContent: string,
  modifiedContent: string,
  tagId: string,
  sessionId: string
): DiffState {
  const originalParsed = parseCSV(originalContent);
  const modifiedParsed = parseCSV(modifiedContent);

  const originalRows = originalParsed.data.rows;
  const modifiedRows = modifiedParsed.data.rows;

  // Use the header row count from the modified content (current state)
  const headerRowCount = modifiedParsed.data.headerRowCount;

  const cells = new Map<string, CellDiff>();
  const rows = new Map<number, RowDiff>();
  const phantomRows: Row[] = [];
  // Track where each phantom row should be inserted (modified data row index)
  const phantomRowPositions: number[] = [];

  const originalColCount = originalParsed.data.columnCount;
  const modifiedColCount = modifiedParsed.data.columnCount;

  // Find the "effective" column count - columns that actually have non-empty data
  // This helps detect when a column is truly new vs just having its empty cells filled
  const getEffectiveColCount = (rows: Row[]): number => {
    let maxCol = 0;
    for (const row of rows) {
      for (let i = row.length - 1; i >= 0; i--) {
        if (row[i]?.raw !== '') {
          maxCol = Math.max(maxCol, i + 1);
          break;
        }
      }
    }
    return maxCol;
  };

  const originalEffectiveColCount = getEffectiveColCount(originalRows);
  const modifiedEffectiveColCount = getEffectiveColCount(modifiedRows);

  // Determine the shared column count for row comparison
  // Use the ORIGINAL's effective column count - this way, if columns were added
  // to the modified version, we only compare the columns that existed in the original
  const sharedColCount = originalEffectiveColCount;

  // Serialize rows using only the original's effective columns for comparison
  // This way, adding a new column doesn't make every row look different
  const originalSerialized = originalRows.map(row => serializeRow(row, sharedColCount));
  const modifiedSerialized = modifiedRows.map(row => serializeRow(row, sharedColCount));

  // Use diffArrays to find actual changes (based on shared columns)
  const rawChanges: ArrayChange<string>[] = diffArrays(originalSerialized, modifiedSerialized);

  // Preprocess changes: merge adjacent removed+added pairs of equal size into "modified"
  // This converts patterns like {removed:1}, {added:1} into a single "modified" change
  type ProcessedChange = { type: 'added' | 'removed' | 'unchanged' | 'modified'; count: number };
  const changes: ProcessedChange[] = [];

  for (let i = 0; i < rawChanges.length; i++) {
    const change = rawChanges[i];
    const nextChange = rawChanges[i + 1];

    if (change.removed && nextChange?.added && change.count === nextChange.count) {
      // Merge removed + added of same count into "modified"
      changes.push({ type: 'modified', count: change.count ?? 0 });
      i++; // Skip the next change since we merged it
    } else if (change.added) {
      changes.push({ type: 'added', count: change.count ?? 0 });
    } else if (change.removed) {
      changes.push({ type: 'removed', count: change.count ?? 0 });
    } else {
      changes.push({ type: 'unchanged', count: change.count ?? 0 });
    }
  }

  console.log('[CSV Diff] Computing diff:', {
    originalRowCount: originalRows.length,
    modifiedRowCount: modifiedRows.length,
    originalColCount,
    modifiedColCount,
    originalEffectiveColCount,
    modifiedEffectiveColCount,
    sharedColCount,
    rawChangesCount: rawChanges.length,
    processedChangesCount: changes.length,
    changes: changes.map(c => ({ type: c.type, count: c.count })),
  });

  // Track position in original and modified arrays
  let origIdx = 0;
  let modIdx = 0;

  /**
   * Convert modified row index to grid row key.
   */
  const toGridRowKey = (idx: number): string => {
    if (idx < headerRowCount) {
      return `pinned:${idx}`;
    }
    return `data:${idx - headerRowCount}`;
  };

  for (const change of changes) {
    const count = change.count;

    if (change.type === 'added') {
      // Rows were added in modified version
      for (let i = 0; i < count; i++) {
        const modRow = modifiedRows[modIdx];
        const gridRowKey = toGridRowKey(modIdx);

        // Check if row has actual content
        const hasContent = modRow && modRow.some(cell => cell.raw !== '');
        if (hasContent) {
          rows.set(modIdx, { type: 'added' });

          // Mark all non-empty cells as added
          for (let colIdx = 0; colIdx < modRow.length; colIdx++) {
            if (modRow[colIdx]?.raw !== '') {
              const colProp = columnIndexToLetter(colIdx);
              cells.set(`${gridRowKey}:${colProp}`, { type: 'added' });
            }
          }
        }

        modIdx++;
      }
    } else if (change.type === 'removed') {
      // Rows were removed (exist in original but not in modified)
      // Track where they should be inserted (at current modIdx position)
      for (let i = 0; i < count; i++) {
        const origRow = originalRows[origIdx];

        // Check if row has actual content
        const hasContent = origRow && origRow.some(cell => cell.raw !== '');
        if (hasContent) {
          // Record the position where this phantom should be inserted
          // This is the current modIdx (where we are in the modified sequence)
          phantomRowPositions.push(modIdx);
          phantomRows.push(origRow);
        }

        origIdx++;
      }
    } else if (change.type === 'modified') {
      // Rows exist in both but content differs - compare cell by cell
      for (let i = 0; i < count; i++) {
        const origRow = originalRows[origIdx];
        const modRow = modifiedRows[modIdx];
        const gridRowKey = toGridRowKey(modIdx);

        let rowChanged = false;

        // Compare all columns
        const maxCols = Math.max(origRow?.length ?? 0, modRow?.length ?? 0, modifiedEffectiveColCount);
        for (let colIdx = 0; colIdx < maxCols; colIdx++) {
          const origCell = origRow?.[colIdx]?.raw ?? '';
          const modCell = modRow?.[colIdx]?.raw ?? '';

          if (origCell !== modCell) {
            if (origCell === '' && modCell === '') continue;

            rowChanged = true;
            const colProp = columnIndexToLetter(colIdx);

            if (origCell === '' && modCell !== '') {
              cells.set(`${gridRowKey}:${colProp}`, { type: 'added' });
            } else if (origCell !== '' && modCell === '') {
              cells.set(`${gridRowKey}:${colProp}`, {
                type: 'deleted',
                previousValue: origCell,
              });
            } else {
              cells.set(`${gridRowKey}:${colProp}`, {
                type: 'modified',
                previousValue: origCell,
              });
            }
          }
        }

        rows.set(modIdx, { type: rowChanged ? 'modified' : 'unchanged' });

        origIdx++;
        modIdx++;
      }
    } else {
      // Rows are unchanged (same in shared columns)
      for (let i = 0; i < count; i++) {
        const origRow = originalRows[origIdx];
        const modRow = modifiedRows[modIdx];
        const gridRowKey = toGridRowKey(modIdx);

        let rowChanged = false;

        // Check shared columns for cell-level differences
        for (let colIdx = 0; colIdx < sharedColCount; colIdx++) {
          const origCell = origRow?.[colIdx]?.raw ?? '';
          const modCell = modRow?.[colIdx]?.raw ?? '';

          if (origCell !== modCell) {
            // Skip if both are empty
            if (origCell === '' && modCell === '') {
              continue;
            }

            rowChanged = true;
            const colProp = columnIndexToLetter(colIdx);

            if (origCell === '') {
              cells.set(`${gridRowKey}:${colProp}`, { type: 'added' });
            } else if (modCell === '') {
              cells.set(`${gridRowKey}:${colProp}`, {
                type: 'deleted',
                previousValue: origCell,
              });
            } else {
              cells.set(`${gridRowKey}:${colProp}`, {
                type: 'modified',
                previousValue: origCell,
              });
            }
          }
        }

        // Mark cells in new columns (beyond original's effective columns) as added
        if (modifiedEffectiveColCount > originalEffectiveColCount) {
          for (let colIdx = originalEffectiveColCount; colIdx < modifiedEffectiveColCount; colIdx++) {
            const modCell = modRow?.[colIdx]?.raw ?? '';
            if (modCell !== '') {
              rowChanged = true;
              const colProp = columnIndexToLetter(colIdx);
              cells.set(`${gridRowKey}:${colProp}`, { type: 'added' });
            }
          }
        }

        // Mark cells in removed columns as deleted
        if (originalEffectiveColCount > modifiedEffectiveColCount) {
          for (let colIdx = modifiedEffectiveColCount; colIdx < originalEffectiveColCount; colIdx++) {
            const origCell = origRow?.[colIdx]?.raw ?? '';
            if (origCell !== '') {
              rowChanged = true;
              const colProp = columnIndexToLetter(colIdx);
              cells.set(`${gridRowKey}:${colProp}`, {
                type: 'deleted',
                previousValue: origCell,
              });
            }
          }
        }

        rows.set(modIdx, { type: rowChanged ? 'modified' : 'unchanged' });

        origIdx++;
        modIdx++;
      }
    }
  }

  return {
    cells,
    rows,
    phantomRows,
    phantomRowPositions,
    originalContent,
    isActive: true,
    tagId,
    sessionId,
  };
}

/**
 * Get the CSS class for a cell based on its diff state.
 *
 * @param diffState - The current diff state (or null if not in diff mode)
 * @param rowIndex - The row index (0-based within its source)
 * @param colProp - The column property (letter like "A", "B", etc.)
 * @param isPinned - Whether this is a pinned (header) row
 * @returns CSS class name or empty string
 */
export function getCellDiffClass(
  diffState: DiffState | null,
  rowIndex: number,
  colProp: string,
  isPinned: boolean = false
): string {
  if (!diffState?.isActive) {
    return '';
  }

  const rowKey = isPinned ? `pinned:${rowIndex}` : `data:${rowIndex}`;
  const cellDiff = diffState.cells.get(`${rowKey}:${colProp}`);
  if (!cellDiff) {
    // Fallback for phantom rows: deleted rows are stored separately and rendered
    // by position rather than by regular cell map keys.
    if (!isPinned) {
      const phantomIdx = diffState.phantomRowPositions.findIndex(
        (pos) => pos === rowIndex,
      );
      if (phantomIdx >= 0) {
        const colIndex = colProp
          .toUpperCase()
          .split('')
          .reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
        const phantomCell = diffState.phantomRows[phantomIdx]?.[colIndex];
        if (phantomCell && phantomCell.raw !== '') {
          return 'cell-diff-deleted';
        }
      }
    }
    return '';
  }

  switch (cellDiff.type) {
    case 'added':
      return 'cell-diff-added';
    case 'modified':
      return 'cell-diff-modified';
    case 'deleted':
      return 'cell-diff-deleted';
    default:
      return '';
  }
}

/**
 * Get the previous value for a cell (for tooltip display).
 *
 * @param diffState - The current diff state (or null if not in diff mode)
 * @param rowIndex - The row index (0-based within its source)
 * @param colProp - The column property (letter like "A", "B", etc.)
 * @param isPinned - Whether this is a pinned (header) row
 * @returns Previous value or undefined
 */
export function getCellPreviousValue(
  diffState: DiffState | null,
  rowIndex: number,
  colProp: string,
  isPinned: boolean = false
): string | undefined {
  if (!diffState?.isActive) {
    return undefined;
  }

  const rowKey = isPinned ? `pinned:${rowIndex}` : `data:${rowIndex}`;
  const cellDiff = diffState.cells.get(`${rowKey}:${colProp}`);
  if (cellDiff?.previousValue !== undefined) {
    return cellDiff.previousValue;
  }

  if (!isPinned) {
    const phantomIdx = diffState.phantomRowPositions.findIndex(
      (pos) => pos === rowIndex,
    );
    if (phantomIdx >= 0) {
      const colIndex = colProp
        .toUpperCase()
        .split('')
        .reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
      return diffState.phantomRows[phantomIdx]?.[colIndex]?.raw;
    }
  }

  return undefined;
}

/**
 * Check if a row is a phantom (deleted) row.
 *
 * @param diffState - The current diff state (or null if not in diff mode)
 * @param rowIndex - The row index
 * @returns True if the row is a phantom row
 */
export function isPhantomRow(
  diffState: DiffState | null,
  rowIndex: number
): boolean {
  if (!diffState?.isActive) {
    return false;
  }

  const rowDiff = diffState.rows.get(rowIndex);
  return rowDiff?.isPhantom === true;
}

/**
 * Get the CSS class for a row based on its diff state.
 *
 * @param diffState - The current diff state (or null if not in diff mode)
 * @param rowIndex - The row index
 * @returns CSS class name or empty string
 */
export function getRowDiffClass(
  diffState: DiffState | null,
  rowIndex: number
): string {
  if (!diffState?.isActive) {
    return '';
  }

  const rowDiff = diffState.rows.get(rowIndex);
  if (!rowDiff) {
    return '';
  }

  if (rowDiff.isPhantom) {
    return 'row-diff-deleted';
  }

  switch (rowDiff.type) {
    case 'added':
      return 'row-diff-added';
    case 'deleted':
      return 'row-diff-deleted';
    default:
      return '';
  }
}
