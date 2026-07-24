import { describe, it, expect } from 'vitest';
import { computeDiff, getCellDiffClass, getCellPreviousValue } from '../diffCompute';

// Helper to create CSV content
function makeCSV(rows: string[][]): string {
  return rows.map(row => row.join(',')).join('\n');
}

// Helper to create CSV with nimbalyst metadata header
function makeCSVWithMeta(rows: string[][]): string {
  const meta = '# nimbalyst: {"hasHeaders":true,"headerRowCount":1,"frozenColumnCount":0}';
  return meta + '\n' + rows.map(row => row.join(',')).join('\n');
}

describe('computeDiff', () => {
  describe('column additions', () => {
    it('should mark only new column cells as added when a column is added', () => {
      const original = makeCSV([
        ['Fruit', 'Color', 'Taste'],
        ['Apple', 'Red', 'sweet'],
        ['Banana', 'Yellow', 'sweet'],
      ]);

      const modified = makeCSV([
        ['Fruit', 'Color', 'Taste', 'Vitamins'],
        ['Apple', 'Red', 'sweet', 'C'],
        ['Banana', 'Yellow', 'sweet', 'B6'],
      ]);

      const diff = computeDiff(original, modified, 'tag1', 'session1');

      // Row 0 is header (pinned), rows 1-2 are data
      // Only column D (index 3) cells should be marked as added
      expect(getCellDiffClass(diff, 0, 'D', true)).toBe('cell-diff-added'); // Header "Vitamins"
      expect(getCellDiffClass(diff, 0, 'D', false)).toBe('cell-diff-added'); // Data row 0: "C"
      expect(getCellDiffClass(diff, 1, 'D', false)).toBe('cell-diff-added'); // Data row 1: "B6"

      // Columns A, B, C should NOT be marked as changed
      expect(getCellDiffClass(diff, 0, 'A', false)).toBe('');
      expect(getCellDiffClass(diff, 0, 'B', false)).toBe('');
      expect(getCellDiffClass(diff, 0, 'C', false)).toBe('');
      expect(getCellDiffClass(diff, 1, 'A', false)).toBe('');
      expect(getCellDiffClass(diff, 1, 'B', false)).toBe('');
      expect(getCellDiffClass(diff, 1, 'C', false)).toBe('');
    });
  });

  describe('row insertions', () => {
    it('should mark only the inserted row as added', () => {
      const original = makeCSV([
        ['Fruit', 'Color'],
        ['Apple', 'Red'],
        ['Cherry', 'Red'],
      ]);

      const modified = makeCSV([
        ['Fruit', 'Color'],
        ['Apple', 'Red'],
        ['Banana', 'Yellow'], // Inserted row
        ['Cherry', 'Red'],
      ]);

      const diff = computeDiff(original, modified, 'tag1', 'session1');

      // Row 0 is header (pinned:0)
      // Data rows: 0=Apple, 1=Banana (new), 2=Cherry

      // Apple row should be unchanged
      expect(getCellDiffClass(diff, 0, 'A', false)).toBe('');
      expect(getCellDiffClass(diff, 0, 'B', false)).toBe('');

      // Banana row should be added
      expect(getCellDiffClass(diff, 1, 'A', false)).toBe('cell-diff-added');
      expect(getCellDiffClass(diff, 1, 'B', false)).toBe('cell-diff-added');

      // Cherry row should be unchanged
      expect(getCellDiffClass(diff, 2, 'A', false)).toBe('');
      expect(getCellDiffClass(diff, 2, 'B', false)).toBe('');
    });
  });

  describe('row deletions', () => {
    it('should create phantom rows for deleted rows', () => {
      const original = makeCSV([
        ['Fruit', 'Color'],
        ['Apple', 'Red'],
        ['Banana', 'Yellow'],
        ['Cherry', 'Red'],
      ]);

      const modified = makeCSV([
        ['Fruit', 'Color'],
        ['Apple', 'Red'],
        ['Cherry', 'Red'],
      ]);

      const diff = computeDiff(original, modified, 'tag1', 'session1');

      // Should have 1 phantom row (Banana)
      expect(diff.phantomRows.length).toBe(1);
      expect(diff.phantomRows[0][0].raw).toBe('Banana');
      expect(diff.phantomRows[0][1].raw).toBe('Yellow');

      // Apple and Cherry should be unchanged
      expect(getCellDiffClass(diff, 0, 'A', false)).toBe('');
      expect(getCellDiffClass(diff, 1, 'A', false)).toBe('');
    });

    it('should mark phantom row cells as deleted with correct index', () => {
      const original = makeCSV([
        ['Fruit', 'Color'],
        ['Apple', 'Red'],
        ['Banana', 'Yellow'],
        ['Cherry', 'Red'],
      ]);

      const modified = makeCSV([
        ['Fruit', 'Color'],
        ['Apple', 'Red'],
        ['Cherry', 'Red'],
      ]);

      const diff = computeDiff(original, modified, 'tag1', 'session1');

      // Modified has 3 rows total: 1 header + 2 data
      // Phantom row should be at data index 2 (after Apple=0, Cherry=1)
      // The grid key would be "data:2"

      expect(getCellDiffClass(diff, 2, 'A', false)).toBe('cell-diff-deleted');
      expect(getCellDiffClass(diff, 2, 'B', false)).toBe('cell-diff-deleted');
      expect(getCellPreviousValue(diff, 2, 'A', false)).toBe('Banana');
      expect(getCellPreviousValue(diff, 2, 'B', false)).toBe('Yellow');
    });
  });

  describe('cell modifications', () => {
    it('should mark modified cells with previous value', () => {
      const original = makeCSV([
        ['Fruit', 'Color'],
        ['Apple', 'Red'],
      ]);

      const modified = makeCSV([
        ['Fruit', 'Color'],
        ['Apple', 'Green'],
      ]);

      const diff = computeDiff(original, modified, 'tag1', 'session1');

      expect(getCellDiffClass(diff, 0, 'A', false)).toBe('');
      expect(getCellDiffClass(diff, 0, 'B', false)).toBe('cell-diff-modified');
      expect(getCellPreviousValue(diff, 0, 'B', false)).toBe('Red');
    });
  });

  describe('combined changes', () => {
    it('should handle column addition + row insertion correctly', () => {
      const original = makeCSV([
        ['Fruit', 'Color'],
        ['Apple', 'Red'],
        ['Cherry', 'Red'],
      ]);

      const modified = makeCSV([
        ['Fruit', 'Color', 'Vitamins'],
        ['Apple', 'Red', 'C'],
        ['Banana', 'Yellow', 'B6'], // Inserted row
        ['Cherry', 'Red', 'C'],
      ]);

      const diff = computeDiff(original, modified, 'tag1', 'session1');

      // Apple row: only Vitamins column should be added
      expect(getCellDiffClass(diff, 0, 'A', false)).toBe('');
      expect(getCellDiffClass(diff, 0, 'C', false)).toBe('cell-diff-added');

      // Banana row: entire row is new
      expect(getCellDiffClass(diff, 1, 'A', false)).toBe('cell-diff-added');
      expect(getCellDiffClass(diff, 1, 'B', false)).toBe('cell-diff-added');
      expect(getCellDiffClass(diff, 1, 'C', false)).toBe('cell-diff-added');

      // Cherry row: only Vitamins column should be added
      expect(getCellDiffClass(diff, 2, 'A', false)).toBe('');
      expect(getCellDiffClass(diff, 2, 'C', false)).toBe('cell-diff-added');
    });

    it('should handle column addition + row deletion correctly', () => {
      const original = makeCSV([
        ['Fruit', 'Color'],
        ['Apple', 'Red'],
        ['Banana', 'Yellow'],
        ['Cherry', 'Red'],
      ]);

      const modified = makeCSV([
        ['Fruit', 'Color', 'Vitamins'],
        ['Apple', 'Red', 'C'],
        ['Cherry', 'Red', 'C'],
      ]);

      const diff = computeDiff(original, modified, 'tag1', 'session1');

      // Should have phantom row for Banana
      expect(diff.phantomRows.length).toBe(1);
      expect(diff.phantomRows[0][0].raw).toBe('Banana');

      // Apple and Cherry: only Vitamins column should be added
      expect(getCellDiffClass(diff, 0, 'A', false)).toBe('');
      expect(getCellDiffClass(diff, 0, 'C', false)).toBe('cell-diff-added');
      expect(getCellDiffClass(diff, 1, 'A', false)).toBe('');
      expect(getCellDiffClass(diff, 1, 'C', false)).toBe('cell-diff-added');

      // Phantom row (Banana) at index 2
      expect(getCellDiffClass(diff, 2, 'A', false)).toBe('cell-diff-deleted');
      expect(getCellDiffClass(diff, 2, 'B', false)).toBe('cell-diff-deleted');
    });
  });

  describe('real-world scenario: fruits CSV', () => {
    it('should handle column addition + row insertion + row deletion correctly', () => {
      const original = makeCSVWithMeta([
        ['Fruit', 'Color', 'Taste', ''],
        ['Banana', 'Yellow', 'sweet', ''],
        ['Blueberry', 'Blue', 'sweet', ''],
        ['Cherry', 'Red', 'sweet', ''],
        ['Grape', 'Purple', 'sweet', ''],
        ['Mango', 'Orange', 'sweet', ''],
        ['Papaya', 'Orange', 'sweet', ''],
        ['Peach', 'Orange', 'sweet', ''],
        ['Strawberry', 'Red', 'sweet', ''],
        ['Watermelon', 'Green', 'sweet', ''],
        ['Kiwi', 'Green', 'tangy', ''],
        ['Pineapple', 'Yellow', 'tangy', ''],
        ['Raspberry', 'Red', 'tart', ''],
        ['Pomegranate', 'Red', 'tangy', ''],
      ]);

      const modified = makeCSVWithMeta([
        ['Fruit', 'Color', 'Taste', 'Vitamins', ''],
        ['Apple', 'Red', 'sweet', 'C', ''],           // NEW ROW at top
        ['Banana', 'Yellow', 'sweet', 'B6 K', ''],
        ['Blueberry', 'Blue', 'sweet', 'C K', ''],
        ['Cherry', 'Red', 'sweet', 'C A', ''],
        ['Grape', 'Purple', 'sweet', 'C K', ''],
        ['Mango', 'Orange', 'sweet', 'A C', ''],
        // Papaya DELETED
        ['Peach', 'Orange', 'sweet', 'C A', ''],
        ['Strawberry', 'Red', 'sweet', 'C', ''],
        ['Watermelon', 'Green', 'sweet', 'C A', ''],
        ['Kiwi', 'Green', 'tangy', 'C K', ''],
        ['Pineapple', 'Yellow', 'tangy', 'C B6', ''],
        ['Raspberry', 'Red', 'tart', 'C K', ''],
        ['Pomegranate', 'Red', 'tangy', 'C K', ''],
        ['Lemon', 'Yellow', 'sour', 'C', ''],         // NEW ROW at bottom
      ]);

      const diff = computeDiff(original, modified, 'tag1', 'session1');

      console.log('Diff cells:', Array.from(diff.cells.entries()));
      console.log('Diff rows:', Array.from(diff.rows.entries()));
      console.log('Phantom rows:', diff.phantomRows.map(r => r.map(c => c.raw)));

      // Header row (pinned:0): Vitamins column should be added
      expect(getCellDiffClass(diff, 0, 'D', true)).toBe('cell-diff-added');
      expect(getCellDiffClass(diff, 0, 'A', true)).toBe(''); // Fruit unchanged
      expect(getCellDiffClass(diff, 0, 'B', true)).toBe(''); // Color unchanged
      expect(getCellDiffClass(diff, 0, 'C', true)).toBe(''); // Taste unchanged

      // Apple row (data:0) - entire row is NEW
      expect(getCellDiffClass(diff, 0, 'A', false)).toBe('cell-diff-added');
      expect(getCellDiffClass(diff, 0, 'B', false)).toBe('cell-diff-added');
      expect(getCellDiffClass(diff, 0, 'C', false)).toBe('cell-diff-added');
      expect(getCellDiffClass(diff, 0, 'D', false)).toBe('cell-diff-added');

      // Banana row (data:1) - only Vitamins column should be added
      expect(getCellDiffClass(diff, 1, 'A', false)).toBe('');
      expect(getCellDiffClass(diff, 1, 'B', false)).toBe('');
      expect(getCellDiffClass(diff, 1, 'C', false)).toBe('');
      expect(getCellDiffClass(diff, 1, 'D', false)).toBe('cell-diff-added');

      // Lemon row (data:13) - entire row is NEW
      expect(getCellDiffClass(diff, 13, 'A', false)).toBe('cell-diff-added');
      expect(getCellDiffClass(diff, 13, 'D', false)).toBe('cell-diff-added');

      // Papaya should be in phantom rows
      expect(diff.phantomRows.length).toBe(1);
      expect(diff.phantomRows[0][0].raw).toBe('Papaya');
    });
  });
});
