// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { afterCommitProposalSettles, beginCommitProposalCall, closeWaitingCommitProposals, isCommitProposalInFlight, onCommitProposalsSettled, reapOrphanedCommitProposalCalls, registerWaitingCommitProposal, noteConfirmedCommitProposalExecution, CONFIRMED_COMMIT_QUEUE_CEILING_MS } from '../commitProposalInFlight';

it('holds deferred work until every in-flight commit call for the session settles', async () => {
  const action = vi.fn(() => 'ran');
  const endFirst = beginCommitProposalCall('s1');
  const endSecond = beginCommitProposalCall('s1');
  expect(isCommitProposalInFlight('s1')).toBe(true);
  expect(isCommitProposalInFlight('s2')).toBe(false);

  const deferred = afterCommitProposalSettles('s1', action);
  endFirst();
  endFirst(); // idempotent: a double settle must not release the second call
  await Promise.resolve();
  expect(action).not.toHaveBeenCalled();
  endSecond();
  await expect(deferred).resolves.toBe('ran');
  expect(isCommitProposalInFlight('s1')).toBe(false);
});

it('runs immediately when nothing is in flight or the session is unknown', async () => {
  await expect(afterCommitProposalSettles('idle', () => 1)).resolves.toBe(1);
  await expect(afterCommitProposalSettles(undefined, () => 2)).resolves.toBe(2);
});

it('wakes only when the last call settles and allows an exact orphan to close', async () => {
  const wake = vi.fn();
  const unsubscribe = onCommitProposalsSettled('exact', wake);
  const endFirst = beginCommitProposalCall('exact');
  const endSecond = beginCommitProposalCall('exact');
  const closeFirst = vi.fn(async () => true);
  const closeSecond = vi.fn(async () => false); // confirmed commit owns this one
  const unregisterFirst = registerWaitingCommitProposal('exact', closeFirst, 'item-1');
  const unregisterSecond = registerWaitingCommitProposal('exact', closeSecond, 'item-2');
  try {
    expect(await closeWaitingCommitProposals('exact', 'item-1')).toBe(1);
    expect(closeFirst).toHaveBeenCalledOnce();
    expect(closeSecond).not.toHaveBeenCalled();
    expect(await closeWaitingCommitProposals('exact', 'item-2')).toBe(0);
    endFirst();
    expect(wake).not.toHaveBeenCalled();
    endSecond();
    expect(wake).toHaveBeenCalledOnce();
  } finally { unregisterFirst(); unregisterSecond(); unsubscribe(); endFirst(); endSecond(); }
});

it('reports a failed close while still closing other waiting proposals', async () => {
  const failure = new Error('proposal storage unavailable');
  const onError = vi.fn();
  const unregisterFailed = registerWaitingCommitProposal('close-failure', async () => { throw failure; }, 'bad');
  const closeGood = vi.fn(async () => true);
  const unregisterGood = registerWaitingCommitProposal('close-failure', closeGood, 'good');
  try {
    expect(await closeWaitingCommitProposals('close-failure', undefined, onError)).toBe(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(closeGood).toHaveBeenCalledOnce();
  } finally { unregisterFailed(); unregisterGood(); }
});

it('reaps an orphaned marker without letting its late cleanup erase a new call', () => {
  const endOld = beginCommitProposalCall('orphan');
  const wake = vi.fn();
  const unsubscribe = onCommitProposalsSettled('orphan', wake);
  try {
    expect(reapOrphanedCommitProposalCalls('orphan')).toBe(true);
    expect(isCommitProposalInFlight('orphan')).toBe(false);
    expect(wake).toHaveBeenCalledOnce();
    const endNew = beginCommitProposalCall('orphan');
    endOld();
    expect(isCommitProposalInFlight('orphan')).toBe(true);
    endNew();
    expect(isCommitProposalInFlight('orphan')).toBe(false);
  } finally { endOld(); unsubscribe(); }
});

it('applies a Send close that arrived before this proposal registered its waiter', async () => {
  const end = beginCommitProposalCall('late-waiter', 'proposal-1');
  const wake = vi.fn();
  const unsubscribe = onCommitProposalsSettled('late-waiter', wake);
  const close = vi.fn(async () => { end(); return true; });
  try {
    expect(await closeWaitingCommitProposals('late-waiter')).toBe(0);
    const unregister = registerWaitingCommitProposal('late-waiter', close, 'proposal-1');
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(isCommitProposalInFlight('late-waiter')).toBe(false);
      expect(wake).toHaveBeenCalledOnce();
    } finally { unregister(); }
    const newEnd = beginCommitProposalCall('late-waiter', 'proposal-2');
    const newClose = vi.fn(async () => true);
    const unregisterNew = registerWaitingCommitProposal('late-waiter', newClose, 'proposal-2');
    try { await Promise.resolve(); expect(newClose).not.toHaveBeenCalled(); }
    finally { unregisterNew(); newEnd(); }
  } finally { end(); unsubscribe(); }
});

it('releases only an aged confirmed generation while leaving its commit alive', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const end = beginCommitProposalCall('long-commit', 'confirmed');
  const wake = vi.fn();
  const unsubscribe = onCommitProposalsSettled('long-commit', wake);
  const action = vi.fn(() => 'released');
  try {
    noteConfirmedCommitProposalExecution('long-commit', 'confirmed');
    const deferred = afterCommitProposalSettles('long-commit', action);
    await vi.advanceTimersByTimeAsync(CONFIRMED_COMMIT_QUEUE_CEILING_MS - 1);
    expect(isCommitProposalInFlight('long-commit')).toBe(true);
    expect(action).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(isCommitProposalInFlight('long-commit')).toBe(false);
    await expect(deferred).resolves.toBe('released');
    expect(wake).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    const endFresh = beginCommitProposalCall('long-commit', 'fresh');
    try { expect(isCommitProposalInFlight('long-commit')).toBe(true); }
    finally { endFresh(); }
  } finally { end(); unsubscribe(); warn.mockRestore(); vi.useRealTimers(); }
});
