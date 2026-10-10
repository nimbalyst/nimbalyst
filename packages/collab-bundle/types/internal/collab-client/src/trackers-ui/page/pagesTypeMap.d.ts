/**
 * A Pages section's Types as data: the map, in the shape `OntologyTypeMap`
 * draws, and the table (its other view). The map has one node per tracker type
 * in the section, a line for every relation one type declares to another, and
 * the zones that group related types.
 *
 * Relations come from the schemas: a relationship field whose
 * `targetTrackerTypes` name another type in the section, and a registry
 * predicate between two entity types whose subject and object kinds name the
 * types. A field's statements are its values, so the map can show which
 * relations are in use; a predicate written as a page link has no count here.
 */
import type { PredicateDefinition, TrackerDataModel } from '../../../../tracker-schema/src/browser';
import type { TypeMapModel, TypeMapRelationship, TypeMapType, TypeMapZone } from '../ontology/ontologyLabelMap';
export interface PagesTypeMapItem {
    id: string;
    primaryType: string;
    archived?: boolean;
    fields: Readonly<Record<string, unknown>>;
}
export interface PagesTypeMapInput {
    /** The section's types (its lane, listed). */
    types: readonly TrackerDataModel[];
    items: readonly PagesTypeMapItem[];
    predicates?: readonly PredicateDefinition[];
    itemTitle: (item: PagesTypeMapItem) => string;
}
export declare function buildPagesTypeMap({ types, items, predicates, itemTitle }: PagesTypeMapInput): TypeMapModel;
/**
 * Types joined by a relation share a zone, a type with none joins what it
 * extends, and groups under `MIN_ZONE_SIZE` are pooled. A zone is named after
 * the type with the most relations in it (then the most pages).
 */
export declare function buildPagesTypeZones(types: ReadonlyArray<Pick<TypeMapType, 'id' | 'plural' | 'count'>>, relationships: ReadonlyArray<Pick<TypeMapRelationship, 'from' | 'to'>>, extendsOf: (type: string) => string | undefined): {
    zones: TypeMapZone[];
    zoneOf: Map<string, string>;
};
export interface PagesTypeTableRow {
    id: string;
    name: string;
    /** The display name of the type it extends, when that type is in the section. */
    extendsName: string | null;
    /** Live (not archived) typed pages. */
    pages: number;
    /** Its own fields, not counting title, tags and relations. */
    fields: number;
    /** Its relationship fields. */
    relations: number;
    /** Placed in the section's tree. */
    placed: boolean;
}
/** One row per type in the section, by name. */
export declare function buildPagesTypeTable({ types, items, placedTypeIds }: {
    types: readonly TrackerDataModel[];
    items: readonly PagesTypeMapItem[];
    placedTypeIds: ReadonlySet<string>;
}): PagesTypeTableRow[];
