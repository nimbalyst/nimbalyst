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
const inFlight = new Map<string, number>();
const waiters = new Map<string, Array<() => void>>();

/** Marks a commit call in flight; the returned function ends it (idempotent). */
export function beginCommitProposalCall(sessionId: string): () => void {
  inFlight.set(sessionId, (inFlight.get(sessionId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const remaining = (inFlight.get(sessionId) ?? 1) - 1;
    if (remaining > 0) {
      inFlight.set(sessionId, remaining);
      return;
    }
    inFlight.delete(sessionId);
    const pending = waiters.get(sessionId) ?? [];
    waiters.delete(sessionId);
    for (const wake of pending) wake();
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

const waitingProposals = new Map<string, Set<CloseWaitingProposal>>();

/** A proposal is waiting for the user; the returned function withdraws it (idempotent). */
export function registerWaitingCommitProposal(sessionId: string, close: CloseWaitingProposal): () => void {
  const set = waitingProposals.get(sessionId) ?? new Set<CloseWaitingProposal>();
  set.add(close);
  waitingProposals.set(sessionId, set);
  return () => {
    set.delete(close);
    if (set.size === 0 && waitingProposals.get(sessionId) === set) waitingProposals.delete(sessionId);
  };
}

/**
 * NIM-7642: the user sent a new message instead of answering. Closes every
 * proposal of the session still waiting on them and resolves how many closed.
 * Their calls then return, ending the in-flight mark a deferred send-now waits on.
 */
export async function closeWaitingCommitProposals(sessionId: string): Promise<number> {
  const closes = [...(waitingProposals.get(sessionId) ?? [])];
  const closed = await Promise.all(closes.map(close => close().catch(() => false)));
  return closed.filter(Boolean).length;
}
