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
import type { FieldDefinition, LabelRegistry, PredicateDefinition, TrackerDataModel } from '@nimbalyst/tracker-schema';
import { computeContentHealth, factBoxPredicates, healthLabelRegistry } from './ontologyContentHealth';
import { computeLabelSchemaHealth } from './ontologyLabelSchemaHealth';
import { isFallbackRegistry, recordRole } from './ontologyLabels';
import {
  buildKnowledgeGraph,
  buildMarketTree,
  CATCH_ALL_KINDS,
  claimPredicate,
  CLAIM_TYPE,
  currentFacts,
  DEPRECATED_ENTITY_FIELDS,
  ENTITY_TYPE,
  entityKind,
  hasKnowledgeTypes,
  plural,
  STALE_FACT_DAYS,
  STRUCTURE_KINDS,
  withHealthIds,
  type HealthDraft,
  type HealthItem,
  type KnowledgeGraph,
  type MarketNode,
} from './ontologyKnowledge';
import {
  byTitle,
  isEmptyFieldValue,
  ontologyFieldValue,
  recordRefs,
  type OntologyRecordLike,
} from './ontologyRecords';

/** Fields the fill rate says nothing about: every item has them, or nobody writes them. */
const FILL_RATE_SKIP: ReadonlySet<string> = new Set(['title', 'status', 'created', 'updated', 'scopeId', 'kind']);
/** Optional by nature: an item without aliases or tags is not missing anything. */
const SPARSE_SKIP: ReadonlySet<string> = new Set(['aliases', 'tags']);
/** A field filled on fewer than this share of its items is sparse. */
export const SPARSE_FILL_RATE = 1 / 3;
/** Groups with fewer items than this are too small to call a field sparse. */
const SPARSE_MIN_ITEMS = 3;
const EXAMPLE_COUNT = 3;

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
  observedTargets: Array<{ type: string; count: number }>;
}

export interface RelationshipGraph {
  nodes: Array<{ type: string; displayName: string; color: string; count: number }>;
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
  unused: Array<{ id: string; label: string }>;
  /** Claims with no predicate at all. */
  unspecified: number;
}

export interface KnowledgeSection<T extends OntologyRecordLike = OntologyRecordLike> {
  markets: Array<MarketNode<T>>;
  facts: { total: number; current: number; stale: number; undated: number; byPredicate: KindCount[] };
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

function isRelationshipField(field: FieldDefinition): boolean {
  return field.type === 'relationship' || field.type === 'reference';
}

function measuredFields(model: TrackerDataModel | undefined): FieldDefinition[] {
  if (!model) return [];
  const skip = new Set([...FILL_RATE_SKIP, model.roles?.title ?? 'title', model.roles?.workflowStatus ?? 'status']);
  return model.fields.filter((field) => !field.readOnly && !skip.has(field.name));
}

function fillRates(items: readonly OntologyRecordLike[], fields: readonly FieldDefinition[], deprecated: ReadonlySet<string>): FieldFill[] {
  return fields
    .map((field) => {
      const filled = items.filter((item) => !isEmptyFieldValue(ontologyFieldValue(item, field.name))).length;
      return { name: field.name, type: field.type, filled, rate: items.length ? filled / items.length : 0, deprecated: deprecated.has(field.name) };
    })
    .sort((a, b) => b.rate - a.rate || a.name.localeCompare(b.name));
}

function kindField(model: TrackerDataModel | undefined): FieldDefinition | undefined {
  return model?.fields.find((field) => field.name === 'kind' && field.type === 'select');
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const list = groups.get(value);
    if (list) list.push(item);
    else groups.set(value, [item]);
  }
  return groups;
}

