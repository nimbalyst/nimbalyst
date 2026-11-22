// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { beginCommitProposalCall, registerWaitingCommitProposal } from '@nimbalyst/runtime/ai/server/commitProposalInFlight';
import { deferInterruptDuringCommit, deferUserSendNowDuringCommit } from '../commitInterruptDeferral';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const deps = (pending: boolean) => {
  const calls: string[] = [];
  return {
    calls,
    hasPendingPrompts: vi.fn(async () => pending),
    interrupt: vi.fn(async () => { calls.push('interrupt'); }),
    drive: vi.fn(async () => { calls.push('drive'); }),
    logWarn: vi.fn(),
  };
};

it('does nothing when no commit call is in flight', () => {
  const d = deps(true);
  expect(deferInterruptDuringCommit('quiet', d)).toBe(false);
  expect(d.interrupt).not.toHaveBeenCalled();
});

it('replays one send-now (interrupt, then drive) only after the commit call settles', async () => {
  const end = beginCommitProposalCall('busy');
  const d = deps(true);
  expect(deferInterruptDuringCommit('busy', d)).toBe(true);
  expect(deferInterruptDuringCommit('busy', d)).toBe(true);
  await flush();
  expect(d.interrupt).not.toHaveBeenCalled();
  end();
  await flush();
  expect(d.calls).toEqual(['interrupt', 'drive']);
});

it('skips the replay when the queued prompt already went out', async () => {
  const end = beginCommitProposalCall('drained');
  const d = deps(false);
  deferInterruptDuringCommit('drained', d);
  end();
  await flush();
  expect(d.interrupt).not.toHaveBeenCalled();
  expect(d.drive).not.toHaveBeenCalled();
});

/** A proposal call waiting for the user; closing it ends the call on a later tick, as the handler's settle does. */
function waitingProposal(sessionId: string, closable = true) {
  const end = beginCommitProposalCall(sessionId);
  const close = vi.fn(async () => {
    if (!closable) return false;
    setTimeout(end, 0);
    return true;
  });
  registerWaitingCommitProposal(sessionId, close);
  return { end, close };
}

// NIM-7642
it("closes a proposal waiting on the user for the user's send-now, then replays it once the call returns", async () => {
  const proposal = waitingProposal('user-send');
  const d = deps(true);
  expect(await deferUserSendNowDuringCommit('user-send', d)).toBe(true);
  expect(proposal.close).toHaveBeenCalledTimes(1);
  await flush();
  await flush();
  expect(d.calls).toEqual(['interrupt', 'drive']);
});

it("keeps the user's send-now waiting while a commit they confirmed owns the proposal", async () => {
  const proposal = waitingProposal('confirmed', false);
  const d = deps(true);
  expect(await deferUserSendNowDuringCommit('confirmed', d)).toBe(true);
  await flush();
  expect(d.interrupt).not.toHaveBeenCalled();
  proposal.end();
  await flush();
  expect(d.calls).toEqual(['interrupt', 'drive']);
});

it('never closes a waiting proposal for a meta-agent or teammate interrupt', async () => {
  const proposal = waitingProposal('meta');
  const d = deps(true);
  expect(deferInterruptDuringCommit('meta', d)).toBe(true);
  await flush();
  expect(proposal.close).not.toHaveBeenCalled();
  expect(d.interrupt).not.toHaveBeenCalled();
  proposal.end();
});
