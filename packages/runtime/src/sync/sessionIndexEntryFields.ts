import type { SessionIndexData } from './types';

/**
 * Plaintext relationship/flag fields copied verbatim from a local session onto
 * the wire `SessionIndexEntry` that syncs desktop -> server -> mobile.
 *
 * Kept as a standalone pure function so the synced field set has a single
 * source of truth and a regression lock (see
 * `__tests__/sessionIndexEntryFields.test.ts`). All values here are plaintext
 * (not E2E-encrypted), matching how `parentSessionId`/`worktreeId` already flow.
 *
 * `agentRole` + `createdBySessionId` drive the iOS meta-agent grouping: the
 * phone treats sessions with `agentRole === 'meta-agent'` as group headers and
 * nests sessions whose `createdBySessionId` points at that meta session.
 */
export interface SyncedSessionIndexFields {
  sessionType?: string;
  parentSessionId?: string;
  worktreeId?: string;
  isArchived?: boolean;
  isPinned?: boolean;
  branchedFromSessionId?: string;
  branchPointMessageId?: number;
  branchedAt?: number;
  /** Agent role marker (e.g. 'meta-agent'); drives mobile meta-agent grouping. */
  agentRole?: string;
  /** Parent meta-agent session id for spawned children; drives mobile grouping. */
  createdBySessionId?: string;
}

/**
 * Build the plaintext relationship/flag portion of a wire `SessionIndexEntry`
 * from a local session record. `createdBySessionId` is normalized from
 * `string | null` (PGLite) to `string | undefined` for the wire.
 */
export function buildSyncedSessionIndexFields(
  session: SessionIndexData,
): SyncedSessionIndexFields {
  return {
    sessionType: session.sessionType,
    parentSessionId: session.parentSessionId,
    worktreeId: session.worktreeId,
    isArchived: session.isArchived,
    isPinned: session.isPinned,
    branchedFromSessionId: session.branchedFromSessionId,
    branchPointMessageId: session.branchPointMessageId,
    branchedAt: session.branchedAt,
    agentRole: session.agentRole,
    createdBySessionId: session.createdBySessionId ?? undefined,
  };
}
