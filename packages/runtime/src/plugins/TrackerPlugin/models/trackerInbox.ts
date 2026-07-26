/**
 * The triage inbox: which items still need a human decision.
 *
 * "Untriaged" is defined by the *absence* of every triage act rather than by a
 * dedicated status, so items arriving from any source -- GitHub imports, inline
 * captures, agent-filed bugs, hand-typed tasks -- land in the inbox without any
 * type needing a `needs-triage` value in its schema. Triaging an item is
 * whatever the user does to it: assign it, prioritize it, put it in a
 * milestone, or move it off its initial status. Any one of those retires it
 * from the inbox.
 *
 * Snoozing is personal (one triager deferring an item must not hide it from
 * their colleague), so deadlines arrive through the context rather than living
 * on the record.
 *
 * Pure and I/O-free: record accessors are injected the same way
 * `computeCollectionRollup` takes `getStatus`, so the CLI, the MCP tools, and
 * the renderer all evaluate the same predicate.
 */

import type { TrackerRecord } from '../../../core/TrackerRecord';
import { getRoleField, globalRegistry } from './TrackerDataModel';
import { getCollectionField, isCollectionType } from './trackerCollections';
import { normalizeRelationshipValue } from './trackerRelationships';

/** Whether the inbox spans every type or only the selected one. */
export type InboxScope = 'global' | 'type';

/** Record accessors the predicate needs, injected to keep this module pure. */
export interface InboxSignals {
  getStatus: (record: TrackerRecord) => string;
  getPriority: (record: TrackerRecord) => string;
  /** Falsy when the item has no assignee. */
  getAssignee: (record: TrackerRecord) => unknown;
}

export interface InboxContext extends InboxSignals {
  /** Personal snooze deadlines (epoch ms) by item id. */
  snoozedUntilByItemId?: ReadonlyMap<string, number>;
  /** Injectable clock so snooze expiry is testable. */
  nowMs?: number;
  /** `type` restricts the inbox to `selectedType`; `global` spans all types. */
  scope?: InboxScope;
  /** The sidebar's selected type; ignored when scope is `global` or `'all'`. */
  selectedType?: string;
}

/**
 * An item an agent filed on its own initiative. The inbox surfaces these
 * distinctly: the house rule is that an agent may propose, only a human accepts.
 */
export function isAgentProposal(record: TrackerRecord): boolean {
  return record.system.createdByAgent === true;
}

/** The initial workflow status: explicit default, then first lifecycle option. */
export function getInitialStatus(type: string): string {
  const model = globalRegistry.get(type);
  if (!model) return '';
  // Mirror the accessor fallback: an explicit `workflowStatus` role wins, and a
  // schema that declares no roles still conventionally uses `status`.
  const fieldName = getRoleField(model, 'workflowStatus') ?? 'status';
  const field = model.fields.find((f) => f.name === fieldName);
  if (typeof field?.default === 'string') return field.default;
  const firstOption = field?.options?.[0];
  return firstOption
    ? (typeof firstOption === 'string' ? firstOption : firstOption.value)
    : '';
}

/**
 * The priority every write path stamps when the caller doesn't pick one --
 * `tracker_create`, the inline/plan/decision capture paths, and the frontmatter
 * projection all write `priority || 'medium'`. The predicate has to know that
 * value: without it a stamp is indistinguishable from a human choosing Medium,
 * every item counts as prioritized, and the inbox is empty forever (NIM-2172).
 */
export const STAMPED_DEFAULT_PRIORITY = 'medium';

/**
 * The priority value that means "nobody decided": the type's declared default,
 * falling back to the stamp for a type that declares none -- such a type is
 * still receiving the stamp on create, so the stamp is its de-facto default.
 */
export function getDefaultPriority(type: string): string {
  const model = globalRegistry.get(type);
  if (!model) return STAMPED_DEFAULT_PRIORITY;
  const fieldName = getRoleField(model, 'priority') ?? 'priority';
  const field = model.fields.find((f) => f.name === fieldName);
  return typeof field?.default === 'string' ? field.default : STAMPED_DEFAULT_PRIORITY;
}

/** Whether an item belongs to at least one collection (milestone / release). */
export function isInCollection(record: TrackerRecord): boolean {
  const field = getCollectionField(record.primaryType);
  if (!field) return false;
  return normalizeRelationshipValue(record.fields[field.name]).length > 0;
}

export interface TriageSignals {
  assigned: boolean;
  /** Given a priority other than the one the write paths stamp by default. */
  prioritized: boolean;
  inCollection: boolean;
  /** Moved off the type's initial status (or the type has no default at all). */
  statusMoved: boolean;
  /** Explicitly marked "looked at, correctly where it is" by a person. */
  markedTriaged: boolean;
}

