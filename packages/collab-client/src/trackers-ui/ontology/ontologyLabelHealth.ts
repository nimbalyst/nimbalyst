/**
 * Health checks that read the label registry. Every one is a report; none
 * blocks a write (the vocabulary may have moved under data written earlier).
 *
 * Content checks (here), which the wiki home counts too:
 *  - `unmet-expects:<label>:<property>`: pages under a label with fewer (or
 *    more) values of a property than the label `expects`. The market pack's
 *    product label expecting `in-market` and `made-by` is what used to be the
 *    hard-coded "no market" and "no maker" checks.
 *  - `range-violation:<property>`: an entity-valued claim or relationship
 *    whose target carries none of the property's `range` labels.
 *  - `unknown-label:<label>`: pages carrying a label the registry lacks.
 *
 * Schema checks (`ontologyLabelSchemaHealth.ts`, loaded with the type pages
 * and the inspector), which only mean something once the room has a registry:
 *  - `sparse-field:entity:<label>:<property>`: fill rate under a third.
 *  - `off-label-claim:<predicate>` (informational): the subject has no label
 *    listing the predicate.
 *  - `undeclared-property:<label>:<property>`: a label lists an id that is no
 *    property, predicate or base field.
 *  - `label-cycle`, `duplicate-label:<a>+<b>` (same name, or near-identical
 *    descriptions).
 */
import type { LabelRegistry, PredicateDefinition } from '@nimbalyst/tracker-schema';
import {
  claimPredicate,
  plural,
  withHealthIds,
  type HealthDraft,
  type HealthItem,
  type KnowledgeGraph,
} from './ontologyKnowledge';
import { buildLabelIndex, isFallbackRegistry, labelName, LABELED_TYPE, propertyRange, type LabelIndex } from './ontologyLabels';
import { byTitle, isEmptyFieldValue, ontologyFieldValue, recordRefs, type OntologyRecordLike } from './ontologyRecords';

