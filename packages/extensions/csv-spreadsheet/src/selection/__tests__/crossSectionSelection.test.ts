// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  buildAxisSections,
  colTypesFromColumns,
  toAbsoluteCell,
  toSectionColumn,
  toLocalRanges,
  clampToGrid,
  resolveHeaderColumnIndex,
  type GridSections,
} from '../crossSectionSelection';
import { columnLetterToIndex } from '../../utils/csvParser';

/**
 * Layout under test: 2 frozen columns + 24 scrollable, 1 pinned header row +
 * 29 body rows. This is the shape a real grid reports (verified live: the
 * colPinStart store reports lastCell.x = 2 and rgCol reports 24).
 */
const sections: GridSections = {
  cols: buildAxisSections(
    { 0: 'colPinStart', 1: 'rgCol' },
    { 0: 2, 1: 24 },
    ['colPinStart', 'rgCol', 'colPinEnd']
  ),
  rows: buildAxisSections(
    { 0: 'rowPinStart', 1: 'rgRow', 2: 'rowPinEnd' },
    { 0: 1, 1: 29, 2: 0 },
    ['rowPinStart', 'rgRow', 'rowPinEnd']
  ),
};

describe('buildAxisSections', () => {
  it('orders sections visually, not by store registration index', () => {
    // RevoGrid registered rgCol as store 0 and the frozen section as store 1,
    // which would put the frozen columns at the wrong offset if we trusted key
    // order. Offsets must follow colPinStart -> rgCol regardless.
    const cols = buildAxisSections(
      { 0: 'rgCol', 1: 'colPinStart' },
      { 0: 24, 1: 2 },
      ['colPinStart', 'rgCol', 'colPinEnd']
    );
    expect(cols.map(s => [s.type, s.storeIndex, s.offset])).toEqual([
      ['colPinStart', 1, 0],
      ['rgCol', 0, 2],
    ]);
  });

  it('ignores unknown section types such as the row-number gutter', () => {
    const cols = buildAxisSections(
      { 0: 'rowHeaders' as 'rgCol', 1: 'rgCol' },
      { 0: 1, 1: 24 },
      ['colPinStart', 'rgCol', 'colPinEnd']
    );
    expect(cols).toEqual([{ type: 'rgCol', storeIndex: 1, offset: 0, count: 24 }]);
  });
});

describe('colTypesFromColumns', () => {
  it('indexes column stores in visual order over the sections that exist', () => {
    expect(colTypesFromColumns([{ pin: 'colPinStart' }, { pin: 'colPinStart' }, {}, {}])).toEqual({
      0: 'colPinStart',
      1: 'rgCol',
    });
    // No frozen columns: the scrollable section is store 0, not store 1.
    expect(colTypesFromColumns([{}, {}])).toEqual({ 0: 'rgCol' });
    expect(colTypesFromColumns([{}, { pin: 'colPinEnd' }])).toEqual({
      0: 'rgCol',
      1: 'colPinEnd',
    });
  });
});

describe('toSectionColumn', () => {
  it('splits a sheet column into the section-local pair RevoGrid writes expect', () => {
    // With two frozen columns, sheet column C is rgCol's column 0. Writing it as
    // `{ col: 2, colType: 'rgCol' }` would land on E instead.
    expect(toSectionColumn(2, 2)).toEqual({ col: 0, colType: 'rgCol' });
    expect(toSectionColumn(1, 2)).toEqual({ col: 1, colType: 'colPinStart' });
    expect(toSectionColumn(4, 0)).toEqual({ col: 4, colType: 'rgCol' });
  });
});

describe('toAbsoluteCell', () => {
  it('maps section-local coordinates to absolute sheet coordinates', () => {
    // First scrollable column is local 0 but absolute 2 (two frozen columns).
    expect(toAbsoluteCell(sections, 'rgCol', 'rgRow', 0, 0)).toEqual({ row: 1, col: 2 });
    // Frozen columns pass through unshifted; the pinned header row is row 0.
    expect(toAbsoluteCell(sections, 'colPinStart', 'rowPinStart', 1, 0)).toEqual({ row: 0, col: 1 });
  });

  it('returns null for the row-number gutter', () => {
    expect(toAbsoluteCell(sections, 'rowHeaders', 'rgRow', 0, 0)).toBeNull();
  });
});

