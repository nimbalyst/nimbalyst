/**
 * Label registry: the vocabulary half that `predicates.yaml` cannot carry.
 *
 * A label is a tag that carries fields. Put `feature` on a page and the page
 * has `feature`'s properties; a page may carry several labels, and a label may
 * sit under several broader labels. Labels are data in a registry rather than
 * tracker types (`extends`), because a tracker item has exactly one type and
 * relabeling must not mean moving it to another schema.
 *
 * The registry is `.nimbalyst/labels.yaml`, and like the predicate registry it
 * is a SCHEMA ARTIFACT the room owns and publishes on the schema lane under a
 * reserved type (`__labels__`, see `schemaSyncPayload.ts`). It has three
 * sections:
 *
 *  - `labels`          the labels themselves;
 *  - `properties`      FIELD-stored vocabulary entries, kept on the item as
 *                      `customFields[<id>]` (current value only);
 *  - `claimProperties` extensions to CLAIM-stored entries, keyed by predicate
 *                      id. The predicate itself stays in `predicates.yaml`; this
 *                      section carries the keys old clients would reject there
 *                      (`range`, `options`, `facet`).
 *
 * Field properties and predicates share ONE id namespace, so a label's
 * `properties` list names either without saying which.
 *
 * This module is the READ path every surface needs on first paint: the model,
 * resolution (labels, ancestors, effective properties, table columns), and the
 * warning-only checks on stored values. Validating, merging, patching and
 * classifying a registry is authoring, in `labelRegistryAuthoring.ts`; the
 * package root re-exports only its `validateLabelRegistry`, and the rest is
 * imported from `@nimbalyst/tracker-schema/labelRegistryAuthoring`, so a
 * browser bundle that re-exports the root does not carry the merge and the
 * classifier.
 *
 * Everything here is pure: plain objects in, plain objects out. Desktop, the
 * browser store, and the collab server all import it.
 */
import { type LabelPropertyQualifierDefinition, type LabelQualifierErrorCode } from './labelPropertyQualifiers.js';
/** `structure` pages (areas, home) and `market-node` pages render specially in the wiki. */
export type LabelRole = 'page' | 'structure' | 'market-node';
export declare const LABEL_ROLES: readonly LabelRole[];
/** Soft constraint: reported by health checks, never blocks a write. */
export interface LabelExpectation {
    property: string;
    min?: number;
    max?: number;
}
export interface LabelDefinition {
    id: string;
    label: string;
    pluralLabel?: string;
    description?: string;
    /** Multiple parents allowed; the graph must stay acyclic. */
    broader?: string[];
    icon?: string;
    color?: string;
    role?: LabelRole;
    /** Field property ids, predicate ids, or base field names of the item type. */
    properties?: string[];
    expects?: LabelExpectation[];
    /** Property ids shown in the page's fact box, in order. */
    factBox?: string[];
    /** Body skeleton for new pages. */
    template?: string;
    /** Reserved for declarative actions (a later plan). Accepted and ignored. */
    actions?: unknown;
}
export type FieldPropertyType = 'string' | 'text' | 'number' | 'date' | 'datetime' | 'select' | 'multiselect' | 'boolean' | 'url' | 'user' | 'relationship' | 'array';
export declare const FIELD_PROPERTY_TYPES: readonly FieldPropertyType[];
export type LabelPropertyOption = string | {
    value: string;
    label?: string;
    icon?: string;
    color?: string;
};
export interface FieldPropertyDefinition {
    id: string;
    label: string;
    type: FieldPropertyType;
    /** For `select` / `multiselect`. */
    options?: LabelPropertyOption[];
    /**
     * See `./labelPropertyQualifiers.ts`. When present the value is stored as
     * `{ value, qualifiers }`; otherwise it is stored bare.
     */
    qualifiers?: Record<string, LabelPropertyQualifierDefinition>;
    /** Offered as a search facet. */
    facet?: boolean;
    description?: string;
    /** For `relationship`: label ids the target should carry. Absent means any. */
    range?: string[];
    /** For `relationship`: more than one target. */
    multiValue?: boolean;
}
/** Extra keys for a claim-stored entry, which `predicates.yaml` cannot carry yet. */
export interface ClaimPropertyExtension {
    /** Label ids an entity-valued claim's object should carry. Absent means any. */
    range?: string[];
    /** Allowed values for a `select` predicate. */
    options?: string[];
    facet?: boolean;
    description?: string;
}
export interface LabelRegistry {
    labels: LabelDefinition[];
    properties: FieldPropertyDefinition[];
    claimProperties: Record<string, ClaimPropertyExtension>;
}
export declare function emptyLabelRegistry(): LabelRegistry;
export declare function isLabelRegistryEmpty(registry: LabelRegistry): boolean;
/**
 * Field names of the reference `entity` type. A field property may not reuse
 * one (its value would live in two places), but a label may LIST one in
 * `properties` -- `website` is a base field a label can still ask for.
 */
