/**
 * What the Types pages and the wiki home's content health compute, behind one
 * dynamic import: the type map, a label's type page and instance table, the
 * content health counts, and every label health check. None of
 * it rides in the trackers-ui entry every tracker surface loads; a host calls
 * `loadOntologyTypesApi()` when it opens the Types section.
 */
import type { OntologyRecordLike } from './ontologyRecords';
import { buildKnowledgeGraph, type HealthItem } from './ontologyKnowledge';
import { healthLabelRegistry, type ContentHealthOptions } from './ontologyContentHealth';
import { computeLabelHealth } from './ontologyLabelHealth';
import { computeLabelSchemaHealth } from './ontologyLabelSchemaHealth';
import { isFallbackRegistry } from './ontologyLabels';

export { computeContentHealth, factBoxPredicates } from './ontologyContentHealth';
export { factStaleAt, STALE_FACT_DAYS } from './ontologyKnowledge';
export { buildTypeMap } from './ontologyLabelMap';
export { buildTypePageModel, claimRecordsOf, typeCell } from './ontologyTypePage';

/**
 * Every label health check (content and schema) over a room's records, for
 * the type pages, which show the ones whose `labelIds` name their label.
 */
export function computeTypeHealth<T extends OntologyRecordLike>(
  records: readonly T[],
  options: Omit<ContentHealthOptions, 'now' | 'staleDays'>,
): Array<HealthItem<T>> {
  const graph = buildKnowledgeGraph(records);
  const registry = healthLabelRegistry(graph, options.labels, options.kindOptions);
  const input = { registry, fallback: isFallbackRegistry(options.labels), graph, predicates: options.predicates ?? null };
  return [...computeLabelHealth(input), ...computeLabelSchemaHealth(input)];
}
