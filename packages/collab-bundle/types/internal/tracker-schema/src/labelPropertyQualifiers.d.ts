/**
 * Qualifiers on label-registry field properties.
 *
 * A field property may declare qualifiers, and its value is then stored as
 * `{ value, qualifiers }` (see `isQualifiedFieldProperty`). This module is the
 * declaration grammar, the value check, and the change verdicts for those
 * qualifiers. Relations do not carry qualifiers: a relation is a named
 * predicate with an inverse, nothing more.
 *
 * Pure: plain objects in, issues out. Declaration issues use the label
 * registry's own `LABEL_*_FIELD` codes; value issues carry `LABEL_QUALIFIER_*`.
 */
export type LabelPropertyQualifierType = 'string' | 'number' | 'boolean' | 'date' | 'select' | 'relationship' | 'array';
export declare const LABEL_PROPERTY_QUALIFIER_TYPES: readonly LabelPropertyQualifierType[];
/** Item types an `array` qualifier may hold. Nested objects are deliberately absent. */
export type LabelPropertyQualifierItemType = 'string' | 'number' | 'boolean';
export declare const LABEL_PROPERTY_QUALIFIER_ITEM_TYPES: readonly LabelPropertyQualifierItemType[];
export interface LabelPropertyQualifierDefinition {
    type: LabelPropertyQualifierType;
    /** Absent means optional. A qualifier becoming required is a destructive change. */
    required?: boolean;
    /** For `array`. Absent accepts any of {@link LABEL_PROPERTY_QUALIFIER_ITEM_TYPES}. */
    itemType?: LabelPropertyQualifierItemType;
    /** For `select`. Values, not labels: a qualifier is data, not presentation. */
    options?: string[];
    /** For `relationship`. Allowed target tracker types, or `'*'` for any. */
    targetTrackerTypes?: string[] | '*';
    /** Presentation only; never affects validation or change classification. */
    label?: string;
    /** Presentation only. */
    description?: string;
}
export type LabelQualifierErrorCode = 'LABEL_MISSING_FIELD' | 'LABEL_INVALID_FIELD' | 'LABEL_UNKNOWN_FIELD' | 'LABEL_QUALIFIERS_NOT_AN_OBJECT' | 'LABEL_QUALIFIER_REQUIRED' | 'LABEL_QUALIFIER_UNKNOWN' | 'LABEL_QUALIFIER_INVALID_TYPE' | 'LABEL_QUALIFIER_INVALID_OPTION';
export interface LabelQualifierIssue {
    code: LabelQualifierErrorCode;
    path: string;
    message: string;
}
/**
 * Validate one qualifier declaration. An unknown KEY is a warning (a later
 * release may add keys, and rejecting them would drop the whole registry); an
 * unknown TYPE is an error. Paths are `qualifiers.<name>[.<key>]`.
 */
export declare function validateLabelPropertyQualifierDeclaration(name: string, declaration: unknown, issues: LabelQualifierIssue[], warnings?: LabelQualifierIssue[]): void;
/**
 * Validate the qualifier bag stored beside one property value.
 *
 * `undefined` is an empty bag rather than "skip", so a required qualifier is
 * reported when the bag is missing entirely.
 */
export declare function validateLabelPropertyQualifiers(propertyId: string, declarations: Record<string, LabelPropertyQualifierDefinition> | undefined, value: unknown): LabelQualifierIssue[];
export type LabelPropertyQualifierChangeKind = 'qualifier-added' | 'qualifier-made-optional' | 'qualifier-option-added' | 'qualifier-removed' | 'qualifier-made-required' | 'qualifier-type-changed' | 'qualifier-option-removed' | 'qualifier-definition-changed';
export interface LabelPropertyQualifierChange {
    kind: LabelPropertyQualifierChangeKind;
    qualifierName: string;
    destructive: boolean;
}
/** Classify the data-bearing differences between two qualifier declaration sets. */
export declare function classifyLabelPropertyQualifierChanges(previous: Record<string, LabelPropertyQualifierDefinition> | undefined, next: Record<string, LabelPropertyQualifierDefinition> | undefined): LabelPropertyQualifierChange[];
