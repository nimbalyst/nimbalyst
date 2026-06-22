import { describe, it, expect } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { TrackerIdentity } from '@nimbalyst/runtime';
import {
  filterTrackerItems,
  groupTrackerItems,
  normalizeViewDefinition,
  createDefaultViewDefinition,
} from '../trackerSavedViews';

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

describe('filterTrackerItems', () => {
  it('filters by the high-priority chip', () => {
    const items = [
      makeItem('1', { priority: 'critical' }),
      makeItem('2', { priority: 'low' }),
      makeItem('3', { priority: 'high' }),
    ];
    const out = filterTrackerItems(items, { activeFilters: ['high-priority'], tagFilter: [] });
    expect(out.map((i) => i.id)).toEqual(['1', '3']);
  });

  it('filters unassigned items (no assignee field)', () => {
    const items = [
      makeItem('1', { owner: 'alice@example.com' }),
      makeItem('2', {}),
    ];
    const out = filterTrackerItems(items, { activeFilters: ['unassigned'], tagFilter: [] });
    expect(out.map((i) => i.id)).toEqual(['2']);
  });

  it('filters "mine" using the identity context', () => {
    const identity: TrackerIdentity = {
      email: 'me@example.com',
      displayName: 'Me',
      gitName: null,
      gitEmail: null,
    };
    const items = [
      makeItem('1', { owner: 'me@example.com' }),
      makeItem('2', { owner: 'other@example.com' }),
    ];
    const out = filterTrackerItems(items, { activeFilters: ['mine'], tagFilter: [] }, { identity });
    expect(out.map((i) => i.id)).toEqual(['1']);
  });

  it('ignores "mine" when no identity is supplied', () => {
    const items = [makeItem('1', { owner: 'x' })];
    const out = filterTrackerItems(items, { activeFilters: ['mine'], tagFilter: [] });
    expect(out.map((i) => i.id)).toEqual(['1']);
  });

  it('applies tag filter and chips together (intersection)', () => {
    const items = [
      makeItem('1', { priority: 'high', tags: ['ui'] }),
      makeItem('2', { priority: 'high', tags: ['backend'] }),
      makeItem('3', { priority: 'low', tags: ['ui'] }),
    ];
    const out = filterTrackerItems(items, { activeFilters: ['high-priority'], tagFilter: ['ui'] });
    expect(out.map((i) => i.id)).toEqual(['1']);
  });
});

describe('groupTrackerItems', () => {
  it('returns a single "All" group for none', () => {
    const items = [makeItem('1', {}), makeItem('2', {})];
    const groups = groupTrackerItems(items, 'none');
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('All');
    expect(groups[0].items).toHaveLength(2);
  });

  it('groups by status with a title-cased label and a trailing None bucket', () => {
    const items = [
      makeItem('1', { status: 'in-progress' }),
      makeItem('2', { status: 'in-progress' }),
      makeItem('3', { status: '' }),
      makeItem('4', { status: 'done' }),
    ];
    const groups = groupTrackerItems(items, 'status');
    expect(groups.map((g) => g.label)).toEqual(['In Progress', 'Done', 'None']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['1', '2']);
    expect(groups[groups.length - 1].key).toBe('');
  });

  it('groups by assignee with an Unassigned fallback bucket', () => {
    const items = [
      makeItem('1', { owner: 'alice' }),
      makeItem('2', {}),
    ];
    const groups = groupTrackerItems(items, 'assignee');
    expect(groups.map((g) => g.label)).toEqual(['alice', 'Unassigned']);
  });

  it('groups by type using the primary type', () => {
    const items = [
      makeItem('1', {}, 'bug'),
      makeItem('2', {}, 'task'),
      makeItem('3', {}, 'bug'),
    ];
    const groups = groupTrackerItems(items, 'type');
    expect(groups.map((g) => g.key)).toEqual(['bug', 'task']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['1', '3']);
  });

  it('groups by tag, repeating multi-tag items and trailing Untagged', () => {
    const items = [
      makeItem('1', { tags: ['ui', 'urgent'] }),
      makeItem('2', { tags: [] }),
    ];
    const groups = groupTrackerItems(items, 'tag');
    expect(groups.map((g) => g.label)).toEqual(['#ui', '#urgent', 'Untagged']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['1']);
    expect(groups[2].items.map((i) => i.id)).toEqual(['2']);
  });
});

describe('normalizeViewDefinition', () => {
  it('fills defaults for missing fields', () => {
    expect(normalizeViewDefinition(undefined)).toEqual(createDefaultViewDefinition());
    expect(normalizeViewDefinition({ selectedType: 'bug' })).toEqual({
      ...createDefaultViewDefinition(),
      selectedType: 'bug',
    });
  });

  it('drops non-string tags', () => {
    const def = normalizeViewDefinition({ tagFilter: ['ok', 5 as unknown as string, 'fine'] });
    expect(def.tagFilter).toEqual(['ok', 'fine']);
  });
});
