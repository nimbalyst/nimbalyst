import { describe, it, expect } from 'vitest';
import { mergeWithDefaults } from '../agentMode';

// Escape hatch for #924: a persisted sortOrder that the panel can't render must
// not brick the workspace on every launch. mergeWithDefaults is the single load
// path, so it coerces anything other than the two known values to 'updated'.
describe('mergeWithDefaults - sessionHistoryLayout.sortOrder (#924)', () => {
  it('preserves a valid "created" sortOrder', () => {
    const merged = mergeWithDefaults({
      sessionHistoryLayout: { sortOrder: 'created' } as never,
    });
    expect(merged.sessionHistoryLayout.sortOrder).toBe('created');
  });

  it('preserves a valid "updated" sortOrder', () => {
    const merged = mergeWithDefaults({
      sessionHistoryLayout: { sortOrder: 'updated' } as never,
    });
    expect(merged.sessionHistoryLayout.sortOrder).toBe('updated');
  });

  it('coerces an unknown/garbage persisted sortOrder to "updated"', () => {
    const merged = mergeWithDefaults({
      sessionHistoryLayout: { sortOrder: 'garbage' } as never,
    });
    expect(merged.sessionHistoryLayout.sortOrder).toBe('updated');
  });

  it('defaults to "updated" when sortOrder is missing', () => {
    const merged = mergeWithDefaults({ sessionHistoryLayout: {} as never });
    expect(merged.sessionHistoryLayout.sortOrder).toBe('updated');
  });
});
