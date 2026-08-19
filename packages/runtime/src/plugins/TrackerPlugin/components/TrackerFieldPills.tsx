/**
 * Compact tracker metadata chips — the canonical presentation for a tracker
 * item's fields.
 *
 * A chip is its own editor trigger. Select and people chips open their choices
 * directly; fields that need a form surface (tags, dates, text, relationships)
 * reuse TrackerFieldEditor inside the same floating popover. Either way the
 * popover is headed by the name of the field being edited, so a chip that shows
 * only a value never opens an unlabeled editor.
 *
 * This component is presentation only: callers own the item, decide which
 * fields to show (see `useTrackerFieldLayout`), and supply `onSave`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { windowControlsClearance } from '../../../ui/floating/windowControlsClearance';
import { MaterialSymbol } from '../../../ui';
import type { FieldDefinition } from '../models/TrackerDataModel';
import {
  TrackerFieldEditor,
  formatDateTimeDisplay,
  type TeamMemberOption,
} from './TrackerFieldEditor';
import type { RelationshipCandidate } from './RelationshipFieldEditor';
import { CollectionPickerPopover } from './CollectionPickerPopover';
import { isCollectionRelationshipField } from '../models/trackerCollections';
import { UserAvatar } from './UserAvatar';
import { formatTrackerFieldLabel, isTrackerFieldEmpty } from './trackerFieldLayout';
import './TrackerFieldPills.css';

/** Default prefix for the `data-testid`s this component emits. */
const DEFAULT_TEST_ID_BASE = 'tracker-field';

/** How long a text-like edit sits before it is written through. */
const TEXT_SAVE_DEBOUNCE_MS = 500;

/**
 * Field types whose value never says which field it belongs to. A date reads
 * "May 29, 2026" and a URL reads "drive.google.com" whether it is the shoot
 * date or the delivery date, the brief or the final cut — so a schema with two
 * of them produces two chips a reader can only tell apart by opening them
 * (#1166). These carry their label in the chip; select and boolean values are
 * already their own label, and text and number chips read as themselves.
 */
const SELF_ANONYMOUS_FIELD_TYPES = new Set([
  'date',
  'datetime',
  'url',
  'user',
  'relationship',
  'reference',
]);

export interface TrackerFieldPillsProps {
  /** Fields to render, already ordered — see `useTrackerFieldLayout`. */
  fields: FieldDefinition[];
  /** Current field values, keyed by field name. */
  values: Record<string, unknown>;
  /** When false every chip renders read-only. Defaults to true. */
  editable?: boolean;
  /** Team members for people chips; when non-empty they pick from a list. */
  teamMembers?: TeamMemberOption[];
  /** Relationship targets, keyed by field name. */
  relationshipCandidates?: Map<string, RelationshipCandidate[]>;
  /** Persist one field. Called with the field name and its next value. */
  onSave: (fieldName: string, value: unknown) => void | Promise<void>;
  /** Open a related tracker item (relationship chip click-through). */
  onOpenItem?: (itemId: string) => void;
  /**
   * Create a collection of `type` titled `title` and resolve to it. Enables the
   * collection chip's inline "Create …" row; omit and the picker only assigns
   * existing collections.
   */
  onCreateCollection?: (title: string, type: string) => Promise<RelationshipCandidate | null>;
  /** Extra class on the chip row for surface-specific layout. */
  className?: string;
  /**
   * Prefix for emitted test ids: `${testIdBase}-pills`, `${testIdBase}-pill-<field>`,
   * `${testIdBase}-popover-<field>`, `${testIdBase}-choices-<field>`.
   */
  testIdBase?: string;
}

export interface TrackerFieldPillProps {
  field: FieldDefinition;
  value: unknown;
  editable: boolean;
  teamMembers?: TeamMemberOption[];
  relationshipCandidates?: RelationshipCandidate[];
  onOpenItem?: (itemId: string) => void;
  onCreateCollection?: (title: string, type: string) => Promise<RelationshipCandidate | null>;
  onSave: (fieldName: string, value: unknown) => void | Promise<void>;
  testIdBase?: string;
}

