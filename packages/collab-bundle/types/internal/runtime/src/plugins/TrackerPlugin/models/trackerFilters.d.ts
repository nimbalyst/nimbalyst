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
import type { FieldType } from '../../../../../tracker-schema/src/browser';
/**
 * Comparison operators.
 *
 * `=`, `!=`, `contains`, and `in` are the original `tracker_list` operators and
 * keep their exact semantics; the rest extend the language for the grid's
 * column filters (ranges, emptiness, negation).
 */
export type TrackerFilterOp = '=' | '!=' | 'contains' | 'not-contains' | 'in' | 'not-in' | '>' | '>=' | '<' | '<=' | 'between' | 'in-last' | 'not-in-last' | 'is-current-user' | 'is-not-current-user' | 'is-empty' | 'is-not-empty';
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
export declare const UNARY_OPS: ReadonlySet<TrackerFilterOp>;
export interface TrackerFilterEvaluationContext {
    /** Identity-like value for relative person predicates. */
    currentUser?: unknown;
    /** Injectable clock for deterministic relative-date evaluation. */
    nowMs?: number;
}
/** Human labels for the column-filter menu. */
export declare const OP_LABELS: Record<TrackerFilterOp, string>;
/** Operators worth offering for a field type, in menu order. */
export declare function opsForFieldType(type: FieldType | undefined): TrackerFilterOp[];
/**
 * Evaluate one clause against an already-resolved field value.
 *
 * Comparisons are case-insensitive, matching how `tracker_list` already filters
 * status and priority. An operator that cannot be evaluated (a range against
 * non-numeric text, say) returns `false` rather than silently matching -- a
 * filter the user set must never widen the result set.
 */
export declare function matchesClause(value: unknown, clause: TrackerFieldFilter, context?: TrackerFilterEvaluationContext): boolean;
/** Whether a clause is complete enough to evaluate. */
export declare function isClauseComplete(clause: TrackerFieldFilter): boolean;
/**
 * Evaluate a whole filter set against one record.
 *
 * Incomplete clauses (a column filter the user has opened but not filled in)
 * are skipped rather than treated as false, so a half-built filter doesn't
 * blank the grid.
 */
export declare function matchesFilterSet(set: TrackerFilterSet | null | undefined, getValue: (field: string) => unknown, context?: TrackerFilterEvaluationContext): boolean;
/** Filter a list with a filter set, given an accessor for each item's fields. */
export declare function applyFilterSet<T>(items: T[], set: TrackerFilterSet | null | undefined, getValue: (item: T, field: string) => unknown, context?: TrackerFilterEvaluationContext): T[];
/** Drop clauses for a column, used when a column filter is cleared. */
export declare function withoutFieldClauses(set: TrackerFilterSet | null | undefined, field: string): TrackerFilterSet;
/** Replace all clauses for one column, leaving other columns' clauses intact. */
export declare function withFieldClauses(set: TrackerFilterSet | null | undefined, field: string, clauses: TrackerFieldFilter[]): TrackerFilterSet;
/** Clauses currently applied to one column. */
export declare function clausesForField(set: TrackerFilterSet | null | undefined, field: string): TrackerFieldFilter[];
/** Whether any complete clause is active, for "filters applied" affordances. */
export declare function hasActiveFilters(set: TrackerFilterSet | null | undefined): boolean;
