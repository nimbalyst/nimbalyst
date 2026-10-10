/**
 * The schema the "New type..." dialog writes: a person's few answers (names,
 * icon, a handful of fields, an optional parent) turned into the same
 * declaration `tracker_define_type` persists. Pure, so the dialog, the hosts
 * and the tests all agree on what a new type is.
 *
 * The section decides `sharing`: Team writes a team-owned schema, Personal a
 * local one. A subtype declares only what it adds and inherits everything
 * else from its parent, sharing included -- the dialog only offers parents
 * from the section it was opened in.
 */
import type { DerivedTrackerTypeDeclaration, TrackerDataModel } from '../../../tracker-schema/src/browser';
import type { CollabTypeLane } from './collabTypeResolver';
/** What the hosts' define-type write accepts: a full type, or a subtype's declared form. */
export type NewTypeSchema = TrackerDataModel | DerivedTrackerTypeDeclaration;
export type NewTypeFieldKind = 'text' | 'number' | 'select' | 'date' | 'person' | 'relation';
export interface NewTypeFieldDraft {
    label: string;
    kind: NewTypeFieldKind;
    /** select: comma-separated option labels, as typed. */
    options?: string;
    /** relation: the type the field links to. */
    targetTypeId?: string;
}
export interface NewTypeDraft {
    pluralName: string;
    singularName: string;
    icon: string;
    /** The parent type this one extends, or null for a standalone type. */
    extendsTypeId: string | null;
    fields: NewTypeFieldDraft[];
}
export interface NewTypeValidationContext {
    /** Every type id the host knows, in any section. A collision is refused, never replaced. */
    existingTypeIds: ReadonlySet<string>;
}
/** "Feature Request" -> "feature-request". Empty when the name has no usable characters. */
export declare function newTypeIdFromName(name: string): string;
/** "Renewal date" -> "renewalDate". */
export declare function newFieldNameFromLabel(label: string): string;
/** Problems in reading order; empty when the draft can be written. */
export declare function validateNewTypeDraft(draft: NewTypeDraft, context: NewTypeValidationContext): string[];
/**
 * The declaration to hand to the host's define-type write. Validate first:
 * this assumes `validateNewTypeDraft` returned no errors.
 */
export declare function buildNewTypeSchema(draft: NewTypeDraft, lane: CollabTypeLane): NewTypeSchema;
