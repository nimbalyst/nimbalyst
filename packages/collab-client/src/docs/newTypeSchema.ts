/**
 * The schema the "New type..." dialog writes: a person's few answers (names,
 * icon, a handful of fields, an optional parent) turned into the same
 * declaration `tracker_define_type` persists. Pure, so the dialog, the hosts
 * and the tests all agree on what a new type is.
 *
 * The section decides `sharing`: Team writes a team-owned schema, Personal a
 * local one. A subtype declares only what it adds and inherits everything
 * else from its parent, sharing included -- the dialog only offers parents
 * from the section it was opened in.
 */

import type {
  DerivedTrackerTypeDeclaration,
  FieldDefinition,
  TrackerDataModel,
} from '@nimbalyst/tracker-schema';
import type { CollabTypeLane } from './collabTypeResolver';

/** What the hosts' define-type write accepts: a full type, or a subtype's declared form. */
export type NewTypeSchema = TrackerDataModel | DerivedTrackerTypeDeclaration;

export type NewTypeFieldKind = 'text' | 'number' | 'select' | 'date' | 'person' | 'relation';

export interface NewTypeFieldDraft {
  label: string;
  kind: NewTypeFieldKind;
  /** select: comma-separated option labels, as typed. */
  options?: string;
  /** relation: the type the field links to. */
  targetTypeId?: string;
}

export interface NewTypeDraft {
  pluralName: string;
  singularName: string;
  icon: string;
  /** The parent type this one extends, or null for a standalone type. */
  extendsTypeId: string | null;
  fields: NewTypeFieldDraft[];
}

export interface NewTypeValidationContext {
  /** Every type id the host knows, in any section. A collision is refused, never replaced. */
  existingTypeIds: ReadonlySet<string>;
}

const TYPE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
/** Field names the product owns on every typed page. */
const RESERVED_FIELD_NAMES = new Set(['title', 'tags', 'id', 'type']);
const DEFAULT_COLOR = '#6b7280';

/** "Feature Request" -> "feature-request". Empty when the name has no usable characters. */
export function newTypeIdFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** "Renewal date" -> "renewalDate". */
export function newFieldNameFromLabel(label: string): string {
  const words = label.trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words
    .map((word, index) => (index === 0 ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1).toLowerCase()))
    .join('');
}

function parseOptions(options: string | undefined): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const parsed: Array<{ value: string; label: string }> = [];
  for (const raw of (options ?? '').split(',')) {
    const label = raw.trim();
    const value = newTypeIdFromName(label);
    if (!label || !value || seen.has(value)) continue;
    seen.add(value);
    parsed.push({ value, label });
  }
  return parsed;
}

/** Problems in reading order; empty when the draft can be written. */
export function validateNewTypeDraft(draft: NewTypeDraft, context: NewTypeValidationContext): string[] {
  const errors: string[] = [];
  if (!draft.pluralName.trim()) errors.push('Enter a plural name.');
  const typeId = newTypeIdFromName(draft.singularName);
  if (!draft.singularName.trim()) {
    errors.push('Enter a singular name.');
  } else if (!TYPE_ID_PATTERN.test(typeId)) {
    errors.push('The singular name must start with a letter.');
  } else if (context.existingTypeIds.has(typeId)) {
    errors.push(`A type named "${typeId}" already exists.`);
  }

  const names = new Set<string>();
  for (const field of draft.fields) {
    const label = field.label.trim();
    const name = newFieldNameFromLabel(label);
    if (!label) {
      errors.push('Every field needs a name.');
      continue;
    }
    if (!/^[a-z]/.test(name)) {
      errors.push(`"${label}" needs a name that starts with a letter.`);
      continue;
    }
    if (RESERVED_FIELD_NAMES.has(name)) {
      errors.push(`"${label}" is a built-in field name.`);
      continue;
    }
    if (names.has(name)) {
      errors.push(`Two fields are both named "${name}".`);
      continue;
    }
    names.add(name);
    if (field.kind === 'select' && parseOptions(field.options).length === 0) {
      errors.push(`"${label}" needs at least one option.`);
    }
    if (field.kind === 'relation' && !field.targetTypeId) {
      errors.push(`"${label}" needs a type to relate to.`);
    }
  }
  return errors;
}

function buildField(field: NewTypeFieldDraft): FieldDefinition {
  const name = newFieldNameFromLabel(field.label);
  switch (field.kind) {
    case 'text':
      return { name, type: 'string' };
    case 'number':
      return { name, type: 'number' };
    case 'date':
      return { name, type: 'date' };
    case 'person':
      return { name, type: 'user' };
    case 'select':
      return { name, type: 'select', options: parseOptions(field.options) };
    case 'relation':
      return { name, type: 'relationship', targetTrackerTypes: [field.targetTypeId!], multiValue: true };
  }
}

/**
 * The declaration to hand to the host's define-type write. Validate first:
 * this assumes `validateNewTypeDraft` returned no errors.
 */
export function buildNewTypeSchema(
  draft: NewTypeDraft,
  lane: CollabTypeLane,
): NewTypeSchema {
  const type = newTypeIdFromName(draft.singularName);
  const displayName = draft.singularName.trim();
  const displayNamePlural = draft.pluralName.trim();
  const icon = draft.icon.trim() || 'label';
  const fields = draft.fields.map(buildField);

  if (draft.extendsTypeId) {
    return { type, extends: draft.extendsTypeId, displayName, displayNamePlural, icon, fields };
  }
  return {
    type,
    displayName,
    displayNamePlural,
    icon,
    color: DEFAULT_COLOR,
    modes: { inline: true, fullDocument: true },
    idPrefix: type.replace(/[^a-z]/g, '').slice(0, 3) || 'typ',
    idFormat: 'ulid',
    fields: [{ name: 'title', type: 'string', required: true, displayInline: true }, ...fields],
    roles: { title: 'title' },
    sharing: lane,
  };
}
