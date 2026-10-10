/**
 * Reconcile a peer's local predicate registry with the one the room publishes.
 *
 * The schema lane's rule for a tracker type is "the room's newer version wins,
 * and a local edit the room has not seen yet is pushed after bootstrap". For a
 * type that rule is safe because the local edit is one whole definition that is
 * still queued. The registry is different: it is ONE artifact holding many
 * predicates, and the local copy is a machine-local file (`.nimbalyst/` is
 * gitignored) that can carry verbs the room has never seen -- on the machine
 * that first defined them, it is the only copy. Replacing it wholesale with the room's copy would erase
 * those without a trace, which is the thing NIM-6653 must not do.
 *
 * So the registry merges per predicate against a baseline -- the room registry
 * this peer last applied:
 *
 *  - untouched locally (equal to the baseline): the room's version, including
 *    the room deleting it;
 *  - added or changed locally, and the room did not change it: the local one,
 *    which the caller then pushes;
 *  - changed on both sides: the room's version wins, as it does for a type, and
 *    the id is reported so the caller can log what it overrode. The room
 *    deleting a predicate this peer edited counts as changed on both sides;
 *  - deleted locally, and the room did not change it: stays deleted.
 *
 * With no baseline (a peer that has never applied a room registry), every local
 * predicate the room lacks counts as a local addition, so a first sync is the
 * union rather than a replacement.
 */

import type { PredicateDefinition } from '@nimbalyst/tracker-schema';

export interface PredicateRegistryMergeResult {
  merged: PredicateDefinition[];
  /** Local predicates kept over (or in the absence of) the room's copy. */
  keptLocal: string[];
  /** Local changes the room's newer version replaced. */
  overriddenLocal: string[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = canonicalize(entry);
    }
    return out;
  }
  return value;
}

/** Order- and key-order-insensitive identity for a registry. */
export function canonicalPredicateRegistryJson(predicates: readonly PredicateDefinition[]): string {
  const sorted = [...predicates].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(canonicalize(sorted));
}

function samePredicate(a: PredicateDefinition | undefined, b: PredicateDefinition | undefined): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function byId(predicates: readonly PredicateDefinition[] | null): Map<string, PredicateDefinition> {
  return new Map((predicates ?? []).map(p => [p.id, p]));
}

export function mergePredicateRegistries(input: {
  baseline: readonly PredicateDefinition[] | null;
  local: readonly PredicateDefinition[];
  remote: readonly PredicateDefinition[];
}): PredicateRegistryMergeResult {
  const baseline = byId(input.baseline);
  const local = byId(input.local);
  const merged = byId(input.remote);
  const keptLocal: string[] = [];
  const overriddenLocal: string[] = [];

  for (const [id, mine] of local) {
    const base = baseline.get(id);
    if (samePredicate(mine, base)) continue;
    const theirs = merged.get(id);
    if (samePredicate(mine, theirs)) continue;
    // Absent in the room: a local addition only when the baseline never had it.
    // With a baseline entry, absence is the room's deletion, and it wins.
    const roomUnchanged = theirs === undefined ? base === undefined : samePredicate(theirs, base);
    if (roomUnchanged) {
      merged.set(id, mine);
      keptLocal.push(id);
    } else {
      overriddenLocal.push(id);
    }
  }

  for (const [id, base] of baseline) {
    if (local.has(id)) continue;
    if (samePredicate(merged.get(id), base)) merged.delete(id);
  }

  return { merged: [...merged.values()], keptLocal, overriddenLocal };
}
