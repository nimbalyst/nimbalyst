import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  updateMetadata: vi.fn(),
  pushChange: vi.fn(),
  pushMetadataChangeWithResult: vi.fn(),
  guardedMetadataUpdate: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    get: mocks.get,
    updateMetadata: mocks.updateMetadata,
  },
}));
vi.mock('../../SyncManager', () => ({
  getSyncProvider: () => ({
    pushChange: mocks.pushChange,
    pushMetadataChangeWithResult: mocks.pushMetadataChangeWithResult,
  }),
}));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { warn: vi.fn() } },
}));
vi.mock('../../PGLiteSessionStore', () => ({
  compareUpdateSessionMetadataWithHostControlAuthority: mocks.guardedMetadataUpdate,
}));

import {
  runClaimedPendingPromptAction,
  setSessionPendingPrompt,
} from '../pendingPromptPersistence';

describe('pendingPromptPersistence structured result and identity guard', () => {
  let metadata: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    metadata = {};
    mocks.get.mockImplementation(async () => ({ id: 'session-1', metadata }));
    mocks.updateMetadata.mockImplementation(async (_sessionId, update) => {
      metadata = { ...metadata, ...update.metadata };
    });
    mocks.pushChange.mockResolvedValue(undefined);
    mocks.pushMetadataChangeWithResult.mockResolvedValue({
      outcome: 'index_frame_written',
      attempted: true,
      indexFrameWritten: true,
      skippedReason: null,
    });
    mocks.guardedMetadataUpdate.mockImplementation(async ({ nextMetadata }) => {
      metadata = nextMetadata;
      return true;
    });
  });

  it('reports local persistence and sync acceptance separately', async () => {
    const result = await setSessionPendingPrompt('session-1', true, { promptId: 'prompt-1' });

    expect(result).toMatchObject({
      applied: true,
      superseded: false,
      fullyPropagated: true,
      local: { attempted: true, succeeded: true },
      sync: { attempted: true, succeeded: true },
    });
    expect(metadata).toMatchObject({ hasPendingPrompt: true, pendingPromptId: 'prompt-1' });
    expect(mocks.pushMetadataChangeWithResult).toHaveBeenCalledWith('session-1', {
      hasPendingPrompt: true,
    });
  });

  it('commits a Jean clear through the durable cleanup CAS and emits no unguarded sync write', async () => {
    metadata = {
      hasPendingPrompt: true,
      pendingPromptId: 'prompt-a',
      pendingPromptGeneration: 'generation-a',
    };
    const authority = {
      receiptId: 'receipt-a',
      reservationOwner: 'owner-a',
      mutationId: 'mutation-a',
      mutationFence: 3,
      attentionGeneration: 'generation-a',
      step: 'prompt' as const,
    };

    const result = await setSessionPendingPrompt('session-1', false, {
      expectedPromptId: 'prompt-a',
      expectedGeneration: 'generation-a',
      durableCleanupAuthority: authority,
    });

    expect(mocks.guardedMetadataUpdate).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      authority,
      nextMetadata: expect.objectContaining({ hasPendingPrompt: false }),
    }));
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
    expect(mocks.pushMetadataChangeWithResult).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      local: { succeeded: true },
      sync: { attempted: false, skippedReason: 'durable_cleanup_local_only' },
    });
  });

  it('still attempts sync and does not claim propagation when local persistence fails', async () => {
    mocks.updateMetadata.mockRejectedValueOnce(new Error('database unavailable'));
    const result = await setSessionPendingPrompt('session-1', false);

    expect(result.local).toMatchObject({
      attempted: true,
      succeeded: false,
      skippedReason: 'local_persistence_failed',
    });
    expect(result.sync.succeeded).toBe(true);
    expect(result.fullyPropagated).toBe(false);
  });

  it('reports a rejected sync call without hiding a successful local clear', async () => {
    mocks.pushMetadataChangeWithResult.mockRejectedValueOnce(new Error('socket failed'));
    const result = await setSessionPendingPrompt('session-1', false);

    expect(result.local.succeeded).toBe(true);
    expect(result.sync).toMatchObject({
      attempted: false,
      succeeded: false,
      skippedReason: 'sync_push_failed',
    });
    expect(result.fullyPropagated).toBe(false);
  });

  it('does not claim propagation when the encrypted index frame was skipped', async () => {
    mocks.pushMetadataChangeWithResult.mockResolvedValueOnce({
      outcome: 'skipped',
      attempted: false,
      indexFrameWritten: false,
      skippedReason: 'index_not_connected',
    });

    const result = await setSessionPendingPrompt('session-1', false);
    expect(result.local.succeeded).toBe(true);
    expect(result.sync).toMatchObject({
      attempted: false,
      succeeded: false,
      skippedReason: 'index_not_connected',
    });
    expect(result.fullyPropagated).toBe(false);
  });

  it('does not let an old continuation clear a newer prompt identity', async () => {
    await setSessionPendingPrompt('session-1', true, { promptId: 'prompt-new' });
    const updateCount = mocks.updateMetadata.mock.calls.length;
    const result = await setSessionPendingPrompt('session-1', false, {
      expectedPromptId: 'prompt-old',
    });

    expect(result).toMatchObject({
      applied: false,
      superseded: true,
      fullyPropagated: false,
    });
    expect(mocks.updateMetadata).toHaveBeenCalledTimes(updateCount);
    expect(metadata).toMatchObject({ hasPendingPrompt: true, pendingPromptId: 'prompt-new' });
  });

  it('does not let a stale terminal generation clear a newer prompt generation', async () => {
    await setSessionPendingPrompt('session-1', true, {
      promptId: 'prompt-new',
      generation: 'turn-b',
    } as any);
    const updateCount = mocks.updateMetadata.mock.calls.length;

    const result = await setSessionPendingPrompt('session-1', false, {
      expectedGeneration: 'turn-a',
    } as any);

    expect(result).toMatchObject({
      applied: false,
      superseded: true,
      fullyPropagated: false,
    });
    expect(mocks.updateMetadata).toHaveBeenCalledTimes(updateCount);
    expect(metadata).toMatchObject({
      hasPendingPrompt: true,
      pendingPromptId: 'prompt-new',
      pendingPromptGeneration: 'turn-b',
    });
  });

  it('lets the matching terminal generation clear its own prompt', async () => {
    await setSessionPendingPrompt('session-1', true, {
      promptId: 'prompt-a',
      generation: 'turn-a',
    } as any);

    const result = await setSessionPendingPrompt('session-1', false, {
      expectedGeneration: 'turn-a',
    } as any);

    expect(result).toMatchObject({ applied: true, superseded: false });
    expect(metadata).toMatchObject({
      hasPendingPrompt: false,
      pendingPromptId: null,
      pendingPromptGeneration: null,
    });
  });

  it('holds the prompt lock across an owned action so prompt B opens afterward', async () => {
    await setSessionPendingPrompt('session-1', true, {
      promptId: 'prompt-a',
      generation: 'turn-a',
    });
    let openPromptB!: Promise<unknown>;

    const result = await runClaimedPendingPromptAction(
      'session-1',
      'prompt-a',
      async () => {
        openPromptB = setSessionPendingPrompt('session-1', true, {
          promptId: 'prompt-b',
          generation: 'turn-b',
        });
        await Promise.resolve();
        expect(metadata).toMatchObject({
          hasPendingPrompt: false,
          pendingPromptId: null,
        });
        return 'delivered-a';
      },
    );

    expect(result).toMatchObject({ claimed: true, value: 'delivered-a' });
    await openPromptB;
    expect(metadata).toMatchObject({
      hasPendingPrompt: true,
      pendingPromptId: 'prompt-b',
      pendingPromptGeneration: 'turn-b',
    });
  });

  it('rejects a stale prompt action before its callback or persistence runs', async () => {
    await setSessionPendingPrompt('session-1', true, {
      promptId: 'prompt-b',
      generation: 'turn-b',
    });
    const action = vi.fn();
    const updateCount = mocks.updateMetadata.mock.calls.length;

    const result = await runClaimedPendingPromptAction('session-1', 'prompt-a', action);

    expect(result).toMatchObject({ claimed: false, promptClear: { superseded: true } });
    expect(action).not.toHaveBeenCalled();
    expect(mocks.updateMetadata).toHaveBeenCalledTimes(updateCount);
  });
});
