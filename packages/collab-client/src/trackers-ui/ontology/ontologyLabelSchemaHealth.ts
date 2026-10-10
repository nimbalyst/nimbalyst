/**
 * The label checks that judge the vocabulary itself, and so only mean
 * something once the room has a registry: sparse properties, statements whose
 * subject has no label listing their predicate (informational), labels listing
 * ids nothing declares, broader cycles, and labels that look like duplicates.
 * Loaded with the type pages and the inspector, not with every tracker surface.
 */
import { DEFAULT_LABEL_BASE_FIELD_NAMES, effectiveProperties, type LabelRegistry } from '@nimbalyst/tracker-schema';
import { claimPredicate, plural, withHealthIds, type HealthDraft, type HealthItem } from './ontologyKnowledge';
import { isSymmetric, labelHealthContext, propertyValueCount, type LabelHealthInput } from './ontologyLabelHealth';
import { labelName, LABELED_TYPE } from './ontologyLabels';
import { byTitle, recordRefs, type OntologyRecordLike } from './ontologyRecords';

const SPARSE_RATE = 1 / 3;
const SPARSE_MIN = 3;

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function computeLabelSchemaHealth<T extends OntologyRecordLike>(input: LabelHealthInput<T>): Array<HealthItem<T>> {
  const { registry, graph, predicates } = input;
  const { index, predicateIds, fieldIds, isClaim, name, fallback } = labelHealthContext(input);
  const items: Array<HealthDraft<T>> = [];
  if (!fallback) {
    for (const label of registry.labels) {
      if (label.role === 'structure') continue;
      const members = index.members.get(label.id) ?? [];
      if (members.length < SPARSE_MIN) continue;
      for (const property of label.properties ?? []) {
        const claim = isClaim(property);
        const filled = members.filter((page) => propertyValueCount(graph, page, property, { claim, symmetric: isSymmetric(predicates, property) }) > 0);
        if (filled.length / members.length >= SPARSE_RATE) continue;
        const missing = members.filter((page) => !filled.includes(page));
        items.push({
          id: `sparse-field:entity:${label.id}:${property}`,
          check: 'sparse-field',
          title: `${name(property)} is filled on ${filled.length} of ${plural(members.length, lower(labelName(registry, label.id)), lower(labelName(registry, label.id, true)))}`,
          detail: 'A property this sparse is missing research, or belongs on a narrower label.',
          count: missing.length,
          items: missing,
          labelIds: [label.id],
        });
      }
    }

    const offLabel = new Map<string, T[]>();
    for (const claim of graph.claims) {
      const predicate = claimPredicate(claim);
      const subject = graph.byId.get(recordRefs(claim, 'subject')[0] ?? '');
      if (!predicate || !subject || subject.primaryType !== LABELED_TYPE) continue;
      const listed = effectiveProperties(registry, subject.fields).some((property) => property.id === predicate);
      if (!listed) offLabel.set(predicate, [...(offLabel.get(predicate) ?? []), claim]);
    }
    for (const [predicate, claims] of offLabel) {
      items.push({
        id: `off-label-claim:${predicate}`,
        check: 'off-label-claim',
        severity: 'info',
        title: `${plural(claims.length, 'statement')} use ${name(predicate)} on a page whose labels do not list it`,
        detail: 'Informational. Either a label should list this property, or the statement belongs on another page.',
        count: claims.length,
        items: [...claims].sort(byTitle),
        labelIds: [],
      });
    }

    if (predicates) {
      const known = (id: string) => fieldIds.has(id) || predicateIds.has(id) || DEFAULT_LABEL_BASE_FIELD_NAMES.includes(id);
      for (const label of registry.labels) {
        for (const property of label.properties ?? []) {
          if (known(property)) continue;
          items.push({
            id: `undeclared-property:${label.id}:${property}`,
            check: 'undeclared-property',
            title: `${labelName(registry, label.id)} lists ${property}, which is neither a property nor a predicate`,
            detail: 'Declare it as a field property or a predicate, or remove it from the label.',
            count: 1,
            items: [],
            labelIds: [label.id],
          });
        }
      }
    }

    for (const cycle of labelCycles(registry)) {
      items.push({
        id: `label-cycle:${[...cycle].sort().join('+')}`,
        check: 'label-cycle',
        title: `Broader labels loop: ${[...cycle, cycle[0]].join(' -> ')}`,
        detail: 'A label cannot sit under itself. Remove one of the broader links.',
        count: cycle.length,
        items: [],
        labelIds: cycle,
      });
    }

    for (const [a, b] of duplicateLabels(registry)) {
      items.push({
        id: `duplicate-label:${a}+${b}`,
        check: 'duplicate-label',
        title: `${labelName(registry, a)} and ${labelName(registry, b)} look like one label`,
        detail: 'Their names or descriptions match. Merge them, or make one narrower than the other.',
        count: 2,
        items: [],
        labelIds: [a, b],
      });
    }
  }

  return items.map(withHealthIds);
}

/** Each distinct cycle in the `broader` graph, as label ids in order. */
export function labelCycles(registry: LabelRegistry): string[][] {
  const byId = new Map(registry.labels.map((label) => [label.id, label]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const found = new Map<string, string[]>();
  const visit = (id: string) => {
    state.set(id, 'visiting');
    stack.push(id);
    for (const parent of byId.get(id)?.broader ?? []) {
      if (!byId.has(parent)) continue;
      if (state.get(parent) === 'visiting') {
        const cycle = stack.slice(stack.indexOf(parent));
        found.set([...cycle].sort().join('|'), cycle);
      } else if (!state.has(parent)) {
        visit(parent);
      }
    }
    stack.pop();
    state.set(id, 'done');
  };
  for (const id of byId.keys()) if (!state.has(id)) visit(id);
  return [...found.values()];
}

function words(text: string | undefined): Set<string> {
  return new Set((text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
}

const normalized = (text: string | undefined) => (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/s$/, '');

/** Label pairs with the same name (singular or plural) or descriptions sharing most of their words. */
export function duplicateLabels(registry: LabelRegistry): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const labels = registry.labels;
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const a = labels[i]!;
      const b = labels[j]!;
      if (a.broader?.includes(b.id) || b.broader?.includes(a.id)) continue;
      const names = [a.label, a.pluralLabel, a.id].map(normalized).filter(Boolean);
      const sameName = [b.label, b.pluralLabel, b.id].map(normalized).some((name) => name && names.includes(name));
      const wa = words(a.description);
      const wb = words(b.description);
      const shared = [...wa].filter((word) => wb.has(word)).length;
      const similar = wa.size >= 4 && wb.size >= 4 && shared / new Set([...wa, ...wb]).size >= 0.8;
      if (sameName || similar) out.push([a.id, b.id]);
    }
  }
  return out;
}
