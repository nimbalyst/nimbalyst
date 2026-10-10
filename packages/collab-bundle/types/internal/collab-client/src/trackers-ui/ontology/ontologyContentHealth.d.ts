/**
 * The graph's content health: stale or undated facts, pages missing what
 * their labels expect, statements pointing outside a property's range, pages
 * carrying labels nobody declared, and likely duplicates. The wiki home and
 * the ontology inspector report the same counts from this one function.
 *
 * Label-driven: which predicates are facts comes from the labels' fact boxes,
 * and what a page must have comes from their `expects`. A room with no label
 * registry reads through the kind stand-in (`effectiveLabelRegistry`), whose
 * product label expects a market and a maker, so the old "no market" and
 * "no maker" reports keep working on today's data.
 */
import type { LabelRegistry, PredicateDefinition } from '../../../../tracker-schema/src/browser';
import { type HealthItem, type KnowledgeGraph } from './ontologyKnowledge';
import { type KindOption } from './ontologyLabels';
import type { OntologyRecordLike } from './ontologyRecords';
export interface ContentHealthOptions {
    now: number;
    /** Stale threshold in days after the end of a fact's period. Default 90. */
    staleDays?: number;
    /** The room's label registry; empty or absent reads through the kind stand-in. */
    labels?: LabelRegistry | null;
    /** `entity.kind` options, for the stand-in's labels. */
    kindOptions?: readonly KindOption[];
    predicates?: readonly PredicateDefinition[] | null;
}
/** The registry health reads: the room's, or the kind stand-in built from the kinds pages use. */
export declare function healthLabelRegistry(graph: KnowledgeGraph, labels: LabelRegistry | null | undefined, kindOptions?: readonly KindOption[]): LabelRegistry;
/** Every predicate some label shows in its fact box. */
export declare function factBoxPredicates(registry: LabelRegistry): Set<string>;
export declare function computeContentHealth<T extends OntologyRecordLike>(records: readonly T[] | KnowledgeGraph<T>, options: ContentHealthOptions): Array<HealthItem<T>>;
