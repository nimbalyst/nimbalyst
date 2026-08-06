import type { JSX, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FloatingPortal } from '@floating-ui/react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { TrackerFilterOp } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { TrackerFilterField } from './TrackerViewHeaderControls';

interface TrackerFilterValueMenuProps {
  field: TrackerFilterField;
  anchorRect: DOMRect | null;
  placement?: 'left' | 'below';
  selectedValues?: ReadonlySet<string>;
  onSelect: (value: string | string[] | number, op?: TrackerFilterOp) => void;
  onClear?: () => void;
  onClose: () => void;
  dismissOnOutsideClick?: boolean;
  menuRef?: RefObject<HTMLDivElement | null>;
  testIdPrefix?: 'tracker-filter' | 'tracker-column-filter';
}

function iconForField(field: TrackerFilterField): string {
  const key = `${field.id} ${field.label}`.toLowerCase();
  if (key.includes('favorite') || key.includes('starred')) return 'star';
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

export function TrackerFilterValueMenu({
  field,
  anchorRect,
  placement = 'left',
  selectedValues = new Set(),
  onSelect,
  onClear,
  onClose,
  dismissOnOutsideClick = true,
  menuRef,
  testIdPrefix = 'tracker-filter',
}: TrackerFilterValueMenuProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [relativeDays, setRelativeDays] = useState('7');
  // Arrow-key selection. Null means "nothing highlighted yet", so Enter keeps
  // its old meaning (commit the only match) until the user starts navigating.
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null);
  const [pendingValues, setPendingValues] = useState<Set<string>>(
    () => new Set(selectedValues),
  );
  const localRef = useRef<HTMLDivElement>(null);
  const allowsMultiple = field.type === 'array'
    || field.type === 'multiselect'
    || field.multiValue === true;
  const options = useMemo(() => {
    // A boolean field may name its own two values ("Starred" / "Not starred");
    // otherwise it falls back to the generic pair.
    if (field.type === 'boolean' && !field.options?.length) {
      return [
        { value: 'true', label: 'True' },
        { value: 'false', label: 'False' },
      ];
    }
    return field.options ?? [];
  }, [field]);
  const matchingOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter(option =>
      option.label.toLowerCase().includes(normalized)
      || option.value.toLowerCase().includes(normalized));
  }, [options, query]);
  const matchingOptionsWithIssues = useMemo(
    () => matchingOptions.filter(option =>
      selectedValues.has(option.value)
      || (option.count ?? 0) > 0
      || option.count === undefined),
    [matchingOptions, selectedValues],
  );
  const unmatchedOptionCount = useMemo(
    () => options.filter(option => option.count === 0).length,
    [options],
  );

  const toggleValue = (value: string): void => {
    setPendingValues(current => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  /**
   * The rows Arrow keys walk, in the order they are painted: the relative
   * person rows first (they are real filter choices, not decoration), then the
   * matching values.
   */
  const navigableRows = useMemo(() => {
    const rows: Array<{ key: string; activate: () => void }> = [];
    if (field.type === 'user') {
      rows.push({ key: 'relative-current-user', activate: () => onSelect('', 'is-current-user') });
      rows.push({ key: 'relative-not-current-user', activate: () => onSelect('', 'is-not-current-user') });
    }
    for (const option of matchingOptionsWithIssues) {
      rows.push({
        key: `option-${option.value}`,
        activate: () => (allowsMultiple ? toggleValue(option.value) : onSelect(option.value, '=')),
      });
    }
    // Enter toggles a multi-select row, so Apply needs its own stop on the tour
    // (Cmd/Ctrl+Enter is the shortcut for anyone who already knows it).
    if (allowsMultiple && pendingValues.size > 0) {
      rows.push({ key: 'apply', activate: () => onSelect(Array.from(pendingValues), 'in') });
    }
    return rows;
  }, [allowsMultiple, field.type, matchingOptionsWithIssues, onSelect, pendingValues]);

  const highlightedKey = highlightIndex === null ? null : navigableRows[highlightIndex]?.key ?? null;

  useEffect(() => {
    setQuery('');
    setRelativeDays('7');
    setHighlightIndex(null);
  }, [field.id]);

  // A narrowing query can strand the highlight past the end of the list.
  useEffect(() => {
    setHighlightIndex(current => (current === null
      ? null
      : navigableRows.length === 0 ? null : Math.min(current, navigableRows.length - 1)));
  }, [navigableRows.length]);

  useEffect(() => {
    if (!dismissOnOutsideClick) return;
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (!localRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [dismissOnOutsideClick, onClose]);

  const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight;
  const left = placement === 'left'
    ? Math.max(8, (anchorRect?.left ?? 376) - 368)
    : Math.max(8, Math.min(viewportWidth - 368, anchorRect?.left ?? 8));
  const top = placement === 'left'
    ? Math.max(8, Math.min(viewportHeight - 180, (anchorRect?.top ?? 180) - 86))
    : Math.max(8, Math.min(viewportHeight - 180, (anchorRect?.bottom ?? 40) + 6));

  return (
    <FloatingPortal>
      <div
        ref={(node) => {
          localRef.current = node;
          if (menuRef) menuRef.current = node;
        }}
        className="fixed z-[60] w-[360px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-nim bg-nim-secondary shadow-xl"
        style={{ left, top }}
        data-testid={`${testIdPrefix}-value-submenu`}
        data-tracker-filter-value-menu
      >
        {field.type !== 'date' && field.type !== 'datetime' && (
          <div className="relative border-b border-nim p-3">
            <input
              autoFocus={placement === 'below'}
              className="h-9 w-full rounded-md bg-transparent px-1 text-[15px] text-nim outline-none placeholder:text-nim-faint"
              placeholder="Filter…"
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  onClose();
                  return;
                }
                if (event.key === 'ArrowDown' && navigableRows.length > 0) {
                  event.preventDefault();
                  setHighlightIndex(current => (current === null
                    ? 0
                    : Math.min(current + 1, navigableRows.length - 1)));
                  return;
                }
                if (event.key === 'ArrowUp' && highlightIndex !== null) {
                  event.preventDefault();
                  setHighlightIndex(current => (current === null || current === 0 ? null : current - 1));
                  return;
                }
                if (event.key !== 'Enter') return;
                event.preventDefault();
                if ((event.metaKey || event.ctrlKey) && allowsMultiple && pendingValues.size > 0) {
                  onSelect(Array.from(pendingValues), 'in');
                  return;
                }
                if (highlightIndex !== null && navigableRows[highlightIndex]) {
                  navigableRows[highlightIndex].activate();
                  return;
                }
                if (allowsMultiple && pendingValues.size > 0) {
                  onSelect(Array.from(pendingValues), 'in');
                  return;
                }
                if (matchingOptionsWithIssues.length === 1) {
                  const value = matchingOptionsWithIssues[0].value;
                  if (allowsMultiple) toggleValue(value);
                  else onSelect(value, '=');
                  return;
                }
                // A field with no option list (free text, numbers) filters on
                // exactly what was typed -- Enter used to do nothing there.
                if (options.length === 0 && query.trim()) onSelect(query.trim(), '=');
              }}
              data-testid={`${testIdPrefix}-option-search`}
            />
          </div>
        )}

        {field.type === 'date' || field.type === 'datetime' ? (
          <div className="p-3">
            <div className="mb-2 flex items-center gap-2 text-[11px] text-nim-muted">
              <MaterialSymbol icon="calendar_today" size={15} />
              Relative days
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step={1}
                className="min-w-0 flex-1 rounded border border-nim bg-nim px-2 py-2 text-[13px] text-nim outline-none focus:border-nim-focus"
                value={relativeDays}
                onChange={event => setRelativeDays(event.target.value)}
                aria-label="Number of days"
                data-testid={`${testIdPrefix}-relative-days`}
              />
              <span className="text-[12px] text-nim-muted">days</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                className="rounded-md bg-[var(--nim-primary)] px-3 py-2 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40"
                disabled={!relativeDays || Number(relativeDays) < 0}
                onClick={() => onSelect(Number(relativeDays), 'in-last')}
                data-testid={`${testIdPrefix}-relative-in-last`}
              >
                In last
              </button>
              <button
                type="button"
                className="rounded-md border border-nim px-3 py-2 text-[12px] font-medium text-nim hover:bg-nim-tertiary disabled:opacity-40"
                disabled={!relativeDays || Number(relativeDays) < 0}
                onClick={() => onSelect(Number(relativeDays), 'not-in-last')}
                data-testid={`${testIdPrefix}-relative-not-in-last`}
              >
                Not in last
              </button>
            </div>
            {onClear && (
              <button
                type="button"
                className="mt-2 w-full px-3 py-1 text-[11px] text-nim-muted hover:text-nim"
                onClick={onClear}
                data-testid={`${testIdPrefix}-clear`}
              >
                Clear filter
              </button>
            )}
          </div>
        ) : options.length > 0 || field.type === 'user' ? (
          <>
            <div className="max-h-[360px] overflow-y-auto p-2">
              {field.type === 'user' && (
                <div className="mb-2 border-b border-nim pb-2">
                  <button
                    type="button"
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] text-nim hover:bg-nim-tertiary ${
                      highlightedKey === 'relative-current-user' ? 'bg-nim-tertiary' : ''
                    }`}
                    onClick={() => onSelect('', 'is-current-user')}
                    data-selected={highlightedKey === 'relative-current-user' ? 'true' : undefined}
                    data-testid={`${testIdPrefix}-relative-current-user`}
                  >
                    <MaterialSymbol icon="person" size={17} className="text-nim-muted" />
                    Is current user
                  </button>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] text-nim hover:bg-nim-tertiary ${
                      highlightedKey === 'relative-not-current-user' ? 'bg-nim-tertiary' : ''
                    }`}
                    onClick={() => onSelect('', 'is-not-current-user')}
                    data-selected={highlightedKey === 'relative-not-current-user' ? 'true' : undefined}
                    data-testid={`${testIdPrefix}-relative-not-current-user`}
                  >
                    <MaterialSymbol icon="person_off" size={17} className="text-nim-muted" />
                    Is not current user
                  </button>
                </div>
              )}
              {matchingOptionsWithIssues.map(option => {
                const selected = allowsMultiple
                  ? pendingValues.has(option.value)
                  : selectedValues.has(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] text-nim hover:bg-nim-tertiary ${
                      highlightedKey === `option-${option.value}` ? 'bg-nim-tertiary' : ''
                    }`}
                    onClick={() => {
                      if (!allowsMultiple) {
                        onSelect(option.value, '=');
                        return;
                      }
                      toggleValue(option.value);
                    }}
                    role={allowsMultiple ? 'checkbox' : 'radio'}
                    aria-checked={selected}
                    data-selected={highlightedKey === `option-${option.value}` ? 'true' : undefined}
                    data-testid={`${testIdPrefix}-option-${option.value}`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center border-2 ${
                        allowsMultiple ? 'rounded' : 'rounded-full'
                      } ${
                        selected ? 'bg-[var(--nim-primary)]' : ''
                      }`}
                      style={{ borderColor: selected ? 'var(--nim-primary)' : option.color ?? 'var(--nim-text-faint)' }}
                    >
                      {selected && <MaterialSymbol icon="check" size={10} className="text-white" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.count !== undefined && (
                      <span className="shrink-0 text-[12px] tabular-nums text-nim-faint">
                        {option.count} issue{option.count === 1 ? '' : 's'}
                      </span>
                    )}
                  </button>
                );
              })}
              {matchingOptionsWithIssues.length === 0 && field.type !== 'user' && (
                <div className="px-3 py-8 text-center text-[12px] text-nim-faint">
                  No matching values
                </div>
              )}
            </div>
            {(unmatchedOptionCount > 0 || onClear || allowsMultiple) && (
              <div className="flex items-center gap-3 border-t border-nim px-4 py-3 text-[13px] text-nim-muted">
                {unmatchedOptionCount > 0 && (
                  <>
                    <MaterialSymbol icon="progress_activity" size={17} className="text-nim-faint" />
                    <span className="flex-1">
                      {unmatchedOptionCount} option
                      {unmatchedOptionCount === 1 ? '' : 's'} not matching any issues
                    </span>
                  </>
                )}
                {onClear && (
                  <button
                    type="button"
                    className="ml-auto shrink-0 text-[12px] text-nim-muted hover:text-nim"
                    onClick={onClear}
                    data-testid={`${testIdPrefix}-clear`}
                  >
                    Clear filter
                  </button>
                )}
                {allowsMultiple && (
                  <button
                    type="button"
                    className={`ml-auto shrink-0 rounded bg-[var(--nim-primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40 ${
                      highlightedKey === 'apply' ? 'ring-2 ring-[var(--nim-primary)] ring-offset-1 ring-offset-[var(--nim-bg-secondary)]' : ''
                    }`}
                    data-selected={highlightedKey === 'apply' ? 'true' : undefined}
                    disabled={pendingValues.size === 0}
                    onClick={() => onSelect(Array.from(pendingValues), 'in')}
                    data-testid={`${testIdPrefix}-apply-multiple`}
                  >
                    Apply{pendingValues.size > 0 ? ` (${pendingValues.size})` : ''}
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="p-3">
            <div className="mb-2 flex items-center gap-2 text-[11px] text-nim-muted">
              <MaterialSymbol icon={iconForField(field)} size={15} />
              {field.label}
            </div>
            <button
              type="button"
              className="w-full rounded-md bg-[var(--nim-primary)] px-3 py-2 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40"
              disabled={!query.trim()}
              onClick={() => onSelect(query, '=')}
              data-testid={`${testIdPrefix}-quick-apply`}
            >
              Filter for “{query || '…'}”
            </button>
            {onClear && (
              <button
                type="button"
                className="mt-2 w-full px-3 py-1 text-[11px] text-nim-muted hover:text-nim"
                onClick={onClear}
                data-testid={`${testIdPrefix}-clear`}
              >
                Clear filter
              </button>
            )}
          </div>
        )}
      </div>
    </FloatingPortal>
  );
}
