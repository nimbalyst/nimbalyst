/**
 * Predicate registry (knowledge-scopes contract 4.1).
 *
 * A predicate is the verb in a statement: `product --integrates-with--> product`.
 * A relation is just that: a named predicate with an inverse label, carrying no
 * qualifiers. The registry is the declaration of those verbs, and it is a
 * SCHEMA ARTIFACT, not project configuration. Per decision 12 the room owns it
 * and publishes it to every client exactly like a type definition;
 * `.nimbalyst/predicates.yaml` is a local copy, never the distribution
 * mechanism. The transport lives in `schemaSyncPayload.ts` and rides the lane
 * type definitions already ride.
 *
 * This module is pure: plain objects in, issues out. It is reachable from
 * desktop, the web console, the collab server, and both MCP surfaces, so a bad
 * declaration reports the SAME code on all of them.
 *
 * Three properties shape this file, and they are the same three that shape
 * `./citationLocator.ts` for the same reasons.
 *
 * **Stable codes.** Every failure carries a `PREDICATE_*` code and a property
 * path. A message is for a person; a code is what a caller may branch on.
 *
 * **Tolerant on declarations.** An unknown KEY on a predicate declaration is a
 * warning: a later release adds keys (`objectKinds`) to this file, and a
 * client that rejected them would drop the whole registry and every field's
 * contract with it. The key is kept, not stripped. A `qualifiers` key left over
 * from an earlier registry lands here too.
 *
 * **Every issue in one pass.** A form or an MCP caller fixes a declaration in
 * one round trip rather than one per property.
 *
 * What this module does NOT do: resolve a relationship target, read items, or
 * decide whether a registry change is safe. That last one is
 * `./trackerPredicateRegistryChangeClassifier.ts`, which applies the same
 * additive-versus-destructive rule type schemas already get.
 */
/**
 * What the object of a statement is. A predicate's value shape and the field
 * carrying it have to agree, or the field stores something the predicate does
 * not describe. See {@link predicateValueShapeAcceptsFieldType}.
 */
export type PredicateValueShape = 'entity' | 'text' | 'boolean-assessment' | 'quantity' | 'select';
export declare const PREDICATE_VALUE_SHAPES: readonly PredicateValueShape[];
/** `symmetric` reads the same both ways (`relates-to`); `directed` does not. */
export type PredicateDirection = 'directed' | 'symmetric';
export declare const PREDICATE_DIRECTIONS: readonly PredicateDirection[];
export interface PredicateDefinition {
    id: string;
    label: string;
    /** How the statement reads from the object's side. Presentation only. */
    inverseLabel?: string;
    /**
     * Tracker types that may be the subject. `['*']` accepts any. A derived type
     * satisfies a base listed here -- see {@link isSubjectKindAllowed} -- which is
     * what lets a workspace declare predicates against `entity` while
     * domain-specific schemas narrow the kinds that extend it.
     */
    subjectKinds: string[];
    /**
     * Tracker types that may be the object of an `entity` statement, resolved
     * through `extends` like {@link subjectKinds}. Absent or `['*']` accepts any
     * type. This is what lets a link hover card offer only the relations that
     * make sense between two pages' types.
     */
    objectKinds?: string[];
    valueShape: PredicateValueShape;
    direction: PredicateDirection;
    /** Advisory for traversal; nothing in this package walks a transitive closure. */
    transitive?: boolean;
}
export type PredicateErrorCode = 'PREDICATE_NOT_AN_OBJECT' | 'PREDICATE_MISSING_FIELD' | 'PREDICATE_INVALID_FIELD' | 'PREDICATE_UNKNOWN_FIELD' | 'PREDICATE_DUPLICATE_ID' | 'PREDICATE_REGISTRY_NOT_AN_ARRAY' | 'PREDICATE_UNKNOWN' | 'PREDICATE_VALUE_SHAPE_MISMATCH' | 'PREDICATE_SUBJECT_KIND_NOT_ALLOWED';
export interface PredicateIssue {
    code: PredicateErrorCode;
    /** The offending property, or `''` when the subject as a whole is at fault. */
    path: string;
    message: string;
}
export type PredicateDefinitionValidation = {
    valid: true;
    predicate: PredicateDefinition;
    issues: [];
    warnings?: PredicateIssue[];
} | {
    valid: false;
    predicate: null;
    issues: PredicateIssue[];
    warnings?: PredicateIssue[];
};
/**
 * Validate one predicate declaration. Returns the narrowed definition on
 * success and every issue on failure, never a partially-accepted value: a
 * half-valid predicate types fields against a contract nobody authored.
 */
