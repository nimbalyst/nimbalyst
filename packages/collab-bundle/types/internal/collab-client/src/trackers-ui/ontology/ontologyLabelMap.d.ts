/**
 * The type map as data: one type per label (pages under it, how complete its
 * properties are, what it is a kind of), every relationship between two types
 * with its statement statistics and status (`typeMap/typeMapRelationships.ts`),
 * and the domain zones the types are grouped into (`typeMap/typeMapZones.ts`).
 * Structure labels (areas, home) stay off the map, as navigation.
 */
import type { LabelRole, PredicateDefinition } from '../../../../tracker-schema/src/browser';
import { type LabelIndex } from './ontologyLabels';
import type { OntologyRecordLike } from './ontologyRecords';
import { type TypeMapRelationship } from './typeMap/typeMapRelationships';
import { type TypeMapZone } from './typeMap/typeMapZones';
export type { RelationshipStatus, TypeMapRelationship, TypeMapStatement, TypeMapExpectation } from './typeMap/typeMapRelationships';
export type { TypeMapZone } from './typeMap/typeMapZones';
export interface TypeMapProperty {
    id: string;
    name: string;
    /** Pages under the type with a value. */
    filled: number;
}
export interface TypeMapType {
    id: string;
    name: string;
    plural: string;
    description: string;
    role: LabelRole;
    /** Pages under the label, narrower labels' included. */
    count: number;
    /** False for a label pages carry that the registry does not declare. */
    declared: boolean;
    /** Broader labels' names: "kind of X". */
    broader: string[];
    properties: TypeMapProperty[];
    zone: string;
}
export interface TypeMapStructureEntry {
    id: string;
    plural: string;
    count: number;
}
export interface TypeMapModel {
    types: TypeMapType[];
    relationships: TypeMapRelationship[];
    zones: TypeMapZone[];
    /** Structure labels (areas, home) are navigation and sit apart from the map. */
    structure: TypeMapStructureEntry[];
    unlabeled: number;
    /** Health-check ids of open proposal requests, so a request is not filed twice. */
    openRequests: string[];
}
export interface TypeMapOptions {
    predicates?: readonly PredicateDefinition[];
    predicateLabel?: (id: string) => string;
}
/** The proposal request a map action files for a relationship. */
export declare function typeMapRequestId(relationship: Pick<TypeMapRelationship, 'predicate' | 'from' | 'to' | 'status'>): string;
export declare function buildTypeMap<T extends OntologyRecordLike>(index: LabelIndex<T>, records: readonly T[], options?: TypeMapOptions): TypeMapModel;
