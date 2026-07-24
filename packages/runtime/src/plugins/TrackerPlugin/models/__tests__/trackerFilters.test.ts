import { describe, it, expect } from 'vitest';
import {
  matchesClause,
  matchesFilterSet,
  applyFilterSet,
  isClauseComplete,
  opsForFieldType,
  withFieldClauses,
  withoutFieldClauses,
  clausesForField,
  hasActiveFilters,
  type TrackerFieldFilter,
} from '../trackerFilters';

describe('matchesClause', () => {
  it('compares equality case-insensitively', () => {
    expect(matchesClause('In Progress', { field: 's', op: '=', value: 'in progress' })).toBe(true);
    expect(matchesClause('done', { field: 's', op: '=', value: 'open' })).toBe(false);
    expect(matchesClause('done', { field: 's', op: '!=', value: 'open' })).toBe(true);
  });

  it('handles contains and its negation', () => {
    expect(matchesClause('Crash on save', { field: 't', op: 'contains', value: 'crash' })).toBe(true);
    expect(matchesClause('Crash on save', { field: 't', op: 'not-contains', value: 'kanban' })).toBe(true);
    expect(matchesClause('Crash on save', { field: 't', op: 'not-contains', value: 'crash' })).toBe(false);
  });

  it('matches one-of against scalars and arrays', () => {
    expect(matchesClause('bug', { field: 'type', op: 'in', value: ['bug', 'task'] })).toBe(true);
    expect(matchesClause('idea', { field: 'type', op: 'in', value: ['bug', 'task'] })).toBe(false);
    // An array value matches if ANY element is in the allowed set.
    expect(matchesClause(['ui', 'sync'], { field: 'tags', op: 'in', value: ['sync'] })).toBe(true);
    expect(matchesClause(['ui'], { field: 'tags', op: 'not-in', value: ['sync'] })).toBe(true);
  });

  it('requires an array operand for in / not-in rather than matching everything', () => {
    expect(matchesClause('bug', { field: 'type', op: 'in', value: 'bug' })).toBe(false);
  });

  it('searches inside array values for contains', () => {
    expect(matchesClause(['ui', 'sync'], { field: 'tags', op: 'contains', value: 'syn' })).toBe(true);
  });

  it('compares relationship values by their item id', () => {
    const value = [{ itemId: 'b1', title: 'Crash' }];
    expect(matchesClause(value, { field: 'items', op: 'contains', value: 'b1' })).toBe(true);
    expect(matchesClause(value, { field: 'items', op: 'in', value: ['b1', 'b2'] })).toBe(true);
  });

  it('orders numbers and dates', () => {
    expect(matchesClause(8, { field: 'points', op: '>', value: 5 })).toBe(true);
    expect(matchesClause(5, { field: 'points', op: '>=', value: 5 })).toBe(true);
    expect(matchesClause(3, { field: 'points', op: '<', value: 5 })).toBe(true);
    expect(matchesClause('2026-07-23', { field: 'due', op: '>', value: '2026-07-01' })).toBe(true);
    expect(matchesClause('2026-06-01', { field: 'due', op: '>', value: '2026-07-01' })).toBe(false);
  });

  it('refuses to match an ordered comparison it cannot evaluate', () => {
    // A range against non-numeric text must exclude, never silently include.
    expect(matchesClause('not a number', { field: 'points', op: '>', value: 5 })).toBe(false);
    expect(matchesClause(undefined, { field: 'points', op: '<', value: 5 })).toBe(false);
  });

  it('supports between with either bound order', () => {
    expect(matchesClause(5, { field: 'points', op: 'between', value: [1, 10] })).toBe(true);
    expect(matchesClause(5, { field: 'points', op: 'between', value: [10, 1] })).toBe(true);
    expect(matchesClause(50, { field: 'points', op: 'between', value: [1, 10] })).toBe(false);
    expect(matchesClause(5, { field: 'points', op: 'between', value: [1] })).toBe(false);
  });

  it('treats blank strings and empty arrays as empty', () => {
    expect(matchesClause('', { field: 'x', op: 'is-empty' })).toBe(true);
    expect(matchesClause('   ', { field: 'x', op: 'is-empty' })).toBe(true);
    expect(matchesClause([], { field: 'x', op: 'is-empty' })).toBe(true);
    expect(matchesClause(undefined, { field: 'x', op: 'is-empty' })).toBe(true);
    expect(matchesClause('set', { field: 'x', op: 'is-not-empty' })).toBe(true);
    // `false` is a real value, not an empty one.
    expect(matchesClause(false, { field: 'x', op: 'is-empty' })).toBe(false);
  });
});

