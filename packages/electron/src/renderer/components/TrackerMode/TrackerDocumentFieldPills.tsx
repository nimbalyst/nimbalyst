/**
 * Compact metadata editors for Tracker Mode's focused document header.
 *
 * Select and people pills are their editor trigger: clicking one opens the
 * choices directly. Fields that need a form surface (tags, dates, text,
 * relationships) reuse TrackerFieldEditor in one floating editor.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
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
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  globalRegistry,
  isRelationshipField,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type {
  FieldDefinition,
  TrackerSchemaRole,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import {
  TrackerFieldEditor,
  formatDateTimeDisplay,
  type TeamMemberOption,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerFieldEditor';
import type { RelationshipCandidate } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/RelationshipFieldEditor';
import {
  trackerItemByIdAtom,
  trackerItemsMapAtom,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';

interface TrackerDocumentFieldPillsProps {
  itemId: string;
  workspacePath?: string;
  onOpenItem?: (itemId: string) => void;
}

const ROLE_ORDER: readonly TrackerSchemaRole[] = [
  'workflowStatus',
  'priority',
  'assignee',
  'reporter',
  'tags',
  'startDate',
  'dueDate',
  'progress',
];

const CONVENTIONAL_ROLE_FIELDS: Partial<Record<TrackerSchemaRole, string>> = {
  workflowStatus: 'status',
  priority: 'priority',
  assignee: 'owner',
  reporter: 'reporterEmail',
  tags: 'tags',
  startDate: 'startDate',
  dueDate: 'dueDate',
  progress: 'progress',
};

const BUILTIN_FIELDS = new Set(['title', 'description', 'created', 'updated']);
const PILL_UNSUPPORTED_FIELD_TYPES = new Set(['multiselect', 'object']);

function isEditable(record: TrackerRecord): boolean {
  return record.source === 'native'
    || !record.system.documentPath
    || record.source === 'frontmatter'
    || record.source === 'import'
    || record.source === 'inline';
}

function formatFieldLabel(name: string): string {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (character) => character.toUpperCase())
    .trim();
}

/**
 * Resolve semantic fields first, then type-specific metadata in schema order.
 * Opaque objects, structural fields, and read-only values stay in the ordinary
 * detail view instead of turning the document header into a second inspector.
 * Custom text fields remain eligible; only the built-in description is omitted.
 */
export function getTrackerDocumentPillFields(
  trackerType: string,
): FieldDefinition[] {
  const model = globalRegistry.get(trackerType);
  if (!model) return [];

  const byName = new Map(model.fields.map((field) => [field.name, field]));
  const ordered: FieldDefinition[] = [];
  const seen = new Set<string>();
  const add = (field: FieldDefinition | undefined): void => {
    if (
      !field
      || seen.has(field.name)
      || BUILTIN_FIELDS.has(field.name)
      || field.readOnly
      || PILL_UNSUPPORTED_FIELD_TYPES.has(field.type)
    ) {
      return;
    }
    seen.add(field.name);
    ordered.push(field);
  };

  for (const role of ROLE_ORDER) {
    const name = model.roles?.[role] ?? CONVENTIONAL_ROLE_FIELDS[role];
    add(name ? byName.get(name) : undefined);
  }
  for (const field of model.fields) add(field);
  return ordered;
}

function isEmptyValue(value: unknown): boolean {
  if (value == null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const candidate = value as { url?: unknown; label?: unknown; itemId?: unknown };
    return !candidate.url && !candidate.label && !candidate.itemId;
  }
  return false;
}

function relationshipLabel(value: unknown): string {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const labels = values.map((entry) => {
    if (!entry || typeof entry !== 'object') return String(entry);
    const relationship = entry as {
      title?: unknown;
      issueKey?: unknown;
      itemId?: unknown;
    };
    return String(relationship.title ?? relationship.issueKey ?? relationship.itemId ?? '');
  }).filter(Boolean);
  if (labels.length <= 2) return labels.join(', ');
  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
}

