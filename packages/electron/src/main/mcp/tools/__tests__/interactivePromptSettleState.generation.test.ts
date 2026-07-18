import { describe, expect, it } from 'vitest';
import { SessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { applyInteractivePromptSettleTurnState } from '../interactivePromptSettleState';

describe('interactive MCP prompt settle generation', () => {
  it('does not let a delayed prompt-A settle flip waiting prompt B back to running', async () => {
    const stateManager = new SessionStateManager();
    await stateManager.startSession({
      sessionId: 'session-1',
      workspacePath: '/workspace',
      attentionGeneration: 'turn-b',
      initialStatus: 'waiting_for_input',
    });

    await applyInteractivePromptSettleTurnState({
      sessionId: 'session-1',
      isCliSession: false,
      attentionGeneration: 'turn-a',
      stateManager,
    });

    expect(stateManager.getSessionState('session-1')).toMatchObject({
      status: 'waiting_for_input',
      attentionGeneration: 'turn-b',
    });
  });
});
