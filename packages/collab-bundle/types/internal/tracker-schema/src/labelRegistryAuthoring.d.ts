/**
 * Authoring a label registry: validation, merge-by-id patches, the sync
 * lane's three-way merge, and change classification. The model and the read
 * path are in `labelRegistry.ts`; read that header first.
 *
 * Validation differs from the predicate registry on purpose. Structural
 * defects (duplicate ids, a broader cycle, a missing broader target) are
 * errors, because a registry with them has no well-defined closure. Unknown
 * keys are warnings, so a newer release can add keys without older clients
 * dropping the whole vocabulary. References into the predicate registry are
 * only checked when the caller passes `predicateIds`: the two registries arrive
 * on separate rows in whatever order, and a sync decode that rejected labels
 * for naming a predicate that had not arrived yet would lose them.
 *
 * The package root re-exports `validateLabelRegistry` (the schema lane decodes
 * with it); everything else is imported from
 * `@nimbalyst/tracker-schema/labelRegistryAuthoring`.
 */
import { type ClaimPropertyExtension, type FieldPropertyDefinition, type LabelDefinition, type LabelIssue, type LabelRegistry } from './labelRegistry.js';
export interface LabelRegistryValidationContext {
    /** Predicate ids in force. Enables the cross-registry checks; see the header. */
    predicateIds?: Iterable<string>;
    /** Base field names of the item type. Defaults to {@link DEFAULT_LABEL_BASE_FIELD_NAMES}. */
    baseFieldNames?: readonly string[];
}
export type LabelRegistryValidation = {
    valid: true;
    registry: LabelRegistry;
    issues: [];
    warnings: LabelIssue[];
} | {
    valid: false;
    registry: null;
    issues: LabelIssue[];
    warnings: LabelIssue[];
};
/**
 * Validate a whole label registry. Missing sections read as empty, so a file
 * holding only `labels:` is valid.
 */
export declare function validateLabelRegistry(value: unknown, context?: LabelRegistryValidationContext): LabelRegistryValidation;
export type LabelRegistrySection = 'labels' | 'properties' | 'claimProperties';
export interface LabelRegistryRemovals {
    labels?: string[];
    properties?: string[];
    claimProperties?: string[];
}
export interface LabelRegistryPatch {
    labels?: LabelDefinition[];
    properties?: FieldPropertyDefinition[];
    claimProperties?: Record<string, ClaimPropertyExtension>;
}
/**
 * Apply an authored patch: each entry replaces the stored entry with its id
 * (in place) or is appended; `removals` deletes by id. Entry-level replacement
 * is what makes two agents adding DIFFERENT entries commute. Whether the
 * result is safe is the classifier's question, not this function's.
 */
export declare function applyLabelRegistryPatch(current: LabelRegistry, patch: LabelRegistryPatch, removals?: LabelRegistryRemovals): LabelRegistry;
/** Entry-order- and key-order-insensitive identity for a registry. */
export declare function canonicalLabelRegistryJson(registry: LabelRegistry): string;
export interface LabelRegistryMergeResult {
    merged: LabelRegistry;
    /** `<section>/<id>` keys kept from the local copy over (or absent from) the room's. */
    keptLocal: string[];
    /** `<section>/<id>` keys whose local change the room's newer version replaced. */
    overriddenLocal: string[];
    /**
     * `<section>/<id>` keys whose local change was valid on its own but broke the
     * merged registry (a cycle, a dangling broader, a clash); the room's version
     * was taken instead.
     */
    conflicts: string[];
}
/**
 * Three-way merge of a local copy with the room's registry, per entry, against
 * the room registry this peer last applied. Same rules as the predicate
 * registry merge: untouched locally takes the room's version (including its
 * deletions); changed only locally keeps the local one; changed on both sides
 * lets the room win, and so does the room deleting an entry this peer edited;
 * no baseline makes a first sync the union.
 *
 * Entries merge independently, but validity is a property of the whole
 * registry: `a.broader = [b]` here and `b.broader = [a]` in the room are each
 * valid and together a cycle. So the local decisions are replayed onto the
 * room's registry one at a time, and one that would leave it invalid is
 * dropped in favour of the room's version (reported in `conflicts`). Replay
 * runs to a fixpoint, so local entries that depend on each other survive in
 * any order. The result is valid whenever the room's registry is.
 */
export declare function mergeLabelRegistries(input: {
    baseline: LabelRegistry | null;
    local: LabelRegistry;
    remote: LabelRegistry;
}): LabelRegistryMergeResult;
/**
 * Keyed table rather than a list so a new kind has to state its verdict. As in
 * the predicate classifier, anything that is not a proven widening is
 * destructive. Presentation (label, pluralLabel, description, icon, color,
 * role, template, factBox, facet) is never a change.
 */
declare const LABEL_CHANGE_DESTRUCTIVE: {
    readonly 'label-added': false;
    readonly 'label-removed': true;
    readonly 'label-property-added': false;
    readonly 'label-property-removed': true;
    readonly 'label-broader-added': false;
    readonly 'label-broader-removed': true;
    readonly 'label-expects-changed': false;
    readonly 'property-added': false;
    readonly 'property-removed': true;
    readonly 'property-type-changed': true;
    readonly 'property-option-added': false;
    readonly 'property-option-removed': true;
    readonly 'property-range-widened': false;
    readonly 'property-range-narrowed': true;
    readonly 'property-multi-value-changed': true;
    readonly 'property-qualifier-changed': true;
    readonly 'claim-property-added': false;
    readonly 'claim-property-removed': true;
    readonly 'claim-property-range-widened': false;
    readonly 'claim-property-range-narrowed': true;
    readonly 'claim-property-option-added': false;
    readonly 'claim-property-option-removed': true;
};
export type LabelRegistryChangeKind = keyof typeof LABEL_CHANGE_DESTRUCTIVE;
export interface LabelRegistryChange {
    kind: LabelRegistryChangeKind;
    section: LabelRegistrySection;
    /** The label, property, or predicate id. */
    id: string;
    /** The property, broader label, option, or qualifier the change is about. */
    detail?: string;
    destructive: boolean;
}
export interface LabelRegistryChangeClassification {
    classification: 'none' | 'additive' | 'destructive';
    changes: LabelRegistryChange[];
}
export declare function classifyLabelRegistryChanges(previous: LabelRegistry, next: LabelRegistry): LabelRegistryChangeClassification;
export {};
