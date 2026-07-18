import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  getSession: vi.fn(),
  updateMetadata: vi.fn(),
  pushMetadataChangeWithResult: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    get: fixture.getSession,
    updateMetadata: fixture.updateMetadata,
  },
}));
vi.mock('../../SyncManager', () => ({
  getSyncProvider: () => ({
    pushMetadataChangeWithResult: fixture.pushMetadataChangeWithResult,
  }),
}));

import {
  SessionStateManager,
  setSessionStateManager,
} from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { AttentionEventService } from '../../AttentionEventService';
import { createAIServiceQueuedChainSettlement } from '../aiServiceQueuedChainSettlement';
import { clearStalePendingPromptOnTerminal } from '../pendingPromptTerminalClear';
import { setSessionPendingPrompt } from '../pendingPromptPersistence';
import { settleTerminalAttentionBeforeContinuation } from '../terminalAttentionSettlement';

describe('AIService queued-chain generation settlement integration', () => {
  const sessionId = 'session-queued-race';
  const workspacePath = '/workspace';

  beforeEach(() => {
    vi.clearAllMocks();
    fixture.metadata = {};
    fixture.getSession.mockImplementation(async () => ({
      id: sessionId,
      workspacePath,
      metadata: fixture.metadata,
    }));
    fixture.updateMetadata.mockImplementation(async (_id, update) => {
      fixture.metadata = { ...fixture.metadata, ...(update.metadata ?? {}) };
    });
    fixture.pushMetadataChangeWithResult.mockResolvedValue({
      outcome: 'index_frame_written',
      attempted: true,
      indexFrameWritten: true,
      skippedReason: null,
    });
  });

  afterEach(() => {
    setSessionStateManager(new SessionStateManager());
  });

  it('preserves prompt and attention B when the real AIService callback settles queued turn A late', async () => {
    const stateManager = new SessionStateManager();
    setSessionStateManager(stateManager);
    const attention = new AttentionEventService({
      getSession: fixture.getSession,
      updateSessionMetadata: async (_id, metadata) => {
        fixture.metadata = { ...fixture.metadata, ...metadata };
      },
      pushAttentionSummary: vi.fn().mockResolvedValue(undefined),
      notifyUserJson: vi.fn().mockResolvedValue(JSON.stringify({
        result: { attempted: true, shown: true, skippedReason: null },
        mobilePush: {
          attempted: true,
          requestFrameWritten: true,
          outcome: 'request_frame_written',
          skippedReason: null,
          bypassActiveDeviceRouting: true,
          forceDesktopAwayForPush: true,
        },
      })),
    });

    await stateManager.startSession({ sessionId, workspacePath, attentionGeneration: 'turn-a' });
    await setSessionPendingPrompt(sessionId, true, {
      promptId: 'prompt-a',
      generation: 'turn-a',
    });

    // A replacement turn opens through the production state manager and the
    // real serialized pending-prompt persistence path before A's callback runs.
    await stateManager.startSession({ sessionId, workspacePath, attentionGeneration: 'turn-b' });
    await setSessionPendingPrompt(sessionId, true, {
      promptId: 'prompt-b',
      generation: 'turn-b',
    });
    await attention.arm(workspacePath, {
      sessionId,
      promptId: 'prompt-b',
      attentionGeneration: 'turn-b',
      severity: 'normal',
      dedupeKey: 'waiting:prompt-b',
    });

    const backstopClears = vi.fn();
    const terminalTasks: Promise<unknown>[] = [];
    const unsubscribe = stateManager.subscribe((event) => {
      terminalTasks.push(Promise.all([
        clearStalePendingPromptOnTerminal(event, {
          readHasPendingPrompt: async () => ({
            hasPendingPrompt: fixture.metadata.hasPendingPrompt === true,
            promptId: fixture.metadata.pendingPromptId as string | undefined,
            generation: fixture.metadata.pendingPromptGeneration as string | undefined,
          }),
          clearPendingPrompt: async (id, { expectedGeneration }) => {
            const result = await setSessionPendingPrompt(id, false, { expectedGeneration });
            if (result.local.succeeded) backstopClears();
          },
        }),
        attention.handleSessionStateEvent(event),
      ]));
    });
    const scheduleStop = vi.fn();
    const tracker = createAIServiceQueuedChainSettlement({
      stateManager,
      logInfo: vi.fn(),
      scheduleStop,
      settleTerminal: (args, continuation) => settleTerminalAttentionBeforeContinuation(
        args,
        continuation,
        {
          clearPendingPrompt: setSessionPendingPrompt,
          settleAttention: (id, settleArgs) => attention.settleTerminalAttention(id, settleArgs),
        },
      ),
    });

    await tracker.onChainSettled({
      sessionId,
      workspacePath,
      source: 'integration regression',
      attentionGeneration: 'turn-a',
    });

    expect(tracker.settledChainEnded).toBe(false);
    expect(scheduleStop).not.toHaveBeenCalled();
    expect(stateManager.getSessionState(sessionId)).toMatchObject({
      status: 'running',
      attentionGeneration: 'turn-b',
    });

    // Also release an A terminal event that was already queued before B opened.
    // The actual terminal subscribers must independently reject it.
    stateManager.emit('session:completed', {
      sessionId,
      workspacePath,
      timestamp: new Date(),
      attentionGeneration: 'turn-a',
    });
    await Promise.all(terminalTasks);

    expect(backstopClears).not.toHaveBeenCalled();
    expect(fixture.metadata).toMatchObject({
      hasPendingPrompt: true,
      pendingPromptId: 'prompt-b',
      pendingPromptGeneration: 'turn-b',
    });
    const attentionStatus = await attention.status(workspacePath, {
      sessionId,
      includeCancelled: true,
    });
    expect(attentionStatus.events).toContainEqual(expect.objectContaining({
      promptId: 'prompt-b',
      attentionGeneration: 'turn-b',
      status: 'pending',
    }));
    unsubscribe();
  });
});