export interface LabelHealthInput<T extends OntologyRecordLike = OntologyRecordLike> {
  /** The registry in force, the kind stand-in included (`effectiveLabelRegistry`). */
  registry: LabelRegistry;
  /** Whether `registry` is the stand-in: the schema checks are skipped then. */
  fallback?: boolean;
  graph: KnowledgeGraph<T>;
  index?: LabelIndex<T>;
  /** Null when the host cannot read the predicate registry. */
  predicates?: readonly PredicateDefinition[] | null;
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function isSymmetric(predicates: readonly PredicateDefinition[] | null | undefined, id: string): boolean {
  return predicates?.find((predicate) => predicate.id === id)?.direction === 'symmetric';
}

/** How many values a page has for a property: asserted claims for a predicate, list length or 1 for a field. */
export function propertyValueCount(
  graph: KnowledgeGraph,
  page: OntologyRecordLike,
  property: string,
  options: { claim: boolean; symmetric?: boolean },
): number {
  if (options.claim) {
    const asserted = (claim: OntologyRecordLike) => {
      const status = ontologyFieldValue(claim, 'status');
      return claimPredicate(claim) === property && (status === undefined || status === null || status === 'asserted');
    };
    const ids = [page.id, ...(page.issueKey ? [page.issueKey] : [])];
    const claims = new Set<string>();
    for (const id of ids) {
      for (const claim of graph.claimsBySubject.get(id) ?? []) if (asserted(claim)) claims.add(claim.id);
      if (options.symmetric) for (const claim of graph.claimsByObject.get(id) ?? []) if (asserted(claim)) claims.add(claim.id);
    }
    return claims.size;
  }
  const value = ontologyFieldValue(page, property);
  const inner = value && typeof value === 'object' && !Array.isArray(value) && 'value' in value ? (value as { value: unknown }).value : value;
  if (isEmptyFieldValue(inner)) return 0;
  return Array.isArray(inner) ? inner.length : 1;
}

/** The shared reading every label check starts from. */
export function labelHealthContext<T extends OntologyRecordLike>(input: LabelHealthInput<T>) {
  const { registry, graph, predicates } = input;
  const index = input.index ?? buildLabelIndex(registry, graph.live);
  const predicateIds = new Set([...(predicates ?? []).map((predicate) => predicate.id), ...graph.claims.map((claim) => claimPredicate(claim)).filter((id): id is string => Boolean(id))]);
  const fieldIds = new Set(registry.properties.map((property) => property.id));
  const isClaim = (id: string) => !fieldIds.has(id) && (predicateIds.has(id) || id in registry.claimProperties);
  const name = (id: string) => registry.properties.find((property) => property.id === id)?.label ?? predicates?.find((predicate) => predicate.id === id)?.label ?? id.replace(/-/g, ' ');
  return { index, predicateIds, fieldIds, isClaim, name, fallback: input.fallback ?? isFallbackRegistry(registry) };
}

/** The content checks. */
export function computeLabelHealth<T extends OntologyRecordLike>(input: LabelHealthInput<T>): Array<HealthItem<T>> {
  const { registry, graph, predicates } = input;
  const { index, isClaim, name, fallback } = labelHealthContext(input);
  const items: Array<HealthDraft<T>> = [];

  {
    for (const label of registry.labels) {
      for (const expectation of label.expects ?? []) {
        const members = index.members.get(label.id) ?? [];
        const claim = isClaim(expectation.property);
        const failing = members.filter((page) => {
          const count = propertyValueCount(graph, page, expectation.property, { claim, symmetric: isSymmetric(predicates, expectation.property) });
          return count < (expectation.min ?? 0) || (expectation.max !== undefined && count > expectation.max);
        });
        if (!failing.length) continue;
        const noun = lower(labelName(registry, label.id));
        const what = expectation.max !== undefined && (expectation.min ?? 0) === 0
          ? `more than ${expectation.max} ${name(expectation.property)}`
          : (expectation.min ?? 0) <= 1 ? `no ${name(expectation.property)}` : `fewer than ${expectation.min} ${name(expectation.property)}`;
        items.push({
          id: `unmet-expects:${label.id}:${expectation.property}`,
          check: 'unmet-expects',
          title: `${plural(failing.length, noun, lower(labelName(registry, label.id, true)))} with ${what}`,
          detail: `${labelName(registry, label.id, true)} are expected to have ${expectation.min !== undefined ? `at least ${expectation.min}` : ''}${expectation.min !== undefined && expectation.max !== undefined ? ' and ' : ''}${expectation.max !== undefined ? `at most ${expectation.max}` : ''} ${name(expectation.property)}.`,
          count: failing.length,
          items: failing,
          labelIds: [label.id],
        });
      }
    }

    // Range: the target of an entity-valued claim or relationship should carry a range label.
    const violations = new Map<string, { items: Map<string, T>; labels: Set<string> }>();
    const note = (property: string, item: T) => {
      const entry = violations.get(property) ?? { items: new Map(), labels: new Set(registry.labels.filter((label) => label.properties?.includes(property)).map((label) => label.id)) };
      entry.items.set(item.id, item);
      violations.set(property, entry);
    };
    const outOfRange = (range: readonly string[], targetId: string) => {
      const target = graph.byId.get(targetId);
      if (!target || target.primaryType !== LABELED_TYPE) return false;
      const labels = index.effective.get(target.id) ?? [];
      return !range.some((id) => labels.includes(id));
    };
    for (const claim of graph.claims) {
      const predicate = claimPredicate(claim);
      const range = predicate ? propertyRange(registry, predicate) : [];
      if (!predicate || !range.length) continue;
      const status = ontologyFieldValue(claim, 'status');
      if (status !== undefined && status !== null && status !== 'asserted') continue;
      if (recordRefs(claim, 'object').some((id) => outOfRange(range, id))) note(predicate, claim);
    }
    for (const property of registry.properties) {
      if (property.type !== 'relationship' || !property.range?.length) continue;
      for (const page of graph.entities) {
        if (recordRefs(page, property.id).some((id) => outOfRange(property.range!, id))) note(property.id, page);
      }
    }
    for (const [property, entry] of violations) {
      const list = [...entry.items.values()].sort(byTitle);
      const range = propertyRange(registry, property).map((id) => labelName(registry, id)).join(' or ');
      items.push({
        id: `range-violation:${property}`,
        check: 'range-violation',
        title: `${plural(list.length, 'statement')} where ${name(property)} points outside ${range}`,
        detail: `${name(property)} should name a ${range} page. Label the target, or restate the claim with a better predicate.`,
        count: list.length,
        items: list,
        labelIds: [...entry.labels, ...propertyRange(registry, property)],
      });
    }

    if (!fallback) {
      for (const id of index.undeclared) {
        const pages = [...(index.direct.get(id) ?? [])].sort(byTitle);
        items.push({
          id: `unknown-label:${id}`,
          check: 'unknown-label',
          title: `${plural(pages.length, 'page')} labeled ${id}, which the registry does not declare`,
          detail: 'The label may be a pending proposal. Add it to the registry, or relabel the pages.',
          count: pages.length,
          items: pages,
          labelIds: [id],
        });
      }
    }
  }

  return items.map(withHealthIds);
}
