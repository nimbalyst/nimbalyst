/**
 * Ontology proposals: agent-drafted changesets to the graph's shape that a
 * person accepts or rejects change by change (contract r1, `ontology-proposal`).
 *
 * Pure. `planOntologyChange` turns one change into the pages it touches, a
 * before/after of one of them, the tracker writes that apply it and the writes
 * that undo it -- so the preview a reader approves and the migration that runs
 * are computed by the same function. Schema changes (a label, a property, a
 * broader link, a range) cannot be written from the browser; an agent applies
 * them and marks the change, and data changes that need them wait until they
 * exist. The label changes live in `ontologyLabelProposals.ts`.
 *
 * `add-kind-option`, `add-predicate` and `reclassify-pages` are retired:
 * agents no longer draft them, but proposals that carry them still read, plan
 * and render.
 */
import type { LabelRegistry } from '@nimbalyst/tracker-schema';
import { claimPredicate, entityKind, type HealthItem, type KnowledgeGraph } from './ontologyKnowledge';
import {
  LABEL_CHANGE_TYPES,
  LABEL_SCHEMA_CHANGE_TYPES,
  labelChangeProblem,
  planLabelChange,
  type LabelChange,
} from './ontologyLabelProposals';
import {
  isEmptyFieldValue,
  ontologyFieldValue,
  ontologyRecordTitle,
  recordRefs,
  stringList,
  type OntologyRecordLike,
} from './ontologyRecords';

export const ONTOLOGY_PROPOSAL_TYPE = 'ontology-proposal';

export type ProposalStatus = 'proposed' | 'accepted' | 'applied' | 'rejected' | 'undone';
export type ChangeDecision = 'pending' | 'accepted' | 'rejected';

interface ChangeBase {
  /** Unique within the proposal. */
  id: string;
  reason?: string;
  decision?: ChangeDecision;
  decidedBy?: string;
  decidedAt?: string;
  rejectReason?: string;
  /** Set when the change was applied: by the web console for data changes, by the agent for schema changes. */
  appliedAt?: string;
  undoneAt?: string;
}

export interface PredicateDraft {
  id: string;
  label: string;
  inverseLabel?: string;
  direction: 'directed' | 'symmetric';
  valueShape: string;
  subjectKinds?: string[];
  qualifiers?: Record<string, unknown>;
}

export type OntologyChange = ChangeBase & (
  | LabelChange
  | { type: 'add-kind-option'; value: string; label: string; icon?: string }
  | { type: 'reclassify-pages'; toKind: string; pageIds: string[] }
  | { type: 'add-market-node'; title: string; parentId?: string | null; summary?: string; aliases?: string[] }
  | { type: 'add-predicate'; predicate: PredicateDraft }
  | { type: 'merge-duplicates'; keepId: string; mergeIds: string[] }
  | {
    type: 'move-field-to-claims';
    /** The entity field whose values move. */
    field: string;
    predicate: string;
    /** Restrict to these pages; default every entity with the field filled. */
    pageIds?: string[];
    /** When set, this entity is the claim's subject and the page is its object (Nimbalyst competes-with X). */
    subjectId?: string;
    /** Qualifier name -> entity field it is read from. */
    qualifiers?: Record<string, string>;
    /** Qualifiers every created claim carries (e.g. `asOf`). */
    staticQualifiers?: Record<string, unknown>;
    /** Put the field's value in `valueText`. Default: true when there is no `subjectId`. */
    valueText?: boolean;
  }
);

export type OntologyChangeType = OntologyChange['type'];
/** Types an agent may draft today. */
export const CHANGE_TYPES: readonly OntologyChangeType[] = [
  ...LABEL_CHANGE_TYPES, 'add-market-node', 'merge-duplicates', 'move-field-to-claims',
];
/** No longer drafted; kept so proposals that carry them still read, plan and apply. */
export const RETIRED_CHANGE_TYPES: readonly OntologyChangeType[] = ['add-kind-option', 'add-predicate', 'reclassify-pages'];
/** Changes to the schema, which an agent applies; the rest are data the page writes. */
export const SCHEMA_CHANGE_TYPES: ReadonlySet<OntologyChangeType> = new Set([...LABEL_SCHEMA_CHANGE_TYPES, 'add-kind-option', 'add-predicate']);

