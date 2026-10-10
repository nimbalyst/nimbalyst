/**
 * Classify the data-bearing difference between two resolved tracker schemas as
 * additive (safe, applies instantly) or destructive (needs a confirm carrying a
 * blast radius). Pure: no item storage, no database, no UI.
 *
 * Presentation-only differences (labels, colors, icons, layout, defaults) never
 * affect the classification. Anything that is not a *proven* widening is
 * destructive by default — a wrong "additive" silently invalidates data that is
 * already in items, while a wrong "destructive" only costs a confirm click.
 */

import type {
  FieldDefinition,
  FieldOption,
  FieldType,
  TrackerDataModel,
  TrackerSharing,
} from './TrackerDataModel.js';
import { diffTrackerFields } from './schemaPatch.js';

export type TrackerSchemaConstraint =
  | 'required'
  | 'readOnly'
  | 'minLength'
  | 'maxLength'
  | 'min'
  | 'max'
  | 'multiValue'
  | 'allowSelfLink'
  | 'targetTrackerTypes';

interface FieldChange {
  fieldName: string;
}

export type AdditiveTrackerSchemaChange =
  | (FieldChange & { kind: 'field-added'; field: FieldDefinition })
  | (FieldChange & { kind: 'status-added'; option: FieldOption })
  | (FieldChange & { kind: 'select-option-added'; option: FieldOption })
  | (FieldChange & {
      kind: 'constraint-widened';
      constraint: TrackerSchemaConstraint;
      previousValue: unknown;
      nextValue: unknown;
    })
  | {
      // A type that had no workflow status field names one. No stored value
      // changes meaning, so only MOVING or dropping the role is destructive.
      kind: 'workflow-status-field-assigned';
      nextFieldName: string;
    };

export type DestructiveTrackerSchemaChange =
  | (FieldChange & { kind: 'field-removed'; field: FieldDefinition })
  | (FieldChange & { kind: 'status-removed'; option: FieldOption })
  | (FieldChange & { kind: 'select-option-removed'; option: FieldOption })
  | (FieldChange & {
      kind: 'field-type-changed';
      previousType: FieldType;
      nextType: FieldType;
    })
  | (FieldChange & {
      kind: 'constraint-narrowed';
      constraint: TrackerSchemaConstraint;
      previousValue: unknown;
      nextValue: unknown;
    })
  | (FieldChange & {
      kind: 'field-definition-changed';
      previousField: FieldDefinition;
      nextField: FieldDefinition;
    })
  | {
      kind: 'workflow-status-field-changed';
      previousFieldName: string | undefined;
      nextFieldName: string | undefined;
    };

export type TrackerSchemaChange =
  | AdditiveTrackerSchemaChange
  | DestructiveTrackerSchemaChange;

/**
 * Keyed by kind so adding a variant to {@link DestructiveTrackerSchemaChange}
 * without listing it here is a compile error rather than a change that silently
 * classifies as additive.
 */
const DESTRUCTIVE_CHANGE_KINDS: Record<DestructiveTrackerSchemaChange['kind'], true> = {
  'field-removed': true,
  'status-removed': true,
  'select-option-removed': true,
  'field-type-changed': true,
  'constraint-narrowed': true,
  'field-definition-changed': true,
  'workflow-status-field-changed': true,
};

export function isDestructiveTrackerSchemaChange(
  change: TrackerSchemaChange,
): change is DestructiveTrackerSchemaChange {
  return change.kind in DESTRUCTIVE_CHANGE_KINDS;
}

/** The subset a confirm dialog and the blast-radius calculation care about. */
export function destructiveTrackerSchemaChanges(
  changes: readonly TrackerSchemaChange[],
): DestructiveTrackerSchemaChange[] {
  return changes.filter(isDestructiveTrackerSchemaChange);
}

export interface TrackerSchemaRenameCandidate {
  previousFieldName: string;
  nextFieldName: string;
  match: 'exact-definition' | 'compatible-type';
}

