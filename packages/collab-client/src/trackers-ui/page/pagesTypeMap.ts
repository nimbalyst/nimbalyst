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
import type { FieldDefinition, PredicateDefinition, TrackerDataModel } from '@nimbalyst/tracker-schema';
import type { TypeMapModel, TypeMapRelationship, TypeMapStatement, TypeMapType, TypeMapZone } from '../ontology/ontologyLabelMap';

/** Groups smaller than this are pooled into one last zone, as the label map does. */
const MIN_ZONE_SIZE = 3;
const OTHER_ZONE = '~other';

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

function humanize(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
}

function targetIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list.flatMap((entry) => {
    if (typeof entry === 'string') return entry ? [entry] : [];
    if (entry && typeof entry === 'object' && typeof (entry as { itemId?: unknown }).itemId === 'string') return [(entry as { itemId: string }).itemId];
    return [];
  });
}

const isRelationField = (field: FieldDefinition) => field.type === 'relationship' || field.type === 'reference';

/** True when `kinds` admits `type`, directly or through what it extends. */
function admits(kinds: readonly string[] | undefined, type: string, extendsOf: (type: string) => string | undefined): boolean {
  if (!kinds) return false;
  if (kinds.includes('*')) return true;
  for (let current: string | undefined = type, guard = 0; current && guard < 16; current = extendsOf(current), guard++) {
    if (kinds.includes(current)) return true;
  }
  return false;
}

export function buildPagesTypeMap({ types, items, predicates = [], itemTitle }: PagesTypeMapInput): TypeMapModel {
  const byType = new Map(types.map((model) => [model.type, model]));
  const extendsOf = (type: string) => byType.get(type)?.extends;
  const live = items.filter((item) => !item.archived && byType.has(item.primaryType));
  const itemById = new Map(live.map((item) => [item.id, item]));
  const membersOf = (type: string) => live.filter((item) => item.primaryType === type);

  const nodes: Array<Omit<TypeMapType, 'zone'>> = types.map((model) => {
    const members = membersOf(model.type);
    return {
      id: model.type,
      name: model.displayName || model.type,
      plural: model.displayNamePlural || model.displayName || model.type,
      description: (model as { description?: string }).description ?? '',
      role: 'page',
      count: members.length,
      declared: true,
      broader: model.extends && byType.has(model.extends) ? [byType.get(model.extends)!.displayName] : [],
      properties: model.fields
        .filter((field) => field.name !== 'title' && field.name !== 'tags')
        .map((field) => ({
          id: field.name,
          name: humanize(field.name),
          filled: members.filter((member) => {
            const value = member.fields[field.name];
            return value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
          }).length,
        })),
    };
  });

  const relationships: TypeMapRelationship[] = [];
  const fieldPredicates = new Set<string>();
  for (const model of types) {
    for (const field of model.fields.filter(isRelationField)) {
      if (field.predicate) fieldPredicates.add(field.predicate);
      const targets = Array.isArray(field.targetTrackerTypes) ? field.targetTrackerTypes.filter((type) => byType.has(type)) : [];
      const predicate = field.predicate ? predicates.find((entry) => entry.id === field.predicate) : undefined;
      for (const to of targets) {
        const list: TypeMapStatement[] = [];
        for (const subject of membersOf(model.type)) {
          for (const objectId of targetIds(subject.fields[field.name])) {
            const object = itemById.get(objectId);
            if (!object || object.primaryType !== to) continue;
            list.push({ claimId: null, subjectId: subject.id, subjectTitle: itemTitle(subject), objectId, objectTitle: itemTitle(object), detail: '' });
          }
        }
        list.sort((a, b) => a.subjectTitle.localeCompare(b.subjectTitle) || a.objectTitle.localeCompare(b.objectTitle));
        const targetsCount = new Map<string, { id: string; title: string; count: number }>();
        for (const statement of list) {
          const entry = targetsCount.get(statement.objectId) ?? { id: statement.objectId, title: statement.objectTitle, count: 0 };
          entry.count += 1;
          targetsCount.set(statement.objectId, entry);
        }
        relationships.push({
          id: `${field.name}|${model.type}|${to}`,
          predicate: field.predicate ?? field.name,
          verb: predicate?.label ?? humanize(field.relationshipTypeKey ?? field.name),
          inverse: predicate?.inverseLabel ?? field.inverseRelationshipTypeKey ?? null,
          symmetric: Boolean(field.symmetric) || predicate?.direction === 'symmetric',
          from: model.type,
          to,
          status: list.length ? 'declared-used' : 'declared-unused',
          statements: list.length,
          subjects: new Set(list.map((statement) => statement.subjectId)).size,
          objects: targetsCount.size,
          range: [to],
          topTargets: [...targetsCount.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)).slice(0, 5),
          expectation: null,
          list,
        });
      }
    }
  }
  // A page-link relation names its kinds; one that admits every type would draw a line between everything.
  for (const predicate of predicates) {
    if (predicate.valueShape !== 'entity' || fieldPredicates.has(predicate.id)) continue;
    if (predicate.subjectKinds.includes('*') || !predicate.objectKinds || predicate.objectKinds.includes('*')) continue;
    for (const from of types) {
      if (!admits(predicate.subjectKinds, from.type, extendsOf)) continue;
      for (const to of types) {
        if (!admits(predicate.objectKinds, to.type, extendsOf)) continue;
        relationships.push({
          id: `${predicate.id}|${from.type}|${to.type}`,
          predicate: predicate.id,
          verb: predicate.label,
          inverse: predicate.inverseLabel ?? null,
          symmetric: predicate.direction === 'symmetric',
          from: from.type,
          to: to.type,
          status: 'declared-unused',
          statements: 0,
          subjects: 0,
          objects: 0,
          range: predicate.objectKinds,
          topTargets: [],
          expectation: null,
          list: [],
        });
      }
    }
  }

  const { zones, zoneOf } = buildPagesTypeZones(nodes, relationships, extendsOf);
  return {
    types: nodes.map((node) => ({ ...node, zone: zoneOf.get(node.id)! })),
    relationships,
    zones,
    structure: [],
    unlabeled: 0,
    openRequests: [],
  };
}

