/**
 * Per-column filter editor for the tracker grid.
 *
 * Edits the clauses for a single column in the shared `{field, op, value}`
 * language, so what a user builds here is the same object saved into a view,
 * queried by the CLI, or passed to `tracker_list`.
 */

import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  useFloating,
  offset,
  flip,
  shift,
  FloatingPortal,
  useDismiss,
  useRole,
  useInteractions,
} from '@floating-ui/react';
import type { FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  opsForFieldType,
  OP_LABELS,
  UNARY_OPS,
  type TrackerFieldFilter,
  type TrackerFilterOp,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

interface TrackerColumnFilterPopoverProps {
  /** Column being filtered. */
  columnId: string;
  columnLabel: string;
  /** Schema field behind the column; drives which operators are offered. */
  field: FieldDefinition | undefined;
  /** Clauses currently applied to this column. */
  clauses: TrackerFieldFilter[];
  /** How every active column-filter clause combines. */
  combinator: 'and' | 'or';
  /** Header cell rect the popover anchors to. */
  anchorRect: DOMRect;
  onApply: (clauses: TrackerFieldFilter[], combinator: 'and' | 'or') => void;
  onClose: () => void;
}

/** Split a comma-separated entry into the list operand `in` / `not-in` expect. */
function parseListValue(text: string): string[] {
  return text.split(',').map(v => v.trim()).filter(Boolean);
}

interface DraftClause {
  op: TrackerFilterOp;
  text: string;
}

function valueText(clause: TrackerFieldFilter | undefined): string {
  if (clause?.value === undefined) return '';
  return Array.isArray(clause.value) ? clause.value.join(', ') : String(clause.value);
}

function completeClause(columnId: string, draft: DraftClause): TrackerFieldFilter | null {
  if (UNARY_OPS.has(draft.op)) return { field: columnId, op: draft.op };
  if (draft.op === 'in' || draft.op === 'not-in') {
    const values = parseListValue(draft.text);
    return values.length > 0 ? { field: columnId, op: draft.op, value: values } : null;
  }
  if (draft.op === 'between') {
    const [low, high] = parseListValue(draft.text);
    return low !== undefined && high !== undefined
      ? { field: columnId, op: draft.op, value: [low, high] }
      : null;
  }
  return draft.text.trim()
    ? { field: columnId, op: draft.op, value: draft.text }
    : null;
}

export function TrackerColumnFilterPopover({
  columnId,
  columnLabel,
  field,
  clauses,
  combinator: initialCombinator,
  anchorRect,
  onApply,
  onClose,
}: TrackerColumnFilterPopoverProps): JSX.Element {
  const ops = useMemo(() => opsForFieldType(field?.type), [field?.type]);
  const [combinator, setCombinator] = useState<'and' | 'or'>(initialCombinator);
  const [drafts, setDrafts] = useState<DraftClause[]>(() =>
    clauses.length > 0
      ? clauses.map(clause => ({ op: clause.op, text: valueText(clause) }))
      : [{ op: ops[0], text: '' }],
  );

  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: open => { if (!open) onClose(); },
    placement: 'bottom-start',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  // Virtual anchor pinned to the header cell that was clicked.
  useEffect(() => {
    refs.setReference({ getBoundingClientRect: () => anchorRect });
  }, [anchorRect, refs]);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const selectOptions = field?.options ?? [];

  const apply = (): void => {
    onApply(
      drafts
        .map(draft => completeClause(columnId, draft))
        .filter((clause): clause is TrackerFieldFilter => clause !== null),
      combinator,
    );
    onClose();
  };

  const clear = (): void => {
    onApply([], combinator);
    onClose();
  };

  const updateDraft = (index: number, updates: Partial<DraftClause>): void => {
    setDrafts(current => current.map((draft, i) => i === index ? { ...draft, ...updates } : draft));
  };

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        {...getFloatingProps()}
        className="tracker-column-filter-popover z-50 w-72 rounded-md border border-nim bg-nim-secondary p-2 shadow-lg text-[13px]"
        data-testid="tracker-column-filter-popover"
      >
        <div className="mb-2 text-[11px] font-medium text-nim-muted">Filter: {columnLabel}</div>

        <label className="mb-1 flex items-center justify-between gap-2 text-[11px] text-nim-muted">
          Match
          <select
            className="rounded border border-nim bg-nim px-2 py-1 text-nim"
            value={combinator}
            onChange={e => setCombinator(e.target.value as 'and' | 'or')}
            data-testid="tracker-column-filter-combinator"
          >
            <option value="and">all conditions</option>
            <option value="or">any condition</option>
          </select>
        </label>
        {/* The combinator is one setting for the whole grid, not per column, so
            say so -- otherwise flipping it here silently changes how every other
            column's filter combines too. */}
        <div className="mb-2 text-[10px] leading-tight text-nim-faint">
          Applies across every column filter, not just this one.
        </div>

        {drafts.map((draft, index) => {
          const isUnary = UNARY_OPS.has(draft.op);
          const isList = draft.op === 'in' || draft.op === 'not-in';
          const isRange = draft.op === 'between';
          return (
            <div key={index} className="mb-2 rounded border border-nim p-1.5">
              <div className="flex items-center gap-1">
                <select
                  className="min-w-0 flex-1 rounded border border-nim bg-nim px-2 py-1 text-nim"
                  value={draft.op}
                  onChange={e => updateDraft(index, { op: e.target.value as TrackerFilterOp })}
                  data-testid={`tracker-column-filter-op-${index}`}
                >
                  {ops.map(o => (
                    <option key={o} value={o}>{OP_LABELS[o]}</option>
                  ))}
                </select>
                {drafts.length > 1 && (
                  <button
                    className="px-1 text-nim-muted hover:text-nim"
                    onClick={() => setDrafts(current => current.filter((_, i) => i !== index))}
                    aria-label={`Remove condition ${index + 1}`}
                  >
                    ×
                  </button>
                )}
              </div>

              {!isUnary && (
                selectOptions.length > 0 && !isList && !isRange ? (
                  <select
                    className="mt-1.5 w-full rounded border border-nim bg-nim px-2 py-1 text-nim"
                    value={draft.text}
                    onChange={e => updateDraft(index, { text: e.target.value })}
                    data-testid={`tracker-column-filter-value-${index}`}
                  >
                    <option value="">Choose…</option>
                    {selectOptions.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="mt-1.5 w-full rounded border border-nim bg-nim px-2 py-1 text-nim"
                    value={draft.text}
                    autoFocus={index === 0}
                    placeholder={
                      isRange ? 'from, to'
                        : isList ? 'comma-separated values'
                          : 'value'
                    }
                    onChange={e => updateDraft(index, { text: e.target.value })}
                    onKeyDown={e => {
                      if (e.key === 'Enter') apply();
                      if (e.key === 'Escape') onClose();
                    }}
                    data-testid={`tracker-column-filter-value-${index}`}
                  />
                )
              )}
            </div>
          );
        })}

        <button
          className="mb-2 text-[11px] text-nim-muted hover:text-nim"
          onClick={() => setDrafts(current => [...current, { op: ops[0], text: '' }])}
          data-testid="tracker-column-filter-add"
        >
          + Add condition
        </button>

        <div className="flex items-center justify-between gap-2">
          <button
            className="text-[11px] text-nim-muted hover:text-nim"
            onClick={clear}
            data-testid="tracker-column-filter-clear"
          >
            Clear
          </button>
          <button
            className="rounded bg-[var(--nim-primary)] px-2 py-1 text-[11px] font-medium text-white hover:opacity-90"
            onClick={apply}
            data-testid="tracker-column-filter-apply"
          >
            Apply
          </button>
        </div>
      </div>
    </FloatingPortal>
  );
}
