/**
 * Fields that follow labels.
 *
 * An item's fields are its type's fields plus the properties its labels bring
 * (`effectiveProperties`, see `labelRegistry.ts`). This turns those properties
 * into what a field surface needs:
 *
 *  - FIELD-stored properties become synthetic `FieldDefinition`s, so the chip
 *    row, the detail pane and the status bar edit them with the editors every
 *    other field uses. They appear empty the moment a label is added.
 *  - Properties whose storage cannot be resolved are listed so a surface can
 *    flag them rather than drop them.
 *
 * Claim-stored properties from the earlier knowledge graph are not shown.
 * A field property that declares qualifiers stores `{ value, qualifiers }`;
 * {@link unwrapLabelFieldValue} and {@link wrapLabelFieldValue} let a chip edit
 * the bare value without dropping the qualifiers already stored beside it.
 */
import { type EffectiveProperty, type FieldDefinition, type FieldPropertyDefinition, type LabeledItem, type TrackerDataModelRegistry } from '../../../../../tracker-schema/src/browser';
/** A field synthesized from a label's field-stored property. */
export interface LabelFieldDefinition extends FieldDefinition {
    /** The property declaration this field was built from. */
    labelProperty: FieldPropertyDefinition;
    /** The label that brought the property (first in resolution order). */
    viaLabel: string;
    /** Header text; property ids are kebab-case and read badly formatted. */
    displayLabel: string;
}
export interface TrackerLabelFieldLayout {
    /** Field-stored properties the type does not already declare, in resolution order. */
    fields: LabelFieldDefinition[];
    /** Properties that are neither a field property, a predicate, nor a type field. */
    unknown: EffectiveProperty[];
}
export declare function isLabelFieldDefinition(field: FieldDefinition): field is LabelFieldDefinition;
/** Map a property declaration onto the field model the editors already understand. */
export declare function labelPropertyToFieldDefinition(property: FieldPropertyDefinition, viaLabel: string): LabelFieldDefinition;
/**
 * Resolve the label-driven part of an item's fields. `values` is the item's
 * field bag (`record.fields`, or a document's frontmatter), read for `labels`
 * and the legacy `kind`.
 */
export declare function resolveTrackerLabelFields(trackerType: string, values: LabeledItem | null | undefined, registry?: TrackerDataModelRegistry): TrackerLabelFieldLayout;
/** The bare value a chip edits. A qualified property stores `{ value, qualifiers }`. */
export declare function unwrapLabelFieldValue(field: FieldDefinition, stored: unknown): unknown;
/**
 * The stored shape for a new bare value. Qualifiers already on the item are
 * kept: changing a value must not silently drop the conditions it was stated
 * under. Clearing the value clears the whole entry.
 */
export declare function wrapLabelFieldValue(field: FieldDefinition, next: unknown, stored: unknown): unknown;
/**
 * Chip values for label fields: qualified values unwrapped, everything else
 * passed through. Returns `values` itself when no field is qualified, so a
 * memoized consumer keeps its identity.
 */
export declare function unwrapLabelFieldValues(fields: readonly FieldDefinition[], values: Record<string, unknown>): Record<string, unknown>;
/**
 * A re-render signal for the tracker registry. The registry is mutable and has
 * no atom, so surfaces that read it subscribe and bump a counter.
 */
export declare function useTrackerRegistryVersion(registry?: TrackerDataModelRegistry): number;
/** Stable key for the inputs label resolution reads, so an unrelated field edit is free. */
export declare function labelResolutionKey(values: LabeledItem | null | undefined): string;
/**
 * Memoized {@link resolveTrackerLabelFields}: recomputed only when the item's
 * labels or kind change, or the registry publishes a new vocabulary.
 */
export declare function useTrackerLabelFields(trackerType: string, values: LabeledItem | null | undefined): TrackerLabelFieldLayout;