export function summarizeTypes<T extends OntologyRecordLike>(types: readonly TrackerDataModel[], records: readonly T[]): Array<TypeSummary<T>> {
  const byType = groupBy(records, (record) => record.primaryType);
  const models = new Map(types.filter((model) => !model.archived).map((model) => [model.type, model]));
  const names = new Set([...models.keys(), ...byType.keys()]);
  const summaries: Array<TypeSummary<T>> = [];
  for (const type of names) {
    const model = models.get(type);
    const all = byType.get(type) ?? [];
    const live = all.filter((record) => !record.archived);
    const fields = measuredFields(model);
    const deprecated = type === ENTITY_TYPE ? DEPRECATED_ENTITY_FIELDS : new Set<string>();
    const kindDef = kindField(model);
    let kinds: Array<KindSummary<T>> | null = null;
    if (kindDef) {
      const byKind = groupBy(live, entityKind);
      kinds = [...byKind.entries()].map(([kind, items]) => ({
        kind,
        label: kindDef.options?.find((option) => option.value === kind)?.label ?? (kind === 'other' ? 'No kind' : kind),
        count: items.length,
        examples: [...items].sort(byTitle).slice(0, EXAMPLE_COUNT),
        fields: fillRates(items, fields, deprecated).filter((fill) => fill.filled > 0),
        structure: STRUCTURE_KINDS.has(kind),
        catchAll: CATCH_ALL_KINDS.has(kind),
      }));
      kinds.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
      for (const option of kindDef.options ?? []) {
        if (!byKind.has(option.value)) {
          kinds.push({ kind: option.value, label: option.label, count: 0, examples: [], fields: [], structure: STRUCTURE_KINDS.has(option.value), catchAll: CATCH_ALL_KINDS.has(option.value) });
        }
      }
    }
    summaries.push({
      type,
      displayName: model?.displayName ?? type,
      icon: model?.icon ?? '',
      color: model?.color ?? '',
      sharing: model?.sharing === 'team' ? 'team' : 'personal',
      declared: Boolean(model),
      count: live.length,
      archived: all.length - live.length,
      examples: [...live].sort(byTitle).slice(0, EXAMPLE_COUNT),
      fields: fillRates(live, fields, deprecated),
      kinds,
    });
  }
  return summaries.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

function tally(counts: Map<string, number>): KindCount[] {
  return [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/** Relationship fields as edges between types, with how many links each carries and where they land. */
export function buildRelationshipGraph<T extends OntologyRecordLike>(types: readonly TrackerDataModel[], records: readonly T[]): RelationshipGraph {
  const allById = new Map(records.map((record) => [record.id, record]));
  const liveByType = groupBy(records.filter((record) => !record.archived), (record) => record.primaryType);
  const edges: RelationshipEdge[] = [];
  const nodeTypes = new Set<string>();
  for (const model of types) {
    if (model.archived) continue;
    for (const field of model.fields.filter(isRelationshipField)) {
      const observed = new Map<string, number>();
      let links = 0;
      let itemsWithLinks = 0;
      for (const item of liveByType.get(model.type) ?? []) {
        const targets = recordRefs(item, field.name);
        if (targets.length) itemsWithLinks += 1;
        for (const target of targets) {
          links += 1;
          const type = allById.get(target)?.primaryType ?? 'missing';
          observed.set(type, (observed.get(type) ?? 0) + 1);
        }
      }
      const declaredTargets = field.targetTrackerTypes ?? '*';
      edges.push({
        id: `${model.type}.${field.name}`,
        source: model.type,
        field: field.name,
        label: field.predicate ?? field.relationshipTypeKey ?? field.name,
        predicate: field.predicate ?? null,
        declaredTargets,
        multi: field.multiValue === true,
        links,
        itemsWithLinks,
        observedTargets: tally(observed).map(({ kind, count }) => ({ type: kind, count })),
      });
      nodeTypes.add(model.type);
      if (Array.isArray(declaredTargets)) declaredTargets.forEach((target) => nodeTypes.add(target));
      observed.forEach((_count, type) => { if (type !== 'missing') nodeTypes.add(type); });
    }
  }
  const models = new Map(types.map((model) => [model.type, model]));
  return {
    nodes: [...nodeTypes].sort().map((type) => ({
      type,
      displayName: models.get(type)?.displayName ?? type,
      color: models.get(type)?.color ?? '',
      count: liveByType.get(type)?.length ?? 0,
    })),
    edges: edges.sort((a, b) => b.links - a.links || a.id.localeCompare(b.id)),
  };
}

function endKind(graph: KnowledgeGraph, id: string | undefined): string {
  if (!id) return 'value';
  const record = graph.allById.get(id);
  if (!record) return 'missing';
  return record.primaryType === ENTITY_TYPE ? entityKind(record) : record.primaryType;
}

export function summarizePredicates(graph: KnowledgeGraph, registry: readonly PredicateDefinition[] | null | undefined): PredicatesSummary {
  const declared = new Map((registry ?? []).map((predicate) => [predicate.id, predicate]));
  const usage = new Map<string, { count: number; subjects: Map<string, number>; objects: Map<string, number> }>();
  let unspecified = 0;
  for (const claim of graph.claims) {
    const predicate = claimPredicate(claim);
    if (!predicate) {
      unspecified += 1;
      continue;
    }
    let entry = usage.get(predicate);
    if (!entry) usage.set(predicate, entry = { count: 0, subjects: new Map(), objects: new Map() });
    entry.count += 1;
    const subject = endKind(graph, recordRefs(claim, 'subject')[0]);
    const object = endKind(graph, recordRefs(claim, 'object')[0]);
    entry.subjects.set(subject, (entry.subjects.get(subject) ?? 0) + 1);
    entry.objects.set(object, (entry.objects.get(object) ?? 0) + 1);
  }
  return {
    used: [...usage.entries()]
      .map(([id, entry]) => ({
        id,
        label: declared.get(id)?.label ?? id,
        declared: registry ? declared.has(id) : null,
        count: entry.count,
        subjectKinds: tally(entry.subjects),
        objectKinds: tally(entry.objects),
      }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    registryAvailable: Boolean(registry),
    unused: (registry ?? []).filter((predicate) => !usage.has(predicate.id)).map(({ id, label }) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id)),
    unspecified,
  };
}

/** Problems with the schema's use: catch-all kinds, sparse and deprecated fields, undeclared predicates, links to nothing. */
export function schemaHealth<T extends OntologyRecordLike>(
  summaries: ReadonlyArray<TypeSummary<T>>,
  input: OntologyInput<T>,
  graph: KnowledgeGraph<T>,
  relationships: RelationshipGraph,
): Array<HealthItem<T>> {
  const items: Array<HealthDraft<T>> = [];
  const models = new Map(input.types.map((model) => [model.type, model]));
  const liveByType = groupBy(graph.live, (record) => record.primaryType);

  for (const summary of summaries) {
    const live = liveByType.get(summary.type) ?? [];
    const model = models.get(summary.type);
    const fieldDefault = (name: string) => model?.fields.find((field) => field.name === name)?.default;
    if (summary.kinds) {
      const byKind = groupBy(live, entityKind);
      for (const kind of [...CATCH_ALL_KINDS, 'other']) {
        const pages = byKind.get(kind);
        if (!pages?.length) continue;
        const label = summary.kinds.find((entry) => entry.kind === kind)?.label ?? kind;
        items.push({
          id: `catch-all-kind:${kind}`,
          check: 'catch-all-kind',
          title: kind === 'other' ? `${plural(pages.length, `${summary.displayName.toLowerCase()} page`)} with no kind` : `${plural(pages.length, 'page')} filed as ${label}`,
          detail: kind === 'other' ? 'These pages do not say what they are.' : `${label} is a catch-all. Each page should be a product, organization, topic, market or another specific kind.`,
          count: pages.length,
          items: [...pages].sort(byTitle),
        });
      }
    }
    const liveByKind = summary.kinds ? groupBy(live, entityKind) : null;
    const groups: Array<[string, string, OntologyRecordLike[], FieldFill[]]> = summary.kinds
      ? summary.kinds.filter((kind) => !kind.structure && kind.count > 0).map((kind) => [`${summary.type}:${kind.kind}`, kind.label.toLowerCase(), liveByKind?.get(kind.kind) ?? [], kind.fields])
      : [[summary.type, summary.displayName.toLowerCase(), live, summary.fields]];
    for (const [scope, noun, members, fills] of groups) {
      for (const fill of fills) {
        if (fill.filled === 0) continue;
        const filled = (members.filter((item) => !isEmptyFieldValue(ontologyFieldValue(item, fill.name))) as T[]).sort(byTitle);
        if (fill.deprecated) {
          items.push({
            id: `deprecated-field:${scope}:${fill.name}`,
            check: 'deprecated-field',
            title: `${fill.name} still set on ${plural(filled.length, noun)}`,
            detail: `${fill.name} is deprecated. Its values belong in claims (competes-with qualifiers for competitor fields).`,
            count: filled.length,
            items: filled,
          });
          continue;
        }
        if (SPARSE_SKIP.has(fill.name) || fieldDefault(fill.name) !== undefined || fill.type === 'boolean') continue;
        if (members.length < SPARSE_MIN_ITEMS || fill.rate >= SPARSE_FILL_RATE) continue;
        items.push({
          id: `sparse-field:${scope}:${fill.name}`,
          check: 'sparse-field',
          title: `${fill.name} is filled on ${fill.filled} of ${plural(members.length, noun)}`,
          detail: 'A field this sparse is either missing research or belongs in claims on the few items that have it.',
          count: filled.length,
          items: filled,
        });
      }
    }
  }

  const broken = relationships.edges.filter((edge) => edge.observedTargets.some((target) => target.type === 'missing'));
  if (broken.length) {
    const sources = new Map<string, T>();
    let count = 0;
    for (const edge of broken) {
      for (const item of liveByType.get(edge.source) ?? []) {
        const missing = recordRefs(item, edge.field).filter((id) => !graph.allById.has(id)).length;
        if (missing) {
          count += missing;
          sources.set(item.id, item);
        }
      }
    }
    items.push({
      id: 'broken-links',
      check: 'broken-links',
      title: `${plural(count, 'link')} to items that do not exist`,
      detail: `Relationship fields name ids no item in this project has: ${broken.map((edge) => edge.id).join(', ')}.`,
      count,
      items: [...sources.values()].sort(byTitle),
    });
  }

  // Without a registry nothing can be called undeclared; an empty registry declares nothing.
  if (input.predicates) {
    const declared = new Set(input.predicates.map((predicate) => predicate.id));
    const undeclared = graph.claims.filter((claim) => {
      const predicate = claimPredicate(claim);
      return predicate !== null && !declared.has(predicate);
    });
    if (undeclared.length) {
      const ids = [...new Set(undeclared.map((claim) => claimPredicate(claim)!))].sort();
      items.push({
        id: 'undeclared-predicates',
        check: 'undeclared-predicates',
        title: `${plural(undeclared.length, 'claim')} use a predicate the registry does not declare`,
        detail: `Undeclared: ${ids.join(', ')}. Add them to the registry or move the claims to a declared predicate.`,
        count: undeclared.length,
        items: undeclared.sort(byTitle),
      });
    }
  }
  return items.map(withHealthIds);
}

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)));
}

