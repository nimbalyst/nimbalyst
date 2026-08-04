/**
 * CollectionPickerPopover — the editor behind a "Collection" chip.
 *
 * Collection membership is an ordinary multi-value relationship field pointing
 * at milestone/release items, but the generic relationship editor (a native
 * datalist typeahead) makes the common case — "put this in the current sprint,
 * or start a new one" — a multi-step guess. This picker searches the existing
 * collections, toggles membership in place, and can create-and-assign a new
 * collection from whatever the user typed.
 *
 * Presentation only: all value math delegates to the pure relationship model,
 * and creation is a caller-supplied callback because item creation lives on the
 * Electron side. The caller persists whatever `onChange` hands back, which keeps
 * both sides of the link consistent via the normal inverse-propagation path.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MaterialSymbol } from '../../../ui';
import type { FieldDefinition, TrackerRelationshipValue } from '../models/TrackerDataModel';
import {
  addRelationshipValue,
  normalizeRelationshipValue,
  removeRelationshipValue,
  serializeRelationshipValue,
} from '../models/trackerRelationships';
import { collectionTypeDisplay, collectionTypesForField } from '../models/trackerCollections';
import type { RelationshipCandidate } from './RelationshipFieldEditor';
import './CollectionPickerPopover.css';

export interface CollectionPickerPopoverProps {
  /** The member-side collection field being edited. */
  field: FieldDefinition;
  /** Current field value (single object or array, per `field.multiValue`). */
  value: unknown;
  /** Collection items this field may point at. */
  candidates?: RelationshipCandidate[];
  /** Persist the next field value. */
  onChange: (value: TrackerRelationshipValue | TrackerRelationshipValue[] | null) => void;
  /**
   * Create a collection of `type` titled `title` and resolve to it. Omit to hide
   * the inline create affordance (e.g. surfaces with no creation path).
   */
  onCreateCollection?: (title: string, type: string) => Promise<RelationshipCandidate | null>;
  /** Open a collection from its assigned chip. */
  onOpenItem?: (itemId: string) => void;
  /** Close the surrounding popover (Escape, or a completed single-value pick). */
  onRequestClose?: () => void;
  /** Test id prefix; defaults to `collection-picker`. */
  testIdBase?: string;
}

const DEFAULT_TEST_ID_BASE = 'collection-picker';

/** Label a candidate the way the user searched for it. */
function candidateLabel(candidate: RelationshipCandidate): string {
  return candidate.title || candidate.issueKey || candidate.itemId;
}

/** Label an assigned value, preferring a live candidate over stored display data. */
function assignedLabel(
  value: TrackerRelationshipValue,
  candidate: RelationshipCandidate | undefined,
): string {
  return candidate?.title || value.title || candidate?.issueKey || value.issueKey || value.itemId;
}

function matchesQuery(candidate: RelationshipCandidate, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    (candidate.title?.toLowerCase().includes(q) ?? false)
    || (candidate.issueKey?.toLowerCase().includes(q) ?? false)
  );
}