function fieldDisplayValue(
  field: FieldDefinition,
  value: unknown,
  teamMembers: TeamMemberOption[],
): string {
  if (isEmptyValue(value)) return formatFieldLabel(field.name);
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
    return relationshipLabel(value);
  }
  if (field.type === 'date' || field.type === 'datetime') {
    return formatDateTimeDisplay(value).display;
  }
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  if (field.type === 'url' && typeof value === 'object') {
    const url = value as { label?: unknown; url?: unknown };
    return String(url.label ?? url.url ?? formatFieldLabel(field.name));
  }
  return String(value);
}

function fieldIcon(field: FieldDefinition, value: unknown): string {
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

function useTeamMembers(workspacePath?: string): TeamMemberOption[] {
  const [teamMembers, setTeamMembers] = useState<TeamMemberOption[]>([]);

  useEffect(() => {
    if (!workspacePath) {
      setTeamMembers((current) => current.length === 0 ? current : []);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const teamResult = await window.electronAPI.invoke(
          'team:find-for-workspace',
          workspacePath,
        );
        const orgId = teamResult?.success && teamResult.team?.orgId
          ? String(teamResult.team.orgId)
          : null;
        if (!orgId || cancelled) {
          if (!cancelled) {
            setTeamMembers((current) => current.length === 0 ? current : []);
          }
          return;
        }
        const membersResult = await window.electronAPI.invoke('team:list-members', orgId);
        if (cancelled) return;
        setTeamMembers(
          membersResult?.success && Array.isArray(membersResult.members)
            ? membersResult.members
                .filter((member: { email?: unknown }) => typeof member.email === 'string')
                .map((member: { email: string; name?: unknown }) => ({
                  email: member.email,
                  name: typeof member.name === 'string' ? member.name : undefined,
                }))
            : [],
        );
      } catch {
        if (!cancelled) {
          setTeamMembers((current) => current.length === 0 ? current : []);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  return teamMembers;
}

interface TrackerDocumentFieldPillProps {
  field: FieldDefinition;
  value: unknown;
  editable: boolean;
  teamMembers: TeamMemberOption[];
  relationshipCandidates?: RelationshipCandidate[];
  onOpenItem?: (itemId: string) => void;
  onSave: (fieldName: string, value: unknown) => Promise<void>;
}

const TrackerDocumentFieldPill: React.FC<TrackerDocumentFieldPillProps> = ({
  field,
  value,
  editable,
  teamMembers,
  relationshipCandidates,
  onOpenItem,
  onSave,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [localValue, setLocalValue] = useState(value);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestValueRef = useRef(value);
  const hasPendingSaveRef = useRef(false);
  const empty = isEmptyValue(localValue);
  const selectedOption = field.type === 'select'
    ? field.options?.find((option) => option.value === localValue)
    : undefined;
  const directChoiceField = field.type === 'select'
    || (field.type === 'user' && teamMembers.length > 0);
  const togglesDirectly = field.type === 'boolean';
  const label = formatFieldLabel(field.name);
  const displayValue = fieldDisplayValue(field, localValue, teamMembers);

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
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${availableHeight}px`;
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
      }, 500);
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
      }));
    }
    if (field.type === 'user') {
      return teamMembers.map((member) => ({
        value: member.email,
        label: member.name ?? member.email,
        icon: 'person',
        color: undefined,
      }));
    }
    return [];
  }, [field.options, field.type, teamMembers]);

  return (
    <>
      <button
        ref={floating.refs.setReference}
        {...getReferenceProps()}
        type="button"
        className={`tracker-document-field-pill ${empty ? 'tracker-document-field-pill-empty' : 'tracker-document-field-pill-set'}`}
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
        title={editable ? `Edit ${label}` : `${label} is read-only`}
        data-testid={`tracker-document-field-pill-${field.name}`}
        data-empty={empty}
      >
        <MaterialSymbol
          icon={fieldIcon(field, localValue)}
          size={14}
          style={selectedOption?.color ? { color: selectedOption.color } : undefined}
        />
        <span className="tracker-document-field-pill-value">{displayValue}</span>
      </button>

      {isOpen && editable && !togglesDirectly && (
        <FloatingPortal>
          <div
            ref={floating.refs.setFloating}
            style={floating.floatingStyles}
            {...getFloatingProps()}
            className="tracker-document-field-popover"
            data-testid={`tracker-document-field-popover-${field.name}`}
          >
            {directChoiceField ? (
              <div
                className="tracker-document-field-choice-list"
                data-testid={`tracker-document-field-choices-${field.name}`}
              >
                {!field.required && (
                  <button
                    type="button"
                    role="option"
                    aria-selected={empty}
                    className={empty
                      ? 'tracker-document-field-choice tracker-document-field-choice-selected'
                      : 'tracker-document-field-choice'}
                    onClick={() => handleDirectChange('')}
                  >
                    <MaterialSymbol icon="remove" size={15} />
                    <span>None</span>
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
                        ? 'tracker-document-field-choice tracker-document-field-choice-selected'
                        : 'tracker-document-field-choice'}
                      onClick={() => handleDirectChange(choice.value)}
                    >
                      <MaterialSymbol
                        icon={choice.icon ?? 'circle'}
                        size={15}
                        style={choice.color ? { color: choice.color } : undefined}
                      />
                      <span className="min-w-0 flex-1 truncate">{choice.label}</span>
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
                teamMembers={teamMembers}
                relationshipCandidates={relationshipCandidates}
                onOpenRelationship={onOpenItem}
              />
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

export const TrackerDocumentFieldPills: React.FC<TrackerDocumentFieldPillsProps> = ({
  itemId,
  workspacePath,
  onOpenItem,
}) => {
  const item = useAtomValue(trackerItemByIdAtom(itemId));
  const itemsMap = useAtomValue(trackerItemsMapAtom);
  const teamMembers = useTeamMembers(workspacePath);
  const fields = useMemo(
    () => getTrackerDocumentPillFields(item?.primaryType ?? ''),
    [item?.primaryType],
  );
  const editable = item ? isEditable(item) : false;
  const syncMode = item
    ? (globalRegistry.get(item.primaryType)?.sync?.mode ?? 'local')
    : 'local';

  const relationshipCandidates = useMemo(() => {
    const candidates = new Map<string, RelationshipCandidate[]>();
    if (!item) return candidates;
    for (const field of fields) {
      if (!isRelationshipField(field)) continue;
      const allowed = field.targetTrackerTypes;
      const values: RelationshipCandidate[] = [];
      for (const record of itemsMap.values()) {
        if (record.id === item.id) continue;
        if (allowed && allowed !== '*' && !allowed.includes(record.primaryType)) continue;
        values.push({
          itemId: record.id,
          title: getRecordTitle(record) || undefined,
          issueKey: record.issueKey || undefined,
          trackerType: record.primaryType,
        });
      }
      candidates.set(field.name, values);
    }
    return candidates;
  }, [fields, item, itemsMap]);

  const saveField = useCallback(async (fieldName: string, nextValue: unknown) => {
    if (!item || !editable) return;
    try {
      const updates = { [fieldName]: nextValue };
      if (
        (item.source === 'frontmatter'
          || item.source === 'import'
          || item.source === 'inline')
        && item.system.documentPath
      ) {
        await window.electronAPI.documentService.updateTrackerItemInFile({
          itemId: item.id,
          updates,
        });
      } else {
        await window.electronAPI.documentService.updateTrackerItem({
          itemId: item.id,
          updates,
          syncMode,
        });
      }
      window.electronAPI
        .invoke('document-service:tracker-item-reindex-relationships', { itemId: item.id })
        .catch(() => {});
    } catch (error) {
      console.error('[TrackerDocumentFieldPills] Failed to save field:', error);
    }
  }, [editable, item, syncMode]);

  if (!item || fields.length === 0) return null;

  return (
    <div
      className="tracker-document-field-pills"
      data-testid="tracker-document-field-pills"
    >
      {fields.map((field) => (
        <TrackerDocumentFieldPill
          key={field.name}
          field={field}
          value={item.fields[field.name]}
          editable={editable}
          teamMembers={teamMembers}
          relationshipCandidates={relationshipCandidates.get(field.name)}
          onOpenItem={onOpenItem}
          onSave={saveField}
        />
      ))}
    </div>
  );
};
