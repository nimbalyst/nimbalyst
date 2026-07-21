import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BoundInteractiveMutationAuthority } from '../../AIProvider';
import type { AgentMessage } from '../../types';
import { AgentMessagesRepository } from '../../../../storage/repositories/AgentMessagesRepository';
import { serializeProviderPermissionResult } from '../../providers/BaseAgentProvider';
import { ToolPermissionService } from '../ToolPermissionService';

const authorityA: BoundInteractiveMutationAuthority = {
  mutationId: 'mutation-A',
  mutationFence: 3,
  attentionGeneration: 'generation-A',
  promptOccurrence: 'occurrence-A:p1',
  answerDigest: 'b'.repeat(64),
};

function boundResult(authority: BoundInteractiveMutationAuthority): AgentMessage {
  return {
    id: 1,
    sessionId: 'session-1',
    source: 'claude-code',
    direction: 'output',
    createdAt: new Date(1),
    content: serializeProviderPermissionResult(
      'p1',
      { decision: 'allow', scope: 'once' },
      'telegram',
      authority,
      1,
    ),
  };
}

function createService(): ToolPermissionService {
  return new ToolPermissionService({
    trustChecker: () => ({ trusted: true, mode: 'ask' }),
    patternSaver: async () => {},
    patternChecker: async () => false,
    emit: () => {},
  });
}

function request(
  service: ToolPermissionService,
  signal: AbortSignal,
  mutationAuthority?: BoundInteractiveMutationAuthority,
) {
  return service.requestToolPermission({
    requestId: 'p1',
    sessionId: 'session-1',
    workspacePath: 'C:\\workspace',
    permissionsPath: 'C:\\workspace',
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    pattern: 'Bash(npm test:*)',
    patternDisplayName: 'npm test',
    toolDescription: 'Run tests',
    isDestructive: false,
    signal,
    mutationAuthority,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ToolPermissionService generation-bound polling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    AgentMessagesRepository.clearStore();
    vi.useRealTimers();
  });

  it('does not let replacement B consume delayed A when the raw permission ID is reused', async () => {
    const messages: AgentMessage[] = [];
    let releaseList!: () => void;
    let pollingStarted!: () => void;
    const delayedList = new Promise<void>((resolve) => { releaseList = resolve; });
    const atPoll = new Promise<void>((resolve) => { pollingStarted = resolve; });
    AgentMessagesRepository.setStore({
      create: async () => {},
      list: async () => {
        pollingStarted();
        await delayedList;
        return messages;
      },
    });
    const service = createService();
    const controller = new AbortController();
    let settled = false;
    const result = request(service, controller.signal).then((value) => {
      settled = true;
      return value;
    });

    await atPoll;
    messages.push(boundResult(authorityA));
    releaseList();
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(service.resolvePermission('p1', { decision: 'deny', scope: 'once' })).toBe(true);
    await expect(result).resolves.toEqual({ decision: 'deny', scope: 'once' });
    controller.abort();
  });

  it('accepts a provider result only when mutation, fence, generation, occurrence, and answer digest all match', async () => {
    AgentMessagesRepository.setStore({
      create: async () => {},
      list: async () => [boundResult(authorityA)],
    });
    const service = createService();
    const controller = new AbortController();

    const result = request(service, controller.signal, authorityA);
    await flushMicrotasks();
    await expect(result).resolves.toEqual({ decision: 'allow', scope: 'once' });
    expect(service.hasPendingPermissions()).toBe(false);
    controller.abort();
  });

  it.each([
    ['mutationId', 'mutation-B'],
    ['mutationFence', 4],
    ['attentionGeneration', 'generation-B'],
    ['promptOccurrence', 'occurrence-B:p1'],
    ['answerDigest', 'f'.repeat(64)],
  ] as const)('rejects a bound result whose %s differs even when raw p1 is reused', async (field, value) => {
    const mismatched = { ...authorityA, [field]: value } as BoundInteractiveMutationAuthority;
    AgentMessagesRepository.setStore({
      create: async () => {},
      list: async () => [boundResult(mismatched)],
    });
    const service = createService();
    const controller = new AbortController();
    let settled = false;
    const result = request(service, controller.signal, authorityA).then((decision) => {
      settled = true;
      return decision;
    });

    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(service.resolvePermission('p1', { decision: 'deny', scope: 'once' })).toBe(true);
    await expect(result).resolves.toEqual({ decision: 'deny', scope: 'once' });
    controller.abort();
  });
});
