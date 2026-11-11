/**
 * #1682: sessions with a `developer_git_commit_proposal` call in flight.
 *
 * Interrupting the turn during that call makes the SDK write its standard
 * "user doesn't want to proceed" text as the tool result while the commit may
 * still land. Send-now, meta-agent interrupts and teammate messages wait here
 * until the call settles instead. A real Stop (cancel/abort) does not consult
 * this and is always honored.
 *
 * The user's own send-now is the exception (NIM-7642): it first closes a
 * proposal still waiting on them (`closeWaitingCommitProposals`), so it waits
 * only for a commit the user already confirmed, not for the user.
 */
type InFlightCalls = { count: number };
const inFlight = new Map<string, InFlightCalls>();
const waiters = new Map<string, Array<() => void>>();
const settledListeners = new Map<string, Set<() => void>>();

/** Marks a commit call in flight; the returned function ends it (idempotent). */
export function beginCommitProposalCall(sessionId: string): () => void {
  const calls = inFlight.get(sessionId) ?? { count: 0 };
  calls.count += 1;
  inFlight.set(sessionId, calls);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    // An orphan reaper may have retired this generation while a later call
    // started. Its late cleanup must never erase the later call's marker.
    if (inFlight.get(sessionId) !== calls) return;
    calls.count -= 1;
    if (calls.count > 0) return;
    inFlight.delete(sessionId);
    wakeCommitProposalWaiters(sessionId);
  };
}

function wakeCommitProposalWaiters(sessionId: string): void {
  const pending = waiters.get(sessionId) ?? [];
  waiters.delete(sessionId);
  for (const wake of pending) wake();
  for (const listener of [...(settledListeners.get(sessionId) ?? [])]) listener();
}

/**
 * Retire a marker whose owner turn is already gone. Callers must establish
 * that the session has no live host turn or running provider before invoking
 * this: a confirmed commit is not safe to interrupt merely because it is slow.
 */
export function reapOrphanedCommitProposalCalls(sessionId: string): boolean {
  if (!inFlight.delete(sessionId)) return false;
  wakeCommitProposalWaiters(sessionId);
  return true;
}

/** Wake a deferred queue drive when the last commit call actually settles. */
export function onCommitProposalsSettled(sessionId: string, listener: () => void): () => void {
  const listeners = settledListeners.get(sessionId) ?? new Set<() => void>();
  listeners.add(listener);
  settledListeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && settledListeners.get(sessionId) === listeners) {
      settledListeners.delete(sessionId);
    }
  };
}

export function isCommitProposalInFlight(sessionId: string | undefined): boolean {
  return !!sessionId && inFlight.has(sessionId);
}

/** Runs `action` now, or once the session's in-flight commit calls have all settled. */
export async function afterCommitProposalSettles<T>(
  sessionId: string | undefined,
  action: () => T | Promise<T>,
): Promise<T> {
  if (sessionId && inFlight.has(sessionId)) {
    await new Promise<void>(wake => {
      const list = waiters.get(sessionId) ?? [];
      list.push(wake);
      waiters.set(sessionId, list);
    });
  }
  return action();
}

/**
 * Closes a proposal waiting for the user. Resolves false when it cannot be
 * closed because a commit the user confirmed already owns it.
 */
type CloseWaitingProposal = () => Promise<boolean>;

type WaitingProposal = { proposalId?: string; close: CloseWaitingProposal };
const waitingProposals = new Map<string, Set<WaitingProposal>>();

/** A proposal is waiting for the user; the returned function withdraws it (idempotent). */
export function registerWaitingCommitProposal(sessionId: string, close: CloseWaitingProposal, proposalId?: string): () => void {
  const set = waitingProposals.get(sessionId) ?? new Set<WaitingProposal>();
  const entry = { proposalId, close };
  set.add(entry);
  waitingProposals.set(sessionId, set);
  return () => {
    set.delete(entry);
    if (set.size === 0 && waitingProposals.get(sessionId) === set) waitingProposals.delete(sessionId);
  };
}

/**
 * Closes still-waiting proposals when the user sends new input or stops the
 * turn. An orphaned MCP call may target its exact proposal ID. Their calls
 * then return, ending the in-flight mark a deferred queue drive waits on.
 */
export async function closeWaitingCommitProposals(
  sessionId: string,
  proposalId?: string,
  onError?: (error: unknown) => void,
): Promise<number> {
  const closes = [...(waitingProposals.get(sessionId) ?? [])]
    .filter(entry => proposalId === undefined || entry.proposalId === proposalId);
  const closed = await Promise.all(closes.map(async entry => {
    try { return await entry.close(); }
    catch (error) { onError?.(error); return false; }
  }));
  return closed.filter(Boolean).length;
}
