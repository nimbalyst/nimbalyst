/**
 * The `citation` field type's editor: a chip per attached citation, each one
 * opening {@link CitationInspector}.
 *
 * The chip list and the add typeahead deliberately mirror
 * `RelationshipFieldEditor` -- a citation entry is a reference to an item, and
 * a second visual idiom for "a list of linked items" would be a second thing to
 * keep consistent for no gain. What is different is what sits behind the chip:
 * a relationship pill navigates, a citation chip opens the evidence.
 *
 * Adding a citation here attaches an EXISTING `citation` item. Authoring one
 * (source, capture, locator, excerpt) is the knowledge extension's job (N13);
 * this field is the attach point, not a capture form.
 */

import React, { useMemo, useState } from 'react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { windowControlsClearance } from '../../../ui/floating/windowControlsClearance';
import type { CitationFieldValue, FieldDefinition } from '@nimbalyst/tracker-schema';
import { MaterialSymbol } from '../../../ui/icons/MaterialSymbol';
import { CitationInspector, type CitationInspectorHost } from './CitationInspector';
import type { RelationshipCandidate } from './RelationshipFieldEditor';

export interface CitationFieldEditorProps {
  field: FieldDefinition;
  value: unknown;
  onChange: (value: CitationFieldValue[]) => void;
  host: CitationInspectorHost;
  /** Existing `citation` items the add control offers. */
  candidates?: RelationshipCandidate[];
  /** Open the citation item itself. */
  onOpenItem?: (itemId: string) => void;
  readOnly?: boolean;
}

/**
 * Tolerant read of the stored value. A `citation` field is multi-valued by
 * definition, but a single object is what a hand-written YAML seed or an older
 * MCP write can leave behind, and dropping it would lose evidence rather than
 * surface it.
 */
export function readCitationEntries(value: unknown): CitationFieldValue[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const itemId = (entry as CitationFieldValue).itemId;
    return typeof itemId === 'string' && itemId.length > 0 ? [entry as CitationFieldValue] : [];
  });
}

const CitationChip: React.FC<{
  entry: CitationFieldValue;
  host: CitationInspectorHost;
  onOpenItem?: (itemId: string) => void;
  onRemove?: () => void;
}> = ({ entry, host, onOpenItem, onRemove }) => {
  const [open, setOpen] = useState(false);
  const floating = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(5), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
  });
  const dismiss = useDismiss(floating.context);
  const role = useRole(floating.context, { role: 'dialog' });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role]);

  const label = host.lookupItem(entry.itemId)?.title
    ?? entry.title
    ?? entry.issueKey
    ?? entry.itemId;

  return (
    <span className="citation-chip inline-flex items-center gap-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-1.5 py-0.5 text-[12px] text-[var(--nim-text)]">
      <button
        type="button"
        ref={floating.refs.setReference}
        {...getReferenceProps()}
        className="citation-chip-open inline-flex items-center gap-1 text-left"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        title="Inspect this citation"
      >
        <MaterialSymbol icon="format_quote" size={14} />
        <span className="max-w-[220px] truncate">{label}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          className="citation-chip-remove text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]"
          onClick={onRemove}
          aria-label={`Remove citation ${label}`}
        >
          <MaterialSymbol icon="close" size={14} />
        </button>
      )}
      {open && (
        <FloatingPortal>
          <div
            ref={floating.refs.setFloating}
            style={floating.floatingStyles}
            {...getFloatingProps()}
            className="citation-inspector-popover z-50 rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] shadow-lg"
          >
            <CitationInspector entry={entry} host={host} onOpenItem={onOpenItem} />
          </div>
        </FloatingPortal>
      )}
    </span>
  );
};

export const CitationFieldEditor: React.FC<CitationFieldEditorProps> = ({
  value,
  onChange,
  host,
  candidates,
  onOpenItem,
  readOnly,
}) => {
  const entries = useMemo(() => readCitationEntries(value), [value]);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');

  const attached = useMemo(() => new Set(entries.map((entry) => entry.itemId)), [entries]);
  const matches = useMemo(() => {
    if (!candidates) return [];
    const needle = query.trim().toLowerCase();
    return candidates
      .filter((candidate) => !attached.has(candidate.itemId))
      .filter((candidate) => needle.length === 0
        || (candidate.title ?? '').toLowerCase().includes(needle)
        || (candidate.issueKey ?? '').toLowerCase().includes(needle))
      .slice(0, 8);
  }, [candidates, attached, query]);

  const attach = (candidate: RelationshipCandidate): void => {
    onChange([
      ...entries,
      { itemId: candidate.itemId, issueKey: candidate.issueKey, title: candidate.title },
    ]);
    setQuery('');
    setAdding(false);
  };

  return (
    <div className="citation-field-editor flex flex-col gap-1.5">
      <div className="citation-field-chips flex flex-wrap items-center gap-1">
        {entries.map((entry) => (
          <CitationChip
            key={entry.itemId}
            entry={entry}
            host={host}
            onOpenItem={onOpenItem}
            onRemove={readOnly
              ? undefined
              : () => onChange(entries.filter((other) => other.itemId !== entry.itemId))}
          />
        ))}
        {entries.length === 0 && (
          <span className="citation-field-empty text-[12px] text-[var(--nim-text-muted)]">
            No citations
          </span>
        )}
        {!readOnly && !adding && (
          <button
            type="button"
            className="citation-field-add inline-flex items-center gap-1 rounded border border-dashed border-[var(--nim-border)] px-1.5 py-0.5 text-[12px] text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]"
            onClick={() => setAdding(true)}
          >
            <MaterialSymbol icon="add" size={14} />
            Cite
          </button>
        )}
      </div>

      {adding && !readOnly && (
        <div className="citation-field-picker flex flex-col gap-1">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setAdding(false);
            }}
            placeholder="Find a citation..."
            className="citation-field-picker-input rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 text-[12px] text-[var(--nim-text)]"
          />
          {matches.length === 0 ? (
            <span className="citation-field-picker-empty text-[12px] text-[var(--nim-text-muted)]">
              No citation items match. Create one first.
            </span>
          ) : (
            matches.map((candidate) => (
              <button
                key={candidate.itemId}
                type="button"
                className="citation-field-picker-option rounded px-2 py-1 text-left text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-secondary)]"
                onClick={() => attach(candidate)}
              >
                {candidate.title ?? candidate.issueKey ?? candidate.itemId}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};