/**
 * Types joined by a relation share a zone, a type with none joins what it
 * extends, and groups under `MIN_ZONE_SIZE` are pooled. A zone is named after
 * the type with the most relations in it (then the most pages).
 */
export function buildPagesTypeZones(
  types: ReadonlyArray<Pick<TypeMapType, 'id' | 'plural' | 'count'>>,
  relationships: ReadonlyArray<Pick<TypeMapRelationship, 'from' | 'to'>>,
  extendsOf: (type: string) => string | undefined,
): { zones: TypeMapZone[]; zoneOf: Map<string, string> } {
  const ids = new Set(types.map((type) => type.id));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(rb, ra);
  };
  const degree = new Map<string, number>();
  for (const { from, to } of relationships) {
    if (!ids.has(from) || !ids.has(to) || from === to) continue;
    union(from, to);
    degree.set(from, (degree.get(from) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
  }
  for (const id of ids) {
    const base = extendsOf(id);
    if (!degree.has(id) && base && ids.has(base)) union(base, id);
  }
  const byId = new Map(types.map((type) => [type.id, type]));
  const members = new Map<string, string[]>();
  for (const type of types) members.set(find(type.id), [...(members.get(find(type.id)) ?? []), type.id]);
  const pages = (list: readonly string[]) => list.reduce((sum, id) => sum + (byId.get(id)?.count ?? 0), 0);
  const zones: TypeMapZone[] = [];
  const pooled: string[] = [];
  for (const list of members.values()) {
    if (list.length < MIN_ZONE_SIZE) {
      pooled.push(...list);
      continue;
    }
    const hub = [...list].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (byId.get(b)?.count ?? 0) - (byId.get(a)?.count ?? 0) || a.localeCompare(b))[0]!;
    zones.push({ id: hub, name: `${byId.get(hub)?.plural ?? hub} and related types`, hub, typeIds: list });
  }
  zones.sort((a, b) => pages(b.typeIds) - pages(a.typeIds) || b.typeIds.length - a.typeIds.length || a.id.localeCompare(b.id));
  if (pooled.length) zones.push({ id: OTHER_ZONE, name: zones.length ? 'Other types' : 'All types', hub: null, typeIds: pooled });
  const zoneOf = new Map<string, string>();
  for (const zone of zones) for (const id of zone.typeIds) zoneOf.set(id, zone.id);
  return { zones, zoneOf };
}

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
export function buildPagesTypeTable({ types, items, placedTypeIds }: {
  types: readonly TrackerDataModel[];
  items: readonly PagesTypeMapItem[];
  placedTypeIds: ReadonlySet<string>;
}): PagesTypeTableRow[] {
  const byType = new Map(types.map((model) => [model.type, model]));
  const pages = new Map<string, number>();
  for (const item of items) {
    if (!item.archived) pages.set(item.primaryType, (pages.get(item.primaryType) ?? 0) + 1);
  }
  return types
    .map((model) => {
      const own = model.fields.filter((field) => field.name !== 'title' && field.name !== 'tags');
      const relations = own.filter(isRelationField).length;
      const base = model.extends ? byType.get(model.extends) : undefined;
      return {
        id: model.type,
        name: model.displayName || model.type,
        extendsName: base ? base.displayName || base.type : null,
        pages: pages.get(model.type) ?? 0,
        fields: own.length - relations,
        relations,
        placed: placedTypeIds.has(model.type),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
