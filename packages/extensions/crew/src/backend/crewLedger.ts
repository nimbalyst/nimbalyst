/**
 * Crew's token ledger: the exact, timestamped usage history the budget caps
 * read. The host persists only a lifetime usage snapshot per session, so the
 * ledger is built by diffing consecutive snapshots of the same session and
 * appending each positive delta with a time.
 *
 * Two paths feed it through the same diff: every settle event (chapters and
 * delegated sessions alike) and a reconcile against `getUsage` at shift start,
 * which catches sessions that settled while the project was closed or never
 * settle again. A late delta is attributed late, never lost.
 *
 * The ledger is a file in the extension's data dir, not a table. It knows when
 * it started; a budget window reaching back before that is answered from the
 * host's session-granular totals instead and labeled as an estimate.
 */

import type { CrewUsageSource } from '../shared/types';

const DAY_MS = 24 * 60 * 60_000;
/** Entries older than this cannot affect a seven-day window. */
export const LEDGER_RETENTION_MS = 8 * DAY_MS;

/**
 * What a token count measures. `all`: input + output + cache reads + cache
 * writes (the host's `allTokens`), which budgets use. `total`: input + output
 * only, the basis of ledgers written before cache tokens were reported; rows
 * without a `basis` field are this.
 */
export type LedgerBasis = 'all' | 'total';

export interface LedgerSnapshot {
  key: string;
  /** The session's lifetime tokens on `basis` (the field name predates `basis`). */
  totalTokens: number;
  atMs: number;
  basis?: LedgerBasis;
}

export interface LedgerEntry {
  atMs: number;
  key: string;
  sessionId: string;
  tokens: number;
  basis?: LedgerBasis;
}

export interface LedgerData {
  version: 1;
  startedAtMs: number;
  snapshots: Record<string, LedgerSnapshot>;
  entries: LedgerEntry[];
}

export function emptyLedger(nowMs: number): LedgerData {
  return { version: 1, startedAtMs: nowMs, snapshots: {}, entries: [] };
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function validSnapshot(value: unknown): value is LedgerSnapshot {
  const snapshot = value as Partial<LedgerSnapshot> | null;
  return !!snapshot && typeof snapshot.key === 'string' && isCount(snapshot.totalTokens) && isCount(snapshot.atMs);
}

/**
 * Validates a parsed ledger file; null when the file is not one this version
 * wrote. Individual entries and snapshots that are not numeric are dropped
 * (`dropped` counts them so the caller can log it) rather than letting one bad
 * value turn a subtraction into NaN. A session whose snapshot was dropped is
 * re-baselined from what the ledger already charged it (see recordSnapshot).
 */
export function parseLedger(value: unknown, dropped?: { count: number }): LedgerData | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Partial<LedgerData>;
  if (data.version !== 1 || !isCount(data.startedAtMs)) return null;
  if (!data.snapshots || typeof data.snapshots !== 'object' || !Array.isArray(data.entries)) return null;
  const entries = data.entries.filter((entry): entry is LedgerEntry =>
    !!entry && isCount(entry.atMs) && typeof entry.key === 'string'
    && typeof entry.sessionId === 'string' && isCount(entry.tokens));
  const snapshots: Record<string, LedgerSnapshot> = {};
  let droppedSnapshots = 0;
  for (const [sessionId, snapshot] of Object.entries(data.snapshots)) {
    if (validSnapshot(snapshot)) snapshots[sessionId] = snapshot;
    else droppedSnapshots += 1;
  }
  if (dropped) dropped.count = data.entries.length - entries.length + droppedSnapshots;
  return { version: 1, startedAtMs: data.startedAtMs, snapshots, entries };
}

/**
 * Records a session's lifetime all-tokens total. Appends the growth since the
 * last snapshot, stamped at `atMs`. A total lower than the last snapshot (a
 * reset on the host) becomes the new baseline without charging anything. A
 * total that is not a finite, non-negative number is ignored. Returns whether
 * anything changed.
 *
 * Mixed bases: entries recorded on the old `total` basis stay in the sums as
 * they are. A `total`-basis snapshot is not a baseline for an all-tokens
 * total (the difference is mostly the session's past cache reads, already
 * spent under the old accounting), so the first all-tokens total re-baselines
 * that session without charging.
 */
export function recordSnapshot(
  ledger: LedgerData,
  input: { sessionId: string; key: string; tokens: number; atMs: number },
): boolean {
  if (!isCount(input.tokens) || !isCount(input.atMs)) return false;
  const stored = ledger.snapshots[input.sessionId];
  if (stored && (stored.basis ?? 'total') !== 'all') {
    ledger.snapshots[input.sessionId] = { key: input.key, totalTokens: input.tokens, atMs: input.atMs, basis: 'all' };
    return true;
  }
  const previous = stored;
  if (previous && previous.totalTokens === input.tokens) return false;
  // No baseline (first sight, or a snapshot dropped as malformed): what the
  // ledger already charged this session is the one earlier total it can prove,
  // so only growth beyond that is charged. That never double-charges; it can
  // over-charge a session older than the ledger, which errs toward the budget.
  const baseline = previous?.totalTokens
    ?? ledger.entries.reduce((sum, entry) => (entry.sessionId === input.sessionId && entry.basis === 'all' ? sum + entry.tokens : sum), 0);
  const delta = input.tokens - baseline;
  if (delta > 0) {
    ledger.entries.push({ atMs: input.atMs, key: input.key, sessionId: input.sessionId, tokens: delta, basis: 'all' });
  }
  ledger.snapshots[input.sessionId] = { key: input.key, totalTokens: input.tokens, atMs: input.atMs, basis: 'all' };
  return true;
}

export function pruneLedger(ledger: LedgerData, nowMs: number): void {
  const cutoff = nowMs - LEDGER_RETENTION_MS;
  ledger.entries = ledger.entries.filter((entry) => entry.atMs >= cutoff);
}

/** Tokens charged at or after `sinceMs`, for one key or the whole crew. */
export function ledgerSum(ledger: LedgerData, sinceMs: number, key?: string): number {
  let sum = 0;
  for (const entry of ledger.entries) {
    if (entry.atMs >= sinceMs && (key === undefined || entry.key === key)) sum += entry.tokens;
  }
  return sum;
}

/** Whether the ledger can answer a window starting at `sinceMs` exactly. */
export function ledgerCovers(ledger: LedgerData | null, sinceMs: number): boolean {
  return ledger !== null && ledger.startedAtMs <= sinceMs;
}

export function usageSourceFor(covered: boolean): CrewUsageSource {
  return covered ? 'ledger' : 'session-estimate';
}
