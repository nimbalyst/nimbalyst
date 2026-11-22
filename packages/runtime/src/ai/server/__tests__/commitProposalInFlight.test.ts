// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { afterCommitProposalSettles, beginCommitProposalCall, isCommitProposalInFlight } from '../commitProposalInFlight';

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