/** The individual acts that retire an item from the inbox. */
export function triageSignals(record: TrackerRecord, signals: InboxSignals): TriageSignals {
  const initial = getInitialStatus(record.primaryType);
  const status = signals.getStatus(record);
  const priority = signals.getPriority(record);
  return {
    assigned: Boolean(signals.getAssignee(record)),
    // The default is a stamp, not a decision -- see STAMPED_DEFAULT_PRIORITY.
    prioritized: Boolean(priority) && priority !== getDefaultPriority(record.primaryType),
    inCollection: isInCollection(record),
    // A type with no usable workflow lifecycle cannot tell "untouched" from
    // "moved", so the other signals decide.
    statusMoved: Boolean(initial) && Boolean(status) && status !== initial,
    markedTriaged: Boolean(record.system.triagedAt),
  };
}

/**
 * Whether an item still needs triage. Archived items and collections themselves
 * are never in the inbox -- archiving *is* the dismiss action, and a milestone
 * is the destination of triage, not its subject.
 */
export function isUntriaged(record: TrackerRecord, signals: InboxSignals): boolean {
  if (record.archived) return false;
  if (isCollectionType(record.primaryType)) return false;
  const triage = triageSignals(record, signals);
  return !triage.assigned && !triage.prioritized && !triage.inCollection
    && !triage.statusMoved && !triage.markedTriaged;
}

/** Whether a personal snooze is still holding this item out of the inbox. */
export function isSnoozed(
  record: TrackerRecord,
  snoozedUntilByItemId: ReadonlyMap<string, number> | undefined,
  nowMs: number,
): boolean {
  const until = snoozedUntilByItemId?.get(record.id);
  return typeof until === 'number' && Number.isFinite(until) && until > nowMs;
}

function createdAtMs(record: TrackerRecord): number {
  const raw = record.system.createdAt || record.system.updatedAt;
  const time = raw ? new Date(raw).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

/**
 * The inbox queue: untriaged, un-snoozed items, newest first so the freshest
 * arrivals are processed while their context is still warm.
 */
export function selectInboxItems(items: TrackerRecord[], ctx: InboxContext): TrackerRecord[] {
  const now = ctx.nowMs ?? Date.now();
  const scoped = ctx.scope === 'type' && ctx.selectedType && ctx.selectedType !== 'all'
    ? items.filter((item) => item.primaryType === ctx.selectedType
      || item.typeTags.includes(ctx.selectedType!))
    : items;

  return scoped
    .filter((item) => isUntriaged(item, ctx) && !isSnoozed(item, ctx.snoozedUntilByItemId, now))
    .sort((a, b) => createdAtMs(b) - createdAtMs(a));
}

/**
 * The status "accept" moves an item to: the first option after the type's
 * initial status. Schemas order their status options as a lifecycle, so the
 * next option is the working state (`to-do` -> `in-progress`). Returns null when
 * the type has no status options or the initial status is already the last one.
 */
export function acceptStatusFor(type: string): string | null {
  const model = globalRegistry.get(type);
  if (!model) return null;
  const fieldName = getRoleField(model, 'workflowStatus') ?? 'status';
  const options = model.fields.find((f) => f.name === fieldName)?.options ?? [];
  if (options.length === 0) return null;
  const values = options.map((o) => (typeof o === 'string' ? o : o.value));
  const initial = getInitialStatus(type);
  const index = values.indexOf(initial);
  const next = values[index + 1];
  return next ?? null;
}

/** Priority values a type offers, in schema order (lowest first). */
export function priorityOptionsFor(type: string): string[] {
  const model = globalRegistry.get(type);
  if (!model) return [];
  const fieldName = getRoleField(model, 'priority') ?? 'priority';
  const options = model.fields.find((f) => f.name === fieldName)?.options ?? [];
  return options.map((o) => (typeof o === 'string' ? o : o.value));
}

/** Common snooze offsets, in ms, for the inbox's snooze action. */
export const SNOOZE_PRESETS: ReadonlyArray<{ id: string; label: string; ms: number }> = [
  { id: 'tomorrow', label: 'Tomorrow', ms: 24 * 60 * 60 * 1000 },
  { id: 'week', label: 'Next week', ms: 7 * 24 * 60 * 60 * 1000 },
];

/** Inbox size, for the sidebar badge. Same predicate, no sort. */
export function countInboxItems(items: TrackerRecord[], ctx: InboxContext): number {
  const now = ctx.nowMs ?? Date.now();
  let count = 0;
  for (const item of items) {
    if (isUntriaged(item, ctx) && !isSnoozed(item, ctx.snoozedUntilByItemId, now)) count++;
  }
  return count;
}
