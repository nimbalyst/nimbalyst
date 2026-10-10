/**
 * The one row under a page's title that says what the page is: the type chip,
 * then the fields that hold a value, then a faint "+" listing the empty ones.
 * A typed page in Pages and a typed markdown file in Files draw this same row,
 * so a page reads the same wherever it lives.
 *
 * Values arrive as stored (label fields still wrapped) and leave the same way:
 * `onSaveField` gets the stored shape, ready to write.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { FieldDefinition } from '@nimbalyst/tracker-schema';
import { MaterialSymbol } from '../../../ui/icons/MaterialSymbol';
import { windowControlsClearance } from '../../../ui/floating/windowControlsClearance';
import { globalRegistry } from '../models';
import { TrackerFieldPills } from './TrackerFieldPills';
import type { TeamMemberOption } from './TrackerFieldEditor';
import type { RelationshipCandidate } from './RelationshipFieldEditor';
import { getTrackerTagsField, useTrackerChipFieldSections } from './trackerChipFields';
import { isTrackerFieldEmpty, trackerFieldDisplayLabel } from './trackerFieldLayout';
import { unwrapLabelFieldValues, useTrackerLabelFields, wrapLabelFieldValue } from './trackerLabelFields';
import './TrackerTypeRow.css';

export interface TrackerAddFieldMenuProps {
  /** Empty fields the row can still show, in schema order. */
  fields: readonly FieldDefinition[];
  onAdd: (fieldName: string) => void;
  testIdBase?: string;
}

