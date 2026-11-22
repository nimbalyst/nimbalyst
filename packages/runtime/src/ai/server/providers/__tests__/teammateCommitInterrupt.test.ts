// @vitest-environment node
import { expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import { TeammateManager, type TeammateManagerDeps } from '../TeammateManager';
import { beginCommitProposalCall } from '../../commitProposalInFlight';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// #1682: a teammate message interrupting the lead mid-commit makes the SDK report a rejection.
it('holds a teammate message to the lead until the in-flight commit call settles', async () => {
  const interruptWithMessage = vi.fn(async () => {});
  const manager = new TeammateManager({
    logNonBlocking: vi.fn(),
    emit: vi.fn(),
    interruptWithMessage,
  } as unknown as TeammateManagerDeps);
  const end = beginCommitProposalCall('lead');

  (manager as any).deliverMessageToLead('lead', 'agent-1', 'alice', 'done with the tests', 'done');
  await flush();
  expect(interruptWithMessage).not.toHaveBeenCalled();

  end();
  await flush();
  expect(interruptWithMessage).toHaveBeenCalledTimes(1);
  expect(interruptWithMessage).toHaveBeenCalledWith(expect.stringContaining('done with the tests'));
});
