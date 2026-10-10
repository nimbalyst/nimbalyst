/**
 * Proposal changes to the label vocabulary, and the one data change that uses
 * it (`apply-label`, a label on many pages at once).
 *
 * Vocabulary changes (`add-label`, `add-property`, `add-label-property`,
 * `add-broader`, `extend-range`) are schema: the browser cannot write the
 * registry, so an agent applies an accepted change through the merge-by-id
 * `tracker_define_type({ labels })` and marks it applied. A change is
 * satisfied as soon as the registry already says what it asks. `apply-label`
 * and `split-label` are data the web console writes, once the labels they
 * name exist.
 */
import type { ClaimPropertyExtension, FieldPropertyDefinition, LabelDefinition, LabelRegistry, PredicateDefinition } from '@nimbalyst/tracker-schema';
import type { KnowledgeGraph } from './ontologyKnowledge';
import { propertyRange } from './ontologyLabels';
import { ontologyRecordTitle, stringList, ontologyFieldValue, type OntologyRecordLike } from './ontologyRecords';
import type { ApplyOp, ChangePlan, PlanEnv, UndoOp } from './ontologyProposals';

/**
 * The change shapes the wiki update skill drafts (its "Ontology proposals"
 * table). Keep the two in step: a field renamed here is a change the agent's
 * proposals stop satisfying.
 */
export type LabelChange =
  /** `label`: a full label registry entry. */
  | { type: 'add-label'; label: LabelDefinition }
  /**
   * `property`: a field property entry for `storage: field`, or a predicate
   * entry for `storage: claim`, whose `range` / `options` / `facet` ride in
   * `claimProperty`. `labelIds`: labels that should list it.
   */
  | {
    type: 'add-property';
    storage: 'field' | 'claim';
    property: FieldPropertyDefinition | (Partial<PredicateDefinition> & { id: string; label: string });
    claimProperty?: ClaimPropertyExtension;
    labelIds?: string[];
  }
  | { type: 'add-label-property'; labelId: string; propertyId: string; expects?: { min?: number; max?: number } }
  | { type: 'add-broader'; labelId: string; broaderId: string }
  /** `labelIds` are added to the property's `range`. */
  | { type: 'extend-range'; propertyId: string; labelIds: string[] }
  | { type: 'apply-label'; labelId: string; pageIds: string[] }
  /** `into`: the new labels; `pageIds`: new label id -> the pages that move to it. */
  | { type: 'split-label'; labelId: string; into: LabelDefinition[]; pageIds: Record<string, string[]> };

export type LabelChangeType = LabelChange['type'];

export const LABEL_CHANGE_TYPES: readonly LabelChangeType[] = [
  'add-label', 'add-property', 'add-label-property', 'add-broader', 'extend-range', 'apply-label', 'split-label',
];

export const LABEL_SCHEMA_CHANGE_TYPES: readonly LabelChangeType[] = ['add-label', 'add-property', 'add-label-property', 'add-broader', 'extend-range'];

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function labelDraftProblem(value: unknown): boolean {
  const draft = value as Record<string, unknown> | undefined;
  return !draft || !nonEmpty(draft.id) || !nonEmpty(draft.label);
}

/** Null when the change is well formed; otherwise what is missing. Undefined for a type this module does not own. */
export function labelChangeProblem(change: Record<string, unknown>): string | null | undefined {
  switch (change.type) {
    case 'add-label': return labelDraftProblem(change.label) ? 'needs label.id and label.label' : null;
    case 'add-property': {
      const property = change.property as Record<string, unknown> | undefined;
      return property && nonEmpty(property.id) && nonEmpty(property.label) && (change.storage === 'field' || change.storage === 'claim')
        ? null : 'needs storage (field or claim) and property.id and label';
    }
    case 'add-label-property': return nonEmpty(change.labelId) && nonEmpty(change.propertyId) ? null : 'needs labelId and propertyId';
    case 'add-broader': return nonEmpty(change.labelId) && nonEmpty(change.broaderId) ? null : 'needs labelId and broaderId';
    case 'extend-range': return nonEmpty(change.propertyId) && isStringArray(change.labelIds) && change.labelIds.length > 0 ? null : 'needs propertyId and labelIds';
    case 'apply-label': return nonEmpty(change.labelId) && isStringArray(change.pageIds) ? null : 'needs labelId and pageIds';
    case 'split-label': {
      const into = change.into;
      const pageIds = change.pageIds as Record<string, unknown> | undefined;
      return nonEmpty(change.labelId) && Array.isArray(into) && into.length > 0 && !into.some(labelDraftProblem)
        && pageIds && typeof pageIds === 'object' && !Array.isArray(pageIds) && Object.values(pageIds).every(isStringArray)
        ? null : 'needs labelId, into and pageIds (new label id -> page ids)';
    }
    default: return undefined;
  }
}

function plan<T extends OntologyRecordLike>(summary: string, extra: Partial<ChangePlan<T>> = {}): ChangePlan<T> {
  return { summary, pages: [], example: null, ops: [], undo: [], blocked: null, satisfied: false, ...extra };
}

