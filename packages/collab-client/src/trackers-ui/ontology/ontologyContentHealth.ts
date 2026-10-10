/**
 * The graph's content health: stale or undated facts, pages missing what
 * their labels expect, statements pointing outside a property's range, pages
 * carrying labels nobody declared, and likely duplicates. The wiki home and
 * the ontology inspector report the same counts from this one function.
 *
 * Label-driven: which predicates are facts comes from the labels' fact boxes,
 * and what a page must have comes from their `expects`. A room with no label
 * registry reads through the kind stand-in (`effectiveLabelRegistry`), whose
 * product label expects a market and a maker, so the old "no market" and
 * "no maker" reports keep working on today's data.
 */
import type { LabelRegistry, PredicateDefinition } from '@nimbalyst/tracker-schema';
import { computeLabelHealth } from './ontologyLabelHealth';
import {
  buildKnowledgeGraph,
  currentFacts,
  entityKind,
  ENTITY_TYPE,
  findDuplicateGroups,
  plural,
  STALE_FACT_DAYS,
  withHealthIds,
  type HealthDraft,
  type HealthItem,
  type KnowledgeGraph,
} from './ontologyKnowledge';
import { buildLabelIndex, effectiveLabelRegistry, isFallbackRegistry, recordRole, type KindOption } from './ontologyLabels';
import type { OntologyRecordLike } from './ontologyRecords';

export interface ContentHealthOptions {
  now: number;
  /** Stale threshold in days after the end of a fact's period. Default 90. */
  staleDays?: number;
  /** The room's label registry; empty or absent reads through the kind stand-in. */
  labels?: LabelRegistry | null;
  /** `entity.kind` options, for the stand-in's labels. */
  kindOptions?: readonly KindOption[];
  predicates?: readonly PredicateDefinition[] | null;
}

/** The registry health reads: the room's, or the kind stand-in built from the kinds pages use. */
export function healthLabelRegistry(
  graph: KnowledgeGraph,
  labels: LabelRegistry | null | undefined,
  kindOptions?: readonly KindOption[],
): LabelRegistry {
  if (!isFallbackRegistry(labels)) return labels!;
  const observed = graph.entities.map(entityKind).filter((kind) => kind !== 'other');
  return effectiveLabelRegistry(null, { kindOptions, observedKinds: observed });
}

/** Every predicate some label shows in its fact box. */
export function factBoxPredicates(registry: LabelRegistry): Set<string> {
  return new Set(registry.labels.flatMap((label) => label.factBox ?? []));
}

export function computeContentHealth<T extends OntologyRecordLike>(
  records: readonly T[] | KnowledgeGraph<T>,
  options: ContentHealthOptions,
): Array<HealthItem<T>> {
  const graph = Array.isArray(records) ? buildKnowledgeGraph(records as readonly T[]) : records as KnowledgeGraph<T>;
  const registry = healthLabelRegistry(graph, options.labels, options.kindOptions);
  const index = buildLabelIndex(registry, graph.live);
  const items: Array<HealthDraft<T>> = [];
  const staleDays = options.staleDays ?? STALE_FACT_DAYS;

  const facts = currentFacts(graph, options.now, staleDays, factBoxPredicates(registry)).filter((fact) => fact.state !== 'current');
  if (facts.length) {
    const undated = facts.filter((fact) => fact.state === 'undated').length;
    items.push({
      id: 'stale-facts',
      check: 'stale-facts',
      title: `${plural(facts.length, 'fact')} out of date`,
      detail: `${plural(facts.length - undated, 'current value')} past ${staleDays} days after its as-of period${undated ? `, ${undated} with no as-of date` : ''}. Research a newer value and cite it.`,
      count: facts.length,
      items: [...new Map(facts.map((fact) => [fact.subject.id, fact.subject])).values()],
    });
  }

  const labelHealth = computeLabelHealth({ registry, fallback: isFallbackRegistry(options.labels), graph, index, predicates: options.predicates ?? null });

  const duplicates = findDuplicateGroups(graph, (record) => record.primaryType === ENTITY_TYPE && recordRole(registry, record) === 'structure');
  if (duplicates.length) {
    items.push({
      id: 'duplicates',
      check: 'duplicates',
      title: plural(duplicates.length, 'likely duplicate'),
      detail: 'Items whose title or alias matches another, including competitor tracker items that repeat a wiki page.',
      count: duplicates.length,
      items: duplicates.flat(),
      groups: duplicates,
    });
  }
  const [staleItems, duplicateItems] = [items.filter((item) => item.id === 'stale-facts'), items.filter((item) => item.id === 'duplicates')];
  return [...staleItems.map(withHealthIds), ...labelHealth, ...duplicateItems.map(withHealthIds)];
}