// ---------------------------------------------------------------------------
// Reading and writing the JSON fields
// ---------------------------------------------------------------------------

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function changeProblem(change: Record<string, unknown>): string | null {
  const labelProblem = labelChangeProblem(change);
  if (labelProblem !== undefined) return labelProblem;
  switch (change.type) {
    case 'add-kind-option': return nonEmpty(change.value) && nonEmpty(change.label) ? null : 'needs value and label';
    case 'reclassify-pages': return nonEmpty(change.toKind) && isStringArray(change.pageIds) ? null : 'needs toKind and pageIds';
    case 'add-market-node': return nonEmpty(change.title) ? null : 'needs title';
    case 'add-predicate': {
      const predicate = change.predicate as Record<string, unknown> | undefined;
      return predicate && nonEmpty(predicate.id) && nonEmpty(predicate.label) && nonEmpty(predicate.valueShape)
        && (predicate.direction === 'directed' || predicate.direction === 'symmetric')
        ? null : 'needs predicate.id, label, valueShape and direction';
    }
    case 'merge-duplicates': return nonEmpty(change.keepId) && isStringArray(change.mergeIds) && change.mergeIds.length > 0 ? null : 'needs keepId and mergeIds';
    case 'move-field-to-claims': return nonEmpty(change.field) && nonEmpty(change.predicate) ? null : 'needs field and predicate';
    default: return `unknown type ${JSON.stringify(change.type)}`;
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export interface ParsedChanges {
  changes: OntologyChange[];
  /** One line per change that could not be read; never silently dropped. */
  errors: string[];
}

/** `changes` as the room stores it: a JSON string (or an array an agent wrote directly). */
export function parseProposalChanges(value: unknown): ParsedChanges {
  const parsed = parseJson(value);
  if (parsed === null || parsed === undefined) {
    return { changes: [], errors: parsed === undefined ? ['changes is not valid JSON'] : [] };
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { changes?: unknown }).changes;
  if (!Array.isArray(list)) return { changes: [], errors: ['changes is not a list'] };
  const changes: OntologyChange[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      errors.push(`change ${index + 1}: not an object`);
      return;
    }
    const change = { ...(entry as Record<string, unknown>) };
    if (!nonEmpty(change.id) || ids.has(change.id)) change.id = `change-${index + 1}`;
    const problem = changeProblem(change);
    if (problem) {
      errors.push(`change ${index + 1}: ${problem}`);
      return;
    }
    ids.add(change.id as string);
    changes.push(change as unknown as OntologyChange);
  });
  return { changes, errors };
}

export function serializeChanges(changes: readonly OntologyChange[]): string {
  return JSON.stringify(changes, null, 2);
}

export type UndoOp =
  | { op: 'restore-fields'; itemId: string; fields: Record<string, unknown> }
  | { op: 'archive'; itemId: string }
  | { op: 'unarchive'; itemId: string };

export interface UndoEntry {
  changeId: string;
  appliedAt: string;
  appliedBy?: string;
  undoneAt?: string;
  /** In the order they undo: last write first. */
  ops: UndoOp[];
}

export interface UndoRecord {
  entries: UndoEntry[];
}

export function parseUndoRecord(value: unknown): UndoRecord {
  const parsed = parseJson(value);
  const entries = parsed && typeof parsed === 'object' ? (parsed as { entries?: unknown }).entries : undefined;
  return { entries: Array.isArray(entries) ? entries as UndoEntry[] : [] };
}

