/**
 * Classify the difference between two predicate registries as additive (safe,
 * applies instantly) or destructive (needs a confirm carrying a blast radius).
 *
 * Contract 4.1: "additive versus destructive classification applies to registry
 * changes exactly as to type schemas". This module is the registry half of
 * `./trackerSchemaChangeClassifier.ts` and follows its rule verbatim: anything
 * that is not a PROVEN widening is destructive. A wrong "additive" silently
 * invalidates statements already written on teammates' items; a wrong
 * "destructive" costs a confirm click.
 *
 * Deliberately a sibling module rather than a branch inside the schema
 * classifier. The two diff different artifacts against different rules and
 * share only the verdict vocabulary; folding them together would mean one
 * function whose `previous` and `next` are sometimes a model and sometimes a
 * registry, which is how a rule gets applied to the wrong shape.
 *
 * Presentation is never a change: `label` and `inverseLabel` classify as
 * nothing, exactly as field labels, colors, and icons do on a type schema.
 *
 * The cases that break existing data are destructive, each for a reason that
 * names what breaks:
 *
 *  - **Removing a predicate.** Every field declaring it stops validating and
 *    every statement written under it loses the contract it was written to.
 *  - **Narrowing `subjectKinds`.** A type that was a legal subject no longer
 *    is, so its existing statements are now unauthorized by the registry.
 *  - **Narrowing `objectKinds`.** Same on the target side: links to a type the
 *    predicate used to accept now point at a disallowed object. An absent
 *    `objectKinds` accepts any type, so adding one is a narrowing.
 */

import type { PredicateDefinition } from './predicateRegistry.js';

interface PredicateChange {
  predicateId: string;
}

export type AdditivePredicateRegistryChange =
  | (PredicateChange & { kind: 'predicate-added'; predicate: PredicateDefinition })
  | (PredicateChange & {
      kind: 'subject-kinds-widened';
      previousValue: string[];
      nextValue: string[];
    })
  | (PredicateChange & {
      /** Values are normalized: an absent `objectKinds` reads as `['*']`. */
      kind: 'object-kinds-widened';
      previousValue: string[];
      nextValue: string[];
    });

export type DestructivePredicateRegistryChange =
  | (PredicateChange & { kind: 'predicate-removed'; predicate: PredicateDefinition })
  | (PredicateChange & {
      kind: 'subject-kinds-narrowed';
      previousValue: string[];
      nextValue: string[];
    })
  | (PredicateChange & {
      /** Values are normalized: an absent `objectKinds` reads as `['*']`. */
      kind: 'object-kinds-narrowed';
      previousValue: string[];
      nextValue: string[];
    })
  | (PredicateChange & {
      kind: 'value-shape-changed';
      previousValue: string;
      nextValue: string;
    })
  | (PredicateChange & {
      kind: 'direction-changed';
      previousValue: string;
      nextValue: string;
    });

export type PredicateRegistryChange =
  | AdditivePredicateRegistryChange
  | DestructivePredicateRegistryChange;

/**
 * Keyed by kind so adding a variant to {@link DestructivePredicateRegistryChange}
 * without listing it here is a compile error rather than a change that silently
 * classifies as additive. Same guard as the schema classifier's.
 */
const DESTRUCTIVE_CHANGE_KINDS: Record<DestructivePredicateRegistryChange['kind'], true> = {
  'predicate-removed': true,
  'subject-kinds-narrowed': true,
  'object-kinds-narrowed': true,
  'value-shape-changed': true,
  'direction-changed': true,
};

export function isDestructivePredicateRegistryChange(
  change: PredicateRegistryChange,
): change is DestructivePredicateRegistryChange {
  return change.kind in DESTRUCTIVE_CHANGE_KINDS;
}

export function destructivePredicateRegistryChanges(
  changes: readonly PredicateRegistryChange[],
): DestructivePredicateRegistryChange[] {
  return changes.filter(isDestructivePredicateRegistryChange);
}

