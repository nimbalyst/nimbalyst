/**
 * Collection (milestone / release) membership and rollups.
 *
 * A collection is an ordinary tracker item whose `items` relationship field
 * holds its members; each member carries the inverse `collection` field. This
 * module owns the pure logic -- which types are collections, how to add/remove a
 * member, and how to roll member statuses up into a progress summary -- so the
 * grid, detail panel, CLI, and MCP tools all agree.
 *
 * Rollups are computed from a single pass over the already-loaded records. Never
 * fetch per member: a collection with 200 items would otherwise issue 200
 * queries every time its row painted.
 */
import type { TrackerRecord } from '../../../core/TrackerRecord';
import type { FieldDefinition, TrackerRelationshipValue } from '../../../../../tracker-schema/src/browser';
import { type StatusCategory } from '../../../../../tracker-schema/src/browser';
/** Relationship key a collection uses to point at its members. */
export declare const COLLECTION_MEMBER_KEY = "has-item";
/** Relationship key a member uses to point back at its collection. */
export declare const COLLECTION_INVERSE_KEY = "in-collection";
/** Built-in tracker types that behave as collections. */
export declare const COLLECTION_TYPES: readonly ["milestone", "release"];
export type CollectionType = (typeof COLLECTION_TYPES)[number];
/**
 * Whether a tracker type is a collection.
 *
 * Determined by schema shape (does it own a `has-item` relationship field?) so a
 * user-defined type modeling its own sprint concept rolls up too; the built-in
 * list is only the fallback for types not in the registry.
 */
export declare function isCollectionType(type: string): boolean;
/** The field holding a collection's members, if the type has one. */
export declare function getMembersField(type: string): FieldDefinition | undefined;
/** The field on a member pointing back at its collection(s), if declared. */
export declare function getCollectionField(type: string): FieldDefinition | undefined;
/**
 * Whether a field definition is the member-side link to a collection -- i.e. the
 * field a "Collection" chip is bound to.
 *
 * The `in-collection` vocabulary key is the primary signal. A field that only
 * declares collection tracker types as its targets counts too, so a custom
 * schema that points at milestones without adopting the vocabulary still gets
 * the collection picker rather than the generic relationship editor.
 */
export declare function isCollectionRelationshipField(field: FieldDefinition): boolean;
/**
 * The collection types a field may create into, in schema order.
 * Falls back to the built-in list when the field targets anything.
 */
export declare function collectionTypesForField(field: FieldDefinition): string[];
/** Display label + icon for a collection type, for the inline create toggle. */
export declare function collectionTypeDisplay(type: string): {
    label: string;
    icon: string;
};
/** Member item ids of a collection record, deduped and in stored order. */
export declare function getMemberIds(collection: TrackerRecord): string[];
/**
 * The relationship value to write when adding `members` to `collection`.
 * Add-wins set semantics: existing members are preserved and duplicates collapse.
 */
export declare function addMembersValue(collection: TrackerRecord, members: TrackerRecord[]): TrackerRelationshipValue[];
/** The relationship value to write when removing member ids from a collection. */
export declare function removeMembersValue(collection: TrackerRecord, memberIds: string[]): TrackerRelationshipValue[];
export interface CollectionRollup {
    /** Members referenced by the collection, including any not currently loaded. */
    total: number;
    /** Members that were resolvable in the provided record set. */
    resolved: number;
    /** Member count per workflow status. */
    byStatus: Record<string, number>;
    /** Member count per lifecycle category. */
    byCategory: Record<StatusCategory, number>;
    /** Members finished successfully. */
    done: number;
    /** Members abandoned. Excluded from the progress denominator. */
    cancelled: number;
    /**
     * `done / (resolved - cancelled)` as a 0-100 integer; 0 when nothing is
     * resolved, 100 when everything resolvable was abandoned.
     */
    percentComplete: number;
}
/**
 * Roll a collection's members up into counts and a progress percentage.
 *
 * `itemsById` must be a prebuilt index of every candidate member -- build it
 * once for the whole view, not once per collection, so rendering N collections
 * stays O(total members) rather than O(N * all items).
 */
export declare function computeCollectionRollup(collection: TrackerRecord, itemsById: ReadonlyMap<string, TrackerRecord>, getStatus: (record: TrackerRecord) => string): CollectionRollup;
/**
 * Roll up many collections in one pass.
 * Builds the member index once and reuses it for every collection.
 */
export declare function computeCollectionRollups(collections: TrackerRecord[], allItems: TrackerRecord[], getStatus: (record: TrackerRecord) => string): Map<string, CollectionRollup>;
