import { describe, it, expect } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { TrackerIdentity } from '@nimbalyst/runtime';
import {
  countFilteredTrackerItemsByTypes,
  filterTrackerItems,
  groupTrackerItems,
  normalizeViewDefinition,
  createDefaultViewDefinition,
  mergeSavedViews,
  parseSharedSavedView,
  serializeSharedSavedView,
  type SavedView,
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

const me: TrackerIdentity = {
  email: 'me@example.com',
  displayName: 'Me',
  gitName: null,
  gitEmail: null,
};

const other: TrackerIdentity = {
  email: 'other@example.com',
  displayName: 'Other',
  gitName: null,
  gitEmail: null,
};

describe('filterTrackerItems', () => {
  it('counts archived items in a type after applying the active row filters', () => {
    const identity: TrackerIdentity = {
      email: 'me@example.com',
      displayName: 'Me',
      gitName: null,
      gitEmail: null,
    };
    const matching = {
      ...makeItem('matching', { owner: 'me@example.com', priority: 'high', tags: ['ui'] }),
      archived: true,
      system: {
        ...makeItem('matching-system', {}).system,
        origin: {
          kind: 'external' as const,
          external: {
            providerId: 'github-issues',
            externalId: '1',
            urn: 'github://owner/repo#1',
            url: 'https://github.com/owner/repo/issues/1',
            titleSnapshot: 'Matching issue',
            importedAt: '2026-07-01T00:00:00.000Z',
            lastSyncedAt: '2026-07-01T00:00:00.000Z',
          },
        },
      },
    };
    const items = [
      matching,
      makeItem('active', { owner: 'me@example.com', priority: 'high', tags: ['ui'] }),
      { ...matching, id: 'other-owner', fields: { ...matching.fields, owner: 'other@example.com' } },
      { ...matching, id: 'low-priority', fields: { ...matching.fields, priority: 'low' } },
      { ...matching, id: 'other-tag', fields: { ...matching.fields, tags: ['backend'] } },
      { ...matching, id: 'native', system: { ...matching.system, origin: undefined } },
      { ...matching, id: 'other-type', primaryType: 'bug', typeTags: ['bug'] },
    ];

    expect(countFilteredTrackerItemsByTypes(
      items,
      ['task'],
      {
        activeFilters: ['archived', 'mine', 'high-priority'],
        tagFilter: ['ui'],
        sourceFilter: ['github-issues'],
      },
      { identity },
    )).toBe(1);
  });

  it('counts unassigned items across every type in a folder', () => {
    const items = [
      makeItem('task', {}),
      makeItem('bug', {}, 'bug'),
      makeItem('assigned', { owner: 'someone@example.com' }, 'bug'),
      makeItem('secondary-type', {}, 'plan'),
      makeItem('outside-folder', {}, 'idea'),
    ];
    items[3].typeTags.push('task');

    expect(countFilteredTrackerItemsByTypes(
      items,
      ['task', 'bug'],
      { activeFilters: ['unassigned'], tagFilter: [], sourceFilter: [] },
    )).toBe(3);
  });

  it('applies the recently-updated cap inside the requested type scope', () => {
    const tasks = Array.from({ length: 51 }, (_, index) => ({
      ...makeItem(`task-${index}`, {}),
      system: {
        ...makeItem(`task-system-${index}`, {}).system,
        updatedAt: new Date(2026, 0, index + 1).toISOString(),
      },
    }));
    const newerBugs = Array.from({ length: 50 }, (_, index) => ({
      ...makeItem(`bug-${index}`, {}, 'bug'),
      system: {
        ...makeItem(`bug-system-${index}`, {}).system,
        updatedAt: new Date(2027, 0, index + 1).toISOString(),
      },
    }));

    expect(countFilteredTrackerItemsByTypes(
      [...newerBugs, ...tasks],
      ['task'],
      { activeFilters: ['recently-updated'], tagFilter: [], sourceFilter: [] },
    )).toBe(50);
  });

  it('filters by the high-priority chip', () => {
    const items = [
      makeItem('1', { priority: 'critical' }),
      makeItem('2', { priority: 'low' }),
      makeItem('3', { priority: 'high' }),
    ];
    const out = filterTrackerItems(items, { activeFilters: ['high-priority'], tagFilter: [] });
    expect(out.map((i) => i.id)).toEqual(['1', '3']);
  });

  it('filters favorites while preserving the incoming order', () => {
    const items = [makeItem('1', {}), makeItem('2', {}), makeItem('3', {})];
    const out = filterTrackerItems(
      items,
      { activeFilters: ['favorites'], tagFilter: [] },
      { favoriteItemIds: new Set(['3', '1']) },
    );
    expect(out.map((i) => i.id)).toEqual(['1', '3']);
  });

  it('sorts genuinely viewed items newest-first within the selected lookback', () => {
    const nowMs = Date.UTC(2026, 6, 16);
    const day = 24 * 60 * 60 * 1000;
    const items = [makeItem('old', {}), makeItem('new', {}), makeItem('outside', {}), makeItem('never', {})];
    const out = filterTrackerItems(
      items,
      { activeFilters: ['recently-viewed'], tagFilter: [], recentlyViewedDays: 30 },
      {
        nowMs,
        viewedAtByItemId: new Map([
          ['old', nowMs - 30 * day],
          ['new', nowMs - day],
          ['outside', nowMs - 30 * day - 1],
        ]),
      },
    );
    expect(out.map((i) => i.id)).toEqual(['new', 'old']);
  });

  it('supports any-time genuinely viewed items', () => {
    const out = filterTrackerItems(
      [makeItem('a', {}), makeItem('b', {})],
      { activeFilters: ['recently-viewed'], tagFilter: [], recentlyViewedDays: null },
      { nowMs: 10_000, viewedAtByItemId: new Map([['a', 1]]) },
    );
    expect(out.map((i) => i.id)).toEqual(['a']);
  });

  it('filters recently edited by a known other actor and sorts by edit time', () => {
    const items = [
      { ...makeItem('older', {}), system: { ...makeItem('older-system', {}).system, updatedAt: '2026-07-01T00:00:00.000Z', lastModifiedBy: other } },
      { ...makeItem('newer', {}), system: { ...makeItem('newer-system', {}).system, updatedAt: '2026-07-02T00:00:00.000Z', lastModifiedBy: other } },
    ];
    const out = filterTrackerItems(
      items,
      { activeFilters: ['recently-edited-by-others'], tagFilter: [] },
      { identity: me },
    );
    expect(out.map((i) => i.id)).toEqual(['newer', 'older']);
  });

  it('falls back to the newest attributed activity, including creation and agents', () => {
    const agent: TrackerIdentity = { email: null, displayName: 'Nimbalyst Agent', gitName: null, gitEmail: null };
    const items = [
      {
        ...makeItem('activity', {}),
        system: {
          ...makeItem('activity-system', {}).system,
          activity: [
            { id: 'old', authorIdentity: other, action: 'updated' as const, timestamp: 10 },
            { id: 'new', authorIdentity: agent, action: 'created' as const, timestamp: 20 },
          ],
        },
      },
    ];
    const out = filterTrackerItems(
      items,
      { activeFilters: ['recently-edited-by-others'], tagFilter: [] },
      { identity: me },
    );
    expect(out.map((i) => i.id)).toEqual(['activity']);
  });

  it('excludes self edits and unknown attribution from edited-by-others', () => {
    const self = { ...makeItem('self', {}), system: { ...makeItem('self-system', {}).system, updatedAt: '2026-07-02T00:00:00.000Z', lastModifiedBy: me } };
    const unknown = { ...makeItem('unknown', {}), system: { ...makeItem('unknown-system', {}).system, updatedAt: '2026-07-03T00:00:00.000Z', lastModifiedBy: null } };
    const emptyActor = {
      ...makeItem('empty-actor', {}),
      system: {
        ...makeItem('empty-system', {}).system,
        activity: [{ id: 'empty', authorIdentity: { email: null, displayName: '', gitName: null, gitEmail: null }, action: 'created' as const, timestamp: 30 }],
      },
    };
    const out = filterTrackerItems(
      [self, unknown, emptyActor],
      { activeFilters: ['recently-edited-by-others'], tagFilter: [] },
      { identity: me },
    );
    expect(out).toEqual([]);
  });

  it('applies boolean, tag, and source predicates before a recency cap', () => {
    const items: TrackerRecord[] = Array.from({ length: 60 }, (_, index) => {
      const item = makeItem(String(index), { priority: 'high', tags: index >= 55 ? ['ui'] : ['other'] });
      return {
        ...item,
        system: {
          ...item.system,
          updatedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
          origin: index >= 55 ? undefined : {
            kind: 'external' as const,
            external: {
              providerId: 'github-issues', externalId: String(index), urn: `github://${index}`,
              url: `https://example.com/${index}`, titleSnapshot: `Issue ${index}`,
              importedAt: '2026-01-01T00:00:00.000Z', lastSyncedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        },
      };
    });
    const out = filterTrackerItems(items, {
      activeFilters: ['high-priority', 'recently-updated'],
      tagFilter: ['ui'],
      sourceFilter: ['native'],
    });
    expect(out.map((i) => i.id)).toEqual(['59', '58', '57', '56', '55']);
  });

  it('counts favorites and recently viewed with the same personal context as rows', () => {
    const nowMs = Date.UTC(2026, 6, 16);
    const items = [makeItem('task-match', {}), makeItem('task-not-favorite', {}), makeItem('bug-match', {}, 'bug')];
    expect(countFilteredTrackerItemsByTypes(
      items,
      ['task'],
      { activeFilters: ['favorites', 'recently-viewed'], tagFilter: [], recentlyViewedDays: 7 },
      {
        nowMs,
        favoriteItemIds: new Set(['task-match', 'bug-match']),
        viewedAtByItemId: new Map([['task-match', nowMs], ['task-not-favorite', nowMs], ['bug-match', nowMs]]),
      },
    )).toBe(1);
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

  it('normalizes and round-trips sort and recently-viewed lookback fields', () => {
    const normalized = normalizeViewDefinition({
      sortBy: 'priority',
      sortDirection: 'asc',
      recentlyViewedDays: 90,
    });
    expect(normalizeViewDefinition(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized);
    expect(normalized).toMatchObject({
      sortBy: 'priority',
      sortDirection: 'asc',
      recentlyViewedDays: 90,
    });
  });
});

describe('view definitions capture full table state', () => {
  it('defaults column layout, filters, and inbox scope to null', () => {
    const def = createDefaultViewDefinition();
    expect(def.columnConfig).toBeNull();
    expect(def.columnFilters).toBeNull();
    expect(def.inboxScope).toBeNull();
  });

  it('round-trips a captured column layout and filter set', () => {
    const def = normalizeViewDefinition({
      columnConfig: { visibleColumns: ['type', 'title'], columnWidths: { title: 320 }, groupBy: null },
      columnFilters: { combinator: 'or', clauses: [{ field: 'status', op: '=', value: 'done' }] },
      inboxScope: 'global',
    });
    expect(def.columnConfig).toEqual({
      visibleColumns: ['type', 'title'],
      columnWidths: { title: 320 },
      groupBy: null,
    });
    expect(def.columnFilters).toEqual({
      combinator: 'or',
      clauses: [{ field: 'status', op: '=', value: 'done' }],
    });
    expect(def.inboxScope).toBe('global');
  });

  it('rejects a column config with no columns rather than hiding every column', () => {
    expect(normalizeViewDefinition({ columnConfig: { visibleColumns: [] } as any }).columnConfig).toBeNull();
    expect(normalizeViewDefinition({ columnConfig: 'nonsense' as any }).columnConfig).toBeNull();
  });

  it('drops malformed clauses but keeps an explicitly empty set (clears on apply)', () => {
    // A present `clauses` array means the view was saved WITH the feature, so a
    // view with no (usable) filters resolves to an empty set that CLEARS filters
    // on apply -- never to legacy null, which would leave stale filters active.
    expect(normalizeViewDefinition({ columnFilters: { clauses: [{ nope: 1 }] } as any }).columnFilters)
      .toEqual({ combinator: 'and', clauses: [] });
    expect(normalizeViewDefinition({ columnFilters: { clauses: [] } as any }).columnFilters)
      .toEqual({ combinator: 'and', clauses: [] });
  });

  it('leaves older views without captured layout untouched', () => {
    // A view saved before column capture existed must not clobber the current
    // table state on restore -- absent (not empty) columnFilters reads as legacy.
    const def = normalizeViewDefinition({ selectedType: 'bug', viewMode: 'list' });
    expect(def.columnConfig).toBeNull();
    expect(def.columnFilters).toBeNull();
    // A non-object columnFilters is unparseable and also treated as legacy.
    expect(normalizeViewDefinition({ columnFilters: 'nonsense' as any }).columnFilters).toBeNull();
  });
});

describe('shared saved views', () => {
  const localView = (id: string, name: string): SavedView => ({
    id,
    name,
    definition: { ...createDefaultViewDefinition(), selectedType: 'bug' },
  });

  it('round-trips a view through the shared payload', () => {
    const view = localView('v1', 'Sprint 7 bugs');
    const parsed = parseSharedSavedView({ viewId: 'v1', payload: serializeSharedSavedView(view) });
    expect(parsed).toEqual({ ...view, shared: true });
  });

  it('normalizes a peer payload written by an older client', () => {
    const parsed = parseSharedSavedView({
      viewId: 'v2',
      payload: JSON.stringify({ name: 'Old view', definition: { selectedType: 'task' } }),
    });
    expect(parsed?.definition.selectedType).toBe('task');
    // Fields the older client never wrote fall back to defaults rather than undefined.
    expect(parsed?.definition.columnConfig).toBeNull();
    expect(parsed?.definition.sortBy).toBe(createDefaultViewDefinition().sortBy);
  });

  it('drops payloads it cannot make sense of instead of failing the whole list', () => {
    expect(parseSharedSavedView({ viewId: 'v3', payload: 'not json' })).toBeNull();
    expect(parseSharedSavedView({ viewId: 'v3', payload: '[]' })).toBeNull();
    expect(parseSharedSavedView({ viewId: 'v3', payload: '{"definition":{}}' })).toBeNull();
    expect(parseSharedSavedView({ viewId: '', payload: '{"name":"x"}' })).toBeNull();
  });

  it('merges local and shared views, with the shared copy winning on id collision', () => {
    const shared = { ...localView('v1', 'Team name'), shared: true };
    const merged = mergeSavedViews([localView('v1', 'My name'), localView('v2', 'Local only')], [shared]);
    expect(merged.map((v) => v.name)).toEqual(['Local only', 'Team name']);
    expect(merged.find((v) => v.id === 'v1')?.shared).toBe(true);
  });

  it('clears a stale shared flag on a view that is no longer shared', () => {
    const stale: SavedView = { ...localView('v9', 'Was shared'), shared: true };
    expect(mergeSavedViews([stale], [])[0].shared).toBe(false);
  });
});
