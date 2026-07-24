import { describe, expect, it } from 'vitest';
import { buildSpreadsheetSelectionContextItem } from '../selectionContext';

describe('CSV spreadsheet selection context', () => {
  it('describes a selected range with stable identity and current values', () => {
    const range = { startRow: 0, startCol: 0, endRow: 4, endCol: 2 };
    const before = buildSpreadsheetSelectionContextItem(range, [
      { A: 'Name', B: 'Count', C: 'Region' },
      { A: 'Apples', B: 12, C: 'North' },
      { A: 'Pears', B: 8, C: 'South' },
      { A: 'Plums', B: 4, C: 'West' },
      { A: 'Oranges', B: 9, C: 'East' },
    ]);
    const after = buildSpreadsheetSelectionContextItem(range, [
      { A: 'Name', B: 'Count', C: 'Region' },
      { A: 'Apples', B: 12, C: 'North' },
      { A: 'Pears', B: 18, C: 'South' },
      { A: 'Plums', B: 4, C: 'West' },
      { A: 'Oranges', B: 9, C: 'East' },
    ]);

    expect(before.id).toBe('csv-range:A1:C5');
    expect(before.label).toBe('A1:C5 (15 cells)');
    expect(before.includeData).toBe(true);
    expect(before.description).toContain('Pears\t8\tSouth');
    expect(after.id).toBe(before.id);
    expect(after.description).toContain('Pears\t18\tSouth');
  });

  it('bounds and sanitizes large previews for JSON-safe prompt data', () => {
    const rows = Array.from({ length: 20 }, (_, rowIndex) =>
      Object.fromEntries(Array.from({ length: 12 }, (_, columnIndex) => [
        String.fromCharCode(65 + columnIndex),
        `${rowIndex}:${columnIndex}:\u0000${'x'.repeat(500)}`,
      ])),
    );
    rows[0].A = { cyclic: rows } as unknown as string;

    const item = buildSpreadsheetSelectionContextItem(
      { startRow: 0, startCol: 0, endRow: 19, endCol: 11 },
      rows,
    );
    const data = item.data as {
      preview: unknown[][];
      previewTruncated: boolean;
      omittedRows: number;
      omittedColumns: number;
    };

    expect(item.label).toBe('A1:L20 (240 cells)');
    expect(data.preview).toHaveLength(8);
    expect(data.preview[0]).toHaveLength(8);
    expect(data.previewTruncated).toBe(true);
    expect(data.omittedRows).toBe(12);
    expect(data.omittedColumns).toBe(4);
    expect(item.description).not.toContain('\u0000');
    expect(JSON.stringify(item.data).length).toBeLessThan(32 * 1024);
  });

  it('uses a singular label for one selected cell', () => {
    const item = buildSpreadsheetSelectionContextItem(
      { startRow: 2, startCol: 1, endRow: 2, endCol: 1 },
      [{}, {}, { B: true }],
    );

    expect(item.id).toBe('csv-range:B3');
    expect(item.label).toBe('B3 (1 cell)');
    expect(item.description).toContain('true');
  });
});
