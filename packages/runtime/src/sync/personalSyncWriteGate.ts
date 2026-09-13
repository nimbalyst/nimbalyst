/**
 * Personal-sync write gate.
 *
 * Decides whether this device may publish personal-sync ciphertext at all:
 * index rows, metadata patches, project config, and transcript uploads. It is
 * the client-side half of the GitHub #1117 fix. A device whose sync key cannot
 * read the shared index must not "repair" it by deleting rows or republishing
 * its own copies under a key the user's other devices do not hold.
 *
 * States:
 *
 * - `unverified` -- nothing has proven this key yet. Writes are withheld until
 *   a complete index read decrypts in full. Reconciliation always reads first,
 *   so a healthy device passes through this state on every fresh provider.
 * - `verified` -- a complete read decrypted under this key. Writes flow.
 * - `blocked` -- a row this key cannot read was seen (`decryption-failed`), or
 *   the server refused this client build (`update-required`). Writes are
 *   withheld. A later complete read clears a decryption block; only a newer
 *   build clears an update requirement, so a clean read leaves that in place.
 *
 * Reconnecting never changes the state: a socket coming back is no evidence
 * about the key. Reads, presence, and team collaboration are unaffected.
 */

export type PersonalSyncWriteGateState = 'unverified' | 'verified' | 'blocked';

export type PersonalSyncBlockReason = 'decryption-failed' | 'update-required';

export interface PersonalSyncWriteGateSnapshot {
  state: PersonalSyncWriteGateState;
  reason: PersonalSyncBlockReason | null;
  /** Bounded, non-sensitive explanation of the current block, for logs and status. */
  detail: string | null;
}

export interface PersonalSyncWriteGate {
  snapshot(): PersonalSyncWriteGateSnapshot;
  canWrite(): boolean;
  /** A complete index read decrypted under this key. */
  markVerified(): void;
  markBlocked(reason: PersonalSyncBlockReason, detail: string): void;
  /** Fires only when the snapshot actually changes. */
  onChange(listener: (snapshot: PersonalSyncWriteGateSnapshot) => void): () => void;
}

const MAX_DETAIL_LENGTH = 300;

export function createPersonalSyncWriteGate(): PersonalSyncWriteGate {
  let current: PersonalSyncWriteGateSnapshot = { state: 'unverified', reason: null, detail: null };
  const listeners = new Set<(snapshot: PersonalSyncWriteGateSnapshot) => void>();

  function transition(next: PersonalSyncWriteGateSnapshot): void {
    if (next.state === current.state && next.reason === current.reason && next.detail === current.detail) return;
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
    markVerified() {
      // The server's refusal is about this build, not this key; a clean read
      // says nothing about whether writes would now be accepted.
      if (current.state === 'blocked' && current.reason === 'update-required') return;
      transition({ state: 'verified', reason: null, detail: null });
    },
    markBlocked(reason, detail) {
      transition({ state: 'blocked', reason, detail: detail.slice(0, MAX_DETAIL_LENGTH) });
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
  return 'This device\'s sync key cannot read your synced sessions, so session sync writes are paused here to protect what your other devices published. Sessions on this device are unaffected.';
}
