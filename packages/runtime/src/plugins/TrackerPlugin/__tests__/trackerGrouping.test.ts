import { describe, expect, it } from 'vitest';
import type { TrackerRecord } from '../../../core/TrackerRecord';
import { groupTrackerItems, normalizeTrackerGroupBy } from '../trackerGrouping';

function makeItem(
  id: string,
  fields: Record<string, unknown>,
  primaryType = 'task',
): TrackerRecord {
  return {
    id,
    primaryType,
    typeTags: [primaryType],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace: '/ws', createdAt: '', updatedAt: '' },
    fields,
  };
}

describe('trackerGrouping', () => {
  it('normalizes unknown or empty grouping values to none', () => {
    expect(normalizeTrackerGroupBy(null)).toBe('none');
    expect(normalizeTrackerGroupBy('')).toBe('none');
    expect(normalizeTrackerGroupBy('unknown')).toBe('none');
  });

  it('groups Display Options owner values through the assignee role', () => {
    const items = [
      makeItem('1', { owner: 'alice@example.com' }),
      makeItem('2', {}),
    ];

    const groups = groupTrackerItems(items, 'owner');

    expect(groups.map((g) => g.label)).toEqual(['alice@example.com', 'Unassigned']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['1']);
    expect(groups[1].items.map((i) => i.id)).toEqual(['2']);
  });
});
