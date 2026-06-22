/**
 * RelationshipFieldEditor — editor/renderer for `relationship` (and legacy
 * `reference`) tracker fields (Epic C Phase 1).
 *
 * Renders the current value as clickable pills with a remove affordance, plus an
 * add control (a native <datalist> typeahead over `candidates` — no manual
 * positioning needed). All value math delegates to the pure, unit-tested model
 * in ../models/trackerRelationships, so this component stays a thin view.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FieldDefinition, TrackerRelationshipValue } from '../models/TrackerDataModel';
import {
  normalizeRelationshipValue,
  addRelationshipValue,
  removeRelationshipValue,
  serializeRelationshipValue,
  resolveRelationshipType,
} from '../models/trackerRelationships';

/** A selectable target item for the typeahead. */
export interface RelationshipCandidate {
  itemId: string;
  title?: string;
  issueKey?: string;
  trackerType?: string;
}

export interface RelationshipFieldEditorProps {
  field: FieldDefinition;
  value: unknown;
  onChange: (value: TrackerRelationshipValue | TrackerRelationshipValue[] | null) => void;
  /** Candidate target items for the add typeahead. */
  candidates?: RelationshipCandidate[];
  /** Click a pill to open the related item. */
  onOpenItem?: (itemId: string) => void;
  /** Read-only render (pills only, no add/remove). */
  readOnly?: boolean;
}

/**
 * Display label for a linked item. Prefers a LIVE lookup against the candidate
 * list (so renamed items and links stored without denormalized display data — a
 * bare itemId — still render a friendly label), then the stored denormalized
 * fields, and finally the raw itemId as a last resort.
 */
function pillLabel(v: TrackerRelationshipValue, candidate?: RelationshipCandidate): string {
  return candidate?.title || v.title || candidate?.issueKey || v.issueKey || v.itemId;
}

