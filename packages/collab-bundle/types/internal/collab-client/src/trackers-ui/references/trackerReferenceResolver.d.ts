/**
 * Live data behind tracker references in a host that has a `TrackerDataSource`
 * but no desktop tracker atoms -- the web console.
 *
 * A `TrackerReferenceNode` stores only a key. Desktop resolves it through the
 * runtime Jotai store; a browser host has the data source instead, so this
 * builds the same answers from its snapshot and change stream.
 *
 * Shaped for `useSyncExternalStore`: one `subscribe`, and every read returns the
 * SAME object until something it depends on changes. A chip for KB-12 must not
 * re-render because KB-40 was edited, and a document can hold dozens of chips.
 * Reads are recomputed lazily against a version counter and then compared by
 * item identity -- the data source replaces only the items that changed, so an
 * unchanged item keeps its object and the previous result is handed back.
 *
 * Deliberately free of the tracker-ui barrels: the collab bundle's editor entry
 * imports this, and it must not drag the grid or list surfaces into that graph.
 */
import { type PredicateDefinition, type StatusCategory, type TrackerDataModel } from '../../../../tracker-schema/src/browser';
import type { TrackerDataSource, TrackerItem } from '../../trackers/dataSource';
import { type TrackerReferenceSearchResult } from '../../../../runtime/src/plugins/TrackerLinkPlugin/trackerReferenceSearch';
import type { TrackerReferenceStatusOption } from './trackerReferenceLifecycle';
export type { TrackerReferenceStatusOption } from './trackerReferenceLifecycle';
export type { TrackerReferenceSearchResult } from '../../../../runtime/src/plugins/TrackerLinkPlugin/trackerReferenceSearch';
export interface TrackerReferenceActor {
    email: string;
    name?: string;
}
export interface TrackerReferenceTypeInfo {
    type: string;
    displayName: string;
    /** CSS color from the schema, or a neutral token when the type is unknown. */
    color: string;
    /** Material Symbols ligature name; empty when the type is unknown. */
    icon: string;
}
export interface TrackerReferenceStatusInfo {
    value: string;
    label: string;
    /** CSS color: the option's own color, else one derived from its category. */
    color: string;
    category?: StatusCategory;
}
export type TrackerReferenceResolution = 
/** The data source has not delivered a synced snapshot yet; absence means nothing. */
{
    state: 'loading';
    key: string;
}
/** Synced, and no item carries this key or id. */
 | {
    state: 'missing';
    key: string;
} | {
    state: 'resolved';
    key: string;
    item: TrackerItem;
    typeInfo: TrackerReferenceTypeInfo;
    status: TrackerReferenceStatusInfo | null;
};
export interface TrackerStatement {
    claim: TrackerItem;
    predicateId: string | null;
    /** Item id the claim's `object` relationship points at, when the object is an entity. */
    objectItemId: string | null;
    valueText: string | null;
    basis: string | null;
    basisLabel: string | null;
    applicability: string | null;
    citationCount: number;
    status: TrackerReferenceStatusInfo | null;
}
export interface TrackerStatementGroup {
    predicateId: string | null;
    /** Registry label, else the raw predicate id, else "Unspecified". */
    label: string;
    statements: TrackerStatement[];
}
export interface TrackerBacklink {
    source: TrackerItem;
    /** Relationship field on `source` that targets the item. */
    fieldName: string;
    relationshipTypeKey?: string;
}
/** The slice of the schema registry this module reads; injectable for tests. */
export interface TrackerReferenceSchema {
    get(type: string): TrackerDataModel | undefined;
    getPredicate(id: string): PredicateDefinition | undefined;
    onChange(listener: () => void): () => void;
}
export interface TrackerReferenceResolver {
    subscribe(listener: () => void): () => void;
    /** Resolve an issue key (`KB-12`) or a record id. Stable until the item changes. */
    resolve(key: string): TrackerReferenceResolution;
    /** Claims whose `subject` targets the item, grouped by predicate. Stable. */
    statementsAbout(itemId: string): readonly TrackerStatementGroup[];
    /** Items with any relationship field targeting the item. Stable. */
    backlinks(itemId: string): readonly TrackerBacklink[];
    typeInfo(type: string): TrackerReferenceTypeInfo;
    statusInfo(item: TrackerItem): TrackerReferenceStatusInfo | null;
    /** Field value tolerant of both storage shapes (nested `customFields` wins). */
    fieldValue(item: TrackerItem, fieldName: string): unknown;
    /** Display label for a select option, falling back to the raw value. */
    optionLabel(type: string, fieldName: string, value: string): string;
    /** Item ids a relationship field on `item` targets, in stored order. */
    relationshipTargets(item: TrackerItem, fieldName: string): string[];
    predicateLabel(predicateId: string): string;
    /**
     * Items to offer when inserting a reference, ranked for a typed `#…` query
     * (title, issue key, optional `type:` scope). Present means the editor can
     * insert references; absent keeps it render-only.
     */
    search?(query: string | null, options?: {
        limit?: number;
    }): TrackerReferenceSearchResult;
    /** Present when the host can navigate to an item. */
    openItem?: (itemId: string) => void;
    /** The type's workflow status options, in schema order. */
    statusOptions?(type: string): TrackerReferenceStatusOption[];
    /** Writes flat field updates to a shared item. Absent means read-only. */
    updateItem?(itemId: string, updates: Record<string, unknown>): Promise<void>;
    /** Archives (or restores) an item; recoverable, unlike deleting it. */
    archiveItem?(itemId: string, archive: boolean): Promise<void>;
    currentActor?(): TrackerReferenceActor | null;
    /** Display name for an email, from identities recorded on loaded items. */
    personName?(email: string): string | null;
    dispose(): void;
}
export interface CreateTrackerReferenceResolverOptions {
    onOpenItem?: (itemId: string) => void;
    /** Defaults to the shared `globalRegistry` the browser schema store feeds. */
    schema?: TrackerReferenceSchema;
    currentActor?: () => TrackerReferenceActor | null;
    /** Display name from the host's member directory; consulted before item identities. */
    personName?: (email: string) => string | null;
}
export declare function createTrackerReferenceResolver(dataSource: TrackerDataSource, options?: CreateTrackerReferenceResolverOptions): TrackerReferenceResolver;