describe('isClauseComplete', () => {
  it('accepts unary operators with no value', () => {
    expect(isClauseComplete({ field: 'x', op: 'is-empty' })).toBe(true);
  });

  it('rejects clauses still missing their operand', () => {
    expect(isClauseComplete({ field: 'x', op: '=' })).toBe(false);
    expect(isClauseComplete({ field: 'x', op: '=', value: '' })).toBe(false);
    expect(isClauseComplete({ field: 'x', op: 'in', value: [] })).toBe(false);
    expect(isClauseComplete({ field: 'x', op: 'between', value: [1] })).toBe(false);
    expect(isClauseComplete({ field: '', op: '=', value: 'a' })).toBe(false);
  });
});

describe('matchesFilterSet', () => {
  const values: Record<string, unknown> = { status: 'done', points: 8, tags: ['ui'] };
  const get = (f: string) => values[f];

  it('ands clauses by default', () => {
    expect(matchesFilterSet({ clauses: [
      { field: 'status', op: '=', value: 'done' },
      { field: 'points', op: '>', value: 5 },
    ] }, get)).toBe(true);

    expect(matchesFilterSet({ clauses: [
      { field: 'status', op: '=', value: 'done' },
      { field: 'points', op: '>', value: 50 },
    ] }, get)).toBe(false);
  });

  it('ors when asked', () => {
    expect(matchesFilterSet({ combinator: 'or', clauses: [
      { field: 'status', op: '=', value: 'open' },
      { field: 'points', op: '>', value: 5 },
    ] }, get)).toBe(true);
  });

  it('matches everything when there are no clauses', () => {
    expect(matchesFilterSet(undefined, get)).toBe(true);
    expect(matchesFilterSet({ clauses: [] }, get)).toBe(true);
  });

  it('ignores half-built clauses instead of blanking the result', () => {
    // A column filter the user opened but has not filled in yet.
    expect(matchesFilterSet({ clauses: [{ field: 'status', op: '=' }] }, get)).toBe(true);
  });
});

describe('applyFilterSet', () => {
  const items = [
    { id: 'a', fields: { status: 'done', points: 8 } },
    { id: 'b', fields: { status: 'open', points: 2 } },
  ];
  const get = (item: (typeof items)[number], field: string) => (item.fields as any)[field];

  it('filters a list', () => {
    const result = applyFilterSet(items, { clauses: [{ field: 'status', op: '=', value: 'done' }] }, get);
    expect(result.map(i => i.id)).toEqual(['a']);
  });

  it('returns the original list untouched when nothing is filtered', () => {
    expect(applyFilterSet(items, undefined, get)).toBe(items);
  });
});

describe('per-column clause helpers', () => {
  const set = { clauses: [
    { field: 'status', op: '=', value: 'done' },
    { field: 'points', op: '>', value: 5 },
  ] as TrackerFieldFilter[] };

  it('reads clauses for one column', () => {
    expect(clausesForField(set, 'status')).toEqual([{ field: 'status', op: '=', value: 'done' }]);
  });

  it('replaces one column without disturbing the others', () => {
    const next = withFieldClauses(set, 'status', [{ field: 'status', op: '=', value: 'open' }]);
    expect(clausesForField(next, 'status')).toEqual([{ field: 'status', op: '=', value: 'open' }]);
    expect(clausesForField(next, 'points')).toEqual([{ field: 'points', op: '>', value: 5 }]);
  });

  it('clears one column', () => {
    const next = withoutFieldClauses(set, 'status');
    expect(clausesForField(next, 'status')).toEqual([]);
    expect(next.clauses).toHaveLength(1);
  });

  it('reports whether any complete filter is active', () => {
    expect(hasActiveFilters(set)).toBe(true);
    expect(hasActiveFilters({ clauses: [{ field: 'status', op: '=' }] })).toBe(false);
    expect(hasActiveFilters(undefined)).toBe(false);
  });
});

describe('opsForFieldType', () => {
  it('offers choice operators for select and range operators for numbers', () => {
    expect(opsForFieldType('select')).toContain('in');
    expect(opsForFieldType('number')).toContain('between');
    expect(opsForFieldType('date')).toContain('>');
    expect(opsForFieldType('boolean')).toEqual(['=', 'is-empty', 'is-not-empty']);
    expect(opsForFieldType('string')).toContain('contains');
  });

  it('always offers emptiness checks', () => {
    for (const type of ['string', 'number', 'select', 'multiselect', 'date', 'boolean', 'relationship'] as const) {
      expect(opsForFieldType(type)).toContain('is-empty');
    }
  });
});
