import type { JSX } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  isClauseComplete,
  OP_LABELS,
  UNARY_OPS,
  type TrackerFilterSet,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { TrackerFilterField } from './TrackerViewHeaderControls';

interface TrackerActiveFilterPillsProps {
  fields: TrackerFilterField[];
  filters: TrackerFilterSet | null;
  onManage: () => void;
  onRemove: (clauseIndex: number) => void;
}

function optionLabel(field: TrackerFilterField | undefined, value: unknown): string {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter(item => item !== undefined && item !== null && item !== '')
    .map(item => {
      const text = String(item);
      return field?.options?.find(option => option.value === text)?.label ?? text;
    })
    .join(', ');
}

export function TrackerActiveFilterPills({
  fields,
  filters,
  onManage,
  onRemove,
}: TrackerActiveFilterPillsProps): JSX.Element | null {
  const activeClauses = (filters?.clauses ?? [])
    .map((clause, clauseIndex) => ({ clause, clauseIndex }))
    .filter(({ clause }) => isClauseComplete(clause));
  if (activeClauses.length === 0) return null;

  return (
    <div
      className="flex min-w-0 max-w-[min(40vw,520px)] shrink items-center gap-1 overflow-x-auto [scrollbar-width:none]"
      data-testid="tracker-active-filter-pills"
    >
      {activeClauses.map(({ clause, clauseIndex }) => {
        const field = fields.find(candidate => candidate.id === clause.field);
        const value = UNARY_OPS.has(clause.op) ? '' : optionLabel(field, clause.value);
        return (
          <div
            key={`${clause.field}-${clauseIndex}`}
            className="flex h-6 shrink-0 items-center overflow-hidden rounded-full border border-nim bg-nim-secondary text-[11px] text-nim-muted"
            data-testid={`tracker-active-filter-pill-${clauseIndex}`}
          >
            <button
              type="button"
              className="flex h-full items-center gap-1.5 px-2 hover:bg-nim-tertiary hover:text-nim"
              onClick={onManage}
              title="Manage filters"
            >
              <span className="font-medium text-nim">{field?.label ?? clause.field}</span>
              <span className="text-nim-faint">{OP_LABELS[clause.op]}</span>
              {value && <span className="max-w-36 truncate">{value}</span>}
            </button>
            <button
              type="button"
              className="inline-flex h-full w-6 items-center justify-center border-l border-nim text-nim-faint hover:bg-nim-tertiary hover:text-nim"
              onClick={() => onRemove(clauseIndex)}
              aria-label={`Remove ${field?.label ?? clause.field} filter`}
            >
              <MaterialSymbol icon="close" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
