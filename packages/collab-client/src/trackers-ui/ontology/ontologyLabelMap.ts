/**
 * The type map as data: one type per label (pages under it, how complete its
 * properties are, what it is a kind of), every relationship between two types
 * with its statement statistics and status (`typeMap/typeMapRelationships.ts`),
 * and the domain zones the types are grouped into (`typeMap/typeMapZones.ts`).
 * Structure labels (areas, home) stay off the map, as navigation.
 */
import type { LabelRole, PredicateDefinition } from '@nimbalyst/tracker-schema';
import { labelName, type LabelIndex } from './ontologyLabels';
import { ONTOLOGY_PROPOSAL_TYPE, openProposalsByCheck } from './ontologyProposals';
import type { OntologyRecordLike } from './ontologyRecords';
import { buildRelationships, declaredProperties, hasValue, type TypeMapRelationship } from './typeMap/typeMapRelationships';
import { buildZones, type TypeMapZone } from './typeMap/typeMapZones';
import { claimRecordsOf } from './ontologyTypePage';

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
export function typeMapRequestId(relationship: Pick<TypeMapRelationship, 'predicate' | 'from' | 'to' | 'status'>): string {
  return relationship.status === 'range-violation'
    ? `type-map:range:${relationship.from}.${relationship.predicate}>${relationship.to}`
    : `type-map:undeclared:${relationship.from}.${relationship.predicate}`;
}

export function buildTypeMap<T extends OntologyRecordLike>(
  index: LabelIndex<T>,
  records: readonly T[],
  options: TypeMapOptions = {},
): TypeMapModel {
  const { registry } = index;
  const ids = [...registry.labels.map((label) => label.id), ...index.undeclared];
  const structure = new Set(ids.filter((id) => index.labels.get(id)?.role === 'structure'));
  const relationships = buildRelationships(index, records, { ...options, skipLabels: structure });
  const has = hasValue(claimRecordsOf(records));
  const fields = new Map(registry.properties.map((property) => [property.id, property.label]));
  const predicates = new Map((options.predicates ?? []).map((predicate) => [predicate.id, predicate.label]));
  const propertyName = (id: string) => fields.get(id) ?? predicates.get(id)?.replace(/^is\s+(an?\s+)?/i, '') ?? options.predicateLabel?.(id) ?? id.replace(/-/g, ' ');

  const types = ids.filter((id) => !structure.has(id)).map((id): Omit<TypeMapType, 'zone'> => {
    const label = index.labels.get(id);
    const members = index.members.get(id) ?? [];
    return {
      id,
      name: labelName(registry, id),
      plural: labelName(registry, id, true),
      description: label?.description ?? '',
      role: label?.role ?? 'page',
      count: members.length,
      declared: Boolean(label),
      broader: (label?.broader ?? []).map((parent) => labelName(registry, parent)),
      properties: label ? [...declaredProperties(registry, id)].map((property) => ({
        id: property,
        name: propertyName(property),
        filled: members.filter((member) => has(member, property) > 0).length,
      })) : [],
    };
  });

  const { zones, zoneOf } = buildZones(registry, types, relationships.map((relationship) => ({ from: relationship.from, to: relationship.to, statements: relationship.statements })));
  const proposals = records.filter((record) => record.primaryType === ONTOLOGY_PROPOSAL_TYPE && !record.archived);
  return {
    types: types.map((type) => ({ ...type, zone: zoneOf.get(type.id)! })),
    relationships,
    zones,
    structure: [...structure].map((id) => ({ id, plural: labelName(registry, id, true), count: index.members.get(id)?.length ?? 0 })),
    unlabeled: index.unlabeled.length,
    openRequests: [...openProposalsByCheck(proposals).keys()].filter((check) => check.startsWith('type-map:')),
  };
}

