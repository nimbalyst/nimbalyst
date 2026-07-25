import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  DisplayOptionsPanel,
  type TrackerColumnDef,
  type TypeColumnConfig,
} from '@nimbalyst/runtime/plugins/TrackerPlugin';
import {
  isClauseComplete,
  opsForFieldType,
  OP_LABELS,
  UNARY_OPS,
  type FieldType,
  type TrackerFieldFilter,
  type TrackerFilterOp,
  type TrackerFilterSet,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { TrackerFilterValueMenu } from './TrackerFilterValueMenu';

export interface TrackerFilterField {
  id: string;
  label: string;
  type?: FieldType;
  options?: Array<{
    value: string;
    label: string;
    count?: number;
    color?: string;
    icon?: string;
  }>;
  group?: 'common' | 'custom' | 'system';
}

interface TrackerViewHeaderControlsProps {
  itemCount: number;
  availableColumns: TrackerColumnDef[];
  columnConfig: TypeColumnConfig;
  onColumnConfigChange: (config: TypeColumnConfig) => void;
  showColumnControls: boolean;
  filterFields: TrackerFilterField[];
  filters: TrackerFilterSet | null;
  onFiltersChange: (filters: TrackerFilterSet) => void;
  openFiltersToken?: number;
}

function firstClause(fields: TrackerFilterField[]): TrackerFieldFilter {
  const field = fields[0];
  const op = opsForFieldType(field?.type)[0];
  return { field: field?.id ?? '', op };
}

function valueAsText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function inputType(field: TrackerFilterField | undefined): 'date' | 'number' | 'text' {
  if (field?.type === 'date' || field?.type === 'datetime') return 'date';
  if (field?.type === 'number') return 'number';
  return 'text';
}

function iconForField(field: TrackerFilterField): string {
  const key = `${field.id} ${field.label}`.toLowerCase();
  if (key.includes('status')) return 'progress_activity';
  if (key.includes('priority')) return 'signal_cellular_alt';
  if (key.includes('assignee') || key.includes('owner') || field.type === 'user') return 'person';
  if (key.includes('tag') || key.includes('label')) return 'sell';
  if (key.includes('relation') || field.type === 'relationship' || field.type === 'reference') return 'account_tree';
  if (key.includes('date') || key.includes('created') || key.includes('updated')) return 'calendar_today';
  if (key.includes('type')) return 'category';
  if (key.includes('source') || key.includes('module')) return 'deployed_code';
  if (field.type === 'boolean') return 'toggle_on';
  if (field.type === 'number') return 'numbers';
  if (field.type === 'array' || field.type === 'multiselect') return 'list';
  return 'text_fields';
}

function filterValueLabel(value: unknown): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

type FilterMenuMode = 'fields' | 'field' | 'advanced';

export function TrackerViewHeaderControls({
  itemCount,
  availableColumns,
  columnConfig,
  onColumnConfigChange,
  showColumnControls,
  filterFields,
  filters,
  onFiltersChange,
  openFiltersToken = 0,
}: TrackerViewHeaderControlsProps): JSX.Element {
  const [showFilters, setShowFilters] = useState(false);
  const [showDisplayOptions, setShowDisplayOptions] = useState(false);
  const [menuMode, setMenuMode] = useState<FilterMenuMode>('fields');
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [selectedFieldRect, setSelectedFieldRect] = useState<DOMRect | null>(null);
  const [quickOp, setQuickOp] = useState<TrackerFilterOp>('=');
  const [quickValue, setQuickValue] = useState<unknown>('');
  const [combinator, setCombinator] = useState<'and' | 'or'>(filters?.combinator ?? 'and');
  const [draftClauses, setDraftClauses] = useState<TrackerFieldFilter[]>(
    filters?.clauses.length ? filters.clauses : [firstClause(filterFields)],
  );
  const filterRootRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  const activeFilterCount = useMemo(
    () => (filters?.clauses ?? []).filter(isClauseComplete).length,
    [filters],
  );
  const selectedField = useMemo(
    () => filterFields.find(field => field.id === selectedFieldId),
    [filterFields, selectedFieldId],
  );
  const matchingFields = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return filterFields;
    return filterFields.filter(field =>
      field.label.toLowerCase().includes(normalizedQuery)
      || field.id.toLowerCase().includes(normalizedQuery));
  }, [filterFields, query]);
  useEffect(() => {
    if (!showFilters) return;
    setMenuMode('fields');
    setQuery('');
    setHighlightedIndex(0);
    setSelectedFieldId(null);
    setSelectedFieldRect(null);
    setCombinator(filters?.combinator ?? 'and');
    setDraftClauses(filters?.clauses.length ? filters.clauses : [firstClause(filterFields)]);
  }, [filterFields, filters, showFilters]);

  useEffect(() => {
    if (openFiltersToken <= 0) return;
    setShowDisplayOptions(false);
    setShowFilters(true);
  }, [openFiltersToken]);

  useEffect(() => {
    if (!showFilters) return;
    const closeOnOutsideClick = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (
        !filterRootRef.current?.contains(target)
        && !submenuRef.current?.contains(target)
      ) {
        setShowFilters(false);
      }
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [showFilters]);

  const updateClause = (index: number, updates: Partial<TrackerFieldFilter>): void => {
    setDraftClauses(current =>
      current.map((clause, clauseIndex) =>
        clauseIndex === index ? { ...clause, ...updates } : clause));
  };

  const applyFilters = (): void => {
    onFiltersChange({
      combinator,
      clauses: draftClauses.filter(isClauseComplete),
    });
    setShowFilters(false);
  };

  const openField = (field: TrackerFilterField, anchorRect?: DOMRect): void => {
    setSelectedFieldId(field.id);
    setSelectedFieldRect(anchorRect ?? null);
    setQuickOp(opsForFieldType(field.type)[0]);
    setQuickValue('');
    setMenuMode('field');
  };

  const applyQuickFilter = (value = quickValue): void => {
    if (!selectedField) return;
    let clause: TrackerFieldFilter;
    if (UNARY_OPS.has(quickOp)) {
      clause = { field: selectedField.id, op: quickOp };
    } else if (quickOp === 'in' || quickOp === 'not-in') {
      const values = Array.isArray(value)
        ? value
        : String(value).split(',').map(item => item.trim()).filter(Boolean);
      clause = { field: selectedField.id, op: quickOp, value: values };
    } else if (quickOp === 'between') {
      clause = {
        field: selectedField.id,
        op: quickOp,
        value: Array.isArray(value) ? value : ['', ''],
      };
    } else {
      clause = { field: selectedField.id, op: quickOp, value };
    }
    if (!isClauseComplete(clause)) return;
    onFiltersChange({
      combinator: filters?.combinator ?? 'and',
      clauses: [...(filters?.clauses ?? []).filter(isClauseComplete), clause],
    });
    setMenuMode('fields');
    setSelectedFieldId(null);
    setSelectedFieldRect(null);
    setQuickValue('');
  };

  const removeActiveFilter = (index: number): void => {
    onFiltersChange({
      combinator: filters?.combinator ?? 'and',
      clauses: (filters?.clauses ?? []).filter((_, clauseIndex) => clauseIndex !== index),
    });
  };

  return (
    <div
      className="tracker-view-header-controls flex shrink-0 items-center gap-1.5"
      data-testid="tracker-view-header-controls"
    >
      <span
        className="min-w-8 text-right text-[11px] tabular-nums text-nim-faint"
        data-testid="tracker-view-item-count"
      >
        {itemCount} item{itemCount === 1 ? '' : 's'}
      </span>

      <div className="relative" ref={filterRootRef}>
        <button
          type="button"
          className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] font-medium transition-colors ${
            showFilters || activeFilterCount > 0
              ? 'border-nim-focus bg-nim-tertiary text-nim'
              : 'border-nim bg-nim-secondary text-nim-muted hover:bg-nim-tertiary hover:text-nim'
          }`}
          onClick={() => {
            setShowDisplayOptions(false);
            setShowFilters(open => !open);
          }}
          aria-expanded={showFilters}
          data-testid="tracker-view-filter-button"
        >
          <MaterialSymbol icon="filter_list" size={14} />
          Filter
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-[var(--nim-primary)] px-1.5 text-[10px] leading-4 text-white">
              {activeFilterCount}
            </span>
          )}
        </button>

        {showFilters && (
          <div
            className={`absolute right-0 top-full z-50 mt-1 max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-nim bg-nim-secondary shadow-xl ${
              menuMode === 'advanced' ? 'w-[620px]' : 'w-[360px]'
            }`}
            role="dialog"
            aria-label="Tracker filters"
            data-testid="tracker-filter-builder"
          >
            {menuMode !== 'advanced' && (
              <>
                <div className="relative border-b border-nim p-3">
                  <MaterialSymbol
                    icon="search"
                    size={17}
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-nim-faint"
                  />
                  <input
                    autoFocus
                    className="h-9 w-full rounded-md border border-transparent bg-transparent pl-8 pr-10 text-[15px] text-nim outline-none placeholder:text-nim-faint focus:border-nim-focus"
                    placeholder="Add filter…"
                    value={query}
                    onChange={event => {
                      setQuery(event.target.value);
                      setHighlightedIndex(0);
                    }}
                    onKeyDown={event => {
                      const itemCount = matchingFields.length + 1;
                      if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        setHighlightedIndex(index => Math.min(index + 1, itemCount - 1));
                      } else if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        setHighlightedIndex(index => Math.max(index - 1, 0));
                      } else if (event.key === 'Enter') {
                        event.preventDefault();
                        if (highlightedIndex === 0) setMenuMode('advanced');
                        else if (matchingFields[highlightedIndex - 1]) {
                          const field = matchingFields[highlightedIndex - 1];
                          const row = filterRootRef.current?.querySelector(
                            `[data-testid="tracker-filter-field-${field.id}"]`,
                          );
                          openField(field, row?.getBoundingClientRect());
                        }
                      } else if (event.key === 'Escape') {
                        setShowFilters(false);
                      }
                    }}
                    data-testid="tracker-filter-command-search"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 rounded border border-nim px-1.5 py-0.5 text-[10px] text-nim-faint">
                    F
                  </span>
                </div>

                {activeFilterCount > 0 && (
                  <div className="border-b border-nim px-2 py-2" data-testid="tracker-filter-active-list">
                    <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-nim-faint">
                      Active filters
                    </div>
                    {(filters?.clauses ?? []).map((clause, index) => {
                      if (!isClauseComplete(clause)) return null;
                      const field = filterFields.find(candidate => candidate.id === clause.field);
                      return (
                        <div
                          key={`${clause.field}-${index}`}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-nim"
                        >
                          <MaterialSymbol icon={iconForField(field ?? {
                            id: clause.field,
                            label: clause.field,
                          })} size={15} className="text-nim-faint" />
                          <span className="min-w-0 flex-1 truncate">
                            {field?.label ?? clause.field}{' '}
                            <span className="text-nim-muted">{OP_LABELS[clause.op]}</span>{' '}
                            {filterValueLabel(clause.value)}
                          </span>
                          <button
                            type="button"
                            className="rounded p-0.5 text-nim-faint hover:bg-nim-tertiary hover:text-nim"
                            onClick={() => removeActiveFilter(index)}
                            aria-label={`Remove ${field?.label ?? clause.field} filter`}
                          >
                            <MaterialSymbol icon="close" size={13} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="border-b border-nim p-2">
                  <button
                    type="button"
                    className={highlightedIndex === 0
                      ? 'flex w-full items-center gap-3 rounded-md bg-nim-tertiary px-3 py-2 text-left text-[14px] text-nim'
                      : 'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[14px] text-nim hover:bg-nim-tertiary'}
                    onMouseEnter={() => {
                      setHighlightedIndex(0);
                      setMenuMode('fields');
                      setSelectedFieldId(null);
                      setSelectedFieldRect(null);
                    }}
                    onClick={() => {
                      setMenuMode('advanced');
                      setSelectedFieldId(null);
                      setSelectedFieldRect(null);
                    }}
                    data-testid="tracker-filter-advanced"
                  >
                    <MaterialSymbol icon="filter_alt" size={19} className="text-nim-muted" />
                    <span className="flex-1">Advanced filter</span>
                  </button>
                </div>

                <div className="max-h-[430px] overflow-y-auto p-2">
                  {matchingFields.map((field, index) => {
                    const startsGroup = index > 0
                      && (field.group ?? 'common') !== (matchingFields[index - 1].group ?? 'common');
                    const commandIndex = index + 1;
                    return (
                      <div
                        key={field.id}
                        className={startsGroup ? 'mt-2 border-t border-nim pt-2' : ''}
                      >
                        <button
                          type="button"
                          className={selectedFieldId === field.id || highlightedIndex === commandIndex
                            ? 'flex w-full items-center gap-3 rounded-md bg-nim-tertiary px-3 py-2 text-left text-[14px] text-nim'
                            : 'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[14px] text-nim hover:bg-nim-tertiary'}
                          onMouseEnter={event => {
                            setHighlightedIndex(commandIndex);
                            openField(field, event.currentTarget.getBoundingClientRect());
                          }}
                          onClick={event => openField(field, event.currentTarget.getBoundingClientRect())}
                          data-testid={`tracker-filter-field-${field.id}`}
                        >
                          <MaterialSymbol icon={iconForField(field)} size={19} className="text-nim-muted" />
                          <span className="min-w-0 flex-1 truncate">{field.label}</span>
                          <MaterialSymbol icon="chevron_right" size={16} className="text-nim-faint" />
                        </button>
                      </div>
                    );
                  })}
                  {matchingFields.length === 0 && (
                    <div className="px-3 py-8 text-center text-[12px] text-nim-faint">
                      No matching fields
                    </div>
                  )}
                </div>
              </>
            )}

            {menuMode === 'advanced' && (
              <>
                <div className="flex items-center justify-between border-b border-nim px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 items-center justify-center rounded text-nim-muted hover:bg-nim-tertiary hover:text-nim"
                      onClick={() => setMenuMode('fields')}
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
                                type={inputType(field)}
                                className="min-w-0 flex-1 rounded border border-nim bg-nim-secondary px-2 py-1.5 text-xs text-nim outline-none focus:border-nim-focus"
                                value={valueAsText(range[0])}
                                placeholder="From"
                                onChange={event => updateClause(index, {
                                  value: [event.target.value, range[1]],
                                })}
                              />
                              <span className="text-[10px] text-nim-faint">to</span>
                              <input
                                type={inputType(field)}
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
                              type={inputType(field)}
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
                      setShowFilters(false);
                    }}
                    data-testid="tracker-filter-builder-clear"
                  >
                    Clear all
                  </button>
                  <button
                    type="button"
                    className="rounded bg-[var(--nim-primary)] px-3 py-1 text-[11px] font-medium text-white hover:opacity-90"
                    onClick={applyFilters}
                    data-testid="tracker-filter-builder-apply"
                  >
                    Apply filters
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {showFilters && menuMode === 'field' && selectedField && (
          <TrackerFilterValueMenu
            field={selectedField}
            anchorRect={selectedFieldRect}
            placement="left"
            onSelect={applyQuickFilter}
            onClose={() => {
              setMenuMode('fields');
              setSelectedFieldId(null);
              setSelectedFieldRect(null);
            }}
            dismissOnOutsideClick={false}
            menuRef={submenuRef}
          />
        )}
      </div>

      {showColumnControls && (
        <div className="relative">
          <button
            type="button"
            className={`inline-flex h-7 w-7 items-center justify-center rounded border transition-colors ${
              showDisplayOptions
                ? 'border-nim-focus bg-nim-tertiary text-nim'
                : 'border-nim bg-nim-secondary text-nim-muted hover:bg-nim-tertiary hover:text-nim'
            }`}
            onClick={() => {
              setShowFilters(false);
              setShowDisplayOptions(open => !open);
            }}
            title="Display options"
            aria-label="Display options"
            aria-expanded={showDisplayOptions}
            data-testid="tracker-view-display-options"
          >
            <MaterialSymbol icon="tune" size={15} />
          </button>
          {showDisplayOptions && (
            <DisplayOptionsPanel
              availableColumns={availableColumns}
              config={columnConfig}
              onConfigChange={onColumnConfigChange}
              onClose={() => setShowDisplayOptions(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