export const RelationshipFieldEditor: React.FC<RelationshipFieldEditorProps> = ({
  field,
  value,
  onChange,
  candidates = [],
  onOpenItem,
  readOnly,
}) => {
  const [draft, setDraft] = useState('');
  // The add control is collapsed to a "+" until the user opens it.
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (adding) inputRef.current?.focus(); }, [adding]);
  const current = useMemo(() => normalizeRelationshipValue(value), [value]);
  const currentIds = useMemo(() => new Set(current.map((v) => v.itemId)), [current]);
  const candidateById = useMemo(() => new Map(candidates.map((c) => [c.itemId, c])), [candidates]);

  // The field's relationship vocabulary entry (e.g. "Depends on"), used to label
  // the field semantics and tint the pills. Schema-driven via relationshipTypeKey.
  const relType = useMemo(() => resolveRelationshipType(field.relationshipTypeKey), [field.relationshipTypeKey]);
  const pillColor = relType?.color;

  const datalistId = `rel-cand-${field.name}`;

  const commit = (next: TrackerRelationshipValue[]) => {
    onChange(serializeRelationshipValue(field, next));
  };

  const resolveDraftToCandidate = (raw: string): RelationshipCandidate | null => {
    const q = raw.trim();
    if (!q) return null;
    // Match a candidate by issueKey, id, or title (case-insensitive).
    const lc = q.toLowerCase();
    const hit = candidates.find(
      (c) => c.issueKey?.toLowerCase() === lc || c.itemId.toLowerCase() === lc || c.title?.toLowerCase() === lc,
    );
    if (hit) return hit;
    // Only resolved candidates can be added from the UI. This keeps the visible
    // editor on the same validation rails as MCP writes: no accidental self-link
    // or disallowed target-type link via a hand-typed bare id.
    return null;
  };

  const handleAdd = () => {
    const cand = resolveDraftToCandidate(draft);
    if (!cand || currentIds.has(cand.itemId)) {
      setDraft('');
      return;
    }
    const next = addRelationshipValue(field, current, {
      itemId: cand.itemId,
      title: cand.title,
      issueKey: cand.issueKey,
      trackerType: cand.trackerType,
    });
    commit(next);
    setDraft('');
    // Single-value fields hold one target, so collapse after a successful add;
    // multi-value fields stay open so several links can be added in a row.
    if (!field.multiValue) setAdding(false);
  };

  const closeAdd = () => { setDraft(''); setAdding(false); };

  const handleRemove = (itemId: string) => {
    commit(removeRelationshipValue(current, itemId));
  };

  return (
    <div className="relationship-field-editor flex flex-col gap-1.5" data-testid={`relationship-field-${field.name}`}>
      {relType && (
        <span
          className="relationship-type-badge inline-flex w-fit items-center gap-1 text-[10px] uppercase tracking-[0.5px] text-[var(--nim-text-faint)]"
          title={relType.description || relType.displayName}
        >
          {relType.icon && <span className="material-symbols-outlined text-[12px]">{relType.icon}</span>}
          {relType.displayName}
          {relType.symmetric && <span className="normal-case tracking-normal">(both ways)</span>}
        </span>
      )}
      <div className="flex flex-wrap gap-1">
        {current.length === 0 && (
          <span className="text-[12px] text-[var(--nim-text-faint)] italic">No links</span>
        )}
        {current.map((v) => {
          const cand = candidateById.get(v.itemId);
          const label = pillLabel(v, cand);
          return (
          <span
            key={v.itemId}
            className="relationship-pill inline-flex items-center gap-1 rounded-full bg-[var(--nim-bg-tertiary)] px-2 py-0.5 text-[12px] text-[var(--nim-text)]"
            style={pillColor ? { backgroundColor: `${pillColor}22`, color: pillColor } : undefined}
          >
            <button
              type="button"
              className="relationship-pill-open hover:underline"
              title={cand?.title || v.title || v.itemId}
              onClick={() => onOpenItem?.(v.itemId)}
            >
              {label}
            </button>
            {!readOnly && (
              <button
                type="button"
                className="relationship-pill-remove text-[var(--nim-text-faint)] hover:text-[var(--nim-error)]"
                title="Remove link"
                aria-label={`Remove ${label}`}
                onClick={() => handleRemove(v.itemId)}
              >
                ×
              </button>
            )}
          </span>
          );
        })}
      </div>

      {!readOnly && !adding && (
        <button
          type="button"
          className="relationship-add-toggle inline-flex w-fit items-center text-[var(--nim-text-faint)] hover:text-[var(--nim-text)]"
          title="Add link"
          aria-label="Add link"
          onClick={() => setAdding(true)}
        >
          <span className="material-symbols-outlined text-[16px]">add</span>
        </button>
      )}

      {!readOnly && adding && (
        <div className="flex gap-1">
          <input
            ref={inputRef}
            type="text"
            list={datalistId}
            value={draft}
            placeholder="Link an item…"
            className="flex-1 py-1 px-2 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] text-[12px] focus:outline-none focus:border-[var(--nim-primary)]"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
              else if (e.key === 'Escape') { e.preventDefault(); closeAdd(); }
            }}
          />
          <datalist id={datalistId}>
            {candidates
              .filter((c) => !currentIds.has(c.itemId))
              .map((c) => (
                <option key={c.itemId} value={c.issueKey || c.title || c.itemId}>
                  {c.title || c.itemId}
                </option>
              ))}
          </datalist>
          <button
            type="button"
            className="relationship-add px-2 py-1 rounded text-[12px] bg-[var(--nim-primary)] text-[var(--nim-on-primary)] disabled:opacity-40"
            disabled={!draft.trim()}
            onClick={handleAdd}
          >
            Add
          </button>
          <button
            type="button"
            className="relationship-add-cancel px-1.5 py-1 rounded text-[12px] text-[var(--nim-text-faint)] hover:text-[var(--nim-text)]"
            title="Cancel"
            aria-label="Cancel adding link"
            onClick={closeAdd}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
};