const SCHEMA_BLOCKED = 'Schema change: an agent adds this to the label registry, then marks the change applied.';

function schemaPlan<T extends OntologyRecordLike>(
  summary: string,
  satisfied: boolean,
  appliedAt: string | undefined,
  title: string,
  before: string,
  after: string,
): ChangePlan<T> {
  const done = satisfied || Boolean(appliedAt);
  return plan(summary, {
    example: { itemId: null, title, before: [{ label: title, value: before }], after: [{ label: title, value: after }] },
    satisfied: done,
    blocked: done ? null : SCHEMA_BLOCKED,
  });
}

/** A page's own `labels` value (not its legacy `kind`). */
function ownLabelList(page: OntologyRecordLike): string[] {
  const value = ontologyFieldValue(page, 'labels');
  return typeof value === 'string' ? [value] : stringList(value);
}

function relabel<T extends OntologyRecordLike>(pages: readonly T[], next: (current: string[], page: T) => string[]): { ops: ApplyOp[]; undo: UndoOp[] } {
  const ops: ApplyOp[] = [];
  const undo: UndoOp[] = [];
  for (const page of pages) {
    const current = ownLabelList(page);
    const updated = next(current, page);
    if (updated.length === current.length && updated.every((id, i) => id === current[i])) continue;
    ops.push({ op: 'update', itemId: page.id, updates: { labels: updated } });
    undo.push({ op: 'restore-fields', itemId: page.id, fields: { labels: current.length ? current : null } });
  }
  return { ops, undo: undo.reverse() };
}

export function planLabelChange<T extends OntologyRecordLike>(
  change: LabelChange & { appliedAt?: string },
  graph: KnowledgeGraph<T>,
  env: PlanEnv,
): ChangePlan<T> {
  const registry: LabelRegistry = env.labels ?? { labels: [], properties: [], claimProperties: {} };
  const label = (id: string): LabelDefinition | undefined => registry.labels.find((entry) => entry.id === id);
  const labelTitle = (id: string) => label(id)?.label ?? id;
  const pagesOf = (ids: readonly string[]) => ids.map((id) => graph.byId.get(id)).filter((page): page is T => page?.primaryType === 'entity');

  switch (change.type) {
    case 'add-label': {
      const { label: draft } = change;
      const parents = draft.broader?.length ? `, under ${draft.broader.map(labelTitle).join(' and ')}` : '';
      return schemaPlan(`Add the label "${draft.label}" (${draft.id})${parents}`, Boolean(label(draft.id)), change.appliedAt, 'Labels',
        label(draft.id) ? `includes ${draft.id}` : `no ${draft.id}`,
        `+ ${draft.id}${draft.properties?.length ? ` with ${draft.properties.join(', ')}` : ''}`);
    }
    case 'add-property': {
      const { property, storage } = change;
      const exists = storage === 'field'
        ? registry.properties.some((entry) => entry.id === property.id)
        : Boolean(env.isPredicate?.(property.id));
      const listed = (change.labelIds ?? []).every((id) => label(id)?.properties?.includes(property.id));
      const shape = storage === 'field' ? (property as FieldPropertyDefinition).type ?? 'string' : (property as Partial<PredicateDefinition>).valueShape ?? 'text';
      const range = storage === 'field' ? (property as FieldPropertyDefinition).range : change.claimProperty?.range;
      return schemaPlan(
        `Add the ${storage === 'field' ? 'field' : 'claim'} property "${property.label}" (${property.id})${change.labelIds?.length ? ` to ${change.labelIds.map(labelTitle).join(', ')}` : ''}`,
        exists && listed, change.appliedAt, 'Properties',
        exists ? `includes ${property.id}` : `no ${property.id}`,
        `+ ${property.id}: ${storage}, ${shape}${range?.length ? `, range ${range.join(' | ')}` : ''}`,
      );
    }
    case 'add-label-property': {
      const target = label(change.labelId);
      const expected = !change.expects || (target?.expects ?? []).some((entry) => entry.property === change.propertyId
        && entry.min === change.expects!.min && entry.max === change.expects!.max);
      const has = Boolean(target?.properties?.includes(change.propertyId)) && expected;
      return schemaPlan(`Give ${labelTitle(change.labelId)} the property ${env.predicateLabel(change.propertyId)}`, has, change.appliedAt, labelTitle(change.labelId),
        (target?.properties ?? []).join(', ') || '(no properties)',
        `+ ${change.propertyId}${change.expects ? ` (expects ${change.expects.min !== undefined ? `at least ${change.expects.min}` : ''}${change.expects.min !== undefined && change.expects.max !== undefined ? ', ' : ''}${change.expects.max !== undefined ? `at most ${change.expects.max}` : ''})` : ''}`);
    }
    case 'add-broader': {
      const has = Boolean(label(change.labelId)?.broader?.includes(change.broaderId));
      return schemaPlan(`Put ${labelTitle(change.labelId)} under ${labelTitle(change.broaderId)}`, has, change.appliedAt, `${labelTitle(change.labelId)} broader`,
        (label(change.labelId)?.broader ?? []).join(', ') || '(top level)', `+ ${change.broaderId}`);
    }
    case 'extend-range': {
      const range = propertyRange(registry, change.propertyId);
      const has = change.labelIds.every((id) => range.includes(id));
      return schemaPlan(`Let ${env.predicateLabel(change.propertyId)} also point at ${change.labelIds.map(labelTitle).join(', ')}`, has, change.appliedAt, `${change.propertyId} range`,
        range.join(' | ') || '(any)', [...new Set([...range, ...change.labelIds])].join(' | '));
    }
    case 'apply-label': {
      const pages = pagesOf(change.pageIds);
      const { ops, undo } = relabel(pages, (current) => (current.includes(change.labelId) ? current : [...current, change.labelId]));
      const first = pages.find((page) => !ownLabelList(page).includes(change.labelId)) ?? pages[0];
      return plan(`Label ${pages.length} ${pages.length === 1 ? 'page' : 'pages'} ${labelTitle(change.labelId)}`, {
        pages,
        example: first ? {
          itemId: first.id,
          title: ontologyRecordTitle(first),
          before: [{ label: 'Labels', value: ownLabelList(first).join(', ') || '(none)' }],
          after: [{ label: 'Labels', value: [...new Set([...ownLabelList(first), change.labelId])].join(', ') }],
        } : null,
        ops,
        undo,
        satisfied: pages.length > 0 && ops.length === 0,
        blocked: label(change.labelId) ? null : `Waiting for the label "${change.labelId}" to exist in the registry.`,
      });
    }
    case 'split-label': {
      const missing = change.into.filter((draft) => !label(draft.id));
      const assigned = Object.entries(change.pageIds).map(([id, pageIds]) => ({ id, pages: pagesOf(pageIds) }));
      // A page may move to several new labels: gather them first, so it gets one
      // write carrying all of them rather than one per label, each replacing the last.
      const targets = new Map<T, string[]>();
      for (const { id, pages } of assigned) {
        for (const page of pages) targets.set(page, [...(targets.get(page) ?? []), id]);
      }
      const pages = [...targets.keys()];
      // The narrower label implies the one it splits, so the page drops the explicit parent.
      const { ops, undo } = relabel(pages, (current, page) => [...new Set([...current.filter((entry) => entry !== change.labelId), ...targets.get(page)!])]);
      const first = assigned.find((entry) => entry.pages.length);
      return plan(`Split ${labelTitle(change.labelId)} into ${change.into.map((draft) => draft.label).join(', ')}`, {
        pages,
        example: first ? {
          itemId: first.pages[0]!.id,
          title: ontologyRecordTitle(first.pages[0]!),
          before: [{ label: 'Labels', value: ownLabelList(first.pages[0]!).join(', ') || labelTitle(change.labelId) }],
          after: [{ label: 'Labels', value: first.id }],
        } : null,
        ops: missing.length ? [] : ops,
        undo: missing.length ? [] : undo,
        satisfied: !missing.length && pages.length > 0 && ops.length === 0,
        blocked: missing.length ? `Schema change first: an agent adds ${missing.map((draft) => draft.id).join(', ')} under ${change.labelId}, then this relabels the pages here.` : null,
      });
    }
  }
}

