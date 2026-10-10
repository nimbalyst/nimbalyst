/**
 * Whether a field holds exactly one value, and so may appear in a page header.
 *
 * A page header shows a type's scalar facts at a glance (status, a number, a
 * date, one linked owner). Lists of any kind -- multiselects, arrays, labels,
 * multi-valued links, citations, predicate statements, dated facts -- belong in
 * tables and the page's links section, never in the header. Every header
 * surface filters through this one rule so they cannot drift apart.
 */
import type { FieldDefinition } from './TrackerDataModel.js';
export declare function isSingleValuedField(field: FieldDefinition): boolean;
