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
import type { FieldDefinition } from '../../../tracker-schema/src/browser';
export { PAGE_STATUSES, applyPageFieldsPatch, normalizePageFields, samePageFields, type PageFields, type PageStatus, } from '@nimbalyst/collab-protocol';
/** All of a page's fields, in display order (the Search table's columns). */
export declare const PAGE_FIELDS: readonly FieldDefinition[];
/** The page header shows single-valued fields only; tags live in tables and Search. */
export declare const PAGE_HEADER_FIELDS: readonly FieldDefinition[];
