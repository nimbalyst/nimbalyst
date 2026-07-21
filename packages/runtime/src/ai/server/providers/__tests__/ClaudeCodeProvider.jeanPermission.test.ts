import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BoundInteractiveMutationAuthority } from '../../AIProvider';
import { ToolPermissionService } from '../../permissions/ToolPermissionService';
import { ClaudeCodeProvider } from '../ClaudeCodeProvider';

const authority: BoundInteractiveMutationAuthority = {
  mutationId: 'mutation-A',
  mutationFence: 7,
  attentionGeneration: 'generation-A',
  promptOccurrence: 'occurrence-A:p1',
  answerDigest: 'a'.repeat(64),
};

function service(): ToolPermissionService {
  return new ToolPermissionService({
    trustChecker: () => ({ trusted: true, mode: 'ask' }),
    patternSaver: async () => {},
    patternChecker: async () => false,
    emit: () => {},
  });
}

describe('ClaudeCodeProvider Jean-bound native acknowledgement', () => {
  afterEach(() => vi.restoreAllMocks());

  it('positively acknowledges the exact permission waiter without starting a handoff-straddling raw-ID write', async () => {
    const provider = new ClaudeCodeProvider() as any;
    const permissionService = service() as any;
    let nativeDecision: unknown;
    permissionService.pendingPermissions.set('p1', {
      request: { requestId: 'p1' },
      resolve: (value: unknown) => { nativeDecision = value; },
      reject: () => {},
    });
    provider.permissionService = permissionService;

    provider.logAgentMessage = vi.fn(async () => {});

    const result = await Promise.resolve(provider.resolveToolPermission(
      'p1',
      { decision: 'allow', scope: 'once' },
      'session-1',
      'telegram',
      authority,
    ));

    expect(nativeDecision).toEqual({ decision: 'allow', scope: 'once' });
    expect(result).toEqual({ outcome: 'acknowledged', authority });
    expect(provider.logAgentMessage).not.toHaveBeenCalled();
  });

  it('returns an exact not-found acknowledgement and writes no raw-ID fallback on a provider miss', async () => {
    const provider = new ClaudeCodeProvider() as any;
    provider.permissionService = service();
    provider.logAgentMessage = vi.fn(async () => {});

    await expect(Promise.resolve(provider.resolveToolPermission(
      'p1',
      { decision: 'allow', scope: 'once' },
      'session-1',
      'telegram',
      authority,
    ))).resolves.toEqual({ outcome: 'not_found', authority });
    expect(provider.logAgentMessage).not.toHaveBeenCalled();

    await expect(Promise.resolve(provider.resolveExitPlanModeConfirmation(
      'p1',
      { approved: true },
      'session-1',
      'telegram',
      authority,
    ))).resolves.toEqual({ outcome: 'not_found', authority });
  });

  it('suppresses reusable Ask and ExitPlan raw-ID rows after a positive bound waiter acknowledgement', async () => {
    const provider = new ClaudeCodeProvider() as any;
    provider.logAgentMessage = vi.fn(async () => {});
    const askResolve = vi.fn();
    const exitResolve = vi.fn();
    provider.pendingAskUserQuestions.set('p1', { resolve: askResolve, reject: vi.fn() });
    provider.pendingExitPlanModeConfirmations.set('p2', { resolve: exitResolve, reject: vi.fn() });

    await expect(Promise.resolve(provider.resolveAskUserQuestion(
      'p1',
      { Question: 'answer' },
      'session-1',
      'telegram',
      authority,
    ))).resolves.toEqual({ outcome: 'acknowledged', authority });
    await expect(Promise.resolve(provider.resolveExitPlanModeConfirmation(
      'p2',
      { approved: false },
      'session-1',
      'telegram',
      authority,
    ))).resolves.toEqual({ outcome: 'acknowledged', authority });
    expect(askResolve).toHaveBeenCalledOnce();
    expect(exitResolve).toHaveBeenCalledOnce();
    expect(provider.logAgentMessage).not.toHaveBeenCalled();
  });
});
