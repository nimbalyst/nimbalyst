/**
 * How pages actually link to each other, per predicate and per pair of labels:
 * every asserted entity-valued statement (a `claim` whose object is a page,
 * or a relationship field whose property declares a range) counted under the
 * subject's and object's own labels, then classified against the vocabulary.
 *
 * - `declared-used`: the subject's label (or a broader one) lists the property
 *   and the object sits in its range.
 * - `declared-unused`: a label lists a ranged property nobody has used yet.
 * - `off-label`: pages use the predicate but the subject's label does not list it.
 * - `range-violation`: the object carries none of the labels the range names.
 *
 * Pure: the type map's lines, pills and inspector all read this.
 */
import { type ClaimRecord, type LabelRegistry, type PredicateDefinition } from '../../../../../tracker-schema/src/browser';
import { type LabelIndex } from '../ontologyLabels';
import { type OntologyRecordLike } from '../ontologyRecords';
export type RelationshipStatus = 'declared-used' | 'declared-unused' | 'off-label' | 'range-violation';
export interface TypeMapStatement {
    /** Null for a relationship field value. */
    claimId: string | null;
    subjectId: string;
    subjectTitle: string;
    objectId: string;
    objectTitle: string;
    /** Short text from the claim's own qualifiers, e.g. "high, AI app builder". */
    detail: string;
}
export interface TypeMapExpectation {
    min: number;
    /** Pages under the subject label with at least `min` statements. */
    met: number;
    total: number;
    missing: Array<{
        id: string;
        title: string;
    }>;
}
export interface TypeMapRelationship {
    /** `predicate|from|to`. */
    id: string;
    predicate: string;
    /** Short verb for pills and sentences: "in market", "made by". */
    verb: string;
    inverse: string | null;
    symmetric: boolean;
    from: string;
    to: string;
    status: RelationshipStatus;
    statements: number;
    subjects: number;
    objects: number;
    /** The range the vocabulary declares for the predicate; empty when none. */
    range: string[];
    topTargets: Array<{
        id: string;
        title: string;
        count: number;
    }>;
    expectation: TypeMapExpectation | null;
    /** Every statement, ordered by subject then object title. */
    list: TypeMapStatement[];
}
export interface RelationshipOptions {
    predicates?: readonly PredicateDefinition[];
    predicateLabel?: (id: string) => string;
    /** Labels left off the map (structure labels); statements touching only these are skipped. */
    skipLabels?: ReadonlySet<string>;
}
/** "is a component of" reads as "component of" on a line between two types. */
export declare function shortVerb(label: string): string;
export declare function buildRelationships<T extends OntologyRecordLike>(index: LabelIndex<T>, records: readonly T[], options?: RelationshipOptions): TypeMapRelationship[];
/** Property ids a label carries: its own and every broader label's. */
export declare function declaredProperties(registry: LabelRegistry, labelId: string): Set<string>;
/**
 * How many values a page has for a property: asserted statements with it as
 * the subject, or one for a non-empty field.
 */
export declare function hasValue(claims: readonly ClaimRecord[]): (record: OntologyRecordLike, property: string) => number;
