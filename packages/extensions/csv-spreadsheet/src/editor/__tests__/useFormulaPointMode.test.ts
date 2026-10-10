import { describe, expect, it } from 'vitest';
import { logicalCellOfElement } from '../useFormulaPointMode';
import { createRowIndexMapping } from '../../filter/rowIndexMapping';

function cellIn(section: string, row: number, col: number): Element {
  const data = document.createElement('revogr-data');
  data.setAttribute('type', section);
  data.setAttribute('col-type', 'rgCol');
  const cell = document.createElement('div');
  cell.setAttribute('data-rgrow', String(row));
  cell.setAttribute('data-rgcol', String(col));
  data.appendChild(cell);
  return cell;
}

describe('logicalCellOfElement', () => {
  it('R3-7: counts frozen data rows as pinned when placing a scrolling cell', () => {
    const meta = { headerRowCount: 1, frozenRowCount: 2, frozenColumnCount: 0 };
    const core = {
      spreadsheetMetaRef: { current: { getMetadata: () => meta } },
      rowSpaceRef: { current: createRowIndexMapping({ rowCount: 10, headerRowCount: 3 }) },
    } as unknown as Parameters<typeof logicalCellOfElement>[1];

    expect(logicalCellOfElement(cellIn('rgRow', 0, 0), core)).toEqual({ row: 3, col: 0 });
    expect(logicalCellOfElement(cellIn('rowPinStart', 2, 1), core)).toEqual({ row: 2, col: 1 });
  });
});
