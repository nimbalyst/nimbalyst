/**
 * Splits a tracker type's fields into the chip row and the leftovers.
 *
 * `getTrackerFieldLayout` decides which fields a compact surface shows and in
 * what order. A surface that replaces a full form with chips still has to
 * account for the rest of the schema: fields the layout drops (opaque objects,
 * multiselects, read-only values) and arrays of objects, which have no one-line
 * form at all. A page header also passes `singleValuedOnly`, which sends every
 * list to the overflow (`isSingleValuedField`). This puts that split in one place so every chip surface makes the
 * same call, and so a surface can exclude a field it renders itself (Tracker
 * Mode's detail pane keeps tags as an always-open row).
 */
import type { FieldDefinition } from '../../../../../tracker-schema/src/browser';
/**
 * True when one chip can carry this field's value. An array of objects (a
 * plan's `agentSessions`, say) has no readable one-line form -- it stringifies
 * to `[object Object]` -- so it never becomes a chip.
 */
export declare function isChipRenderableField(field: FieldDefinition): boolean;
/**
 * The type's tags field, whatever the schema calls it. Surfaces that keep tags
 * as an always-open row (they're edited far more often than they're read) pull
 * it out of the chip row with this.
 */
export declare function getTrackerTagsField(trackerType: string): FieldDefinition | null;
export interface TrackerChipFieldSections {
    /** Fields for the chip row, in shared layout order. */
    chipFields: FieldDefinition[];
    /** Fields no chip can present; the surface places or omits these itself. */
    overflowFields: FieldDefinition[];
}
/**
 * @param trackerType Registered tracker type name.
 * @param exclude Field names the surface renders on its own, in neither section.
 * @param labelFields Fields the item's labels bring (`useTrackerLabelFields`).
 * @param options.singleValuedOnly Page headers only: keep every list out of the chips.
 */
export declare function getTrackerChipFieldSections(trackerType: string, exclude?: readonly string[], labelFields?: readonly FieldDefinition[], options?: {
    singleValuedOnly?: boolean;
}): TrackerChipFieldSections;
/** Memoized `getTrackerChipFieldSections` for component use. */
export declare function useTrackerChipFieldSections(trackerType: string, exclude?: readonly string[], labelFields?: readonly FieldDefinition[], singleValuedOnly?: boolean): TrackerChipFieldSections;