export interface TrackerSchemaChangeClassification {
  /**
   * The verdict the write-through path gates on. Kept alongside {@link changes}
   * so the none/additive/destructive precedence is stated once here rather than
   * re-derived (and eventually mis-derived) at each call site. Every other view
   * of the diff — the destructive subset, the additive subset, counts — is a
   * filter of {@link changes}; see {@link destructiveTrackerSchemaChanges}.
   */
  classification: 'none' | 'additive' | 'destructive';
  changes: TrackerSchemaChange[];
  renameCandidates: TrackerSchemaRenameCandidate[];
}

export type TrackerSchemaAffectedItemCounter = (
  change: DestructiveTrackerSchemaChange,
) => number | Promise<number>;

export interface TrackerSchemaBlastRadiusEntry {
  change: DestructiveTrackerSchemaChange;
  affectedItemCount: number;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function definitionsMatch(previous: FieldDefinition, next: FieldDefinition): boolean {
  const { name: _previousName, ...previousDefinition } = previous;
  const { name: _nextName, ...nextDefinition } = next;
  return stableValue(previousDefinition) === stableValue(nextDefinition);
}

/**
 * Everything the rules below already classify, stripped out — plus `default` and
 * `displayInline`, which are presentation. Whatever survives (itemType, schema,
 * relationship wiring, …) has no widening rule, so a change to it is reported as
 * a destructive `field-definition-changed`.
 */
function unclassifiedDefinition(field: FieldDefinition): Record<string, unknown> {
  const {
    name: _name,
    type: _type,
    options: _options,
    required: _required,
    readOnly: _readOnly,
    minLength: _minLength,
    maxLength: _maxLength,
    min: _min,
    max: _max,
    multiValue: _multiValue,
    allowSelfLink: _allowSelfLink,
    targetTrackerTypes: _targetTrackerTypes,
    default: _default,
    displayInline: _displayInline,
    ...definition
  } = field;
  return definition;
}

type ConstraintDirection = 'widened' | 'narrowed' | 'unchanged';

/** A lower — or absent — floor still accepts every value the old floor did. */
function floorDirection(
  previous: number | undefined,
  next: number | undefined,
): ConstraintDirection {
  if (previous === next) return 'unchanged';
  if (next === undefined) return 'widened';
  if (previous === undefined) return 'narrowed';
  return next < previous ? 'widened' : 'narrowed';
}

/** A higher — or absent — ceiling still accepts every value the old ceiling did. */
function ceilingDirection(
  previous: number | undefined,
  next: number | undefined,
): ConstraintDirection {
  if (previous === next) return 'unchanged';
  if (next === undefined) return 'widened';
  if (previous === undefined) return 'narrowed';
  return next > previous ? 'widened' : 'narrowed';
}

/** Switching a restriction on rejects item values that were legal a moment ago. */
function restrictionDirection(
  previous: boolean | undefined,
  next: boolean | undefined,
): ConstraintDirection {
  if ((previous ?? false) === (next ?? false)) return 'unchanged';
  return next ? 'narrowed' : 'widened';
}

/** Switching a capability on only adds legal values; switching it off removes them. */
function capabilityDirection(
  previous: boolean | undefined,
  next: boolean | undefined,
): ConstraintDirection {
  if ((previous ?? false) === (next ?? false)) return 'unchanged';
  return next ? 'widened' : 'narrowed';
}

function normalizedTargets(value: string[] | '*' | undefined): '*' | Set<string> {
  return value === undefined || value === '*' ? '*' : new Set(value);
}

/** Widened only when the new target set is a superset of the old one. */
function targetTypesDirection(
  previous: string[] | '*' | undefined,
  next: string[] | '*' | undefined,
): ConstraintDirection {
  const before = normalizedTargets(previous);
  const after = normalizedTargets(next);
  if (before === '*' && after === '*') return 'unchanged';
  if (before === '*' || after === '*') return after === '*' ? 'widened' : 'narrowed';
  const keepsEveryTarget = [...before].every((value) => after.has(value));
  if (keepsEveryTarget && before.size === after.size) return 'unchanged';
  return keepsEveryTarget ? 'widened' : 'narrowed';
}

interface ConstraintRule<Value> {
  constraint: TrackerSchemaConstraint;
  read: (field: FieldDefinition) => Value;
  direction: (previous: Value, next: Value) => ConstraintDirection;
}

function constraintRule<Value>(
  constraint: TrackerSchemaConstraint,
  read: (field: FieldDefinition) => Value,
  direction: (previous: Value, next: Value) => ConstraintDirection,
): ConstraintRule<Value> {
  return { constraint, read, direction };
}

/**
 * One row per data-bearing constraint. A rule may only report `widened` when it
 * can prove the new constraint accepts everything the old one did; every other
 * outcome is `narrowed` and therefore destructive.
 */
// `any` is the existential here: each row is fully type-checked at its
// constraintRule() call, where `read` and `direction` must agree on Value.
const CONSTRAINT_RULES: ReadonlyArray<ConstraintRule<any>> = [
  constraintRule('minLength', (field) => field.minLength, floorDirection),
  constraintRule('min', (field) => field.min, floorDirection),
  constraintRule('maxLength', (field) => field.maxLength, ceilingDirection),
  constraintRule('max', (field) => field.max, ceilingDirection),
  constraintRule('required', (field) => field.required, restrictionDirection),
  constraintRule('readOnly', (field) => field.readOnly, restrictionDirection),
  constraintRule('multiValue', (field) => field.multiValue, capabilityDirection),
  constraintRule('allowSelfLink', (field) => field.allowSelfLink, capabilityDirection),
  constraintRule('targetTrackerTypes', (field) => field.targetTrackerTypes, targetTypesDirection),
];

function compareOptions(
  changes: TrackerSchemaChange[],
  previous: TrackerDataModel,
  next: TrackerDataModel,
  previousField: FieldDefinition,
  nextField: FieldDefinition,
): void {
  const previousOptions = new Map(
    (previousField.options ?? []).map((option) => [option.value, option]),
  );
  const nextOptions = new Map((nextField.options ?? []).map((option) => [option.value, option]));
  const isStatusField =
    previous.roles?.workflowStatus === previousField.name ||
    next.roles?.workflowStatus === nextField.name;

  for (const [value, option] of nextOptions) {
    if (previousOptions.has(value)) continue;
    changes.push({
      kind: isStatusField ? 'status-added' : 'select-option-added',
      fieldName: nextField.name,
      option,
    });
  }
  for (const [value, option] of previousOptions) {
    if (nextOptions.has(value)) continue;
    // Destructive even when zero items currently use the option: a teammate's
    // in-flight item can be sitting on it, and it is only visible here as a
    // count. The blast radius decides how loud the confirm is, not whether one
    // is needed — a zero count is a low-friction confirm, not a silent apply.
    changes.push({
      kind: isStatusField ? 'status-removed' : 'select-option-removed',
      fieldName: previousField.name,
      option,
    });
  }
}

function compareField(
  changes: TrackerSchemaChange[],
  previous: TrackerDataModel,
  next: TrackerDataModel,
  previousField: FieldDefinition,
  nextField: FieldDefinition,
): void {
  if (previousField.type !== nextField.type) {
    // Every type change is destructive: there is no safe-widening lattice over
    // FieldType, so no pair can be proven lossless. Do not special-case a
    // "widening" here (number->string, select->multiselect, …) without first
    // defining that lattice and the value coercion that goes with it.
    changes.push({
      kind: 'field-type-changed',
      fieldName: previousField.name,
      previousType: previousField.type,
      nextType: nextField.type,
    });
  }

  compareOptions(changes, previous, next, previousField, nextField);

  for (const rule of CONSTRAINT_RULES) {
    const previousValue = rule.read(previousField);
    const nextValue = rule.read(nextField);
    const direction = rule.direction(previousValue, nextValue);
    if (direction === 'unchanged') continue;
    changes.push({
      kind: direction === 'widened' ? 'constraint-widened' : 'constraint-narrowed',
      fieldName: previousField.name,
      constraint: rule.constraint,
      previousValue,
      nextValue,
    });
  }

  if (
    stableValue(unclassifiedDefinition(previousField)) !==
    stableValue(unclassifiedDefinition(nextField))
  ) {
    changes.push({
      kind: 'field-definition-changed',
      fieldName: previousField.name,
      previousField,
      nextField,
    });
  }
}

function findRenameCandidates(
  removedFields: FieldDefinition[],
  addedFields: FieldDefinition[],
): TrackerSchemaRenameCandidate[] {
  const candidates: TrackerSchemaRenameCandidate[] = [];
  for (const previousField of removedFields) {
    for (const nextField of addedFields) {
      const exactDefinition = definitionsMatch(previousField, nextField);
      if (!exactDefinition && previousField.type !== nextField.type) continue;
      candidates.push({
        previousFieldName: previousField.name,
        nextFieldName: nextField.name,
        match: exactDefinition ? 'exact-definition' : 'compatible-type',
      });
    }
  }
  return candidates;
}

/**
 * Classify data-bearing differences between two resolved tracker schemas.
 * A remove-plus-add is reported as exactly that, with any plausible rename
 * surfaced separately in `renameCandidates` — the classifier never guesses that
 * a rename happened, because guessing wrong migrates values onto the wrong field.
 */
export function classifyTrackerSchemaChanges(
  previous: TrackerDataModel,
  next: TrackerDataModel,
): TrackerSchemaChangeClassification {
  if (previous.type !== next.type) {
    throw new Error(
      `Cannot compare tracker schemas with different types: '${previous.type}' and '${next.type}'`,
    );
  }

  const changes: TrackerSchemaChange[] = [];
  const { entries, removed: removedFields } = diffTrackerFields(previous, next);
  const addedFields = entries.filter((entry) => !entry.seed).map((entry) => entry.target);

  for (const field of addedFields) {
    changes.push({ kind: 'field-added', fieldName: field.name, field });
  }
  for (const field of removedFields) {
    changes.push({ kind: 'field-removed', fieldName: field.name, field });
  }
  for (const entry of entries) {
    if (entry.seed) compareField(changes, previous, next, entry.seed, entry.target);
  }

  if (!previous.roles?.workflowStatus && next.roles?.workflowStatus) {
    changes.push({ kind: 'workflow-status-field-assigned', nextFieldName: next.roles.workflowStatus });
  } else if (previous.roles?.workflowStatus !== next.roles?.workflowStatus) {
    changes.push({
      kind: 'workflow-status-field-changed',
      previousFieldName: previous.roles?.workflowStatus,
      nextFieldName: next.roles?.workflowStatus,
    });
  }

  return {
    classification: changes.some(isDestructiveTrackerSchemaChange)
      ? 'destructive'
      : changes.length > 0
        ? 'additive'
        : 'none',
    changes,
    renameCandidates: findRenameCandidates(removedFields, addedFields),
  };
}

/**
 * Ask a caller-owned data source for the impact of each destructive change.
 * The classifier remains independent of item storage and database backends.
 */
export async function calculateTrackerSchemaBlastRadius(
  classification: TrackerSchemaChangeClassification,
  countAffectedItems: TrackerSchemaAffectedItemCounter,
): Promise<TrackerSchemaBlastRadiusEntry[]> {
  return Promise.all(
    destructiveTrackerSchemaChanges(classification.changes).map(async (change) => ({
      change,
      affectedItemCount: await countAffectedItems(change),
    })),
  );
}

// ---------------------------------------------------------------------------
// The gate: who may apply which verdict, stated once
// ---------------------------------------------------------------------------

/**
 * D3: anyone can add, admins can remove or rename. The split lands on the same
 * line as the safety evidence — an additive change provably cannot invalidate a
 * teammate's data, a destructive one can.
 */
export type TrackerSchemaActorRole = 'admin' | 'member';

/** A remove-plus-add the caller states outright, so it stops reading as a removal. */
export interface TrackerSchemaRenameIntent {
  previousFieldName: string;
  nextFieldName: string;
}

export interface TrackerSchemaChangeGateInput {
  classification: TrackerSchemaChangeClassification;
  /** Only a team tracker has other people's data behind it. */
  sharing: TrackerSharing | undefined;
  actorRole: TrackerSchemaActorRole;
  /** The caller showed the blast radius and the user approved it. */
  confirmed: boolean;
}

export type TrackerSchemaChangeGateVerdict =
  | { allowed: true; reason: 'no-change' | 'additive' | 'confirmed' }
  | {
      allowed: false;
      /**
       * `requires-admin` outranks `needs-confirmation`: a member's approval is
       * not the approval that was missing, so telling them to confirm would send
       * them round a loop they cannot exit.
       */
      reason: 'needs-confirmation' | 'requires-admin';
      blocking: DestructiveTrackerSchemaChange[];
    };

/**
 * The one statement of the rule every write path gates on.
 *
 * Additive and no-change pass unconditionally — no role check, no confirmation,
 * no friction. That is not an oversight to be tightened later: additive edits are
 * the majority of real schema work and are provably safe (unknown fields are
 * preserved byte-for-byte and simply do not render, a removed status is retained
 * as an extra column). Adding ceremony here makes the common case worse for no
 * safety gain.
 */
export function resolveTrackerSchemaChangeGate(
  input: TrackerSchemaChangeGateInput,
): TrackerSchemaChangeGateVerdict {
  const { classification, sharing, actorRole, confirmed } = input;
  if (classification.classification === 'none') return { allowed: true, reason: 'no-change' };
  if (classification.classification === 'additive') return { allowed: true, reason: 'additive' };

  const blocking = destructiveTrackerSchemaChanges(classification.changes);
  if (sharing === 'team' && actorRole !== 'admin') {
    return { allowed: false, reason: 'requires-admin', blocking };
  }
  if (!confirmed) return { allowed: false, reason: 'needs-confirmation', blocking };
  return { allowed: true, reason: 'confirmed' };
}

// ---------------------------------------------------------------------------
// Blast radius and confirmation copy
// ---------------------------------------------------------------------------

function itemsHave(count: number, fieldName: string): string {
  return count === 1 ? `1 item has \`${fieldName}\`` : `${count} items have \`${fieldName}\``;
}

/** `7 items have \`severity\`` / `3 are in \`blocked\`` — one clause per change. */
function describeBlastRadiusEntry(entry: TrackerSchemaBlastRadiusEntry): string | null {
  const { change, affectedItemCount: count } = entry;
  switch (change.kind) {
    case 'field-removed':
    case 'field-type-changed':
    case 'constraint-narrowed':
    case 'field-definition-changed':
      return itemsHave(count, change.fieldName);
    case 'status-removed':
      return count === 1
        ? `1 is in \`${change.option.value}\``
        : `${count} are in \`${change.option.value}\``;
    case 'select-option-removed':
      return count === 1
        ? `1 uses \`${change.option.value}\``
        : `${count} use \`${change.option.value}\``;
    case 'workflow-status-field-changed':
      if (!change.previousFieldName) return null;
      return itemsHave(count, change.previousFieldName);
  }
}

/**
 * The sentence the confirm leads with, e.g.
 * `7 items have \`severity\`; 3 are in \`blocked\`.`
 *
 * A zero count still gets a clause. "No items have `severity`" is the answer to
 * the question the user is actually asking, and silence reads as "we didn't check".
 */
export function describeTrackerSchemaBlastRadius(
  entries: readonly TrackerSchemaBlastRadiusEntry[],
): string {
  const clauses = entries
    .map((entry) => describeBlastRadiusEntry(entry))
    .filter((clause): clause is string => clause !== null)
    .map((clause) => clause.replace(/^0 items/, 'No items').replace(/^0 (are|use)\b/, 'None $1'));
  if (clauses.length === 0) return 'No items are affected.';
  const sentence = clauses.join('; ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

export interface TrackerSchemaChangeOption {
  /** Stable id the confirm surface echoes back with the write. */
  id: string;
  kind: 'rename' | 'retire';
  label: string;
  description: string;
  rename?: TrackerSchemaRenameIntent;
}

export interface TrackerSchemaDestructiveConfirmCopy {
  title: string;
  /** {@link describeTrackerSchemaBlastRadius} over the same entries. */
  blastRadius: string;
  message: string;
  /**
   * Rename first, always. A remove-plus-add is indistinguishable from a rename
   * without stated intent, and the user is the only one who holds that intent —
   * so the option that captures it has to be the one they see first, not one
   * they discover after choosing wrong.
   */
  options: TrackerSchemaChangeOption[];
  confirmLabel: string;
}

/**
 * `exact-definition` candidates first: a field whose whole definition survived
 * under a new name is far likelier to be the rename the user meant than one that
 * merely shares a type.
 */
function orderedRenameCandidates(
  candidates: readonly TrackerSchemaRenameCandidate[],
): TrackerSchemaRenameCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.match === right.match) return 0;
    return left.match === 'exact-definition' ? -1 : 1;
  });
}

