/**
 * Relationship field value model (Epic C, Phase 1).
 *
 * Relationships are field-backed: a relationship value lives inside the owning
 * tracker item's `fields` bag and syncs on the metadata socket exactly like
 * `labels` (see tracker-relationships-design.md). This module owns the PURE
 * value-model logic — vocabulary, normalize, validate, add/remove — so the
 * service layer, MCP tools, and UI all agree and it is unit-testable without a
 * DB. No I/O here.
 */
import type { FieldDefinition, TrackerRelationshipValue } from '../../../../../tracker-schema/src/browser';
/** A relationship vocabulary entry (label + behavior hints for a field). */
export interface TrackerRelationshipType {
    key: string;
    displayName: string;
    inverseKey?: string;
    inverseDisplayName?: string;
    category: 'dependency' | 'hierarchy' | 'reference' | 'governance' | 'custom';
    symmetric?: boolean;
    color?: string;
    icon?: string;
    description?: string;
}
/** Built-in relationship vocabulary. Custom keys may be added per workspace. */
export declare const BUILTIN_RELATIONSHIP_TYPES: TrackerRelationshipType[];
/** Look up a relationship type from the built-in vocabulary (+ optional custom). */
export declare function resolveRelationshipType(key: string | undefined, custom?: TrackerRelationshipType[]): TrackerRelationshipType | undefined;
/** True if a field definition is a relationship field (incl. the legacy alias). */
export declare function isRelationshipField(def: Pick<FieldDefinition, 'type'>): boolean;
/**
 * Coerce a raw stored value (object, array, or null/undefined) into a normalized
 * array of relationship values, deduped by `itemId` (last write wins for the
 * denormalized display fields). Tolerant of legacy/string-y shapes so reading a
 * pre-existing `reference` value never throws.
 */
export declare function normalizeRelationshipValue(raw: unknown): TrackerRelationshipValue[];
export interface RelationshipValidationContext {
    /** The item the relationship field belongs to (to reject self-links). */
    sourceItemId: string;
    /** Resolver: tracker type for a target item id (for target-type compat checks). */
    targetTypeOf?: (itemId: string) => string | undefined;
}
export interface RelationshipValidationError {
    code: 'self-link' | 'duplicate' | 'too-many' | 'target-type' | 'empty-target';
    itemId?: string;
    message: string;
}
/**
 * Validate a proposed normalized value against the field definition + context.
 * Returns all violations (empty = valid). Pure.
 */
export declare function validateRelationshipValue(def: FieldDefinition, values: TrackerRelationshipValue[], ctx: RelationshipValidationContext): RelationshipValidationError[];
/**
 * Add a target to a relationship field's current value (add-wins set; dedup by
 * itemId). For a single-value field, the new target REPLACES the existing one.
 * Returns the new normalized array; does not mutate inputs.
 */
export declare function addRelationshipValue(def: FieldDefinition, current: unknown, target: TrackerRelationshipValue): TrackerRelationshipValue[];
/** Remove a target by itemId. Returns the new normalized array. */
export declare function removeRelationshipValue(current: unknown, itemId: string): TrackerRelationshipValue[];
/**
 * Serialize a relationship value for storage in the item `fields` bag: a single
 * object (or null) for single-value fields, an array for multi-value fields.
 */
export declare function serializeRelationshipValue(def: FieldDefinition, values: TrackerRelationshipValue[]): TrackerRelationshipValue | TrackerRelationshipValue[] | null;
/** One derived edge for the local `tracker_relationship_index` projection. */
export interface RelationshipEdge {
    sourceItemId: string;
    sourceFieldId: string;
    relationshipTypeKey?: string;
    targetItemId: string;
    targetTrackerType?: string;
    /** Predicate id: the field's declared `predicate`, or a body link's `rel=`. */
    predicate?: string | null;
    metadata?: Record<string, unknown>;
}
/**
 * One line of a page's Links section, read through
 * `document-service:tracker-item-links`. Covers both body links (`body:<rel>`,
 * `body:link`) and relationship-field edges, in either direction.
 */
export interface TrackerPageLink {
    /** `out`: this item is the source; `in`: the other item links here. */
    direction: 'out' | 'in';
    /** Null for a plain link or a relationship field with no declared predicate. */
    predicateId: string | null;
    /**
     * The indexed relationship type. For a field edge this honors a value's own
     * `relationshipTypeKey` over the field default (null when neither is set), so
     * a predicate-less edge can still be labelled the right way round. For a body
     * edge it is the predicate id, or 'link' for a plain link.
     */
    relationshipTypeKey: string | null;
    otherItemId: string;
    otherTitle: string;
    otherIssueKey: string | null;
    otherTypeId: string;
    /** The sentence around a body link; null for field edges. */
    sentence: string | null;
    /** `body:<rel>`, `body:link`, or the relationship field id. */
    sourceFieldId: string;
}
/** A minimal reference to the source item, stamped onto a target's inverse field. */
export interface InverseSourceRef {
    itemId: string;
    issueKey?: string;
    title?: string;
    trackerType?: string;
}
/** One inverse-field mutation to apply to a target item (Phase 3). */
export interface InverseFieldDelta {
    /** The target item whose inverse field changes. */
    targetItemId: string;
    /** The field name on the target type that holds the inverse value. */
    inverseFieldId: string;
    /** Add (source now links to target) or remove (link was dropped). */
    op: 'add' | 'remove';
    /** The value (referencing the SOURCE item) to add/remove on the target. */
    value: TrackerRelationshipValue;
}
/**
 * Compute the inverse-field mutations for ONE relationship field after a source
 * item's value changed from `prev` to `next` (Phase 3 bidirectional write).
 *
 * Returns [] unless the field declares an `inverseFieldId` — only then is the
 * inverse materialized as a real field on the target. Added targets get an `add`
 * delta; dropped targets get a `remove`. The stamped value references the source
 * item and carries the field's `inverseRelationshipTypeKey` so the target pill
 * reads in the right direction (e.g. source `depends-on` → target `blocks`).
 *
 * Pure: the caller persists the result through the synced write path.
 */
export declare function computeInverseFieldDeltas(def: FieldDefinition, source: InverseSourceRef, prev: unknown, next: unknown): InverseFieldDelta[];
/**
 * Derive the outgoing relationship edges for one item from its `fields` bag and
 * its schema's field definitions. Pure: the index store persists the result.
 * Every relationship-typed field contributes one edge per (deduped) target.
 */
export declare function deriveRelationshipEdges(sourceItemId: string, fields: Record<string, unknown> | undefined, fieldDefs: FieldDefinition[]): RelationshipEdge[];
