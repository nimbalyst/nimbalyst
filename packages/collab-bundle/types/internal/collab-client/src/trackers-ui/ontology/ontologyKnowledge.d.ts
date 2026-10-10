/**
 * The knowledge graph's reading of a tracker room: `entity` pages with a
 * `kind`, `claim` statements between them, the market tree, dated facts, and
 * likely duplicates. `ontologyContentHealth.ts` turns these into the content
 * problems a reader can act on.
 *
 * The vocabulary is the knowledge ontology's shared contract (r1 + r2):
 * `in-market`, `made-by`, `competes-with`, fact predicates carrying `asOf` and
 * an optional `asOfPrecision`. Pure, so the wiki home and the ontology
 * inspector report the same counts from the same function.
 */
import { type OntologyRecordLike } from './ontologyRecords';
export declare const ENTITY_TYPE = "entity";
export declare const CLAIM_TYPE = "claim";
/** Kinds that hold pages which say nothing about what the thing is. */
export declare const CATCH_ALL_KINDS: ReadonlySet<string>;
/** Kinds that are page structure (navigation), not a statement about the thing. */
export declare const STRUCTURE_KINDS: ReadonlySet<string>;
/** Competitor fields contract r1 moves into `competes-with` qualifiers. Kept in the schema, not read. */
export declare const DEPRECATED_ENTITY_FIELDS: ReadonlySet<string>;
export declare const FACT_PREDICATES: ReadonlySet<string>;
export declare const STALE_FACT_DAYS = 90;
/** A market with more products than this is worth splitting. */
export declare const OVERFULL_MARKET = 15;
export declare function entityKind(record: OntologyRecordLike): string;
export declare function claimPredicate(claim: OntologyRecordLike): string | null;
/** A claim's qualifiers as an object; tolerant of a JSON-string value. */
export declare function claimQualifiers(claim: OntologyRecordLike): Record<string, unknown>;
/** The live knowledge graph, indexed once. Archived items resolve through `allById` (citations may point at them). */
export interface KnowledgeGraph<T extends OntologyRecordLike = OntologyRecordLike> {
    live: T[];
    byId: ReadonlyMap<string, T>;
    allById: ReadonlyMap<string, T>;
    entities: T[];
    claims: T[];
    claimsBySubject: ReadonlyMap<string, T[]>;
    claimsByObject: ReadonlyMap<string, T[]>;
}
export declare function buildKnowledgeGraph<T extends OntologyRecordLike>(records: readonly T[]): KnowledgeGraph<T>;
export declare function hasKnowledgeTypes(typeNames: Iterable<string>): boolean;
export interface MarketNode<T extends OntologyRecordLike = OntologyRecordLike> {
    record: T;
    children: Array<MarketNode<T>>;
    /** Pages with an `in-market` claim naming this market. */
    direct: T[];
    /** Distinct pages in this market or any market beneath it. */
    total: number;
    empty: boolean;
    overfull: boolean;
}
/**
 * Market pages as a tree by `parent`; a market whose parent is not a market is
 * a root. `isMarket` reads the `market-node` role once there is a registry.
 */
export declare function buildMarketTree<T extends OntologyRecordLike>(graph: KnowledgeGraph<T>, isMarket?: (record: T) => boolean): Array<MarketNode<T>>;
export type AsOfPrecision = 'day' | 'month' | 'year';
/** When a fact dated `asOf` goes stale: `days` after the end of its period (the day, month or year). */
export declare function factStaleAt(asOf: unknown, precision: unknown, days?: number): number | null;
export interface FactValue<T extends OntologyRecordLike = OntologyRecordLike> {
    subject: T;
    predicate: string;
    claim: T;
    /** Null when the claim carries no `asOf`, which the contract requires. */
    asOf: string | null;
    precision: AsOfPrecision;
    /** `undated` has no `asOf`; `stale` is past its threshold; `current` is neither. */
    state: 'current' | 'stale' | 'undated';
}
/**
 * The current value of every fact: per subject and predicate, the asserted
 * claim with the latest `asOf`. Facts are the predicates labels put in a fact
 * box (`factPredicates`).
 */
export declare function currentFacts<T extends OntologyRecordLike>(graph: KnowledgeGraph<T>, now: number, days?: number, factPredicates?: ReadonlySet<string>): Array<FactValue<T>>;
export type ContentHealthCheck = 'stale-facts' | 'unmet-expects' | 'range-violation' | 'unknown-label' | 'duplicates';
export interface HealthItem<T extends OntologyRecordLike = OntologyRecordLike> {
    /** Stable across renders and sessions: an Improve request and its proposal carry it. */
    id: string;
    check: string;
    title: string;
    detail: string;
    /**
     * What `count` counts: items for most checks, facts for `stale-facts` (one
     * page can hold several), groups for `duplicates`, links for `broken-links`.
     */
    count: number;
    /** The items the problem is about, for links. */
    items: T[];
    /** Ids of `items`, in order: what a search or filter over the affected items takes. */
    itemIds: string[];
    /** Labels the problem is about, so a type page can show its own. */
    labelIds?: string[];
    /** `info` reports are observations, not problems to fix. */
    severity?: 'info';
    /** Duplicates only: the records that look like one thing, the one to keep first. */
    groups?: T[][];
    /** Ids of `groups`, in the same shape. */
    groupIds?: string[][];
}
/** A health item before its ids are derived from its records. */
export type HealthDraft<T extends OntologyRecordLike = OntologyRecordLike> = Omit<HealthItem<T>, 'itemIds' | 'groupIds'>;
export declare function withHealthIds<T extends OntologyRecordLike>(draft: HealthDraft<T>): HealthItem<T>;
/**
 * Live records whose title or an alias matches another's, across entity and
 * competitor items. Structure pages (areas, home) are navigation and never
 * count; `isStructure` says which those are (by label role once there is a
 * registry).
 */
export declare function findDuplicateGroups<T extends OntologyRecordLike>(graph: KnowledgeGraph<T>, isStructure?: (record: T) => boolean): T[][];
export declare function plural(count: number, one: string, many?: string): string;
