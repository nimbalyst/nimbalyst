import { describe, it, expect } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { groupTrackerItemsByTag } from '../trackerTagFilterUtils';

function makeItem(id: string, tags: unknown): TrackerRecord {
  return {
    id,
    primaryType: 'task',
    typeTags: ['task'],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace: '/ws', createdAt: '', updatedAt: '' },
    fields: { tags },
  };
}

describe('groupTrackerItemsByTag (tag board columns)', () => {
  it('creates one column per distinct tag, ordered by count then name', () => {
    const items = [
      makeItem('1', ['frontend', 'urgent']),
      makeItem('2', ['frontend']),
      makeItem('3', ['backend', 'frontend']),
      makeItem('4', ['urgent']),
    ];
    const cols = groupTrackerItemsByTag(items);
    // frontend(3), urgent(2), backend(1)
    expect(cols.map((c) => c.tag)).toEqual(['frontend', 'urgent', 'backend']);
    expect(cols[0].items.map((i) => i.id)).toEqual(['1', '2', '3']);
  });

  it('places an item with multiple tags in every matching column', () => {
    const cols = groupTrackerItemsByTag([makeItem('1', ['a', 'b', 'c'])]);
    expect(cols.map((c) => c.tag).sort()).toEqual(['a', 'b', 'c']);
    for (const col of cols) {
      expect(col.items.map((i) => i.id)).toEqual(['1']);
    }
  });

  it('collects untagged items into a trailing Untagged column', () => {
    const items = [makeItem('1', ['x']), makeItem('2', []), makeItem('3', undefined)];
    const cols = groupTrackerItemsByTag(items);
    const last = cols[cols.length - 1];
    expect(last.tag).toBeNull();
    expect(last.label).toBe('Untagged');
    expect(last.items.map((i) => i.id)).toEqual(['2', '3']);
  });

  it('omits the Untagged column when every item has a tag', () => {
    const cols = groupTrackerItemsByTag([makeItem('1', ['x'])]);
    expect(cols.some((c) => c.tag === null)).toBe(false);
  });

  it('breaks count ties alphabetically by tag name', () => {
    const cols = groupTrackerItemsByTag([makeItem('1', ['zebra']), makeItem('2', ['apple'])]);
    expect(cols.map((c) => c.tag)).toEqual(['apple', 'zebra']);
  });
});