function mentions(change: Record<string, unknown>, labelId: string): boolean {
  const ids = [
    change.labelId,
    change.broaderId,
    (change.label as { id?: unknown } | undefined)?.id,
    ...((change.label as { broader?: unknown[] } | undefined)?.broader ?? []),
    ...((change.property as { range?: unknown[] } | undefined)?.range ?? []),
    ...((change.claimProperty as { range?: unknown[] } | undefined)?.range ?? []),
    ...(Array.isArray(change.labelIds) ? change.labelIds : []),
    ...(Array.isArray(change.into) ? change.into.map((draft) => (draft as { id?: unknown }).id) : []),
    change.toKind,
  ];
  return ids.includes(labelId);
}

/**
 * Open proposals (proposed or accepted) touching a label: a change naming it,
 * or a request raised from one of its health checks.
 */
export function proposalsTouchingLabel<T extends OntologyRecordLike>(proposals: readonly T[], labelId: string): T[] {
  return proposals.filter((proposal) => {
    const status = ontologyFieldValue(proposal, 'status');
    if (proposal.archived || (status !== undefined && status !== 'proposed' && status !== 'accepted')) return false;
    const check = ontologyFieldValue(proposal, 'healthCheck');
    if (typeof check === 'string' && check.split(/[:+]/).includes(labelId)) return true;
    const raw = ontologyFieldValue(proposal, 'changes');
    let changes: unknown = raw;
    if (typeof raw === 'string') {
      try { changes = JSON.parse(raw); } catch { return false; }
    }
    return Array.isArray(changes) && changes.some((change) => change && typeof change === 'object' && mentions(change as Record<string, unknown>, labelId));
  });
}
