/** Personal-sync writes require a complete index read and a supported client.
 * Unreadable rows are skipped, never deleted, and do not prevent publication.
 */

export type PersonalSyncWriteGateState = 'unverified' | 'verified' | 'blocked';

export type PersonalSyncBlockReason = 'update-required';

export interface PersonalSyncWriteGateSnapshot {
  state: PersonalSyncWriteGateState;
  reason: PersonalSyncBlockReason | null;
  /** Bounded, non-sensitive explanation of the current block, for logs and status. */
  detail: string | null;
  skippedRowCount?: number;
}

export interface PersonalSyncWriteGate {
  snapshot(): PersonalSyncWriteGateSnapshot;
  canWrite(): boolean;
  /** A complete index read, including unreadable rows covered by the cursor. */
  markVerified(skippedRowCount?: number): void;
  setSkippedRowCount(count: number): void;
  markBlocked(reason: PersonalSyncBlockReason, detail: string): void;
  /** Fires only when the snapshot actually changes. */
  onChange(listener: (snapshot: PersonalSyncWriteGateSnapshot) => void): () => void;
}

const MAX_DETAIL_LENGTH = 300;

export function createPersonalSyncWriteGate(): PersonalSyncWriteGate {
  let current: PersonalSyncWriteGateSnapshot = { state: 'unverified', reason: null, detail: null };
  const listeners = new Set<(snapshot: PersonalSyncWriteGateSnapshot) => void>();

  function transition(next: PersonalSyncWriteGateSnapshot): void {
    if (next.state === current.state && next.reason === current.reason && next.detail === current.detail && next.skippedRowCount === current.skippedRowCount) return;
    current = next;
    for (const listener of Array.from(listeners)) {
      try {
        listener(current);
      } catch (err) {
        console.error('[PersonalSyncWriteGate] Listener failed:', err);
      }
    }
  }

  return {
    snapshot: () => current,
    canWrite: () => current.state === 'verified',
    markVerified(skippedRowCount = 0) {
      // The server's refusal is about this build, not this key; a clean read
      // says nothing about whether writes would now be accepted.
      if (current.state === 'blocked' && current.reason === 'update-required') return;
      transition({ state: 'verified', reason: null, detail: null, skippedRowCount: boundSkippedRowCount(skippedRowCount) });
    },
    setSkippedRowCount(count) {
      transition({ ...current, skippedRowCount: boundSkippedRowCount(count) });
    },
    markBlocked(reason, detail) {
      transition({ ...current, state: 'blocked', reason, detail: detail.slice(0, MAX_DETAIL_LENGTH) });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * User-facing sentence for a blocked gate, or null when nothing needs saying.
 * Shown verbatim in the sync status row, so it has to say what is true without
 * promising a recovery the product does not have yet.
 */
export function describePersonalSyncWriteGate(snapshot: PersonalSyncWriteGateSnapshot): string | null {
  if (snapshot.state !== 'blocked') return null;
  if (snapshot.reason === 'update-required') {
    return snapshot.detail
      ? `Update Nimbalyst to resume session sync. ${snapshot.detail}`
      : 'Update Nimbalyst to resume session sync. The sync server no longer accepts session writes from this version.';
  }
  return null;
}

export function boundSkippedRowCount(count: number): number {
  return Number.isFinite(count) ? Math.min(999_999, Math.max(0, Math.floor(count))) : 0;
}

export function describeSkippedSyncRows(count: number): string | null {
  const bounded = boundSkippedRowCount(count);
  return bounded > 0
    ? `${bounded} synced ${bounded === 1 ? 'session was' : 'sessions were'} written with a different sync key and ${bounded === 1 ? 'is' : 'are'} not shown here. If your phone shows old sessions, re-pair it from this computer.`
    : null;
}
