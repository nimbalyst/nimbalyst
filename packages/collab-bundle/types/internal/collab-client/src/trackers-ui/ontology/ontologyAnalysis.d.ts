/**
 * The ontology inspector's view model: the shape of a tracker room rather than
 * its content. Every tracker type with its item count and per-field fill
 * rates, the relationship fields drawn as a graph between types, predicates
 * against the room's registry, a knowledge section (markets, facts) when the
 * knowledge types exist, and a Health list of concrete problems.
 *
 * Host-agnostic and pure: it takes the type schemas, the predicate registry
 * and the records, so desktop settings and the web console's Tracker setup
 * screen render the same numbers.
 */
import type { LabelRegistry, PredicateDefinition, TrackerDataModel } from '../../../../tracker-schema/src/browser';
import { type HealthItem, type KnowledgeGraph, type MarketNode } from './ontologyKnowledge';
import { type OntologyRecordLike } from './ontologyRecords';
/** A field filled on fewer than this share of its items is sparse. */
export declare const SPARSE_FILL_RATE: number;
export interface OntologyInput<T extends OntologyRecordLike = OntologyRecordLike> {
    types: readonly TrackerDataModel[];
    /**
     * The predicate registry, or null/absent when the host has not received one
     * yet; predicates are then keyed off the ids claims use. An empty array means
     * a registry that declares nothing, which is a different answer from
     * "unknown".
     */
    predicates?: readonly PredicateDefinition[] | null;
    /** The room's label registry; empty or absent reads through the kind stand-in. */
    labels?: LabelRegistry | null;
    records: readonly T[];
    now: number;
}
export interface FieldFill {
    name: string;
    type: string;
    filled: number;
    rate: number;
    deprecated: boolean;
}
export interface KindSummary<T extends OntologyRecordLike = OntologyRecordLike> {
    kind: string;
    label: string;
    count: number;
    examples: T[];
    fields: FieldFill[];
    structure: boolean;
    catchAll: boolean;
}
export interface TypeSummary<T extends OntologyRecordLike = OntologyRecordLike> {
    type: string;
    displayName: string;
    icon: string;
    color: string;
    sharing: 'personal' | 'team';
    /** False for a type items use that the room's schema does not declare. */
    declared: boolean;
    count: number;
    archived: number;
    examples: T[];
    /** Every measured field, most filled first; zero-filled fields included so unused ones show. */
    fields: FieldFill[];
    /** Present when the type has a `kind` select: the same view per kind. */
    kinds: Array<KindSummary<T>> | null;
}
export interface RelationshipEdge {
    /** `source.field` */
    id: string;
    source: string;
    field: string;
    /** The relationship key or predicate, for the edge label. */
    label: string;
    predicate: string | null;
    declaredTargets: string[] | '*';
    multi: boolean;
    /** Target references across live items of the source type. */
    links: number;
    itemsWithLinks: number;
    /** Where the links actually land, by target type; `missing` for ids no item has. */
    observedTargets: Array<{
        type: string;
        count: number;
    }>;
}
export interface RelationshipGraph {
    nodes: Array<{
        type: string;
        displayName: string;
        color: string;
        count: number;
    }>;
    edges: RelationshipEdge[];
}
export interface KindCount {
    kind: string;
    count: number;
}
export interface PredicateUsage {
    id: string;
    /** The registry label, or the id itself when there is no registry to read it from. */
    label: string;
    /** Null when there is no registry to check against. */
    declared: boolean | null;
    count: number;
    subjectKinds: KindCount[];
    /** Kinds on the object end; `value` for claims that state a value rather than name an item. */
    objectKinds: KindCount[];
}
export interface PredicatesSummary {
    /** False when no registry was given: labels are ids, and nothing can be called unused or undeclared. */
    registryAvailable: boolean;
    used: PredicateUsage[];
    /** Declared predicates no claim uses; empty without a registry. */
    unused: Array<{
        id: string;
        label: string;
    }>;
    /** Claims with no predicate at all. */
    unspecified: number;
}
export interface KnowledgeSection<T extends OntologyRecordLike = OntologyRecordLike> {
    markets: Array<MarketNode<T>>;
    facts: {
        total: number;
        current: number;
        stale: number;
        undated: number;
        byPredicate: KindCount[];
    };
}
export interface OntologyViewModel<T extends OntologyRecordLike = OntologyRecordLike> {
    types: Array<TypeSummary<T>>;
    relationships: RelationshipGraph;
    /** Null when the room has neither claims nor a non-empty predicate registry. */
    predicates: PredicatesSummary | null;
    /** Null unless the room has the knowledge types (`entity` and `claim`). */
    knowledge: KnowledgeSection<T> | null;
    health: Array<HealthItem<T>>;
}
export declare function summarizeTypes<T extends OntologyRecordLike>(types: readonly TrackerDataModel[], records: readonly T[]): Array<TypeSummary<T>>;
/** Relationship fields as edges between types, with how many links each carries and where they land. */
export declare function buildRelationshipGraph<T extends OntologyRecordLike>(types: readonly TrackerDataModel[], records: readonly T[]): RelationshipGraph;
export declare function summarizePredicates(graph: KnowledgeGraph, registry: readonly PredicateDefinition[] | null | undefined): PredicatesSummary;
/** Problems with the schema's use: catch-all kinds, sparse and deprecated fields, undeclared predicates, links to nothing. */
export declare function schemaHealth<T extends OntologyRecordLike>(summaries: ReadonlyArray<TypeSummary<T>>, input: OntologyInput<T>, graph: KnowledgeGraph<T>, relationships: RelationshipGraph): Array<HealthItem<T>>;
export declare function analyzeOntology<T extends OntologyRecordLike>(input: OntologyInput<T>): OntologyViewModel<T>;