/**
 * Label a relationship value. A live candidate wins over the denormalized copy
 * stored on the link, so a renamed target — or a link saved as a bare itemId —
 * still reads as its title rather than an opaque id.
 */
function relationshipLabel(value: unknown, candidates?: RelationshipCandidate[]): string {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const byId = new Map((candidates ?? []).map((c) => [c.itemId, c]));
  const labels = values.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      const candidate = byId.get(String(entry));
      return String(candidate?.title ?? candidate?.issueKey ?? entry);
    }
    const relationship = entry as {
      title?: unknown;
      issueKey?: unknown;
      itemId?: unknown;
    };
    const candidate = byId.get(String(relationship.itemId ?? ''));
    return String(
      candidate?.title
      ?? relationship.title
      ?? candidate?.issueKey
      ?? relationship.issueKey
      ?? relationship.itemId
      ?? '',
    );
  }).filter(Boolean);
  if (labels.length <= 2) return labels.join(', ');
  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
}

function fieldDisplayValue(
  field: FieldDefinition,
  value: unknown,
  teamMembers: TeamMemberOption[],
  relationshipCandidates?: RelationshipCandidate[],
): string {
  if (isTrackerFieldEmpty(value)) return formatTrackerFieldLabel(field.name);
  if (field.type === 'select') {
    return field.options?.find((option) => option.value === value)?.label ?? String(value);
  }
  if (field.type === 'user') {
    const identity = String(value);
    return teamMembers.find((member) => member.email === identity)?.name ?? identity;
  }
  if (field.type === 'array') {
    const values = value as unknown[];
    if (values.length <= 2) return values.join(', ');
    return `${values.slice(0, 2).join(', ')} +${values.length - 2}`;
  }
  if (field.type === 'relationship' || field.type === 'reference') {
    return relationshipLabel(value, relationshipCandidates);
  }
  if (field.type === 'date' || field.type === 'datetime') {
    return formatDateTimeDisplay(value).display;
  }
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  if (field.type === 'url' && typeof value === 'object') {
    const url = value as { label?: unknown; url?: unknown };
    return String(url.label ?? url.url ?? formatTrackerFieldLabel(field.name));
  }
  return String(value);
}

function fieldIcon(field: FieldDefinition, value: unknown): string {
  if (isCollectionRelationshipField(field)) return 'inventory_2';
  if (field.type === 'select') {
    return field.options?.find((option) => option.value === value)?.icon ?? 'tune';
  }
  if (field.type === 'user') return 'person';
  if (field.type === 'array') return 'label';
  if (field.type === 'relationship' || field.type === 'reference') return 'link';
  if (field.type === 'date' || field.type === 'datetime') return 'calendar_today';
  if (field.type === 'boolean') return value ? 'check_box' : 'check_box_outline_blank';
  if (field.type === 'number') return 'numbers';
  if (field.type === 'url') return 'link';
  return 'short_text';
}

/** Header naming the field an open popover edits. */
export const TrackerFieldPopoverHeader: React.FC<{
  label: string;
  testId?: string;
}> = ({ label, testId }) => (
  <div className="tracker-field-popover-header" data-testid={testId}>
    {label}
  </div>
);

