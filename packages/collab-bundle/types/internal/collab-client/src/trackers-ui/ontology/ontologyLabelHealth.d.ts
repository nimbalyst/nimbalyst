/**
 * Health checks that read the label registry. Every one is a report; none
 * blocks a write (the vocabulary may have moved under data written earlier).
 *
 * Content checks (here), which the wiki home counts too:
 *  - `unmet-expects:<label>:<property>`: pages under a label with fewer (or
 *    more) values of a property than the label `expects`. The market pack's
 *    product label expecting `in-market` and `made-by` is what used to be the
 *    hard-coded "no market" and "no maker" checks.
 *  - `range-violation:<property>`: an entity-valued claim or relationship
 *    whose target carries none of the property's `range` labels.
 *  - `unknown-label:<label>`: pages carrying a label the registry lacks.
 *
 * Schema checks (`ontologyLabelSchemaHealth.ts`, loaded with the type pages
 * and the inspector), which only mean something once the room has a registry:
 *  - `sparse-field:entity:<label>:<property>`: fill rate under a third.
 *  - `off-label-claim:<predicate>` (informational): the subject has no label
 *    listing the predicate.
 *  - `undeclared-property:<label>:<property>`: a label lists an id that is no
 *    property, predicate or base field.
 *  - `label-cycle`, `duplicate-label:<a>+<b>` (same name, or near-identical
 *    descriptions).
 */
import type { LabelRegistry, PredicateDefinition } from '../../../../tracker-schema/src/browser';
import { type HealthItem, type KnowledgeGraph } from './ontologyKnowledge';
import { type LabelIndex } from './ontologyLabels';
import { type OntologyRecordLike } from './ontologyRecords';
export interface LabelHealthInput<T extends OntologyRecordLike = OntologyRecordLike> {
    /** The registry in force, the kind stand-in included (`effectiveLabelRegistry`). */
    registry: LabelRegistry;
    /** Whether `registry` is the stand-in: the schema checks are skipped then. */
    fallback?: boolean;
    graph: KnowledgeGraph<T>;
    index?: LabelIndex<T>;
    /** Null when the host cannot read the predicate registry. */
    predicates?: readonly PredicateDefinition[] | null;
}
export declare function isSymmetric(predicates: readonly PredicateDefinition[] | null | undefined, id: string): boolean;
/** How many values a page has for a property: asserted claims for a predicate, list length or 1 for a field. */
export declare function propertyValueCount(graph: KnowledgeGraph, page: OntologyRecordLike, property: string, options: {
    claim: boolean;
    symmetric?: boolean;
}): number;
/** The shared reading every label check starts from. */
export declare function labelHealthContext<T extends OntologyRecordLike>(input: LabelHealthInput<T>): {
    index: LabelIndex<T>;
    predicateIds: Set<string>;
    fieldIds: Set<string>;
    isClaim: (id: string) => boolean;
    name: (id: string) => string;
    fallback: boolean;
};
/** The content checks. */
export declare function computeLabelHealth<T extends OntologyRecordLike>(input: LabelHealthInput<T>): Array<HealthItem<T>>;