export function analyzeOntology<T extends OntologyRecordLike>(input: OntologyInput<T>): OntologyViewModel<T> {
  const types = summarizeTypes(input.types, input.records);
  const relationships = buildRelationshipGraph(input.types, input.records);
  const graph = buildKnowledgeGraph(input.records);
  const typeNames = [...input.types.map((model) => model.type), ...input.records.map((record) => record.primaryType)];
  const knowledgeTypes = hasKnowledgeTypes(typeNames);
  const hasClaims = typeNames.includes(CLAIM_TYPE);
  let knowledge: KnowledgeSection<T> | null = null;
  const kindOptions = input.types.find((model) => model.type === ENTITY_TYPE)?.fields.find((field) => field.name === 'kind')?.options;
  const registry = healthLabelRegistry(graph, input.labels, kindOptions);
  if (knowledgeTypes) {
    const facts = currentFacts(graph, input.now, STALE_FACT_DAYS, factBoxPredicates(registry));
    const byPredicate = new Map<string, number>();
    for (const fact of facts) byPredicate.set(fact.predicate, (byPredicate.get(fact.predicate) ?? 0) + 1);
    knowledge = {
      markets: buildMarketTree(graph, (record) => recordRole(registry, record) === 'market-node'),
      facts: {
        total: facts.length,
        current: facts.filter((fact) => fact.state === 'current').length,
        stale: facts.filter((fact) => fact.state === 'stale').length,
        undated: facts.filter((fact) => fact.state === 'undated').length,
        byPredicate: tally(byPredicate),
      },
    };
  }
  return {
    types,
    relationships,
    predicates: hasClaims || input.predicates?.length ? summarizePredicates(graph, input.predicates) : null,
    knowledge,
    // A label named like a kind can report the same sparse field twice; the kind's report wins.
    health: uniqueById([
      ...schemaHealth(types, input, graph, relationships),
      ...(knowledgeTypes ? computeContentHealth(graph, { now: input.now, labels: input.labels, kindOptions, predicates: input.predicates }) : []),
      ...(knowledgeTypes ? computeLabelSchemaHealth({ registry, fallback: isFallbackRegistry(input.labels), graph, predicates: input.predicates }) : []),
    ]),
  };
}