export const TrackerFieldPill: React.FC<TrackerFieldPillProps> = ({
  field,
  value,
  editable,
  teamMembers,
  relationshipCandidates,
  onOpenItem,
  onCreateCollection,
  onSave,
  testIdBase = DEFAULT_TEST_ID_BASE,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [localValue, setLocalValue] = useState(value);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestValueRef = useRef(value);
  const hasPendingSaveRef = useRef(false);
  const members = teamMembers ?? [];
  const empty = isTrackerFieldEmpty(localValue);
  const selectedOption = field.type === 'select'
    ? field.options?.find((option) => option.value === localValue)
    : undefined;
  const directChoiceField = field.type === 'select'
    || (field.type === 'user' && members.length > 0);
  const togglesDirectly = field.type === 'boolean';
  // Collection membership gets a dedicated picker: searching milestones/releases
  // and starting a new one are the whole job, and the generic relationship
  // typeahead does neither well.
  const isCollectionField = isCollectionRelationshipField(field);
  const label = formatTrackerFieldLabel(field.name);
  const displayValue = fieldDisplayValue(field, localValue, members, relationshipCandidates);
  // An empty chip already reads as its label, so only a filled one needs one.
  const showLabel = !empty && SELF_ANONYMOUS_FIELD_TYPES.has(field.type);

  useEffect(() => {
    if (!hasPendingSaveRef.current) {
      setLocalValue(value);
      latestValueRef.current = value;
    }
  }, [value]);

  useEffect(() => () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      void onSave(field.name, latestValueRef.current);
    }
  }, [field.name, onSave]);

  const floating = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(5),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      windowControlsClearance(),
      size({
        padding: 8,
        apply({ availableHeight, elements, middlewareData }) {
          const pushed = middlewareData.windowControlsClearance?.pushed ?? 0;
          elements.floating.style.maxHeight = `${Math.max(0, availableHeight - pushed)}px`;
        },
      }),
    ],
  });
  const dismiss = useDismiss(floating.context, {
    outsidePress: (event) => {
      const target = event.target;
      return !(target instanceof Element && target.closest('.custom-select-dropdown'));
    },
  });
  const role = useRole(floating.context, {
    role: directChoiceField ? 'listbox' : 'dialog',
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role]);

  const handleChange = useCallback((nextValue: unknown) => {
    setLocalValue(nextValue);
    latestValueRef.current = nextValue;
    const textLike = field.type === 'string'
      || field.type === 'text'
      || field.type === 'user';
    if (textLike) {
      hasPendingSaveRef.current = true;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        hasPendingSaveRef.current = false;
        void onSave(field.name, latestValueRef.current);
      }, TEXT_SAVE_DEBOUNCE_MS);
      return;
    }
    void onSave(field.name, nextValue);
  }, [field.name, field.type, onSave]);

  const handleDirectChange = useCallback((nextValue: unknown) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    hasPendingSaveRef.current = false;
    setLocalValue(nextValue);
    latestValueRef.current = nextValue;
    setIsOpen(false);
    void onSave(field.name, nextValue);
  }, [field.name, onSave]);

  const directChoices = useMemo(() => {
    if (field.type === 'select') {
      return (field.options ?? []).map((option) => ({
        value: option.value,
        label: option.label,
        icon: option.icon,
        color: option.color,
        avatarIdentity: undefined as string | undefined,
      }));
    }
    if (field.type === 'user') {
      return members.map((member) => ({
        value: member.email,
        label: member.name ?? member.email,
        icon: 'person',
        color: undefined,
        avatarIdentity: member.name ?? member.email,
      }));
    }
    return [];
  }, [field.options, field.type, members]);

  const pillTitle = !editable
    ? `${label} is read-only`
    : empty
      ? `Set ${label}`
      : `${label}: ${displayValue}`;

  return (
    <>
      <button
        ref={floating.refs.setReference}
        {...getReferenceProps()}
        type="button"
        className={`tracker-field-pill ${empty ? 'tracker-field-pill-empty' : 'tracker-field-pill-set'}${showLabel ? ' tracker-field-pill-labeled' : ''}`}
        disabled={!editable}
        onClick={() => {
          if (togglesDirectly) {
            handleDirectChange(!localValue);
            return;
          }
          setIsOpen((open) => !open);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !isOpen) return;
          event.preventDefault();
          event.stopPropagation();
          setIsOpen(false);
        }}
        aria-expanded={togglesDirectly ? undefined : isOpen}
        aria-haspopup={togglesDirectly ? undefined : directChoiceField ? 'listbox' : 'dialog'}
        aria-label={`${label}: ${empty ? 'Not set' : displayValue}`}
        title={pillTitle}
        data-testid={`${testIdBase}-pill-${field.name}`}
        data-field={field.name}
        data-empty={empty}
      >
        {field.type === 'user' && !empty ? (
          <span className="tracker-field-pill-icon">
            <UserAvatar identity={displayValue} size={14} />
          </span>
        ) : (
          <MaterialSymbol
            icon={fieldIcon(field, localValue)}
            size={14}
            className="tracker-field-pill-icon"
            style={selectedOption?.color ? { color: selectedOption.color } : undefined}
          />
        )}
        {showLabel && (
          <span className="tracker-field-pill-label">{label}</span>
        )}
        <span className="tracker-field-pill-value">{displayValue}</span>
      </button>

      {isOpen && editable && !togglesDirectly && (
        <FloatingPortal>
          <div
            ref={floating.refs.setFloating}
            style={floating.floatingStyles}
            {...getFloatingProps()}
            className="tracker-field-popover"
            data-testid={`${testIdBase}-popover-${field.name}`}
          >
            <TrackerFieldPopoverHeader
              label={label}
              testId={`${testIdBase}-popover-header-${field.name}`}
            />
            {isCollectionField ? (
              <CollectionPickerPopover
                field={field}
                value={localValue}
                candidates={relationshipCandidates}
                onChange={handleChange}
                onCreateCollection={onCreateCollection}
                onOpenItem={onOpenItem}
                onRequestClose={() => setIsOpen(false)}
                testIdBase={`${testIdBase}-collection-picker`}
              />
            ) : directChoiceField ? (
              <div
                className="tracker-field-choice-list"
                data-testid={`${testIdBase}-choices-${field.name}`}
              >
                {!field.required && (
                  <button
                    type="button"
                    role="option"
                    aria-selected={empty}
                    className={empty
                      ? 'tracker-field-choice tracker-field-choice-selected'
                      : 'tracker-field-choice'}
                    onClick={() => handleDirectChange('')}
                  >
                    <MaterialSymbol icon="remove" size={15} />
                    <span className="tracker-field-choice-label">None</span>
                  </button>
                )}
                {directChoices.map((choice) => {
                  const selected = choice.value === localValue;
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={selected
                        ? 'tracker-field-choice tracker-field-choice-selected'
                        : 'tracker-field-choice'}
                      onClick={() => handleDirectChange(choice.value)}
                    >
                      {choice.avatarIdentity ? (
                        <UserAvatar identity={choice.avatarIdentity} size={16} />
                      ) : (
                        <MaterialSymbol
                          icon={choice.icon ?? 'circle'}
                          size={15}
                          style={choice.color ? { color: choice.color } : undefined}
                        />
                      )}
                      <span className="tracker-field-choice-label">{choice.label}</span>
                      {selected && <MaterialSymbol icon="check" size={15} />}
                    </button>
                  );
                })}
              </div>
            ) : (
              <TrackerFieldEditor
                field={field}
                value={localValue}
                onChange={handleChange}
                teamMembers={members}
                relationshipCandidates={relationshipCandidates}
                onOpenRelationship={onOpenItem}
                showLabel={false}
              />
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

export const TrackerFieldPills: React.FC<TrackerFieldPillsProps> = ({
  fields,
  values,
  editable = true,
  teamMembers,
  relationshipCandidates,
  onSave,
  onOpenItem,
  onCreateCollection,
  className,
  testIdBase = DEFAULT_TEST_ID_BASE,
}) => {
  if (fields.length === 0) return null;

  return (
    <div
      className={className ? `tracker-field-pills ${className}` : 'tracker-field-pills'}
      data-testid={`${testIdBase}-pills`}
    >
      {fields.map((field) => (
        <TrackerFieldPill
          key={field.name}
          field={field}
          value={values[field.name]}
          editable={editable}
          teamMembers={teamMembers}
          relationshipCandidates={relationshipCandidates?.get(field.name)}
          onOpenItem={onOpenItem}
          onCreateCollection={onCreateCollection}
          onSave={onSave}
          testIdBase={testIdBase}
        />
      ))}
    </div>
  );
};
