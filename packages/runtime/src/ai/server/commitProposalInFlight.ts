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
 * only for a commit the user already confirmed, up to its queue ceiling.
 */
/** A confirmed Git execution may outlive its tool call; release queue admission after this ceiling. */
export const CONFIRMED_COMMIT_QUEUE_CEILING_MS = 10 * 60 * 1_000;

type InFlightCall = {
  proposalId?: string;
  confirmedAt?: number;
  closeRequested: boolean;
  ceilingTimer?: ReturnType<typeof setTimeout>;
};
const inFlight = new Map<string, Set<InFlightCall>>();
const waiters = new Map<string, Array<() => void>>();
const settledListeners = new Map<string, Set<() => void>>();

/** Marks a commit call in flight; the returned function ends it (idempotent). */
export function beginCommitProposalCall(sessionId: string, proposalId?: string): () => void {
  const calls = inFlight.get(sessionId) ?? new Set<InFlightCall>();
  const call: InFlightCall = { proposalId, closeRequested: false };
  calls.add(call);
  inFlight.set(sessionId, calls);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    if (call.ceilingTimer) clearTimeout(call.ceilingTimer);
    // A late cleanup may follow an orphan reap. Remove only this exact call.
    if (!calls.delete(call)) return;
    if (calls.size === 0 && inFlight.get(sessionId) === calls) inFlight.delete(sessionId);
    wakeIfNoBlockingCalls(sessionId);
  };
}

function wakeCommitProposalWaiters(sessionId: string): void {
  const pending = waiters.get(sessionId) ?? [];
  waiters.delete(sessionId);
  for (const wake of pending) wake();
  for (const listener of [...(settledListeners.get(sessionId) ?? [])]) listener();
}

function wakeIfNoBlockingCalls(sessionId: string): void {
  if (!isCommitProposalInFlight(sessionId)) wakeCommitProposalWaiters(sessionId);
}

/** An actual confirmed execution starts the queue ceiling for its exact proposal. */
export function noteConfirmedCommitProposalExecution(sessionId: string, proposalId: string, startedAt = Date.now()): void {
  for (const call of inFlight.get(sessionId) ?? []) {
    if (call.proposalId !== proposalId || call.confirmedAt !== undefined) continue;
    call.confirmedAt = startedAt;
    call.ceilingTimer = setTimeout(() => {
      if (!inFlight.get(sessionId)?.has(call)) return;
      console.warn(`[CommitProposal] Confirmed commit ${proposalId} in session ${sessionId} exceeded the 10-minute queue ceiling; Git continues running.`);
      wakeIfNoBlockingCalls(sessionId);
    }, Math.max(0, startedAt + CONFIRMED_COMMIT_QUEUE_CEILING_MS - Date.now()));
    call.ceilingTimer.unref?.();
  }
}

/**
 * Retire marker generations whose owner turn is gone and whose Git execution
 * is not running. Callers must establish that the host and provider are idle.
 */
export function reapOrphanedCommitProposalCalls(
  sessionId: string,
  isRunning: (proposalId?: string) => boolean = () => false,
): boolean {
  const calls = inFlight.get(sessionId);
  if (!calls) return false;
  let reaped = false;
  for (const call of [...calls]) {
    if (isRunning(call.proposalId)) continue;
    if (call.ceilingTimer) clearTimeout(call.ceilingTimer);
    calls.delete(call);
    reaped = true;
  }
  if (!reaped) return false;
  if (calls.size === 0 && inFlight.get(sessionId) === calls) inFlight.delete(sessionId);
  wakeIfNoBlockingCalls(sessionId);
  return true;
}

/** Wake a deferred queue drive when the last blocking call settles or reaches its ceiling. */
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
  return !!sessionId && [...(inFlight.get(sessionId) ?? [])].some(call =>
    call.confirmedAt === undefined || Date.now() - call.confirmedAt < CONFIRMED_COMMIT_QUEUE_CEILING_MS);
}

/** Includes aged calls so orphan recovery cannot mistake a live generation for an absent marker. */
export function hasCommitProposalCall(sessionId: string): boolean {
  return (inFlight.get(sessionId)?.size ?? 0) > 0;
}

/** Runs `action` now, or once no commit call blocks the session's queue. */
export async function afterCommitProposalSettles<T>(
  sessionId: string | undefined,
  action: () => T | Promise<T>,
): Promise<T> {
  if (sessionId && isCommitProposalInFlight(sessionId)) {
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
  // Send may have crossed the marker before the MCP handler reached this registration.
  // The request belongs only to the generation that existed at Send time.
  const call = [...(inFlight.get(sessionId) ?? [])].find(item => item.proposalId === proposalId && item.closeRequested);
  if (call) {
    call.closeRequested = false;
    void Promise.resolve().then(close).catch(error => {
      console.error(`[CommitProposal] Failed to close superseded proposal ${proposalId ?? 'unknown'}:`, error);
    });
  }
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
  const registered = new Set(closes.map(entry => entry.proposalId));
  for (const call of inFlight.get(sessionId) ?? []) {
    if ((proposalId === undefined || call.proposalId === proposalId)
      && !registered.has(call.proposalId) && call.confirmedAt === undefined) call.closeRequested = true;
  }
  const closed = await Promise.all(closes.map(async entry => {
    try { return await entry.close(); }
    catch (error) { onError?.(error); return false; }
  }));
  return closed.filter(Boolean).length;
}
