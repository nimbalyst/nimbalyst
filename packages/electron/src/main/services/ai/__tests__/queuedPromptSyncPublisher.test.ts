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
  it('serializes pending reads so an older snapshot cannot follow a claim clear', async () => {
    const { deps, pushChange } = makeDeps([]);
    let release!: (rows: Array<{ id: string; prompt: string; createdAt: number }>) => void;
    deps.listPending.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const beforeClaim = publishQueuedPromptsToSync(deps, 'session-1');
    await vi.waitFor(() => expect(deps.listPending).toHaveBeenCalledOnce());
    const afterClaim = publishQueuedPromptsToSync(deps, 'session-1');
    await Promise.resolve();
    expect(deps.listPending).toHaveBeenCalledOnce();
    release([{ id: 'old', prompt: 'claimed during the read', createdAt: 1 }]);
    await Promise.all([beforeClaim, afterClaim]);
    expect(pushChange.mock.calls.map(([, change]) => change.metadata.queuedPrompts.map((prompt: { id: string }) => prompt.id)))
      .toEqual([['old'], []]);
  });

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

  it('waits for async publication and reports an unpublished outcome', async () => {
    const { pushChange, deps } = makeDeps([]);
    let finish!: (outcome: { published: boolean; reason: string; retryable: boolean }) => void;
    pushChange.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const settled = vi.fn();
    const publishing = publishQueuedPromptsToSync(deps, 'session-1').then(settled);
    await vi.waitFor(() => expect(pushChange).toHaveBeenCalled());
    expect(settled).not.toHaveBeenCalled();
    finish({ published: false, reason: 'not connected', retryable: true });
    await publishing;
    expect(settled).toHaveBeenCalledWith(null);
    expect(deps.logWarn).toHaveBeenCalledWith(expect.stringContaining('not connected'));
  });

  it('handles a rejected async send without interrupting queue execution', async () => {
    const { pushChange, deps } = makeDeps([]);
    pushChange.mockRejectedValue(new Error('socket closed'));
    expect(await publishQueuedPromptsToSync(deps, 'session-1')).toBeNull();
    expect(deps.logWarn).toHaveBeenCalledWith(expect.stringContaining('socket closed'));
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