export function serializeUndoRecord(record: UndoRecord): string {
  return JSON.stringify(record, null, 2);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function decisionOf(change: OntologyChange): ChangeDecision {
  return change.decision === 'accepted' || change.decision === 'rejected' ? change.decision : 'pending';
}

export function isLive(change: OntologyChange): boolean {
  return Boolean(change.appliedAt) && !change.undoneAt;
}

/** Proposal status from its changes: the stored status is written from this, never edited by hand in the page. */
export function deriveProposalStatus(changes: readonly OntologyChange[]): ProposalStatus {
  if (changes.length === 0 || changes.some((change) => decisionOf(change) === 'pending')) return 'proposed';
  const accepted = changes.filter((change) => decisionOf(change) === 'accepted');
  if (accepted.length === 0) return 'rejected';
  if (accepted.every(isLive)) return 'applied';
  // Schema changes an agent made have no undo; once every data change is undone the proposal is.
  if (accepted.some((change) => change.undoneAt)
    && !accepted.some((change) => isLive(change) && !SCHEMA_CHANGE_TYPES.has(change.type))) return 'undone';
  return 'accepted';
}

export function decideChange(
  changes: readonly OntologyChange[],
  changeId: string,
  decision: ChangeDecision,
  by: string | null,
  at: string,
  rejectReason?: string,
): OntologyChange[] {
  return changes.map((change) => {
    if (change.id !== changeId || isLive(change)) return change;
    const next = { ...change, decision, decidedAt: at } as OntologyChange;
    if (by) next.decidedBy = by;
    else delete next.decidedBy;
    if (decision === 'rejected' && rejectReason?.trim()) next.rejectReason = rejectReason.trim();
    else delete next.rejectReason;
    return next;
  });
}

// ---------------------------------------------------------------------------
// Planning one change
// ---------------------------------------------------------------------------

export type ApplyOp =
  | { op: 'update'; itemId: string; updates: Record<string, unknown> }
  | { op: 'create'; item: { id: string; type: string; title: string; status: string; customFields: Record<string, unknown> } }
  | { op: 'archive'; itemId: string };

export interface PreviewLine {
  label: string;
  value: string;
}

export interface ChangePreview {
  itemId: string | null;
  title: string;
  before: PreviewLine[];
  after: PreviewLine[];
}

export interface ChangePlan<T extends OntologyRecordLike = OntologyRecordLike> {
  summary: string;
  /** Pages the change touches. */
  pages: T[];
  example: ChangePreview | null;
  /** Writes that apply it, in order. */
  ops: ApplyOp[];
  /** Writes that reverse `ops`, in the order to run them. */
  undo: UndoOp[];
  /** Why it cannot be applied from here yet. */
  blocked: string | null;
  /** Schema changes: already true in the room, nothing to write. */
  satisfied: boolean;
}

export interface PlanEnv {
  /** Options of `entity.kind` in the room's live schema. */
  kindOptions: ReadonlySet<string>;
  predicateLabel: (id: string) => string;
  newId: () => string;
  /** The label registry in force (the kind stand-in included), for label changes. */
  labels?: LabelRegistry;
  /** Whether an id is a declared predicate. */
  isPredicate?: (id: string) => boolean;
}

type Ref = { itemId: string };
const ref = (itemId: string): Ref => ({ itemId });

function display(value: unknown): string {
  if (isEmptyFieldValue(value)) return '(empty)';
  if (Array.isArray(value)) return value.map(display).join(', ');
  if (value && typeof value === 'object') {
    const itemId = (value as { itemId?: unknown }).itemId;
    return typeof itemId === 'string' ? itemId : JSON.stringify(value);
  }
  return String(value);
}

function emptyPlan<T extends OntologyRecordLike>(summary: string, extra: Partial<ChangePlan<T>> = {}): ChangePlan<T> {
  return { summary, pages: [], example: null, ops: [], undo: [], blocked: null, satisfied: false, ...extra };
}

/** Fields that hold references a merge repoints. */
const REF_FIELDS = ['subject', 'object', 'parent', 'subjects', 'question'] as const;

function repoint(value: unknown, from: ReadonlySet<string>, to: string): unknown {
  if (Array.isArray(value)) {
    const seen = new Set<string>();
    return value.map((entry) => repoint(entry, from, to)).filter((entry) => {
      const id = typeof entry === 'string' ? entry : (entry as { itemId?: string } | null)?.itemId;
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  if (typeof value === 'string') return from.has(value) ? to : value;
  if (value && typeof value === 'object' && typeof (value as Ref).itemId === 'string') {
    return from.has((value as Ref).itemId) ? { ...(value as Ref), itemId: to } : value;
  }
  return value;
}

function claimExists<T extends OntologyRecordLike>(graph: KnowledgeGraph<T>, subject: string, predicate: string, object: string | null): boolean {
  return (graph.claimsBySubject.get(subject) ?? []).some((claim) => claimPredicate(claim) === predicate
    && (object === null ? recordRefs(claim, 'object').length === 0 : recordRefs(claim, 'object')[0] === object));
}

export function planOntologyChange<T extends OntologyRecordLike>(change: OntologyChange, graph: KnowledgeGraph<T>, env: PlanEnv): ChangePlan<T> {
  switch (change.type) {
    case 'add-label':
    case 'add-property':
    case 'add-label-property':
    case 'add-broader':
    case 'extend-range':
    case 'apply-label':
    case 'split-label':
      return planLabelChange(change, graph, env);
    case 'add-kind-option': {
      const exists = env.kindOptions.has(change.value);
      return emptyPlan(`Add the kind "${change.label}" (${change.value})`, {
        example: { itemId: null, title: 'entity.kind', before: [{ label: 'Kind options', value: exists ? `includes ${change.value}` : `no ${change.value}` }], after: [{ label: 'Kind options', value: `+ ${change.value} (${change.label})` }] },
        satisfied: exists || Boolean(change.appliedAt),
        blocked: exists || change.appliedAt ? null : 'Schema change: an agent adds this option to entity.kind, then marks the change applied.',
      });
    }
    case 'add-predicate': {
      const { predicate } = change;
      const used = graph.claims.some((claim) => claimPredicate(claim) === predicate.id);
      return emptyPlan(`Add the predicate "${predicate.label}" (${predicate.id})`, {
        example: {
          itemId: null,
          title: 'Predicate registry',
          before: [{ label: predicate.id, value: used ? 'in use' : 'not declared' }],
          after: [
            { label: predicate.id, value: `${predicate.direction}, ${predicate.valueShape}${predicate.inverseLabel ? `, inverse "${predicate.inverseLabel}"` : ''}` },
          ],
        },
        satisfied: Boolean(change.appliedAt),
        blocked: change.appliedAt ? null : 'Schema change: an agent adds this predicate to the registry, then marks the change applied.',
      });
    }
    case 'reclassify-pages': {
      const pages = change.pageIds.map((id) => graph.byId.get(id)).filter((page): page is T => page?.primaryType === 'entity');
      const moving = pages.filter((page) => entityKind(page) !== change.toKind);
      const first = moving[0] ?? pages[0];
      return emptyPlan(`Reclassify ${pages.length} ${pages.length === 1 ? 'page' : 'pages'} as ${change.toKind}`, {
        pages,
        example: first ? {
          itemId: first.id,
          title: ontologyRecordTitle(first),
          before: [{ label: 'Kind', value: display(ontologyFieldValue(first, 'kind')) }],
          after: [{ label: 'Kind', value: change.toKind }],
        } : null,
        ops: moving.map((page) => ({ op: 'update', itemId: page.id, updates: { kind: change.toKind } })),
        undo: moving.slice().reverse().map((page) => ({ op: 'restore-fields', itemId: page.id, fields: { kind: ontologyFieldValue(page, 'kind') ?? null } })),
        blocked: env.kindOptions.has(change.toKind) ? null : `Waiting for the kind "${change.toKind}" to exist in the schema.`,
      });
    }
    case 'add-market-node': {
      const parentId = change.parentId ?? graph.entities.find((entity) => entityKind(entity) === 'area' && ontologyRecordTitle(entity).trim().toLowerCase() === 'markets')?.id ?? null;
      const parent = parentId ? graph.byId.get(parentId) : undefined;
      const existing = graph.entities.find((entity) => entityKind(entity) === 'market'
        && ontologyRecordTitle(entity).trim().toLowerCase() === change.title.trim().toLowerCase());
      const blocked = existing ? null
        : !env.kindOptions.has('market') ? 'Waiting for the kind "market" to exist in the schema.'
          : !parent ? (change.parentId ? 'The parent market is not in this project.' : 'There is no Markets area to put it under.')
            : null;
      const id = env.newId();
      const customFields: Record<string, unknown> = { kind: 'market', parent: ref(parent?.id ?? '') };
      if (change.summary) customFields.summary = change.summary;
      if (change.aliases?.length) customFields.aliases = change.aliases;
      return emptyPlan(`Add the market "${change.title}" under ${parent ? ontologyRecordTitle(parent) : '(missing parent)'}`, {
        pages: existing ? [existing] : parent ? [parent] : [],
        example: {
          itemId: existing?.id ?? null,
          title: change.title,
          before: [{ label: 'Page', value: existing ? 'already exists' : '(none)' }],
          after: [{ label: 'Kind', value: 'market' }, { label: 'Parent', value: parent ? ontologyRecordTitle(parent) : '(missing)' }, ...change.summary ? [{ label: 'Summary', value: change.summary }] : []],
        },
        ops: existing || blocked ? [] : [{ op: 'create', item: { id, type: 'entity', title: change.title, status: 'active', customFields } }],
        undo: existing || blocked ? [] : [{ op: 'archive', itemId: id }],
        satisfied: Boolean(existing),
        blocked,
      });
    }
    case 'merge-duplicates': {
      const keep = graph.byId.get(change.keepId);
      const merged = change.mergeIds.filter((id) => id !== change.keepId).map((id) => graph.byId.get(id)).filter((page): page is T => Boolean(page));
      if (!keep) return emptyPlan(`Merge into ${change.keepId}`, { blocked: 'The item to keep is not in this project (or is archived).' });
      if (merged.length === 0) return emptyPlan(`Merge into ${ontologyRecordTitle(keep)}`, { pages: [keep], satisfied: Boolean(change.appliedAt), blocked: change.appliedAt ? null : 'None of the pages to merge are live.' });
      const from = new Set(merged.map((page) => page.id));
      const ops: ApplyOp[] = [];
      const undo: UndoOp[] = [];
      let repointed = 0;
      for (const record of graph.live) {
        if (from.has(record.id)) continue;
        const updates: Record<string, unknown> = {};
        const before: Record<string, unknown> = {};
        for (const field of REF_FIELDS) {
          const value = ontologyFieldValue(record, field);
          if (value === undefined || value === null) continue;
          const next = repoint(value, from, keep.id);
          if (JSON.stringify(next) !== JSON.stringify(value)) {
            updates[field] = next;
            before[field] = value;
          }
        }
        if (Object.keys(updates).length) {
          repointed += 1;
          ops.push({ op: 'update', itemId: record.id, updates });
          undo.push({ op: 'restore-fields', itemId: record.id, fields: before });
        }
      }
      const aliasesBefore = stringList(ontologyFieldValue(keep, 'aliases'));
      const known = new Set([ontologyRecordTitle(keep), ...aliasesBefore].map((name) => name.toLowerCase()));
      const aliasesAfter = [...aliasesBefore];
      for (const page of merged) {
        for (const name of [ontologyRecordTitle(page), ...stringList(ontologyFieldValue(page, 'aliases'))]) {
          if (!known.has(name.toLowerCase())) {
            known.add(name.toLowerCase());
            aliasesAfter.push(name);
          }
        }
      }
      if (aliasesAfter.length !== aliasesBefore.length) {
        ops.push({ op: 'update', itemId: keep.id, updates: { aliases: aliasesAfter } });
        undo.push({ op: 'restore-fields', itemId: keep.id, fields: { aliases: aliasesBefore.length ? aliasesBefore : null } });
      }
      for (const page of merged) {
        ops.push({ op: 'archive', itemId: page.id });
        undo.push({ op: 'unarchive', itemId: page.id });
      }
      return emptyPlan(`Merge ${merged.map((page) => ontologyRecordTitle(page)).join(', ')} into ${ontologyRecordTitle(keep)}`, {
        pages: [keep, ...merged],
        example: {
          itemId: keep.id,
          title: ontologyRecordTitle(keep),
          before: [
            { label: 'Aliases', value: display(aliasesBefore) },
            ...merged.map((page) => ({ label: `${page.primaryType} ${page.issueKey ?? ''}`.trim(), value: ontologyRecordTitle(page) })),
          ],
          after: [
            { label: 'Aliases', value: display(aliasesAfter) },
            { label: 'References moved here', value: String(repointed) },
            { label: 'Archived', value: merged.map((page) => ontologyRecordTitle(page)).join(', ') },
          ],
        },
        ops,
        undo: undo.reverse(),
      });
    }
    case 'move-field-to-claims': {
      const subject = change.subjectId ? graph.byId.get(change.subjectId) : undefined;
      if (change.subjectId && !subject) return emptyPlan(`Move ${change.field} into ${change.predicate} claims`, { blocked: 'The subject page is not in this project.' });
      const scope = change.pageIds ? new Set(change.pageIds) : null;
      const pages = graph.entities
        .filter((page) => (!scope || scope.has(page.id)) && page.id !== subject?.id && !isEmptyFieldValue(ontologyFieldValue(page, change.field)))
        .sort((a, b) => ontologyRecordTitle(a).localeCompare(ontologyRecordTitle(b)));
      const useValueText = change.valueText ?? !change.subjectId;
      const label = env.predicateLabel(change.predicate);
      const ops: ApplyOp[] = [];
      const undo: UndoOp[] = [];
      const drafts: Array<{ page: T; title: string; qualifiers: Record<string, unknown>; valueText: string | null }> = [];
      for (const page of pages) {
        const subjectId = subject?.id ?? page.id;
        const objectId = subject ? page.id : null;
        if (claimExists(graph, subjectId, change.predicate, objectId)) continue;
        const qualifiers: Record<string, unknown> = { ...(change.staticQualifiers ?? {}) };
        for (const [name, field] of Object.entries(change.qualifiers ?? {})) {
          const value = ontologyFieldValue(page, field);
          if (!isEmptyFieldValue(value)) qualifiers[name] = value;
        }
        const raw = ontologyFieldValue(page, change.field);
        const valueText = useValueText ? display(raw) : null;
        const claimTitle = subject
          ? `${ontologyRecordTitle(subject)} ${label} ${ontologyRecordTitle(page)}`
          : `${ontologyRecordTitle(page)} ${label}: ${valueText}`;
        const customFields: Record<string, unknown> = { subject: ref(subjectId), predicate: change.predicate, basis: 'documented' };
        if (objectId) customFields.object = ref(objectId);
        if (Object.keys(qualifiers).length) customFields.qualifiers = qualifiers;
        if (valueText !== null) customFields.valueText = valueText;
        const id = env.newId();
        ops.push({ op: 'create', item: { id, type: 'claim', title: claimTitle, status: 'asserted', customFields } });
        undo.push({ op: 'archive', itemId: id });
        drafts.push({ page, title: claimTitle, qualifiers, valueText });
      }
      const first = drafts[0];
      return emptyPlan(`Move ${change.field} on ${pages.length} ${pages.length === 1 ? 'page' : 'pages'} into ${change.predicate} claims`, {
        pages,
        example: first ? {
          itemId: first.page.id,
          title: ontologyRecordTitle(first.page),
          before: [{ label: change.field, value: display(ontologyFieldValue(first.page, change.field)) }],
          after: [
            { label: 'New claim', value: first.title },
            ...Object.entries(first.qualifiers).map(([name, value]) => ({ label: name, value: display(value) })),
            { label: change.field, value: `${display(ontologyFieldValue(first.page, change.field))} (kept, deprecated)` },
          ],
        } : null,
        ops,
        undo: undo.reverse(),
        satisfied: drafts.length === 0 && pages.length > 0,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Improve: a request for an agent to draft a proposal
// ---------------------------------------------------------------------------

const REQUEST_PAGE_LIMIT = 40;

export interface ProposalRequestDraft {
  title: string;
  request: string;
  healthCheck: string;
}

/**
 * What the Improve button writes: a `proposed` proposal with no changes and a
 * request naming the health check and the pages, which the wiki update skill's
 * agent workflow picks up and fills in.
 */
export function proposalRequestFor<T extends OntologyRecordLike>(item: HealthItem<T>): ProposalRequestDraft {
  const lines = item.groups
    ? item.groups.map((group) => group.map((page) => `${ontologyRecordTitle(page)} [${page.primaryType} ${page.id}]`).join(' = '))
    : item.items.map((page) => `${ontologyRecordTitle(page)} [${page.id}]`);
  const listed = lines.slice(0, REQUEST_PAGE_LIMIT);
  return {
    title: `Improve: ${item.title}`,
    healthCheck: item.id,
    request: [
      `Health check ${item.id}: ${item.title}.`,
      item.detail,
      '',
      `Affected (${item.count}):`,
      ...listed.map((line) => `- ${line}`),
      ...lines.length > listed.length ? [`- ...and ${lines.length - listed.length} more`] : [],
    ].join('\n'),
  };
}

/** Open proposals (not yet applied, rejected or undone) by the health check they answer. */
export function openProposalsByCheck<T extends OntologyRecordLike>(proposals: readonly T[]): Map<string, T> {
  const open = new Map<string, T>();
  for (const proposal of proposals) {
    const check = ontologyFieldValue(proposal, 'healthCheck');
    const status = ontologyFieldValue(proposal, 'status');
    if (typeof check !== 'string' || !check) continue;
    if (status === 'proposed' || status === 'accepted' || status === undefined) open.set(check, proposal);
  }
  return open;
}