export declare function validatePredicateDefinition(value: unknown): PredicateDefinitionValidation;
export type PredicateRegistryValidation = {
    valid: true;
    predicates: PredicateDefinition[];
    issues: [];
    warnings?: PredicateIssue[];
} | {
    valid: false;
    predicates: null;
    issues: PredicateIssue[];
    warnings?: PredicateIssue[];
};
/**
 * Validate a whole registry. Entry issues are prefixed with the index, and a
 * duplicate id is reported on the later entry: two declarations of one verb
 * means every write validates against whichever happened to be registered last.
 */
export declare function validatePredicateRegistry(value: unknown): PredicateRegistryValidation;
/**
 * Whether `type` may be the subject of a predicate declaring `subjectKinds`.
 *
 * `baseOf` walks the `extends` chain, so a predicate declared against `entity`
 * accepts `product extends entity` with no edit to the predicate. Without this
 * every pack would have to restate its predicates for each derived kind, which
 * is the drift N5's inheritance resolver exists to prevent.
 *
 * Depth is bounded because a corrupted chain must not hang a write path; the
 * inheritance resolver rejects cycles, and this is the second line.
 */
export declare function isSubjectKindAllowed(subjectKinds: readonly string[], type: string, baseOf?: (type: string) => string | undefined): boolean;
/**
 * Whether a field of `fieldType` can carry a predicate of `valueShape`.
 *
 * Today only `entity` is exercised: 4.1 attaches `predicate` to a relationship
 * field, whose value IS the object of the statement. The rest of the table is
 * stated because the `claim` kind (N11) carries `value` shaped per its
 * predicate, and leaving the mapping implicit is how the two halves drift.
 */
export declare function predicateValueShapeAcceptsFieldType(valueShape: PredicateValueShape, fieldType: string): boolean;
export interface PredicateFieldDeclarationContext {
    /** Tracker type declaring the field: the subject of every statement it holds. */
    ownerType: string;
    /** The field's `type`, checked against the predicate's value shape. */
    fieldType: string;
    /** Resolve a tracker type's `extends` base, for {@link isSubjectKindAllowed}. */
    baseOf?: (type: string) => string | undefined;
}
/**
 * Validate a field's `predicate:` against the registry, at the moment the type
 * is declared rather than at the moment an item is written.
 *
 * A value-shape or subject-kind mismatch is a defect in the SCHEMA, and
 * reporting it on every item write would point the author at data that is
 * fine. `tracker_define_type` and the schema editor call this.
 */
export declare function validatePredicateFieldDeclaration(predicateId: string, predicate: PredicateDefinition | undefined, context: PredicateFieldDeclarationContext): PredicateIssue[];
/** The subset of a tracker type this check needs, so it stays free of the model. */
export interface PredicateDeclaringType {
    type: string;
    extends?: string;
    fields: ReadonlyArray<{
        name: string;
        type: string;
        predicate?: string;
    }>;
}
/**
 * Check every `predicate:` a type declares against the registry, at the moment
 * the type is authored.
 *
 * Issue paths are `fields.<name>.predicate`, so an authoring surface can point
 * at the row that is wrong rather than reporting "the schema is invalid".
 */
export declare function validateTrackerTypePredicateDeclarations(model: PredicateDeclaringType, lookup: (id: string) => PredicateDefinition | undefined, baseOf?: (type: string) => string | undefined): PredicateIssue[];
