/**
 * The multi-clause filter builder behind the header's "Advanced filter" entry.
 *
 * It edits a draft copy of the clause set and only publishes on Apply, so a
 * half-typed clause never reaches the view. The draft seeds from the active
 * filters at mount, which is why the caller renders it only while the advanced
 * mode is open -- reopening restarts from what is actually applied.
 */

import type { JSX } from 'react';
import { useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  isClauseComplete,
  opsForFieldType,
  OP_LABELS,
  UNARY_OPS,
  type TrackerFieldFilter,
  type TrackerFilterOp,
  type TrackerFilterSet,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { TrackerFilterField } from './trackerFilterFields';

export interface TrackerAdvancedFilterBuilderProps {
  filterFields: TrackerFilterField[];
  filters: TrackerFilterSet | null;
  onFiltersChange: (filters: TrackerFilterSet) => void;
  /** Back to the field command menu. */
  onBack: () => void;
  /** Close the whole filter menu (after applying or clearing). */
  onClose: () => void;
}

export function firstClause(fields: TrackerFilterField[]): TrackerFieldFilter {
  const field = fields[0];
  const op = opsForFieldType(field?.type)[0];
  return { field: field?.id ?? '', op };
}

function valueAsText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function inputType(
  field: TrackerFilterField | undefined,
  op?: TrackerFilterOp,
): 'date' | 'number' | 'text' {
  if (op === 'in-last' || op === 'not-in-last') return 'number';
  if (field?.type === 'date' || field?.type === 'datetime') return 'date';
  if (field?.type === 'number') return 'number';
  return 'text';
}

export function TrackerAdvancedFilterBuilder({
  filterFields,
  filters,
  onFiltersChange,
  onBack,
  onClose,
}: TrackerAdvancedFilterBuilderProps): JSX.Element {
  const [combinator, setCombinator] = useState<'and' | 'or'>(filters?.combinator ?? 'and');
  const [draftClauses, setDraftClauses] = useState<TrackerFieldFilter[]>(
    filters?.clauses.length ? filters.clauses : [firstClause(filterFields)],
  );

  const updateClause = (index: number, updates: Partial<TrackerFieldFilter>): void => {
    setDraftClauses(current =>
      current.map((clause, clauseIndex) =>
        clauseIndex === index ? { ...clause, ...updates } : clause));
  };

  return (
    <div className="tracker-advanced-filter-builder">
      <div className="flex items-center justify-between border-b border-nim px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded text-nim-muted hover:bg-nim-tertiary hover:text-nim"
            onClick={onBack}
            aria-label="Back to filter fields"
          >
            <MaterialSymbol icon="arrow_back" size={16} />
          </button>
          <span className="text-xs font-semibold text-nim">Advanced filter</span>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-nim-muted">
          Match
          <select
            className="rounded border border-nim bg-nim px-2 py-1 text-nim"
            value={combinator}
            onChange={event => setCombinator(event.target.value as 'and' | 'or')}
            data-testid="tracker-filter-builder-combinator"
          >
            <option value="and">all filters</option>
            <option value="or">any filter</option>
          </select>
        </label>
      </div>

      <div className="max-h-[360px] space-y-1.5 overflow-y-auto p-2">
        {draftClauses.map((clause, index) => {
          const field = filterFields.find(candidate => candidate.id === clause.field);
          const operators = opsForFieldType(field?.type);
          const isUnary = UNARY_OPS.has(clause.op);
          const isList = clause.op === 'in' || clause.op === 'not-in';
          const isRange = clause.op === 'between';
          const options = field?.options ?? [];
          const range = Array.isArray(clause.value) ? clause.value : ['', ''];

          return (
            <div
              key={index}
              className="grid grid-cols-[minmax(130px,1fr)_minmax(150px,1fr)_minmax(150px,1.25fr)_24px] items-center gap-1.5 rounded-md border border-nim bg-nim px-1.5 py-1.5"
              data-testid={`tracker-filter-builder-row-${index}`}
            >
              <select
                className="min-w-0 rounded border border-nim bg-nim-secondary px-2 py-1.5 text-xs text-nim outline-none focus:border-nim-focus"
                value={clause.field}
                onChange={event => {
                  const nextField = filterFields.find(candidate => candidate.id === event.target.value);
                  updateClause(index, {
                    field: event.target.value,
                    op: opsForFieldType(nextField?.type)[0],
                    value: undefined,
                  });
                }}
                aria-label={`Filter ${index + 1} field`}
                data-testid={`tracker-filter-builder-field-${index}`}
              >
                {!field ? <option value={clause.field}>{clause.field} (unavailable field)</option> : null}
                {filterFields.map(candidate => (
                  <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
                ))}
              </select>
              <select
                className="min-w-0 rounded border border-nim bg-nim-secondary px-2 py-1.5 text-xs text-nim outline-none focus:border-nim-focus"
                value={clause.op}
                onChange={event => updateClause(index, {
                  op: event.target.value as TrackerFilterOp,
                  value: undefined,
                })}
                aria-label={`Filter ${index + 1} operator`}
                data-testid={`tracker-filter-builder-op-${index}`}
              >
                {operators.map(operator => (
                  <option key={operator} value={operator}>{OP_LABELS[operator]}</option>
                ))}
              </select>
              <div className="min-w-0">
                {isUnary ? (
                  <span className="px-2 text-[11px] text-nim-faint">No value</span>
                ) : isRange ? (
                  <div className="flex items-center gap-1">
                    <input
                      type={inputType(field, clause.op)}
                      className="min-w-0 flex-1 rounded border border-nim bg-nim-secondary px-2 py-1.5 text-xs text-nim outline-none focus:border-nim-focus"
                      value={valueAsText(range[0])}
                      placeholder="From"
                      onChange={event => updateClause(index, {
                        value: [event.target.value, range[1]],
                      })}
                    />
                    <span className="text-[10px] text-nim-faint">to</span>
                    <input
                      type={inputType(field, clause.op)}
                      className="min-w-0 flex-1 rounded border border-nim bg-nim-secondary px-2 py-1.5 text-xs text-nim outline-none focus:border-nim-focus"
                      value={valueAsText(range[1])}
                      placeholder="To"
                      onChange={event => updateClause(index, {
                        value: [range[0], event.target.value],
                      })}
                    />
                  </div>
                ) : options.length > 0 && !isList ? (
                  <select
                    className="w-full rounded border border-nim bg-nim-secondary px-2 py-1.5 text-xs text-nim outline-none focus:border-nim-focus"
                    value={valueAsText(clause.value)}
                    onChange={event => updateClause(index, { value: event.target.value })}
                    data-testid={`tracker-filter-builder-value-${index}`}
                  >
                    <option value="">Choose…</option>
                    {options.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={inputType(field, clause.op)}
                    className="w-full rounded border border-nim bg-nim-secondary px-2 py-1.5 text-xs text-nim outline-none focus:border-nim-focus"
                    value={valueAsText(clause.value)}
                    placeholder={isList ? 'Comma-separated values' : 'Value'}
                    onChange={event => updateClause(index, {
                      value: isList
                        ? event.target.value.split(',').map(value => value.trim()).filter(Boolean)
                        : event.target.value,
                    })}
                    data-testid={`tracker-filter-builder-value-${index}`}
                  />
                )}
              </div>
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-nim-faint hover:bg-nim-tertiary hover:text-nim"
                onClick={() => setDraftClauses(current =>
                  current.length === 1
                    ? [firstClause(filterFields)]
                    : current.filter((_, clauseIndex) => clauseIndex !== index))}
                aria-label={`Remove filter ${index + 1}`}
              >
                <MaterialSymbol icon="close" size={14} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="inline-flex items-center gap-1 px-1 py-1 text-[11px] text-nim-muted hover:text-nim"
          onClick={() => setDraftClauses(current => [...current, firstClause(filterFields)])}
          data-testid="tracker-filter-builder-add"
        >
          <MaterialSymbol icon="add" size={13} />
          Add filter
        </button>
      </div>

      <div className="flex items-center justify-between border-t border-nim px-3 py-2">
        <button
          type="button"
          className="text-[11px] text-nim-muted hover:text-nim"
          onClick={() => {
            onFiltersChange({ combinator: 'and', clauses: [] });
            onClose();
          }}
          data-testid="tracker-filter-builder-clear"
        >
          Clear all
        </button>
        <button
          type="button"
          className="rounded bg-[var(--nim-primary)] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90"
          onClick={() => {
            onFiltersChange({ combinator, clauses: draftClauses.filter(isClauseComplete) });
            onClose();
          }}
          data-testid="tracker-filter-builder-apply"
        >
          Apply filters
        </button>
      </div>
    </div>
  );
}
