import { describe, expect, it } from 'vitest';
import { formatTrackerActivity } from '../trackerActivityPresentation';

describe('formatTrackerActivity', () => {
  it('shows before and after values for field changes', () => {
    expect(formatTrackerActivity({
      action: 'updated',
      field: 'priority',
      oldValue: 'low',
      newValue: 'high',
    })).toBe('changed priority from “low” to “high”');
  });

  it('describes content updates without dumping content', () => {
    expect(formatTrackerActivity({ action: 'updated', field: 'content' }))
      .toBe('updated content');
  });

  it('describes comment edits and deletes with relevant detail', () => {
    expect(formatTrackerActivity({
      action: 'comment_updated',
      oldValue: 'before',
      newValue: 'after',
    })).toBe('edited a comment from “before” to “after”');
    expect(formatTrackerActivity({
      action: 'comment_deleted',
      oldValue: 'obsolete',
    })).toBe('deleted comment “obsolete”');
  });
});
