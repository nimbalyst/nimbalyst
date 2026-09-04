/**
 * Read-time conflict resolution.
 *
 * v1 resolved contradictions by file mtime at read time and reported nothing.
 * That is the weakest part of the shipped system for a reason that is easy to
 * miss: recency-wins does not merely pick badly sometimes, it *discards the
 * material history is made of*. If the only record of "B replaced A" is that B
 * happens to be newer, there is no timeline to render, no supersede link to
 * follow, and no way to answer "what did we believe last quarter".
 *
 * The order below is fixed and each step is strictly stronger than the next:
 *
 *   1. **Explicit `supersedes`** — a human or a dedup verdict said so.
 *   2. **The `validTo` / `expiresAt` window** — the page states when it stopped
 *      being true.
 *   3. **Recency** — a last resort within a group of pages that only know they
 *      overlap.
 *
 * A stronger step wins outright: a page that is both explicitly superseded and
 * out of its window is reported as `superseded` with the id that replaced it,
 * because that is the answer a reader can act on. The window is what a page
 * says about itself; a link is what the system decided.
 *
 * **Never silent** is the other half. Nothing is dropped without a reason and,
 * where one exists, the id of the record that beat it. The timeline, the
 * conflicts view, and "why did recall not return this?" all read the same
 * `suppressed` list; if a caller only wants the survivors it takes `.active`
 * and pays nothing for the rest.
 *
 * `status` is deliberately NOT an input to steps 1–3. It is a persisted
 * projection of this computation and can be stale — a record marked
 * `superseded` whose superseder was later deleted should come back. Only the
 * lifecycle states that are nobody's conclusion (`archived`, `candidate`) are
 * read from `status`.
 */
import type { MemoryRecord } from './types.js';

export type MemorySuppressionReason =
  /** Tombstoned. */
  | 'deleted'
  /** Retired by hand; not a conflict outcome. */
  | 'archived'
  /** Still in the review queue, not yet part of memory. */
  | 'candidate'
  /** Step 1: another live record explicitly supersedes this one. */
  | 'superseded'
  /** Step 2: `validTo` or `expiresAt` has passed. */
  | 'expired'
  /** Step 2: `validFrom` is in the future. */
  | 'not-yet-valid'
  /** Step 3: lost to a newer record it was linked to as a duplicate. */
  | 'outdated';

export interface SuppressedMemory {
  record: MemoryRecord;
  reason: MemorySuppressionReason;
  /** factId of the record that won, when one did. Absent for `expired`,
   * `archived`, `candidate`, `deleted` and `not-yet-valid`, which are
   * properties of the record itself rather than of a comparison. */
  by?: string;
}

export interface ResolvedMemories {
  /** Live memory, in the caller's input order. */
  active: MemoryRecord[];
  /** Everything excluded, each with why and by what. */
  suppressed: SuppressedMemory[];
}

export interface ResolveOptions {
  /** Evaluation instant, epoch millis. Defaults to now. */
  now?: number;
}

/** Parse an ISO timestamp to millis; unparseable or absent yields null so a
 * malformed date can never silently read as "1970" and expire a page. */
function millis(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Order within a duplicate group: newest `validFrom` wins, then newest
 * `createdAt`, then `factId` so the result never depends on input order.
 */
function newerFirst(a: MemoryRecord, b: MemoryRecord): number {
  const av = millis(a.validFrom) ?? millis(a.createdAt) ?? 0;
  const bv = millis(b.validFrom) ?? millis(b.createdAt) ?? 0;
  if (av !== bv) return bv - av;
  const ac = millis(a.createdAt) ?? 0;
  const bc = millis(b.createdAt) ?? 0;
  if (ac !== bc) return bc - ac;
  return a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0;
}

export function resolveMemories(
  records: readonly MemoryRecord[],
  options: ResolveOptions = {}
): ResolvedMemories {
  const now = options.now ?? Date.now();
  const suppressed: SuppressedMemory[] = [];
  const reasonOf = new Map<string, SuppressedMemory>();

  const suppress = (record: MemoryRecord, reason: MemorySuppressionReason, by?: string): void => {
    if (reasonOf.has(record.factId)) return; // first (strongest) step wins
    const entry: SuppressedMemory = by ? { record, reason, by } : { record, reason };
    reasonOf.set(record.factId, entry);
    suppressed.push(entry);
  };

  // Step 0 — lifecycle. Not conflict resolution; these records are simply not
  // part of live memory, and a superseder that is itself deleted or archived
  // must not go on to retire anything below.
  for (const record of records) {
    if (record.deletedAt) suppress(record, 'deleted');
    else if (record.status === 'archived') suppress(record, 'archived');
    else if (record.status === 'candidate') suppress(record, 'candidate');
  }

  const live = records.filter((r) => !reasonOf.has(r.factId));
  const byId = new Map(live.map((r) => [r.factId, r]));

  // Step 1 — explicit supersedes. Evaluated before the window on purpose: the
  // superseder's own validity is irrelevant to whether the link holds. "A was
  // replaced by B" stays true even once B has itself expired, and reporting
  // that as a bare `expired` would lose the link the history view is built on.
  for (const record of live) {
    for (const targetId of record.supersedes) {
      const target = byId.get(targetId);
      if (target && target.factId !== record.factId) {
        suppress(target, 'superseded', record.factId);
      }
    }
  }

  // Step 2 — the bi-temporal window, plus expiry.
  for (const record of live) {
    if (reasonOf.has(record.factId)) continue;
    const from = millis(record.validFrom);
    if (from !== null && from > now) {
      suppress(record, 'not-yet-valid');
      continue;
    }
    const to = millis(record.validTo);
    const expires = millis(record.expiresAt);
    const end = to !== null && expires !== null ? Math.min(to, expires) : (to ?? expires);
    if (end !== null && end <= now) suppress(record, 'expired');
  }

  // Step 3 — recency, and only within a group of records that told us they
  // overlap. Recency across unrelated memories would be nonsense: an old
  // `constraint` does not lose to an unrelated `fact` written this morning.
  const surviving = live.filter((r) => !reasonOf.has(r.factId));
  for (const group of duplicateGroups(surviving)) {
    if (group.length < 2) continue;
    const [winner, ...rest] = [...group].sort(newerFirst);
    for (const loser of rest) suppress(loser, 'outdated', winner.factId);
  }

  return {
    active: records.filter((r) => !reasonOf.has(r.factId)),
    suppressed,
  };
}

/**
 * Connected components over `duplicates` edges, treated as undirected: if A
 * lists B, they are in the same group whether or not B lists A back. A
 * one-sided link is the normal case, because dedup writes the link from the
 * incoming page onto the existing one it matched.
 */
function duplicateGroups(records: readonly MemoryRecord[]): MemoryRecord[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string): void => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };

  const present = new Set(records.map((r) => r.factId));
  for (const r of records) parent.set(r.factId, r.factId);
  for (const r of records) {
    for (const other of r.duplicates) {
      if (present.has(other)) union(r.factId, other);
    }
  }

  const groups = new Map<string, MemoryRecord[]>();
  for (const r of records) {
    const root = find(r.factId);
    const bucket = groups.get(root);
    if (bucket) bucket.push(r);
    else groups.set(root, [r]);
  }
  return [...groups.values()];
}
