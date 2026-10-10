/**
 * Ontology proposals: agent-drafted changesets to the graph's shape that a
 * person accepts or rejects change by change (contract r1, `ontology-proposal`).
 *
 * Pure. `planOntologyChange` turns one change into the pages it touches, a
 * before/after of one of them, the tracker writes that apply it and the writes
 * that undo it -- so the preview a reader approves and the migration that runs
 * are computed by the same function. Schema changes (a label, a property, a
 * broader link, a range) cannot be written from the browser; an agent applies
 * them and marks the change, and data changes that need them wait until they
 * exist. The label changes live in `ontologyLabelProposals.ts`.
 *
 * `add-kind-option`, `add-predicate` and `reclassify-pages` are retired:
 * agents no longer draft them, but proposals that carry them still read, plan
 * and render.
 */
import type { LabelRegistry } from '../../../../tracker-schema/src/browser';
import { type HealthItem, type KnowledgeGraph } from './ontologyKnowledge';
import { type LabelChange } from './ontologyLabelProposals';
import { type OntologyRecordLike } from './ontologyRecords';
export declare const ONTOLOGY_PROPOSAL_TYPE = "ontology-proposal";
export type ProposalStatus = 'proposed' | 'accepted' | 'applied' | 'rejected' | 'undone';
export type ChangeDecision = 'pending' | 'accepted' | 'rejected';
interface ChangeBase {
    /** Unique within the proposal. */
    id: string;
    reason?: string;
    decision?: ChangeDecision;
    decidedBy?: string;
    decidedAt?: string;
    rejectReason?: string;
    /** Set when the change was applied: by the web console for data changes, by the agent for schema changes. */
    appliedAt?: string;
    undoneAt?: string;
}
export interface PredicateDraft {
    id: string;
    label: string;
    inverseLabel?: string;
    direction: 'directed' | 'symmetric';
    valueShape: string;
    subjectKinds?: string[];
    qualifiers?: Record<string, unknown>;
}
export type OntologyChange = ChangeBase & (LabelChange | {
    type: 'add-kind-option';
    value: string;
    label: string;
    icon?: string;
} | {
    type: 'reclassify-pages';
    toKind: string;
    pageIds: string[];
} | {
    type: 'add-market-node';
    title: string;
    parentId?: string | null;
    summary?: string;
    aliases?: string[];
} | {
    type: 'add-predicate';
    predicate: PredicateDraft;
} | {
    type: 'merge-duplicates';
    keepId: string;
    mergeIds: string[];
} | {
    type: 'move-field-to-claims';
    /** The entity field whose values move. */
    field: string;
    predicate: string;
    /** Restrict to these pages; default every entity with the field filled. */
    pageIds?: string[];
    /** When set, this entity is the claim's subject and the page is its object (Nimbalyst competes-with X). */
    subjectId?: string;
    /** Qualifier name -> entity field it is read from. */
    qualifiers?: Record<string, string>;
    /** Qualifiers every created claim carries (e.g. `asOf`). */
    staticQualifiers?: Record<string, unknown>;
    /** Put the field's value in `valueText`. Default: true when there is no `subjectId`. */
    valueText?: boolean;
});
export type OntologyChangeType = OntologyChange['type'];
/** Types an agent may draft today. */
export declare const CHANGE_TYPES: readonly OntologyChangeType[];
/** No longer drafted; kept so proposals that carry them still read, plan and apply. */
export declare const RETIRED_CHANGE_TYPES: readonly OntologyChangeType[];
/** Changes to the schema, which an agent applies; the rest are data the page writes. */
export declare const SCHEMA_CHANGE_TYPES: ReadonlySet<OntologyChangeType>;
export interface ParsedChanges {
    changes: OntologyChange[];
    /** One line per change that could not be read; never silently dropped. */
    errors: string[];
}
/** `changes` as the room stores it: a JSON string (or an array an agent wrote directly). */
export declare function parseProposalChanges(value: unknown): ParsedChanges;
export declare function serializeChanges(changes: readonly OntologyChange[]): string;
export type UndoOp = {
    op: 'restore-fields';
    itemId: string;
    fields: Record<string, unknown>;
} | {
    op: 'archive';
    itemId: string;
} | {
    op: 'unarchive';
    itemId: string;
};
export interface UndoEntry {
    changeId: string;
    appliedAt: string;
    appliedBy?: string;
    undoneAt?: string;
    /** In the order they undo: last write first. */
    ops: UndoOp[];
}
export interface UndoRecord {
    entries: UndoEntry[];
}
export declare function parseUndoRecord(value: unknown): UndoRecord;
export declare function serializeUndoRecord(record: UndoRecord): string;
export declare function decisionOf(change: OntologyChange): ChangeDecision;
export declare function isLive(change: OntologyChange): boolean;
/** Proposal status from its changes: the stored status is written from this, never edited by hand in the page. */
export declare function deriveProposalStatus(changes: readonly OntologyChange[]): ProposalStatus;
export declare function decideChange(changes: readonly OntologyChange[], changeId: string, decision: ChangeDecision, by: string | null, at: string, rejectReason?: string): OntologyChange[];
export type ApplyOp = {
    op: 'update';
    itemId: string;
    updates: Record<string, unknown>;
} | {
    op: 'create';
    item: {
        id: string;
        type: string;
        title: string;
        status: string;
        customFields: Record<string, unknown>;
    };
} | {
    op: 'archive';
    itemId: string;
};
export interface PreviewLine {
    label: string;
    value: string;
}
export interface ChangePreview {
    itemId: string | null;
    title: string;
    before: PreviewLine[];
    after: PreviewLine[];
}
export interface ChangePlan<T extends OntologyRecordLike = OntologyRecordLike> {
    summary: string;
    /** Pages the change touches. */
    pages: T[];
    example: ChangePreview | null;
    /** Writes that apply it, in order. */
    ops: ApplyOp[];
    /** Writes that reverse `ops`, in the order to run them. */
    undo: UndoOp[];
    /** Why it cannot be applied from here yet. */
    blocked: string | null;
    /** Schema changes: already true in the room, nothing to write. */
    satisfied: boolean;
}
export interface PlanEnv {
    /** Options of `entity.kind` in the room's live schema. */
    kindOptions: ReadonlySet<string>;
    predicateLabel: (id: string) => string;
    newId: () => string;
    /** The label registry in force (the kind stand-in included), for label changes. */
    labels?: LabelRegistry;
    /** Whether an id is a declared predicate. */
    isPredicate?: (id: string) => boolean;
}
export declare function planOntologyChange<T extends OntologyRecordLike>(change: OntologyChange, graph: KnowledgeGraph<T>, env: PlanEnv): ChangePlan<T>;
export interface ProposalRequestDraft {
    title: string;
    request: string;
    healthCheck: string;
}
/**
 * What the Improve button writes: a `proposed` proposal with no changes and a
 * request naming the health check and the pages, which the wiki update skill's
 * agent workflow picks up and fills in.
 */
export declare function proposalRequestFor<T extends OntologyRecordLike>(item: HealthItem<T>): ProposalRequestDraft;
/** Open proposals (not yet applied, rejected or undone) by the health check they answer. */
export declare function openProposalsByCheck<T extends OntologyRecordLike>(proposals: readonly T[]): Map<string, T>;
export {};