export function describeTrackerSchemaDestructiveChange(input: {
  displayNamePlural: string;
  sharing: TrackerSharing | undefined;
  teamName?: string | null;
  blastRadius: readonly TrackerSchemaBlastRadiusEntry[];
  renameCandidates: readonly TrackerSchemaRenameCandidate[];
}): TrackerSchemaDestructiveConfirmCopy {
  const { displayNamePlural, sharing, teamName, blastRadius, renameCandidates } = input;
  const isTeam = sharing === 'team';
  const removedFields = blastRadius
    .map((entry) => entry.change)
    .filter((change) => change.kind === 'field-removed')
    .map((change) => change.fieldName);

  const options: TrackerSchemaChangeOption[] = orderedRenameCandidates(renameCandidates).map(
    (candidate) => ({
      id: `rename:${candidate.previousFieldName}->${candidate.nextFieldName}`,
      kind: 'rename' as const,
      label: `Rename \`${candidate.previousFieldName}\` → \`${candidate.nextFieldName}\` (keeps values)`,
      description:
        `Records this as one rename rather than a removal and an addition. ` +
        `The values already stored under \`${candidate.previousFieldName}\` stay in your items.`,
      rename: {
        previousFieldName: candidate.previousFieldName,
        nextFieldName: candidate.nextFieldName,
      },
    }),
  );

  options.push({
    id: 'retire',
    kind: 'retire',
    label: removedFields.length
      ? `Retire ${removedFields.map((name) => `\`${name}\``).join(', ')}`
      : 'Apply the change',
    description: removedFields.length
      ? 'The field stops appearing on forms and in the table. Its values stay in your items; nothing is deleted.'
      : 'The schema changes. No item data is deleted.',
  });

  return {
    title: isTeam
      ? `Change ${displayNamePlural} for ${teamName?.trim() || 'your team'}?`
      : `Change ${displayNamePlural}?`,
    blastRadius: describeTrackerSchemaBlastRadius(blastRadius),
    message: isTeam
      ? `This tracker is your team's, so this changes it for everyone. Nothing is deleted: values already in items are kept and simply stop being shown.`
      : `Nothing is deleted: values already in items are kept and simply stop being shown.`,
    options,
    confirmLabel: 'Apply change',
  };
}
