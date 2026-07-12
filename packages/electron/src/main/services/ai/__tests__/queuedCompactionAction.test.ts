import { describe, expect, it, vi } from 'vitest';
import {
  dispatchQueuedCompactionAction,
  isQueuedCompactionAction,
} from '../queuedCompactionAction';

describe('queuedCompactionAction', () => {
  it('recognizes only an exact, explicitly tagged internal action', () => {
    expect(isQueuedCompactionAction({
      prompt: '/compact',
      documentContext: { promptOrigin: 'agent_compaction' },
    })).toBe(true);
    expect(isQueuedCompactionAction({
      prompt: '/compact focus on state',
      documentContext: { promptOrigin: 'agent_compaction' },
    })).toBe(false);
    expect(isQueuedCompactionAction({ prompt: '/compact' })).toBe(false);
  });

  it('runs native compaction for the tagged action and reports it handled', async () => {
    const compact = vi.fn().mockResolvedValue({
      supported: true,
      compacted: true,
      method: 'thread/compact/start',
    });

    await expect(dispatchQueuedCompactionAction({
      prompt: '/compact',
      documentContext: { promptOrigin: 'agent_compaction' },
    }, compact)).resolves.toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('surfaces structured native failures so the queue row settles failed', async () => {
    await expect(dispatchQueuedCompactionAction({
      prompt: '/compact',
      documentContext: { promptOrigin: 'agent_compaction' },
    }, async () => ({
      supported: true,
      compacted: false,
      error: 'active turn',
    }))).rejects.toThrow('active turn');
  });
});
