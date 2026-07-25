/**
 * Cell editor registry for the editable tracker grid.
 *
 * Maps a schema `FieldDefinition` to the editor a grid cell should use, and
 * converts values across the editor <-> storage boundary. Kept pure and free of
 * React/RevoGrid imports so both the grid surface and the detail panel can share
 * it, and so the mapping is unit-testable on its own.
 *
 * Storage shapes follow TrackerDataModel: `url` stores {@link UrlFieldValue},
 * `relationship` stores {@link TrackerRelationshipValue}[], `multiselect`/`array`
 * store string[], and dates store ISO strings.
 */

import type {
  FieldDefinition,
  FieldOption,
  UrlFieldValue,
} from '../models/TrackerDataModel';
import { normalizeRelationshipValue } from '../models/trackerRelationships';

/** Which editor a cell renders when it enters edit mode. */
export type CellEditorKind =
  | 'text'
  | 'multiline'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'user'
  | 'relationship'
  | 'url'
  | 'readonly';

export interface CellEditorDescriptor {
  kind: CellEditorKind;
  /** Choices for select/multiselect editors. */
  options?: FieldOption[];
  /** Relationship/multiselect cardinality. */
  multiValue?: boolean;
  min?: number;
  max?: number;
  targetTrackerTypes?: string[] | '*';
  relationshipTypeKey?: string;
}

/** Structural columns are derived, not stored fields -- never editable. */
export const READONLY_STRUCTURAL_COLUMNS = new Set([
  'type',
  'key',
  'updated',
  'created',
  'module',
  'shared',
]);

/**
 * Resolve the editor for a schema field. A missing field (or one the schema
 * marks `readOnly`) yields a `readonly` descriptor so the grid renders it as a
 * plain, non-editable cell rather than guessing.
 */
export function resolveCellEditor(field: FieldDefinition | undefined): CellEditorDescriptor {
  if (!field || field.readOnly) return { kind: 'readonly' };

  switch (field.type) {
    case 'text':
      return { kind: 'multiline' };
    case 'number':
      return { kind: 'number', min: field.min, max: field.max };
    case 'select':
      return { kind: 'select', options: field.options ?? [] };
    case 'multiselect':
      return { kind: 'multiselect', options: field.options ?? [], multiValue: true };
    case 'array':
      // Free-form tag lists (no fixed option set) still edit as a multi-value cell.
      return { kind: 'multiselect', options: field.options ?? [], multiValue: true };
    case 'date':
      return { kind: 'date' };
    case 'datetime':
      return { kind: 'datetime' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'user':
      return { kind: 'user' };
    case 'url':
      return { kind: 'url' };
    case 'relationship':
    case 'reference':
      return {
        kind: 'relationship',
        multiValue: field.multiValue ?? false,
        targetTrackerTypes: field.targetTrackerTypes,
        relationshipTypeKey: field.relationshipTypeKey,
      };
    case 'object':
      // No sensible inline editor for a nested object -- edit it in the detail panel.
      return { kind: 'readonly' };
    case 'string':
    default:
      return { kind: 'text' };
  }
}

/** Whether a column backed by `field` can be edited in place in the grid. */
export function isFieldEditableInGrid(
  columnId: string,
  field: FieldDefinition | undefined,
): boolean {
  if (READONLY_STRUCTURAL_COLUMNS.has(columnId)) return false;
  return resolveCellEditor(field).kind !== 'readonly';
}

function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(v => String(v).trim()).filter(v => v.length > 0);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map(v => v.trim())
      .filter(v => v.length > 0);
  }
  return [];
}

function isBlank(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
}

/**
 * Convert a value produced by a cell editor into the shape the tracker stores.
 *
 * Returns `undefined` to mean "clear this field" so a blanked cell round-trips
 * to an actual clear rather than persisting an empty string.
 */
export function coerceCellValue(field: FieldDefinition | undefined, raw: unknown): unknown {
  const descriptor = resolveCellEditor(field);

  switch (descriptor.kind) {
    case 'number': {
      if (isBlank(raw)) return undefined;
      const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());
      // A non-numeric entry is discarded rather than written as NaN.
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (isBlank(raw)) return false;
      const normalized = String(raw).trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes';
    }

    case 'multiselect': {
      const values = toStringArray(raw);
      return values.length > 0 ? values : undefined;
    }

    case 'date': {
      if (isBlank(raw)) return undefined;
      if (raw instanceof Date) {
        return Number.isNaN(raw.getTime()) ? undefined : raw.toISOString().slice(0, 10);
      }
      const text = String(raw).trim();
      // Already a plain calendar date -- keep it verbatim so no timezone shift occurs.
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
      const parsed = new Date(text);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
    }

    case 'datetime': {
      if (isBlank(raw)) return undefined;
      const parsed = raw instanceof Date ? raw : new Date(String(raw).trim());
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
    }

    case 'url': {
      if (isBlank(raw)) return undefined;
      if (typeof raw === 'object' && raw !== null && 'url' in (raw as UrlFieldValue)) {
        const value = raw as UrlFieldValue;
        return value.url ? value : undefined;
      }
      return { url: String(raw).trim() } satisfies UrlFieldValue;
    }

    case 'relationship': {
      if (isBlank(raw)) return [];
      const normalized = normalizeRelationshipValue(raw);
      // A single-value relationship keeps only the last target picked.
      return descriptor.multiValue ? normalized : normalized.slice(0, 1);
    }

    case 'readonly':
      return undefined;

    case 'select':
    case 'user':
    case 'text':
    case 'multiline':
    default: {
      if (isBlank(raw)) return undefined;
      return String(raw);
    }
  }
}

/**
 * Convert a stored value into the plain text a text-like editor seeds with.
 * Rich editors (select, relationship, boolean) take the stored value directly.
 */
export function formatCellForEditor(field: FieldDefinition | undefined, stored: unknown): string {
  if (stored === undefined || stored === null) return '';

  const descriptor = resolveCellEditor(field);
  switch (descriptor.kind) {
    case 'multiselect':
      return toStringArray(stored).join(', ');
    case 'url': {
      if (typeof stored === 'object' && stored !== null && 'url' in (stored as UrlFieldValue)) {
        return (stored as UrlFieldValue).url ?? '';
      }
      return String(stored);
    }
    case 'datetime': {
      const parsed = new Date(String(stored));
      return Number.isNaN(parsed.getTime()) ? String(stored) : parsed.toISOString();
    }
    default:
      return String(stored);
  }
}
