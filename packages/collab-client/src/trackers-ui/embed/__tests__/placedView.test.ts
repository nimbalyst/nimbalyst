// @vitest-environment node
/**
 * A placed view's definition comes from its link title, and its 2x2 places
 * items by two number fields.
 */

import { describe, expect, it, vi } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { quadrantData } from '../quadrantData';
import { CHART_CATEGORY, CHART_VALUE, chartData } from '../chartData';
import { placedViewDefinition } from '../placedViewDefinition';
import { parsePlacedViewHandoff } from '../../page/placedViewHandoff';

function competitor(id: string, fields: Record<string, unknown>): TrackerRecord {
  return {
    id, primaryType: 'competitor', typeTags: ['competitor'], source: 'native', archived: false, syncStatus: 'local',
    system: { workspace: '/w', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
    fields,
  } as unknown as TrackerRecord;
}

describe('quadrantData', () => {
  it('places items by two number fields, skips missing values, keeps pinned points', () => {
    const data = quadrantData(
      [
        competitor('sf', { title: 'Salesforce', devFirst: 0.15, realtime: 0.85 }),
        competitor('ph', { title: 'PostHog', devFirst: '0.9', realtime: 0.3 }),
        competitor('nx', { title: 'No score', devFirst: 0.5 }),
        competitor('bad', { title: 'Bad', devFirst: 'high', realtime: 0.2 }),
      ],
      { xField: 'devFirst', yField: 'realtime', pins: [{ label: 'UserCurrent', x: 0.85, y: 0.9 }] },
    );
    expect(data.points).toEqual([
      { id: 'sf', label: 'Salesforce', x: 0.15, y: 0.85, pinned: false },
      { id: 'ph', label: 'PostHog', x: 0.9, y: 0.3, pinned: false },
      { id: 'pin:0', label: 'UserCurrent', x: 0.85, y: 0.9, pinned: true },
    ]);
    expect(data.skipped).toBe(2);
  });
});

describe('placedViewDefinition', () => {
  it('round trips handoff expressions and refuses malformed query payloads', () => {
    const view = { label: 'Due soon', attrs: { mode: 'timeline', filter: 'due:<+7d', start: 'launchDate', custom: 'future' } };
    const query = new URLSearchParams({ view: JSON.stringify(view) });
    expect(parsePlacedViewHandoff(new URLSearchParams(query.toString()).get('view')!)).toEqual(view);
    for (const value of ['null', '{}', '[]', '{', JSON.stringify({ label: 'Bad', attrs: { mode: 1 } })]) expect(() => parsePlacedViewHandoff(value)).toThrow();
  });
  it('preserves explicit timeline fields and rejects unavailable or non-date fields', () => {
    const fields = [{ id: 'launch', label: 'Launch', type: 'date' as const }, { id: 'finish', label: 'Finish', type: 'datetime' as const }, { id: 'title', label: 'Title', type: 'string' as const }];
    expect(placedViewDefinition('task', '', { mode: 'timeline', start: 'launch', end: 'finish' }, fields).view.definition.timelineFields).toEqual({ start: 'launch', end: 'finish' });
    for (const start of ['missing', 'title']) expect(() => placedViewDefinition('task', '', { mode: 'timeline', start }, fields)).toThrow('timeline');
  });
  it('validates multiple sorts, widths and typed filter operators including relative dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
    try {
      const fields = [{ id: 'score', label: 'Score', type: 'number' as const }, { id: 'due', label: 'Due', type: 'date' as const }, { id: 'title', label: 'Title', type: 'string' as const }];
      const definition = placedViewDefinition('task', 'Tasks', { cols: 'title,score', sort: 'score:desc,title:asc', w: 'title:320,score:100', filter: 'score:>=2,due:<+7d,title:!empty' }, fields).view.definition;
      const due = new Date(); due.setDate(due.getDate() + 7); due.setHours(0, 0, 0, 0);
      expect(definition.sortColumns).toEqual([{ field: 'score', direction: 'desc' }, { field: 'title', direction: 'asc' }]);
      expect(definition.columnConfig?.columnWidths).toEqual({ title: 320, score: 100 });
      expect(definition.columnFilters?.clauses).toEqual([{ field: 'score', op: '>=', value: '2' }, { field: 'due', op: '<', value: due.toISOString() }, { field: 'title', op: 'is-not-empty' }]);
      const invalidAttrs: Record<string, string>[] = [{ sort: 'score:sideways' }, { sort: 'unknown:asc' }, { w: 'title:NaN' }, { scope: 'closed' }, { filter: 'title:>hello' }, { filter: 'score:!1|' }];
      for (const attrs of invalidAttrs) expect(() => placedViewDefinition('task', '', attrs, fields)).toThrow();
    } finally { vi.useRealTimers(); }
  });

  it('reads board, list and timeline layouts without discarding their grouping and lifecycle scope', () => {
    const board = placedViewDefinition('task', 'Tasks', { mode: 'board', group: 'priority', scope: 'open' });
    expect(board.view.definition).toMatchObject({ viewMode: 'kanban', groupBy: 'priority', ordering: 'manual', statusScope: 'open' });
    expect(placedViewDefinition('task', 'Tasks', { mode: 'timeline' }).view.definition.viewMode).toBe('timeline');
    expect(() => placedViewDefinition('task', 'Tasks', { mode: 'board', group: 'unknown' })).toThrow('Unsupported grouping');
  });

  it.each(['status', 'status:', ':open', 'status:open|', 'status:open,,tier:1', 'status:open,tier'])('refuses malformed filters instead of broadening the view: %s', (filter) => {
    expect(() => placedViewDefinition('competitor', 'Competitors', { filter })).toThrow(/Invalid filter/);
  });

  it('reads columns, sort and filters into a view of the type', () => {
    const placed = placedViewDefinition('competitor', 'Competitors', {
      cols: 'title,devFirst,realtime', sort: 'realtime:asc', filter: 'status:open|active,tier:1',
    });
    expect(placed.mode).toBe('table');
    expect(placed.view.name).toBe('Competitors');
    expect(placed.view.definition).toMatchObject({
      selectedType: 'competitor',
      viewMode: 'table',
      statusScope: 'all',
      sortBy: 'realtime',
      sortDirection: 'asc',
      columnConfig: { visibleColumns: ['title', 'devFirst', 'realtime'], columnWidths: {} },
      columnFilters: { combinator: 'and', clauses: [
        { field: 'status', op: 'in', value: ['open', 'active'] },
        { field: 'tier', op: '=', value: '1' },
      ] },
    });
  });

  it('reads a 2x2 with axis labels, quadrant labels and pins', () => {
    const placed = placedViewDefinition('competitor', 'Landscape', {
      mode: '2x2', x: 'devFirst', y: 'realtime',
      xl: 'Developer-first%2C%20open', yl: 'Realtime',
      q: 'Enterprise%20suites|Opportunity|Guidance|Dev-first',
      pin: 'UserCurrent@0.85,0.9;Bad@x,1',
    });
    expect(placed.mode).toBe('2x2');
    expect(placed.quadrant).toEqual({
      xField: 'devFirst', yField: 'realtime',
      xLabel: 'Developer-first, open', yLabel: 'Realtime',
      quadrants: ['Enterprise suites', 'Opportunity', 'Guidance', 'Dev-first'],
      pins: [{ label: 'UserCurrent', x: 0.85, y: 0.9 }],
    });
  });

  it('falls back to a table when a 2x2 names no axes', () => {
    expect(placedViewDefinition('competitor', 'C', { mode: '2x2' }).mode).toBe('table');
  });

  it('reads a chart and refuses a grouping or sum field it cannot chart', () => {
    const fields = [
      { id: 'tier', label: 'Tier', type: 'select' as const },
      { id: 'tags', label: 'Tags', type: 'select' as const, multiValue: true },
      { id: 'arr', label: 'ARR', type: 'number' as const },
    ];
    expect(placedViewDefinition('competitor', 'C', { mode: 'chart', by: 'tier', sum: 'arr', chart: 'pie' }, fields).chart)
      .toEqual({ type: 'pie', by: 'tier', sum: 'arr' });
    expect(placedViewDefinition('competitor', 'C', { mode: 'chart', by: 'tier' }, fields).chart).toEqual({ type: 'bar', by: 'tier' });
    expect(() => placedViewDefinition('competitor', 'C', { mode: 'chart', by: 'tags' }, fields)).toThrow('Cannot chart by "tags"');
    expect(() => placedViewDefinition('competitor', 'C', { mode: 'chart', by: 'tier', sum: 'tier' }, fields)).toThrow('Cannot sum "tier"');
    expect(() => placedViewDefinition('competitor', 'C', { mode: 'chart', by: 'tier', chart: 'radar' }, fields)).toThrow('Unknown chart type');
    // Starred and readiness depend on the viewer, which a chart's rows do not carry.
    const contextual = [...fields, { id: 'favorite', label: 'Starred', type: 'boolean' as const }];
    expect(() => placedViewDefinition('competitor', 'C', { mode: 'chart', by: 'favorite' }, contextual)).toThrow('Cannot chart by "favorite"');
  });
});