export const CollectionPickerPopover: React.FC<CollectionPickerPopoverProps> = ({
  field,
  value,
  candidates = [],
  onChange,
  onCreateCollection,
  onOpenItem,
  onRequestClose,
  testIdBase = DEFAULT_TEST_ID_BASE,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  // Non-null once the user picks "Create …": the type they are choosing between.
  const [pendingType, setPendingType] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const current = useMemo(() => normalizeRelationshipValue(value), [value]);
  const currentIds = useMemo(() => new Set(current.map((v) => v.itemId)), [current]);
  const candidateById = useMemo(
    () => new Map(candidates.map((c) => [c.itemId, c])),
    [candidates],
  );
  const createTypes = useMemo(() => collectionTypesForField(field), [field]);

  const trimmedQuery = query.trim();

  // Assigned collections sort first so "what am I already in" stays visible while
  // the list narrows.
  const results = useMemo(() => {
    const matching = candidates.filter((c) => matchesQuery(c, trimmedQuery));
    return matching.sort((a, b) => {
      const aAssigned = currentIds.has(a.itemId) ? 0 : 1;
      const bAssigned = currentIds.has(b.itemId) ? 0 : 1;
      if (aAssigned !== bAssigned) return aAssigned - bAssigned;
      return candidateLabel(a).localeCompare(candidateLabel(b));
    });
  }, [candidates, currentIds, trimmedQuery]);

  // Creating is offered only for a genuinely new name: an exact title/key match
  // means the user is looking at the collection they meant, not missing one.
  const hasExactMatch = useMemo(() => {
    if (!trimmedQuery) return false;
    const q = trimmedQuery.toLowerCase();
    return candidates.some(
      (c) => c.title?.toLowerCase() === q || c.issueKey?.toLowerCase() === q,
    );
  }, [candidates, trimmedQuery]);

  const canCreate = Boolean(onCreateCollection) && trimmedQuery.length > 0 && !hasExactMatch;
  const rowCount = results.length + (canCreate ? 1 : 0);
  const createRowIndex = canCreate ? results.length : -1;

  useEffect(() => {
    setActiveIndex((index) => (index < rowCount ? index : Math.max(0, rowCount - 1)));
  }, [rowCount]);

  const commit = useCallback((next: TrackerRelationshipValue[]) => {
    onChange(serializeRelationshipValue(field, next));
  }, [field, onChange]);

  const assign = useCallback((candidate: RelationshipCandidate) => {
    commit(addRelationshipValue(field, current, {
      itemId: candidate.itemId,
      title: candidate.title,
      issueKey: candidate.issueKey,
      trackerType: candidate.trackerType,
    }));
    setQuery('');
    // A single-value field holds one collection, so the pick is the whole
    // interaction; multi-value stays open to add several in a row.
    if (!field.multiValue) onRequestClose?.();
  }, [commit, current, field, onRequestClose]);

  const unassign = useCallback((itemId: string) => {
    commit(removeRelationshipValue(current, itemId));
  }, [commit, current]);

  const toggle = useCallback((candidate: RelationshipCandidate) => {
    if (currentIds.has(candidate.itemId)) unassign(candidate.itemId);
    else assign(candidate);
  }, [assign, currentIds, unassign]);

  const beginCreate = useCallback(() => {
    setCreateError(null);
    setPendingType(createTypes[0] ?? null);
  }, [createTypes]);

  const confirmCreate = useCallback(async (type: string) => {
    if (!onCreateCollection || !trimmedQuery || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await onCreateCollection(trimmedQuery, type);
      if (!created) {
        setCreateError('Could not create the collection.');
        return;
      }
      setPendingType(null);
      assign(created);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }, [assign, creating, onCreateCollection, trimmedQuery]);

  const cancelCreate = useCallback(() => {
    setPendingType(null);
    setCreateError(null);
    inputRef.current?.focus();
  }, []);

  const activateRow = useCallback((index: number) => {
    if (index === createRowIndex) {
      beginCreate();
      return;
    }
    const candidate = results[index];
    if (candidate) toggle(candidate);
  }, [beginCreate, createRowIndex, results, toggle]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    // While the type toggle is up, the arrows steer the toggle instead of the
    // list — the list is hidden, so stealing them back would be a dead key.
    if (pendingType !== null) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelCreate();
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const at = createTypes.indexOf(pendingType);
        const delta = event.key === 'ArrowRight' ? 1 : createTypes.length - 1;
        setPendingType(createTypes[(at + delta) % createTypes.length] ?? pendingType);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        void confirmCreate(pendingType);
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (rowCount > 0) setActiveIndex((index) => (index + 1) % rowCount);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (rowCount > 0) setActiveIndex((index) => (index - 1 + rowCount) % rowCount);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activateRow(activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onRequestClose?.();
    }
  }, [
    activateRow, activeIndex, cancelCreate, confirmCreate, createTypes,
    onRequestClose, pendingType, rowCount,
  ]);

  // Keep the highlighted row in view when the arrows walk past the fold.
  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]');
    // jsdom has no scrollIntoView; scrolling is a nicety, never a correctness step.
    if (active instanceof HTMLElement && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  return (
    <div className="collection-picker" data-testid={testIdBase}>
      <input
        ref={inputRef}
        type="text"
        className="collection-picker-search"
        placeholder="Search collections…"
        aria-label="Search collections"
        value={query}
        disabled={creating}
        onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
        onKeyDown={handleKeyDown}
        data-testid={`${testIdBase}-search`}
      />

      {current.length > 0 && (
        <div className="collection-picker-current" data-testid={`${testIdBase}-current`}>
          {current.map((assignment) => {
            const label = assignedLabel(assignment, candidateById.get(assignment.itemId));
            return (
              <span key={assignment.itemId} className="collection-picker-chip">
                <button
                  type="button"
                  className="collection-picker-chip-open"
                  title={label}
                  onClick={() => onOpenItem?.(assignment.itemId)}
                >
                  {label}
                </button>
                <button
                  type="button"
                  className="collection-picker-chip-remove"
                  aria-label={`Remove from ${label}`}
                  title={`Remove from ${label}`}
                  onClick={() => unassign(assignment.itemId)}
                  data-testid={`${testIdBase}-remove-${assignment.itemId}`}
                >
                  <MaterialSymbol icon="close" size={13} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {pendingType !== null ? (
        <div className="collection-picker-create-panel" data-testid={`${testIdBase}-create-panel`}>
          <div className="collection-picker-create-prompt">
            Create &ldquo;{trimmedQuery}&rdquo; as
          </div>
          <div className="collection-picker-type-toggle" role="radiogroup" aria-label="Collection type">
            {createTypes.map((type) => {
              const display = collectionTypeDisplay(type);
              const selected = type === pendingType;
              return (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={creating}
                  className={selected
                    ? 'collection-picker-type-option collection-picker-type-option-selected'
                    : 'collection-picker-type-option'}
                  onClick={() => { setPendingType(type); void confirmCreate(type); }}
                  data-testid={`${testIdBase}-type-${type}`}
                >
                  <MaterialSymbol icon={display.icon} size={15} />
                  <span>{display.label}</span>
                </button>
              );
            })}
          </div>
          {createError && (
            <div className="collection-picker-error" role="alert">{createError}</div>
          )}
          <button
            type="button"
            className="collection-picker-create-cancel"
            onClick={cancelCreate}
            disabled={creating}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div
          ref={listRef}
          className="collection-picker-list"
          role="listbox"
          aria-label="Collections"
          data-testid={`${testIdBase}-list`}
        >
          {results.length === 0 && !canCreate && (
            <div className="collection-picker-empty" data-testid={`${testIdBase}-empty`}>
              {candidates.length === 0 ? 'No collections yet' : 'No matches'}
            </div>
          )}
          {results.map((candidate, index) => {
            const assigned = currentIds.has(candidate.itemId);
            const active = index === activeIndex;
            return (
              <button
                key={candidate.itemId}
                type="button"
                role="option"
                aria-selected={assigned}
                data-active={active}
                className={active
                  ? 'collection-picker-option collection-picker-option-active'
                  : 'collection-picker-option'}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => toggle(candidate)}
                data-testid={`${testIdBase}-option-${candidate.itemId}`}
              >
                <MaterialSymbol
                  icon={collectionTypeDisplay(candidate.trackerType ?? '').icon}
                  size={15}
                  className="collection-picker-option-icon"
                />
                <span className="collection-picker-option-label">{candidateLabel(candidate)}</span>
                {assigned && <MaterialSymbol icon="check" size={15} />}
              </button>
            );
          })}
          {canCreate && (
            <button
              type="button"
              role="option"
              aria-selected={false}
              data-active={activeIndex === createRowIndex}
              className={activeIndex === createRowIndex
                ? 'collection-picker-option collection-picker-option-create collection-picker-option-active'
                : 'collection-picker-option collection-picker-option-create'}
              onMouseEnter={() => setActiveIndex(createRowIndex)}
              onClick={beginCreate}
              data-testid={`${testIdBase}-create`}
            >
              <MaterialSymbol icon="add" size={15} className="collection-picker-option-icon" />
              <span className="collection-picker-option-label">
                Create &ldquo;{trimmedQuery}&rdquo;
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
