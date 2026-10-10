/**
 * A plain page's own fields. Every page in Pages is a typed "Page": a plain
 * page carries a small fixed set of fields on its document row, not as a
 * tracker item (no issue key, no open-work status, nothing to convert). A page
 * given another type through Set type takes that type's fields instead.
 *
 * The values and their one validation gate (`normalizePageFields`) live in
 * `@nimbalyst/collab-protocol` so the sync server validates Team writes the
 * same way; this module adds the field definitions the UI renders.
 */
import type { FieldDefinition } from '@nimbalyst/tracker-schema';

export {
  PAGE_STATUSES,
  applyPageFieldsPatch,
  normalizePageFields,
  samePageFields,
  type PageFields,
  type PageStatus,
} from '@nimbalyst/collab-protocol';

/** All of a page's fields, in display order (the Search table's columns). */
export const PAGE_FIELDS: readonly FieldDefinition[] = [
  {
    name: 'status',
    type: 'select',
    options: [
      { value: 'draft', label: 'Draft', icon: 'edit_note', color: '#64748b' },
      { value: 'current', label: 'Current', icon: 'check_circle', color: '#22c55e' },
      { value: 'outdated', label: 'Outdated', icon: 'history_toggle_off', color: '#f59e0b' },
    ],
  },
  { name: 'owner', type: 'user' },
  { name: 'summary', type: 'string', maxLength: 280 },
  { name: 'tags', type: 'array', itemType: 'string' },
] as FieldDefinition[];

/** The page header shows single-valued fields only; tags live in tables and Search. */
export const PAGE_HEADER_FIELDS: readonly FieldDefinition[] = PAGE_FIELDS.filter((field) => field.type !== 'array');