describe('toLocalRanges', () => {
  it('splits a range that crosses the frozen boundary into per-store ranges', () => {
    // Absolute A2:D5 -> frozen A-B and scrollable C-D, body rows only.
    const local = toLocalRanges(sections, { startRow: 1, startCol: 0, endRow: 4, endCol: 3 });

    expect(local).toEqual([
      {
        storeY: 1,
        storeX: 0,
        start: { x: 0, y: 0 },
        end: { x: 1, y: 3 },
        // Continues into the scrollable columns, so its right edge is a seam.
        open: { top: false, right: true, bottom: false, left: false },
      },
      {
        storeY: 1,
        storeX: 1,
        start: { x: 0, y: 0 },
        end: { x: 1, y: 3 },
        open: { top: false, right: false, bottom: false, left: true },
      },
    ]);
  });

  it('reports no open edges for a range wholly inside one section', () => {
    // Every side is a real border here; suppressing any of them would leave the
    // selection rectangle unclosed.
    const [local] = toLocalRanges(sections, { startRow: 1, startCol: 0, endRow: 2, endCol: 1 });
    expect(local.open).toEqual({ top: false, right: false, bottom: false, left: false });
  });

  it('splits across both axes at once', () => {
    // A range covering the pinned header row and the body, across the frozen
    // boundary, must hit all four stores.
    const local = toLocalRanges(sections, { startRow: 0, startCol: 0, endRow: 2, endCol: 2 });

    expect(local).toHaveLength(4);
    // Top-left quadrant: seams on the two sides facing the other quadrants.
    expect(local).toContainEqual({
      storeY: 0,
      storeX: 0,
      start: { x: 0, y: 0 },
      end: { x: 1, y: 0 },
      open: { top: false, right: true, bottom: true, left: false },
    });
    expect(local).toContainEqual({
      storeY: 1,
      storeX: 1,
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      open: { top: true, right: false, bottom: false, left: true },
    });
  });

  it('omits sections the range does not touch', () => {
    // Entirely inside the frozen columns: the scrollable store must not be
    // painted, otherwise stale highlight is stranded there.
    const local = toLocalRanges(sections, { startRow: 1, startCol: 0, endRow: 2, endCol: 1 });
    expect(local.map(r => r.storeX)).toEqual([0]);
  });

  it('omits empty sections', () => {
    // rowPinEnd has zero rows; a full-height range must not address it.
    const local = toLocalRanges(sections, { startRow: 0, startCol: 0, endRow: 29, endCol: 25 });
    expect(local.some(r => r.storeY === 2)).toBe(false);
  });
});

describe('clampToGrid', () => {
  it('clamps a drag that overshoots the data to the last addressable cell', () => {
    expect(clampToGrid(sections, { row: 999, col: 999 })).toEqual({ row: 29, col: 25 });
    expect(clampToGrid(sections, { row: -3, col: -1 })).toEqual({ row: 0, col: 0 });
  });
});

describe('resolveHeaderColumnIndex', () => {
  it('reads the column from data-rgcol, never from the decorated header text', () => {
    // The column template renders `A` as `A▼` (label + filter funnel). Parsing
    // that text as a column letter is how right-clicking A once targeted -- and
    // deleted -- a completely different column.
    expect(columnLetterToIndex('A▼')).not.toBe(0);

    expect(resolveHeaderColumnIndex({ sectionColumn: '0', isPinnedColumn: false }, 0)).toBe(0);
    // Scrollable headers are section-local, so they sit past the frozen columns.
    expect(resolveHeaderColumnIndex({ sectionColumn: '0', isPinnedColumn: false }, 2)).toBe(2);
    expect(resolveHeaderColumnIndex({ sectionColumn: '0', isPinnedColumn: true }, 2)).toBe(0);
  });

  it('resolves nothing rather than a wrong column when the attribute is missing', () => {
    expect(resolveHeaderColumnIndex({ sectionColumn: null, isPinnedColumn: false }, 0)).toBeNull();
    expect(resolveHeaderColumnIndex({ sectionColumn: 'A', isPinnedColumn: false }, 0)).toBeNull();
  });
});
