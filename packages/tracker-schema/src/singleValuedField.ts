/**
 * Whether a field holds exactly one value, and so may appear in a page header.
 *
 * A page header shows a type's scalar facts at a glance (status, a number, a
 * date, one linked owner). Lists of any kind -- multiselects, arrays, labels,
 * multi-valued links, citations, predicate statements, dated facts -- belong in
 * tables and the page's links section, never in the header. Every header
 * surface filters through this one rule so they cannot drift apart.
 */

import type { FieldDefinition, FieldType } from './TrackerDataModel.js';

const SINGLE_VALUED_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'string',
  'text',
  'number',
  'select',
  'date',
  'datetime',
  'boolean',
  'user',
  'url',
]);

export function isSingleValuedField(field: FieldDefinition): boolean {
  if (field.type === 'relationship' || field.type === 'reference') {
    // A predicate makes each value a qualified statement, which reads as a
    // list of edges even when only one is stored.
    return !field.multiValue && !field.predicate;
  }
  // Everything else not listed (multiselect, array, object, label-ref,
  // citation, predicate-ref, and any future type) stays out until it is
  // deliberately classified.
  return SINGLE_VALUED_TYPES.has(field.type);
}