/** The faint "+" at the end of the row: the empty fields, one click to add. */
export const TrackerAddFieldMenu: React.FC<TrackerAddFieldMenuProps> = ({ fields, onAdd, testIdBase = 'tracker-page' }) => {
  const [open, setOpen] = useState(false);
  const floating = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(5), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
  });
  const dismiss = useDismiss(floating.context);
  const role = useRole(floating.context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role]);

  if (fields.length === 0) return null;

  return (
    <>
      <button
        ref={floating.refs.setReference}
        {...getReferenceProps()}
        type="button"
        className="tracker-field-pill tracker-field-pill-empty tracker-page-view-add-field"
        onClick={() => setOpen((value) => !value)}
        aria-label="Add field"
        title="Add field"
        data-testid={`${testIdBase}-add-field`}
      >
        <MaterialSymbol icon="add" size={14} className="tracker-field-pill-icon" />
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={floating.refs.setFloating}
            style={floating.floatingStyles}
            {...getFloatingProps()}
            className="tracker-field-popover tracker-page-view-add-field-menu"
            data-testid={`${testIdBase}-add-field-menu`}
          >
            <span className="tracker-field-popover-header">Add field</span>
            <div className="tracker-field-choice-list">
              {fields.map((field) => (
                <button
                  key={field.name}
                  type="button"
                  role="menuitem"
                  className="tracker-field-choice"
                  data-field={field.name}
                  onClick={() => {
                    setOpen(false);
                    onAdd(field.name);
                  }}
                >
                  <span className="tracker-field-choice-label">{trackerFieldDisplayLabel(field)}</span>
                </button>
              ))}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

export interface TrackerTypeRowProps {
  typeId: string;
  /** Stored values, label fields still wrapped. */
  values: Record<string, unknown>;
  editable: boolean;
  onSaveField: (field: FieldDefinition, storedValue: unknown) => void;
  /**
   * `page` (Pages): single-valued fields only; relations live in Links.
   * `all` (Files): every chip field, since a file has no Links section.
   */
  fieldSet?: 'page' | 'all';
  /** The chip's color; the type's own color by default. */
  typeColor?: string;
  /**
   * The row's fields when they don't come from a registered type: a plain
   * page's own fields (owner, status, summary). Used as given, in order.
   */
  fields?: readonly FieldDefinition[];
  /** Replaces the type chip (a plain page's "Page", which opens Set type). */
  typeChip?: React.ReactNode;
  /** Changing it forgets fields added from the "+" (a different page). */
  resetKey?: string;
  /** Right-aligned at the end of the row (updated, key). */
  end?: React.ReactNode;
  teamMembers?: TeamMemberOption[];
  relationshipCandidates?: Map<string, RelationshipCandidate[]>;
  onOpenItem?: (itemId: string) => void;
  onCreateCollection?: (title: string, type: string) => Promise<RelationshipCandidate | null>;
  testIdBase?: string;
  className?: string;
}

export const TrackerTypeRow: React.FC<TrackerTypeRowProps> = ({
  typeId,
  values,
  editable,
  onSaveField,
  fieldSet = 'page',
  typeColor,
  fields: givenFields,
  typeChip,
  resetKey,
  end,
  teamMembers,
  relationshipCandidates,
  onOpenItem,
  onCreateCollection,
  testIdBase = 'tracker-page',
  className,
}) => {
  const model = useMemo(() => globalRegistry.get(typeId), [typeId]);
  const pageFields = fieldSet === 'page';
  // Tags and label lists never reach the row; on a page neither does any relation.
  const tagsField = useMemo(() => (pageFields ? getTrackerTagsField(typeId) : undefined), [pageFields, typeId]);
  const labelLayout = useTrackerLabelFields(typeId, values);
  const { chipFields: sectionFields } = useTrackerChipFieldSections(
    typeId, tagsField ? [tagsField.name] : [], labelLayout.fields, pageFields,
  );
  const chipFields = useMemo(
    () => givenFields
      ?? (pageFields ? sectionFields.filter((field) => field.type !== 'relationship' && field.type !== 'reference') : sectionFields),
    [givenFields, pageFields, sectionFields],
  );
  const chipValues = useMemo(() => unwrapLabelFieldValues(labelLayout.fields, values), [labelLayout.fields, values]);
  // Read through a ref: a save callback that changed identity on every edit
  // would make each chip flush its pending text save early.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const handleSave = useCallback((fieldName: string, value: unknown) => {
    const field = chipFields.find((candidate) => candidate.name === fieldName);
    if (!field) return;
    onSaveField(field, wrapLabelFieldValue(field, value, valuesRef.current[fieldName]));
  }, [chipFields, onSaveField]);

  // Only fields that hold a value show, plus any added from the "+" while
  // this page is open, so a just-added field stays put while it is filled in.
  const [addedFields, setAddedFields] = useState<ReadonlySet<string>>(() => new Set());
  const [fieldToOpen, setFieldToOpen] = useState<string | null>(null);
  useEffect(() => {
    setAddedFields(new Set());
    setFieldToOpen(null);
  }, [resetKey]);
  const shownFields = useMemo(
    () => chipFields.filter((field) => addedFields.has(field.name) || !isTrackerFieldEmpty(chipValues[field.name])),
    [chipFields, chipValues, addedFields],
  );
  const emptyFields = useMemo(() => chipFields.filter((field) => !shownFields.includes(field)), [chipFields, shownFields]);
  const handleAddField = useCallback((fieldName: string) => {
    setAddedFields((prev) => new Set(prev).add(fieldName));
    setFieldToOpen(fieldName);
  }, []);
  // A field added from the menu opens in its ordinary chip editor. The chip
  // owns its popover state, so open it the way a user would. Booleans toggle
  // on click, so they are added without being set.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fieldToOpen) return;
    setFieldToOpen(null);
    if (chipFields.find((field) => field.name === fieldToOpen)?.type === 'boolean') return;
    const pill = Array.from(rowRef.current?.querySelectorAll<HTMLButtonElement>('.tracker-field-pill') ?? [])
      .find((candidate) => candidate.dataset.field === fieldToOpen);
    pill?.click();
  }, [fieldToOpen, chipFields]);

  const typeName = model?.displayName || typeId;
  const color = typeColor || model?.color || 'var(--nim-text-muted)';

  return (
    <div
      ref={rowRef}
      className={`tracker-type-row tracker-page-view-props flex flex-wrap items-center gap-x-2 gap-y-1.5 ${className ?? ''}`}
      data-testid={`${testIdBase}-props`}
    >
      {typeChip ?? (
        <span
          className="tracker-type-row-type tracker-page-view-type inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium"
          style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
        >
          <MaterialSymbol icon={model?.icon || 'label'} size={13} />
          {typeName}
        </span>
      )}
      {shownFields.length > 0 && (
        <TrackerFieldPills
          fields={shownFields}
          values={chipValues}
          labelFields
          editable={editable}
          teamMembers={teamMembers}
          relationshipCandidates={relationshipCandidates}
          onSave={handleSave}
          onOpenItem={onOpenItem}
          onCreateCollection={onCreateCollection}
          className="tracker-page-view-field-pills"
          testIdBase={`${testIdBase}-field`}
        />
      )}
      {editable && <TrackerAddFieldMenu fields={emptyFields} onAdd={handleAddField} testIdBase={testIdBase} />}
      {end}
    </div>
  );
};
