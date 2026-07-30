import { describe, expect, it } from 'vitest';
import { getTrackerTableCellClassName } from '../TrackerTable';

describe('getTrackerTableCellClassName', () => {
  it('scopes progress so global progress styles cannot theme the cell wrapper', () => {
    const classNames = getTrackerTableCellClassName('progress').split(/\s+/);

    expect(classNames).toContain('tracker-table-cell');
    expect(classNames).toContain('tracker-table-cell-progress');
    expect(classNames).not.toContain('progress');
  });
});
