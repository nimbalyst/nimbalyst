/**
 * The ontology inspector's main reading: "what does our team keep track of,
 * and how do those things relate?"
 *
 * `analyzeOntology` describes the schema (types, fields, predicates). This
 * describes the domain: categories a person would name (competitors, markets,
 * companies, capabilities, customers, bugs), how completely each named
 * relationship between them is recorded, and the gaps worth fixing, each in
 * domain words. Roles are derived, not declared: a competitor is a product
 * that is the object of `competes-with` from us, not a page type.
 *
 * Pure and host-agnostic, like the rest of this directory: desktop settings and
 * the web console's Tracker setup screen render the same model.
 */
import type { TrackerDataModel } from '../../../../tracker-schema/src/browser';
import { type OntologyInput, type TypeSummary } from './ontologyAnalysis';
import { type DomainGroupId } from './ontologyDomainVocabulary';
import { type FactValue, type HealthItem, type KnowledgeGraph, type MarketNode } from './ontologyKnowledge';
import { type OntologyRecordLike } from './ontologyRecords';
export type { DomainGroupId };
export declare const DOMAIN_GROUP_ORDER: readonly DomainGroupId[];
/** `full` is (nearly) every member; `low` under 60%; `untracked` means nothing can record it yet. */
export type LineState = 'full' | 'partial' | 'low' | 'untracked';
export interface DomainLine {
    /** `${categoryId}:${key}` */
    id: string;
    /** Plural present tense, read after the category name: "Competitors *sit in* markets". */
    verb: string;
    /** The category at the other end; null for an attribute ("have a threat level"). */
    targetId: string | null;
    /** Members with at least one link. */
    have: number;
    total: number;
    /** Links across all members. */
    links: number;
    rate: number;
    state: LineState;
    /** Members without the link, for the gap and the table. */
    missingIds: string[];
    /** How a member that lacks it reads, for a gap title: "have no known maker". */
    missing: string | null;
    /** What records it, in schema words, for the "how this is stored" disclosure. */
    via: string;
    gapId: string | null;
}
export type StoredPart = {
    text: string;
    code?: boolean;
};
export interface SchemaRow {
    label: string;
    /** Null when the value is not a per-item fill (an inverse field, say). */
    filled: number | null;
    total: number;
    /** An old field being retired, still shown so its values are not forgotten. */
    retired: boolean;
}
export interface DomainSchema {
    stored: StoredPart[];
    rows: SchemaRow[];
}
export interface MemberCell {
    text: string;
    tone?: 'warn' | 'faint';
    /** A threat level, rendered as a pill. */
    threat?: string;
}
export interface MemberRow {
    id: string;
    cells: MemberCell[];
}
export interface MemberTable {
    columns: string[];
    rows: MemberRow[];
}
export interface DomainCategory<T extends OntologyRecordLike = OntologyRecordLike> {
    id: string;
    name: string;
    singular: string;
    group: DomainGroupId;
    role: string;
    blurb: string;
    /** The headline number: open items for work trackers, every member otherwise. */
    count: number;
    /** "open" when `count` is the open subset of `total`. */
    countLabel: string | null;
    total: number;
    /** The product everything else is recorded relative to. */
    us: boolean;
    /** Suggested, not tracked: rendered dashed, and opening it proposes tracking it. */
    ghost: boolean;
    /** Most connected first. */
    members: T[];
    /** One line of examples for the card. */
    example: string;
    lines: DomainLine[];
    gapIds: string[];
    /** A secondary line under the relationship list ("Threat: 1 critical, 16 high"). */
    note: string | null;
    schema: DomainSchema | null;
    table: MemberTable;
}
export type DomainGapTone = 'gap' | 'opportunity';
/** A gap is a health item, so the existing proposal request and open-proposal lookup take it as is. */
export interface DomainGap<T extends OntologyRecordLike = OntologyRecordLike> extends HealthItem<T> {
    tone: DomainGapTone;
    categoryIds: string[];
}
export interface DomainEdge {
    id: string;
    from: string;
    to: string;
    verb: string;
    links: number;
    have: number;
    total: number;
    /** `weak` is possible but rarely used; `missing` is a link nothing records yet. */
    state: 'recorded' | 'weak' | 'missing';
    gapId: string | null;
}
export type SummaryPart = {
    text: string;
    categoryId?: string;
};
export interface DomainModel<T extends OntologyRecordLike = OntologyRecordLike> {
    us: T | null;
    categories: Array<DomainCategory<T>>;
    groups: Array<{
        id: DomainGroupId;
        label: string;
        question: string;
        categoryIds: string[];
    }>;
    /** Everything else with items, as chips. */
    also: Array<{
        id: string;
        name: string;
        count: number;
    }>;
    /** The plain sentence at the top, with clickable counts. */
    summary: SummaryPart[];
    meta: {
        pages: number;
        statements: number;
        types: number;
        lastChange: string | null;
    };
    gaps: Array<DomainGap<T>>;
    edges: DomainEdge[];
}
/** One line while it is being built: the line and, per member, what it links to. */
export interface LineCalc {
    line: DomainLine;
    /** Member id -> target ids (or attribute values for a line with no target). */
    targets: Map<string, string[]>;
    /** Identifies the link itself, so the two ends of one link draw one edge. */
    linkKey: string;
    /** The end that draws the edge and owns the gap. */
    owner: boolean;
}
/** What the detail builder needs to know about the room, beyond one category. */
export interface DomainContext<T extends OntologyRecordLike = OntologyRecordLike> {
    graph: KnowledgeGraph<T>;
    models: ReadonlyMap<string, TrackerDataModel>;
    summaries: ReadonlyMap<string, TypeSummary<T>>;
    us: T | null;
    facts: Array<FactValue<T>>;
    markets: Array<MarketNode<T>>;
    /** Item id -> category id. */
    categoryOf: ReadonlyMap<string, string>;
    categoryName: (id: string) => string;
    /** The tracker type a work category reads, by category id. */
    workType: ReadonlyMap<string, string>;
    now: number;
}
export declare function buildDomainModel<T extends OntologyRecordLike>(input: OntologyInput<T>): DomainModel<T>;
export { formatCount, nameList, singularVerb } from './ontologyDomainVocabulary';
export { suggestStructureRequest } from './ontologyDomainSummary';
