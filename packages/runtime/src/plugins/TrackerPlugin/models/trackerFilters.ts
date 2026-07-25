/**
 * The shared tracker filter language.
 *
 * One `{ field, op, value }` vocabulary backs the grid's per-column filters,
 * saved views, the `nim` CLI, and the `tracker_list` MCP tool -- so a filter a
 * user builds in the UI is literally the same object an agent can query with.
 *
 * Pure and I/O-free: evaluation works against a value accessor, so it applies
 * equally to a `TrackerRecord` (schema `fields` bag) and to the flattened item
 * shape the MCP tools hand back.
 */

import type { FieldType } from './TrackerDataModel';

/**
 * Comparison operators.
 *
 * `=`, `!=`, `contains`, and `in` are the original `tracker_list` operators and
 * keep their exact semantics; the rest extend the language for the grid's
 * column filters (ranges, emptiness, negation).
 */
export type TrackerFilterOp =
  | '='
  | '!='
  | 'contains'
  | 'not-contains'
  | 'in'
  | 'not-in'
  | '>'
  | '>='
  | '<'
  | '<='
  | 'between'
  | 'is-empty'
  | 'is-not-empty';

export interface TrackerFieldFilter {
  /** Schema field name (or structural column id) the clause applies to. */
  field: string;
  op: TrackerFilterOp;
  /** Omitted for `is-empty` / `is-not-empty`; a 2-tuple for `between`. */
  value?: unknown;
}

export interface TrackerFilterSet {
  /** How clauses combine. Defaults to `and` when absent. */
  combinator?: 'and' | 'or';
  clauses: TrackerFieldFilter[];
}

/** Operators that carry no operand. */
export const UNARY_OPS: ReadonlySet<TrackerFilterOp> = new Set(['is-empty', 'is-not-empty']);

/** Human labels for the column-filter menu. */
export const OP_LABELS: Record<TrackerFilterOp, string> = {
  '=': 'is',
  '!=': 'is not',
  'contains': 'contains',
  'not-contains': 'does not contain',
  'in': 'is any of',
  'not-in': 'is none of',
  '>': 'is after / greater than',
  '>=': 'is at or after',
  '<': 'is before / less than',
  '<=': 'is at or before',
  'between': 'is between',
  'is-empty': 'is empty',
  'is-not-empty': 'is not empty',
};

const TEXT_OPS: TrackerFilterOp[] = ['=', '!=', 'contains', 'not-contains', 'is-empty', 'is-not-empty'];
const CHOICE_OPS: TrackerFilterOp[] = ['=', '!=', 'in', 'not-in', 'is-empty', 'is-not-empty'];
const NUMERIC_OPS: TrackerFilterOp[] = ['=', '!=', '>', '>=', '<', '<=', 'between', 'is-empty', 'is-not-empty'];
const BOOLEAN_OPS: TrackerFilterOp[] = ['=', 'is-empty', 'is-not-empty'];
const COLLECTION_OPS: TrackerFilterOp[] = ['contains', 'not-contains', 'in', 'is-empty', 'is-not-empty'];

/** Operators worth offering for a field type, in menu order. */
export function opsForFieldType(type: FieldType | undefined): TrackerFilterOp[] {
  switch (type) {
    case 'select':
    case 'user':
      return CHOICE_OPS;
    case 'multiselect':
    case 'array':
    case 'relationship':
    case 'reference':
      return COLLECTION_OPS;
    case 'number':
    case 'date':
    case 'datetime':
      return NUMERIC_OPS;
    case 'boolean':
      return BOOLEAN_OPS;
    case 'string':
    case 'text':
    case 'url':
    default:
      return TEXT_OPS;
  }
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Flatten a stored value into the comparable strings it should match on. */
function toComparableStrings(value: unknown): string[] {
  if (isEmptyValue(value)) return [];
  if (Array.isArray(value)) return value.flatMap(toComparableStrings);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Relationship values and url values carry their identity on a known key.
    const identity = obj.itemId ?? obj.issueKey ?? obj.url ?? obj.title;
    return identity === undefined ? [] : [String(identity)];
  }
  return [String(value)];
}

/** Coerce a value for ordered comparison; dates compare as epoch millis. */
function toComparableNumber(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? undefined : date.getTime();
  }
  return undefined;
}

function equalsIgnoringCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Evaluate one clause against an already-resolved field value.
 *
 * Comparisons are case-insensitive, matching how `tracker_list` already filters
 * status and priority. An operator that cannot be evaluated (a range against
 * non-numeric text, say) returns `false` rather than silently matching -- a
 * filter the user set must never widen the result set.
 */
