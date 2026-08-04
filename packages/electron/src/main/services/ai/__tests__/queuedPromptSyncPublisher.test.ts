// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { publishQueuedPromptsToSync } from '../queuedPromptSyncPublisher';

function makeDeps(pending: Array<{ id: string; prompt: string; createdAt: number }>) {
  const pushChange = vi.fn();
  return {
    pushChange,
    logWarn: vi.fn(),
    deps: {
      listPending: vi.fn(async () => pending),
      getSyncProvider: () => ({ pushChange }) as any,
      logWarn: vi.fn(),
    },
  };
}

describe('publishQueuedPromptsToSync', () => {
  it('publishes the drained queue so mobile stops re-showing a prompt the desktop already ran', async () => {
    // The regression (NIM-2402): iOS publishes the prompt, desktop claims and runs
    // it, but nothing ever publishes the emptied queue back — so the desktop's
    // cached index entry keeps re-asserting the same prompt and the phone's
    // "1 QUEUED" chip never clears.
    const { pushChange, deps } = makeDeps([]);

    const published = await publishQueuedPromptsToSync(deps, 'session-1');

    expect(published).toEqual([]);
    expect(pushChange).toHaveBeenCalledWith('session-1', {
      type: 'metadata_updated',
      metadata: { queuedPrompts: [] },
    });
    // No updatedAt: clearing the queue must not resort the mobile session list.
    expect(pushChange.mock.calls[0][1].metadata).not.toHaveProperty('updatedAt');
  });

  it('publishes only the rows still pending, mapped to the wire shape', async () => {
    const { pushChange, deps } = makeDeps([
      { id: 'p2', prompt: 'second', createdAt: 200 },
    ]);

    const published = await publishQueuedPromptsToSync(deps, 'session-1');

    expect(published).toEqual([{ id: 'p2', prompt: 'second', timestamp: 200 }]);
    expect(pushChange).toHaveBeenCalledWith('session-1', {
      type: 'metadata_updated',
      metadata: { queuedPrompts: [{ id: 'p2', prompt: 'second', timestamp: 200 }] },
    });
  });

  it('no-ops without reading the queue when sync is unavailable', async () => {
    const listPending = vi.fn();
    const published = await publishQueuedPromptsToSync(
      { listPending, getSyncProvider: () => null, logWarn: vi.fn() },
      'session-1',
    );

    expect(published).toBeNull();
    expect(listPending).not.toHaveBeenCalled();
  });

  it('swallows and logs a publish failure so a queue transition never breaks', async () => {
    const logWarn = vi.fn();
    const published = await publishQueuedPromptsToSync(
      {
        listPending: vi.fn(async () => {
          throw new Error('db closed');
        }),
        getSyncProvider: () => ({ pushChange: vi.fn() }) as any,
        logWarn,
      },
      'session-1',
    );

    expect(published).toBeNull();
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('db closed'));
  });
});
