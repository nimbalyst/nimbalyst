/**
 * One queued-prompt drive attempt, expressed as pure decision logic.
 *
 * The ordering here is load-bearing:
 *  1. Look for work BEFORE resolving a window — a spurious drive must never
 *     auto-open a project just to find there was nothing to send.
 *  2. Busy checks before window resolution, for the same reason.
 *  3. A dispatcher that declines while rows are still pending defers rather
 *     than reporting "nothing to do" — that silent `false` is the failure mode
 *     the queue driver exists to remove (#962).
 */

import type { DriveOutcome, DriveReason } from './QueueDriveService';

export type WindowResolution<W> =
  | { kind: 'window'; window: W; opened: boolean }
  | { kind: 'deferred'; reason: 'no-window' }
  | { kind: 'terminal'; reason: 'workspace-missing' };

export interface QueueDriveAttemptDeps<W> {
  /** Ids of the session's pending rows, oldest first. */
  listPendingIds(sessionId: string): Promise<string[]>;
  /** Is a queued-prompt chain already running for this session? */
  isChainActive(sessionId: string): boolean;
  /** Is the session mid-turn (running or streaming)? */
  isSessionBusy(sessionId: string): boolean;
  resolveWindow(workspacePath: string, allowAutoOpen: boolean): Promise<WindowResolution<W>>;
  failAllPending(sessionId: string, errorMessage: string): Promise<number>;
  dispatch(input: { sessionId: string; workspacePath: string; window: W; reason: DriveReason }): Promise<boolean>;
  logWarn(message: string): void;
}

/**
 * Only a remote-originated delivery may open a window. Boot recovery must not
 * race window restore into a wall of duplicate windows, and a scheduled wakeup
 * keeps its existing "wait until the user opens the project" contract.
 */
export function allowsAutoOpen(reason: DriveReason): boolean {
  return reason === 'mobile-control' || reason === 'mobile-index' || reason === 'send-now';
}

export async function runQueueDriveAttempt<W>(
  deps: QueueDriveAttemptDeps<W>,
  input: { sessionId: string; workspacePath: string; reason: DriveReason },
): Promise<DriveOutcome> {
  const { sessionId, workspacePath, reason } = input;

  const pendingIds = await deps.listPendingIds(sessionId);
  if (pendingIds.length === 0) {
    return { kind: 'nothing-pending' };
  }

  if (deps.isChainActive(sessionId) || deps.isSessionBusy(sessionId)) {
    return { kind: 'deferred', reason: 'session-busy' };
  }

  const resolved = await deps.resolveWindow(workspacePath, allowsAutoOpen(reason));
  if (resolved.kind === 'terminal') {
    const failed = await deps.failAllPending(
      sessionId,
      'Queued prompt delivery failed: workspace is unavailable',
    );
    deps.logWarn(
      `[AIService] queue drive (${reason}): workspace missing for session ${sessionId}; failed ${failed} pending prompt(s)`,
    );
    return { kind: 'failed', reason: 'workspace-missing' };
  }
  if (resolved.kind === 'deferred') {
    return { kind: 'deferred', reason: 'no-window' };
  }

  const dispatched = await deps.dispatch({
    sessionId,
    workspacePath,
    window: resolved.window,
    reason,
  });
  if (dispatched) {
    return { kind: 'dispatched', promptId: pendingIds[0] };
  }

  // The dispatcher declined (row claimed elsewhere, CLI mid-turn, ...).
  // Re-arm if rows remain rather than stranding them.
  const stillPending = await deps.listPendingIds(sessionId);
  return stillPending.length > 0
    ? { kind: 'deferred', reason: 'session-busy' }
    : { kind: 'nothing-pending' };
}