export interface PredicateRegistryChangeClassification {
  /** The verdict a write path gates on; stated once here, not re-derived per caller. */
  classification: 'none' | 'additive' | 'destructive';
  changes: PredicateRegistryChange[];
}

function byId(predicates: readonly PredicateDefinition[]): Map<string, PredicateDefinition> {
  return new Map(predicates.map(predicate => [predicate.id, predicate]));
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

/** An absent `objectKinds`, like `['*']`, accepts any type. */
function normalizedObjectKinds(predicate: PredicateDefinition): string[] {
  const kinds = predicate.objectKinds;
  return !kinds || kinds.includes('*') ? ['*'] : [...kinds];
}

/** A widening: every kind the old list accepted is still accepted. */
function isKindsWidening(previous: readonly string[], next: readonly string[]): boolean {
  if (next.includes('*')) return true;
  if (previous.includes('*')) return false;
  return previous.every(kind => next.includes(kind));
}

/**
 * Classify the data-bearing differences between two predicate registries.
 *
 * Both inputs are the VALIDATED form. Classifying an unvalidated registry would
 * compare against declarations that may never have been accepted, which reports
 * a change nobody made.
 */
export function classifyPredicateRegistryChanges(
  previous: readonly PredicateDefinition[],
  next: readonly PredicateDefinition[],
): PredicateRegistryChangeClassification {
  const previousById = byId(previous);
  const nextById = byId(next);
  const changes: PredicateRegistryChange[] = [];

  for (const [id, predicate] of previousById) {
    if (!nextById.has(id)) {
      changes.push({ kind: 'predicate-removed', predicateId: id, predicate });
    }
  }

  for (const [id, predicate] of nextById) {
    const before = previousById.get(id);
    if (!before) {
      changes.push({ kind: 'predicate-added', predicateId: id, predicate });
      continue;
    }
    comparePredicate(before, predicate, changes);
  }

  const destructive = changes.some(isDestructivePredicateRegistryChange);
  return {
    classification: changes.length === 0 ? 'none' : destructive ? 'destructive' : 'additive',
    changes,
  };
}

function comparePredicate(
  previous: PredicateDefinition,
  next: PredicateDefinition,
  changes: PredicateRegistryChange[],
): void {
  const predicateId = next.id;

  if (previous.valueShape !== next.valueShape) {
    changes.push({
      kind: 'value-shape-changed',
      predicateId,
      previousValue: previous.valueShape,
      nextValue: next.valueShape,
    });
  }

  if (previous.direction !== next.direction) {
    // Flipping directed to symmetric (or back) re-reads every edge already
    // stored under this predicate as saying something it did not say.
    changes.push({
      kind: 'direction-changed',
      predicateId,
      previousValue: previous.direction,
      nextValue: next.direction,
    });
  }

  if (stableValue(previous.subjectKinds) !== stableValue(next.subjectKinds)) {
    changes.push(
      isKindsWidening(previous.subjectKinds, next.subjectKinds)
        ? {
            kind: 'subject-kinds-widened',
            predicateId,
            previousValue: [...previous.subjectKinds],
            nextValue: [...next.subjectKinds],
          }
        : {
            kind: 'subject-kinds-narrowed',
            predicateId,
            previousValue: [...previous.subjectKinds],
            nextValue: [...next.subjectKinds],
          },
    );
  }

  const previousObjectKinds = normalizedObjectKinds(previous);
  const nextObjectKinds = normalizedObjectKinds(next);
  if (stableValue(previousObjectKinds) !== stableValue(nextObjectKinds)) {
    changes.push({
      kind: isKindsWidening(previousObjectKinds, nextObjectKinds) ? 'object-kinds-widened' : 'object-kinds-narrowed',
      predicateId,
      previousValue: previousObjectKinds,
      nextValue: nextObjectKinds,
    });
  }
}