export function matchesClause(value: unknown, clause: TrackerFieldFilter): boolean {
  const { op } = clause;

  if (op === 'is-empty') return isEmptyValue(value);
  if (op === 'is-not-empty') return !isEmptyValue(value);

  const actuals = toComparableStrings(value);

  switch (op) {
    case '=':
      return actuals.some(a => equalsIgnoringCase(a, String(clause.value ?? '')))
        || (isEmptyValue(value) && isEmptyValue(clause.value));
    case '!=':
      return !actuals.some(a => equalsIgnoringCase(a, String(clause.value ?? '')));

    case 'contains': {
      const needle = String(clause.value ?? '').toLowerCase();
      return actuals.some(a => a.toLowerCase().includes(needle));
    }
    case 'not-contains': {
      const needle = String(clause.value ?? '').toLowerCase();
      return !actuals.some(a => a.toLowerCase().includes(needle));
    }

    case 'in': {
      if (!Array.isArray(clause.value)) return false;
      const allowed = clause.value.map(v => String(v).toLowerCase());
      return actuals.some(a => allowed.includes(a.toLowerCase()));
    }
    case 'not-in': {
      if (!Array.isArray(clause.value)) return false;
      const blocked = clause.value.map(v => String(v).toLowerCase());
      return !actuals.some(a => blocked.includes(a.toLowerCase()));
    }

    case '>':
    case '>=':
    case '<':
    case '<=': {
      const actual = toComparableNumber(value);
      const operand = toComparableNumber(clause.value);
      if (actual === undefined || operand === undefined) return false;
      if (op === '>') return actual > operand;
      if (op === '>=') return actual >= operand;
      if (op === '<') return actual < operand;
      return actual <= operand;
    }

    case 'between': {
      if (!Array.isArray(clause.value) || clause.value.length !== 2) return false;
      const actual = toComparableNumber(value);
      const low = toComparableNumber(clause.value[0]);
      const high = toComparableNumber(clause.value[1]);
      if (actual === undefined || low === undefined || high === undefined) return false;
      // Accept the bounds in either order so a reversed range still reads sanely.
      return actual >= Math.min(low, high) && actual <= Math.max(low, high);
    }

    default:
      return false;
  }
}

/** Whether a clause is complete enough to evaluate. */
export function isClauseComplete(clause: TrackerFieldFilter): boolean {
  if (!clause.field || !clause.op) return false;
  if (UNARY_OPS.has(clause.op)) return true;
  if (clause.op === 'between') return Array.isArray(clause.value) && clause.value.length === 2;
  if (clause.op === 'in' || clause.op === 'not-in') {
    return Array.isArray(clause.value) && clause.value.length > 0;
  }
  return clause.value !== undefined && clause.value !== null && String(clause.value) !== '';
}

/**
 * Evaluate a whole filter set against one record.
 *
 * Incomplete clauses (a column filter the user has opened but not filled in)
 * are skipped rather than treated as false, so a half-built filter doesn't
 * blank the grid.
 */
export function matchesFilterSet(
  set: TrackerFilterSet | null | undefined,
  getValue: (field: string) => unknown,
): boolean {
  const clauses = (set?.clauses ?? []).filter(isClauseComplete);
  if (clauses.length === 0) return true;

  const combinator = set?.combinator ?? 'and';
  return combinator === 'or'
    ? clauses.some(clause => matchesClause(getValue(clause.field), clause))
    : clauses.every(clause => matchesClause(getValue(clause.field), clause));
}

/** Filter a list with a filter set, given an accessor for each item's fields. */
export function applyFilterSet<T>(
  items: T[],
  set: TrackerFilterSet | null | undefined,
  getValue: (item: T, field: string) => unknown,
): T[] {
  const clauses = (set?.clauses ?? []).filter(isClauseComplete);
  if (clauses.length === 0) return items;
  return items.filter(item => matchesFilterSet(set, field => getValue(item, field)));
}

/** Drop clauses for a column, used when a column filter is cleared. */
export function withoutFieldClauses(
  set: TrackerFilterSet | null | undefined,
  field: string,
): TrackerFilterSet {
  return {
    combinator: set?.combinator ?? 'and',
    clauses: (set?.clauses ?? []).filter(c => c.field !== field),
  };
}

/** Replace all clauses for one column, leaving other columns' clauses intact. */
export function withFieldClauses(
  set: TrackerFilterSet | null | undefined,
  field: string,
  clauses: TrackerFieldFilter[],
): TrackerFilterSet {
  const base = withoutFieldClauses(set, field);
  return { combinator: base.combinator, clauses: [...base.clauses, ...clauses] };
}

/** Clauses currently applied to one column. */
export function clausesForField(
  set: TrackerFilterSet | null | undefined,
  field: string,
): TrackerFieldFilter[] {
  return (set?.clauses ?? []).filter(c => c.field === field);
}

/** Whether any complete clause is active, for "filters applied" affordances. */
export function hasActiveFilters(set: TrackerFilterSet | null | undefined): boolean {
  return (set?.clauses ?? []).some(isClauseComplete);
}
