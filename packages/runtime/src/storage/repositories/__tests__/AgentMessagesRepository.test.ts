import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentMessagesRepository, type AgentMessagesStore } from '../AgentMessagesRepository';

function message(id: number) {
  return {
    id,
    sessionId: 'session-1',
    source: 'test',
    direction: 'output' as const,
    content: `message-${id}`,
    createdAt: new Date(id * 1_000),
  };
}

describe('AgentMessagesRepository.listTail', () => {
  afterEach(() => {
    AgentMessagesRepository.clearStore();
  });

  it('delegates to a native tail query', async () => {
    const listTail = vi.fn(async () => [message(3), message(4)]);
    AgentMessagesRepository.setStore({
      create: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      listTail,
    });

    await expect(AgentMessagesRepository.listTail('session-1', 2)).resolves.toEqual([
      message(3),
      message(4),
    ]);
    expect(listTail).toHaveBeenCalledWith('session-1', 2, undefined);
  });

  it('falls back to slicing the end of an ordered store result', async () => {
    const list = vi.fn(async () => [message(1), message(2), message(3), message(4)]);
    AgentMessagesRepository.setStore({
      create: vi.fn(async () => {}),
      list,
    } satisfies AgentMessagesStore);

    await expect(AgentMessagesRepository.listTail('session-1', 2, {
      includeHidden: true,
    })).resolves.toEqual([message(3), message(4)]);
    expect(list).toHaveBeenCalledWith('session-1', { includeHidden: true });
  });
});