describe('chartData', () => {
  const tier = { id: 'tier', label: 'Tier', type: 'select', options: [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver' }, { value: 'bronze', label: 'Bronze' }] };
  const rows = (data: ReturnType<typeof chartData>) => data.map((row) => [row[CHART_CATEGORY], row[CHART_VALUE]]);

  it('counts or sums per bucket in option order, with the no-value bucket last', () => {
    const records = [
      competitor('a', { tier: 'silver', arr: 5 }),
      competitor('b', { tier: 'gold', arr: '7' }),
      competitor('c', { arr: 2 }),
      competitor('d', { tier: 'silver', arr: 'n/a' }),
    ];
    expect(rows(chartData(records, { by: tier }))).toEqual([['Gold', 1], ['Silver', 2], ['(none)', 1]]);
    expect(rows(chartData(records, { by: tier, sum: 'arr' }))).toEqual([['Gold', 7], ['Silver', 5], ['(none)', 2]]);
  });

  it('reads system fields through the shared accessor', () => {
    const record = competitor('a', {});
    const [[month, count], ...rest] = rows(chartData([record], { by: { id: 'created', type: 'date' } }));
    expect([rest, count]).toEqual([[], 1]);
    expect(month).toMatch(/^2026-0[89]$/);
  });

  it('keeps distinct people and options apart even when their labels match', () => {
    const records = [
      competitor('a', { owner: { displayName: 'Alex', email: 'alex@a.com' }, state: 'done' }),
      competitor('b', { owner: { displayName: 'Alex', email: 'ALEX@a.com' }, state: 'closed' }),
      competitor('c', { owner: { displayName: 'Alex', email: 'alex@b.com' }, state: 'done' }),
    ];
    expect(rows(chartData(records, { by: { id: 'owner', type: 'user' } }))).toEqual([
      ['Alex (alex@a.com)', 2], ['Alex (alex@b.com)', 1],
    ]);
    const state = { id: 'state', type: 'select', options: [{ value: 'done', label: 'Done' }, { value: 'closed', label: 'Done' }] };
    expect(rows(chartData(records, { by: state }))).toEqual([['Done (done)', 2], ['Done (closed)', 1]]);
  });

  it('buckets a datetime by the instant it names, a plain date by its calendar month', () => {
    const records = [
      competitor('a', { when: '2026-10-01T00:30:00+02:00', day: '2026-10-01' }),
      competitor('b', { when: '2026-09-30T22:30:00Z', day: '2026-09-30' }),
      competitor('c', { when: new Date('2026-09-30T22:30:00Z'), day: '2026-10-31' }),
    ];
    const byInstant = rows(chartData(records, { by: { id: 'when', type: 'datetime' } }));
    expect(byInstant).toHaveLength(1);
    expect(byInstant[0][1]).toBe(3);
    expect(rows(chartData(records, { by: { id: 'day', type: 'date' } }))).toEqual([['2026-09', 1], ['2026-10', 2]]);
  });

  it('charts a field named count without losing its categories', () => {
    const count = { id: 'count', type: 'select', options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }] };
    const data = chartData([competitor('a', { count: 'one' }), competitor('b', { count: 'two' })], { by: count });
    expect(rows(data)).toEqual([['One', 1], ['Two', 1]]);
  });
});
