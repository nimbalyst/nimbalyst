/**
 * Multi-select picker for a `label-ref` field (an item's labels).
 *
 * Labels come from the project's label registry and are shown as a tree: each
 * label sits under its first declared broader label, indented. A label the
 * item carries that the registry does not declare (a pending proposal, or a
 * typo from an agent) is listed first and flagged -- never dropped, because
 * dropping it on the next save would silently delete data.
 *
 * Renders inline; the chip popover that hosts it already owns positioning.
 * Loaded lazily by `TrackerFieldEditor`; reading a stored value is
 * `labelRefValue.ts`.
 */

import React, { useMemo, useState } from 'react';
import { globalRegistry, type LabelRegistry } from '@nimbalyst/tracker-schema';
import { MaterialSymbol } from '../../../ui/icons/MaterialSymbol';
import { labelRefIds } from './labelRefValue';

export interface LabelPickerRow {
  id: string;
  label: string;
  depth: number;
  /** False for a label the registry does not declare. */
  known: boolean;
  selected: boolean;
  description?: string;
  icon?: string;
  color?: string;
}

/**
 * Picker rows: unknown selected labels first, then the registry as a tree in
 * declaration order. A label with several broader labels appears once, under
 * the first one the registry declares.
 */
export function labelPickerRows(registry: LabelRegistry, selectedIds: readonly string[]): LabelPickerRow[] {
  const selected = new Set(selectedIds);
  const known = new Set(registry.labels.map(label => label.id));
  const children = new Map<string | null, string[]>();
  for (const label of registry.labels) {
    const parent = label.broader?.find(id => known.has(id) && id !== label.id) ?? null;
    children.set(parent, [...(children.get(parent) ?? []), label.id]);
  }
  const byId = new Map(registry.labels.map(label => [label.id, label]));
  const rows: LabelPickerRow[] = selectedIds
    .filter(id => !known.has(id))
    .map(id => ({ id, label: id, depth: 0, known: false, selected: true }));
  const visited = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (visited.has(id)) return;
    visited.add(id);
    const label = byId.get(id)!;
    rows.push({
      id,
      label: label.label,
      depth,
      known: true,
      selected: selected.has(id),
      description: label.description,
      icon: label.icon,
      color: label.color,
    });
    for (const child of children.get(id) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  // A broader cycle has no root; list whatever the walk could not reach.
  for (const label of registry.labels) visit(label.id, 0);
  return rows;
}

export interface LabelRefPickerProps {
  value: unknown;
  onChange: (next: string[]) => void;
  readOnly?: boolean;
  /** Defaults to the active registry. */
  registry?: LabelRegistry;
}

export const LabelRefPicker: React.FC<LabelRefPickerProps> = ({ value, onChange, readOnly = false, registry }) => {
  const [query, setQuery] = useState('');
  const selectedIds = useMemo(() => labelRefIds(value), [value]);
  const activeRegistry = registry ?? globalRegistry.getLabelRegistry();
  const rows = useMemo(() => labelPickerRows(activeRegistry, selectedIds), [activeRegistry, selectedIds]);
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? rows.filter(row => row.label.toLowerCase().includes(needle) || row.id.includes(needle))
    : rows;

  const toggle = (id: string) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter(entry => entry !== id) : [...selectedIds, id]);
  };

  return (
    <div className="label-ref-picker flex flex-col gap-1 min-w-[220px]" data-testid="label-ref-picker">
      {rows.length > 4 && (
        <input
          type="text"
          className="label-ref-picker-search py-1 px-2 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] text-[12px] focus:outline-none focus:border-[var(--nim-primary)]"
          placeholder="Filter labels"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
      )}
      {rows.length === 0 && (
        <span className="label-ref-picker-empty text-[12px] text-[var(--nim-text-faint)] px-1 py-1">
          This project has no labels yet.
        </span>
      )}
      <div className="label-ref-picker-list flex flex-col max-h-[280px] overflow-y-auto" role="listbox" aria-multiselectable="true">
        {visible.map(row => (
          <button
            key={row.id}
            type="button"
            role="option"
            aria-selected={row.selected}
            disabled={readOnly}
            className={`label-ref-picker-row flex items-center gap-1.5 py-1 pr-2 rounded text-left text-[12px] ${row.selected ? 'bg-[var(--nim-bg-selected)] text-[var(--nim-text)]' : 'bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)]'}`}
            style={{ paddingLeft: 6 + row.depth * 14 }}
            title={row.known ? row.description ?? row.label : `'${row.id}' is not in the label registry`}
            data-testid={`label-ref-picker-row-${row.id}`}
            data-unknown={row.known ? undefined : true}
            onClick={() => toggle(row.id)}
          >
            <MaterialSymbol icon={row.selected ? 'check_box' : 'check_box_outline_blank'} size={14} />
            {row.known ? (
              <MaterialSymbol icon={row.icon ?? 'sell'} size={14} style={row.color ? { color: row.color } : undefined} />
            ) : (
              <MaterialSymbol icon="warning" size={14} className="text-[var(--nim-warning)]" />
            )}
            <span className="label-ref-picker-row-label truncate">{row.label}</span>
            {!row.known && <span className="label-ref-picker-unknown text-[10px] text-[var(--nim-warning)]">unknown</span>}
          </button>
        ))}
      </div>
    </div>
  );
};
