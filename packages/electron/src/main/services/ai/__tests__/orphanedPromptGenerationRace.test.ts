import { describe, expect, it, vi } from 'vitest';
import { SessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { AttentionEventService } from '../../AttentionEventService';
import { clearStalePendingPromptOnTerminal } from '../pendingPromptTerminalClear';
import { settleTerminalAttentionBeforeContinuation } from '../terminalAttentionSettlement';
import { settleOrphanedPromptTurn } from '../orphanedPromptTurnSettlement';
import type { PendingPromptPersistenceResult } from '../pendingPromptPersistence';
import { terminateHostBoundAiSession } from '../aiServiceQueuedChainSettlement';

const lifecycle = vi.hoisted(() => ({
  revoke: vi.fn(async () => undefined),
}));

vi.mock('../../../mcp/httpServer', () => ({
  revokeHostBoundMcpAuthority: lifecycle.revoke,
}));

function supersededPromptClear(): PendingPromptPersistenceResult {
  return {
    sessionId: 'session-1',
    hasPendingPrompt: false,
    promptId: null,
    generation: null,
    applied: false,
    superseded: true,
    local: { attempted: false, succeeded: false, skippedReason: 'newer_prompt_is_pending' },
    sync: { attempted: false, succeeded: false, skippedReason: 'newer_prompt_is_pending' },
    fullyPropagated: false,
  };
}

describe('orphaned git proposal generation race', () => {
  it('preserves active prompt B through the real state event, backstop, and attention flow', async () => {
    const sessionId = 'session-1';
    const workspacePath = '/workspace';
    const session = {
      id: sessionId,
      workspacePath,
      metadata: {
        hasPendingPrompt: true,
        pendingPromptId: 'prompt-b',
        pendingPromptGeneration: 'turn-b',
      } as Record<string, unknown>,
    };
    const attention = new AttentionEventService({
      getSession: async () => session,
      updateSessionMetadata: async (_id, metadata) => {
        session.metadata = { ...session.metadata, ...metadata };
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
    await attention.arm(workspacePath, {
      sessionId,
      promptId: 'prompt-b',
      attentionGeneration: 'turn-b',
      severity: 'normal',
      dedupeKey: 'waiting:prompt-b',
    });

    const stateManager = new SessionStateManager();
    await stateManager.startSession({ sessionId, workspacePath, attentionGeneration: 'turn-a' });
    await stateManager.startSession({ sessionId, workspacePath, attentionGeneration: 'turn-b' });

    const backstopClears = vi.fn();
    const eventTasks: Promise<unknown>[] = [];
    const unsubscribe = stateManager.subscribe((event) => {
      eventTasks.push(Promise.all([
        clearStalePendingPromptOnTerminal(event, {
          readHasPendingPrompt: async () => ({
            hasPendingPrompt: session.metadata.hasPendingPrompt === true,
            promptId: session.metadata.pendingPromptId as string | undefined,
            generation: session.metadata.pendingPromptGeneration as string | undefined,
          }),
          clearPendingPrompt: async () => { backstopClears(); },
        }),
        attention.handleSessionStateEvent(event),
      ]));
    });

    const result = await settleOrphanedPromptTurn({
      ownership: {
        sessionId,
        promptId: 'prompt-a',
        matchedPendingPrompt: true,
        attentionGeneration: 'turn-a',
        readSucceeded: true,
      },
      reason: 'completed',
    }, {
      settleTerminal: (args, continuation) => settleTerminalAttentionBeforeContinuation(
        args,
        continuation,
        {
          clearPendingPrompt: vi.fn().mockResolvedValue(supersededPromptClear()),
          settleAttention: (id, args) => attention.settleTerminalAttention(id, args),
        },
      ),
      ownsCurrentGeneration: () => false,
      terminateSession: async (ownership) => {
        await stateManager.endSession(ownership.sessionId, {
          attentionGeneration: ownership.attentionGeneration!,
        });
        return true;
      },
    });

    expect(result.settled).toBe(false);
    expect(stateManager.getSessionState(sessionId)).toMatchObject({
      status: 'running',
      attentionGeneration: 'turn-b',
    });

    // Exercise the actual subscribed backstops too, as though an already-queued
    // delayed A terminal event arrived after B became current.
    stateManager.emit('session:completed', {
      sessionId,
      workspacePath,
      timestamp: new Date(),
      attentionGeneration: 'turn-a',
    });
    await Promise.all(eventTasks);

    expect(backstopClears).not.toHaveBeenCalled();
    expect(session.metadata).toMatchObject({
      hasPendingPrompt: true,
      pendingPromptId: 'prompt-b',
      pendingPromptGeneration: 'turn-b',
    });
    const status = await attention.status(workspacePath, {
      sessionId,
      includeCancelled: true,
    });
    expect(status.events).toContainEqual(expect.objectContaining({
      promptId: 'prompt-b',
      attentionGeneration: 'turn-b',
      status: 'pending',
    }));
    unsubscribe();
  });

  it('routes an owned orphaned turn through the host termination capability boundary', async () => {
    const terminalTransition = vi.fn(async () => undefined);
    const terminateSession = vi.fn((ownership) => terminateHostBoundAiSession(
      ownership.sessionId,
      terminalTransition,
      () => true,
    ));
    const result = await settleOrphanedPromptTurn({
      ownership: {
        sessionId: 'orphaned-terminal',
        promptId: 'prompt-orphaned',
        matchedPendingPrompt: true,
        attentionGeneration: 'turn-orphaned',
        readSucceeded: true,
      },
      reason: 'error',
    }, {
      settleTerminal: (async (_args, continuation) => ({
        promptClear: {} as PendingPromptPersistenceResult,
        attentionSettledCount: 0,
        continuationResult: await continuation({
          promptClear: {
            ...supersededPromptClear(),
            superseded: false,
            local: { attempted: true, succeeded: true, skippedReason: null },
          },
          attentionSettledCount: 0,
        }),
      })) as any,
      ownsCurrentGeneration: () => true,
      terminateSession,
    });

    expect(result.settled).toBe(true);
    expect(terminateSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'orphaned-terminal',
      attentionGeneration: 'turn-orphaned',
    }));
    expect(lifecycle.revoke).toHaveBeenCalledWith('orphaned-terminal');
    expect(terminalTransition).toHaveBeenCalledTimes(1);
  });
});