export declare const DEFAULT_LABEL_BASE_FIELD_NAMES: readonly string[];
export type LabelErrorCode = 'LABEL_REGISTRY_NOT_AN_OBJECT' | 'LABEL_NOT_AN_OBJECT' | 'LABEL_MISSING_FIELD' | 'LABEL_INVALID_FIELD' | 'LABEL_UNKNOWN_FIELD' | 'LABEL_DUPLICATE_ID' | 'LABEL_BROADER_UNKNOWN' | 'LABEL_CYCLE' | 'LABEL_PROPERTY_ID_CONFLICT' | 'LABEL_PROPERTY_BASE_FIELD' | 'LABEL_UNKNOWN_PROPERTY' | 'LABEL_EXPECTS_UNKNOWN_PROPERTY' | 'LABEL_RANGE_UNKNOWN' | 'LABEL_CLAIM_PROPERTY_UNKNOWN_PREDICATE' | 'LABEL_REF_INVALID' | 'LABEL_UNKNOWN' | 'LABEL_PROPERTY_INVALID_VALUE' | 'LABEL_PROPERTY_UNKNOWN_OPTION' | 'LABEL_PROPERTY_EXPECTS_QUALIFIED_VALUE';
export interface LabelIssue {
    code: LabelErrorCode | LabelQualifierErrorCode;
    path: string;
    message: string;
}
/** The part of an item label resolution reads. `customFields` is checked too. */
export type LabeledItem = {
    labels?: unknown;
    kind?: unknown;
    customFields?: unknown;
};
/** An item's own labels: its `labels` field, then its legacy `kind`, deduplicated. */
export declare function itemOwnLabels(item: LabeledItem): string[];
/**
 * Effective labels of an item: its own labels plus its legacy `kind`, closed
 * under `broader`. Unknown labels are kept, never dropped -- a health check
 * reports them.
 */
export declare function resolveLabels(registry: LabelRegistry, item: LabeledItem): string[];
/** Every label above `labelId`, nearest first, excluding itself. */
export declare function labelAncestors(registry: LabelRegistry, labelId: string): string[];
/** Every label below `labelId`, in registry order, excluding itself. */
export declare function labelDescendants(registry: LabelRegistry, labelId: string): string[];
export type EffectivePropertyStorage = 'field' | 'claim' | 'base-field' | 'unknown';
export interface EffectiveProperty {
    id: string;
    storage: EffectivePropertyStorage;
    /** The first label (in resolution order) that lists this property. */
    viaLabel: string;
    /** Present when `storage === 'field'`. */
    definition?: FieldPropertyDefinition;
    /** The `claimProperties` extension, when one is declared. */
    claim?: ClaimPropertyExtension;
}
export interface EffectivePropertyOptions {
    /** Whether an id is a predicate. Without it, only `claimProperties` marks a claim. */
    isPredicate?: (id: string) => boolean;
    baseFieldNames?: readonly string[];
}
/**
 * Union of `properties` over an item's effective labels: own labels first,
 * then ancestors, each property once. Properties are global ids, so two labels
 * asking for `owner` share the one `owner`.
 */
export declare function effectiveProperties(registry: LabelRegistry, item: LabeledItem, options?: EffectivePropertyOptions): EffectiveProperty[];
/**
 * Columns of a label's instance table: its own properties, then its
 * ancestors'. An item's OTHER labels never widen the table, so the columns
 * stay stable as items are relabeled.
 */
export declare function tableColumns(registry: LabelRegistry, labelId: string, options?: EffectivePropertyOptions): EffectiveProperty[];
export declare function labelPropertyOptionValues(property: FieldPropertyDefinition): string[];
/** Whether a property's value is stored as `{ value, qualifiers }`. */
export declare function isQualifiedFieldProperty(property: FieldPropertyDefinition): boolean;
/**
 * Check a stored field-property value against its declaration. Every issue is
 * a WARNING: the vocabulary may have moved under a value written earlier, and
 * a write path must never destroy it for that.
 */
export declare function validateFieldPropertyValue(property: FieldPropertyDefinition, stored: unknown): LabelIssue[];
/** Check a `label-ref` value. Unknown labels are warnings; a malformed value is an error. */
export declare function validateLabelRefValue(registry: LabelRegistry, value: unknown): {
    errors: LabelIssue[];
    warnings: LabelIssue[];
};
