/**
 * Custom-fields-aware storage helpers for tracker relationship values (NIM-1305).
 *
 * Two storage shapes coexist in the `tracker_items.data` JSONB:
 *  - legacy/local: a field value sits at the TOP LEVEL of `data` (`data.features`).
 *  - synced/canonical: the sync round-trip (`trackerRecordToItem`) nests every
 *    non-fixed field under a `data.customFields` sub-object
 *    (`data.customFields.features`). This is the DURABLE form for any item that
 *    has ever synced — verified in the DB on NIM-985 / NIM-1332.
 *
 * The relationship-write subsystem historically read/wrote ONLY the top level, so
 * inverse propagation read a synced target's existing inverse array as empty and
 * clobbered it. These helpers are the single place that understands both shapes so
 * reads see the real value and writes land where the sync re-serialization keeps
 * them. Pure over `data`; no I/O.
 */
import type { FieldDefinition } from '../../../tracker-schema/src/browser';
/**
 * Read a field value tolerant of BOTH storage shapes. The nested `customFields`
 * value wins when present (it is the durable synced form and what the read model /
 * renderer ultimately surface); otherwise fall back to the top-level value.
 */
export declare function readStoredFieldValue(data: Record<string, unknown> | null | undefined, name: string): unknown;
/**
 * Write a field back to the shape that already owns it. A nested field stays
 * nested even when the writer's schema is stale and does not recognize its
 * relationship type. Removing the top-level shadow keeps read and sync
 * serialization from observing different values.
 */
export declare function writeStoredFieldValue(data: Record<string, unknown>, name: string, value: unknown): void;
/**
 * Move every relationship-typed field that currently sits at the TOP LEVEL of
 * `data` into the nested `data.customFields` bag (the durable synced location),
 * removing the top-level shadow so the two can never diverge (nested wins on read,
 * a stale top-level copy would be silently ignored). Sibling custom fields already
 * in `data.customFields` are preserved. Mutates `data` in place.
 *
 * Non-relationship custom fields keep their existing storage shape — only
 * relationship fields are normalized, since they are the ones the inverse-write
 * path mutates and the only ones whose location caused the clobber.
 */
export declare function nestRelationshipFieldsIntoCustomFields(data: Record<string, unknown>, fieldDefs: FieldDefinition[], options?: {
    writtenFields?: Iterable<string>;
}): void;
/**
 * Produce a flattened view of `data` with the nested `customFields` bag lifted to
 * the top level, for readers that expect flat field access (schema validation,
 * `deriveRelationshipEdges` / relationship-index reindex). Does not mutate `data`.
 */
export declare function flattenDataForRead(data: Record<string, unknown> | null | undefined): Record<string, unknown>;
