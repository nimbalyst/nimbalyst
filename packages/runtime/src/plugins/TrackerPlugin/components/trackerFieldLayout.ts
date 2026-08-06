/**
 * Shared field-layout rules for tracker metadata surfaces.
 *
 * Every surface that shows a tracker item's fields (the focused document
 * header, the detail pane, document headers) should pick its fields here so
 * the same schema produces the same order and the same omissions everywhere.
 */

import { useMemo } from 'react';
import { globalRegistry } from '../models';
import type {
  FieldDefinition,
  TrackerSchemaRole,
} from '../models/TrackerDataModel';
import type { TrackerRecord } from '../../../core/TrackerRecord';

/** Semantic roles, in the order a reader scans them. */
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

/** Fallbacks for schemas that never declared roles but follow the conventions. */
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

/** Structural fields the surrounding chrome already renders. */
const BUILTIN_FIELDS = new Set(['title', 'description', 'created', 'updated']);

/** Types with no compact representation; they stay in the full detail view. */
const CHIP_UNSUPPORTED_FIELD_TYPES = new Set(['multiselect', 'object']);

/**
 * Resolve semantic fields first, then type-specific metadata in schema order.
 * Opaque objects, structural fields, and read-only values stay in the ordinary
 * detail view instead of turning a compact header into a second inspector.
 * Custom text fields remain eligible; only the built-in description is omitted.
 */
export function getTrackerFieldLayout(trackerType: string): FieldDefinition[] {
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
      || CHIP_UNSUPPORTED_FIELD_TYPES.has(field.type)
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

/** Memoized `getTrackerFieldLayout` for component use. */
export function useTrackerFieldLayout(trackerType: string): FieldDefinition[] {
  return useMemo(() => getTrackerFieldLayout(trackerType), [trackerType]);
}

/**
 * Format a display label from a camelCase field name.
 * e.g. "publishDate" -> "Publish Date", "storyPoints" -> "Story Points"
 */
export function formatTrackerFieldLabel(name: string): string {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (character) => character.toUpperCase())
    .trim();
}

/** True when a field value should render as "not set". */
export function isTrackerFieldEmpty(value: unknown): boolean {
  if (value == null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Date) return Number.isNaN(value.getTime());
  if (typeof value === 'object') {
    const candidate = value as { url?: unknown; label?: unknown; itemId?: unknown };
    if ('url' in candidate || 'label' in candidate || 'itemId' in candidate) {
      return !candidate.url && !candidate.label && !candidate.itemId;
    }
    return Object.keys(candidate).length === 0;
  }
  return false;
}

/**
 * Records that came from a file keep their document as the source of truth, but
 * the known file-backed sources round-trip edits, so they stay editable.
 */
export function isTrackerRecordEditable(record: TrackerRecord): boolean {
  return record.source === 'native'
    || !record.system.documentPath
    || record.source === 'frontmatter'
    || record.source === 'import'
    || record.source === 'inline';
}
