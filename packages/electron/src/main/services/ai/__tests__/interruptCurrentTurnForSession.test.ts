import { describe, expect, it, vi } from 'vitest';
import {
  runInterruptCurrentTurnForSession,
  type InterruptCurrentTurnDependencies,
} from '../interruptCurrentTurnForSession';
import type { PendingPromptPersistenceResult } from '../pendingPromptPersistence';

const SESSION_ID = 'session-priority';

function createFakes(providerType: string = 'claude-code') {
  const promptClear: PendingPromptPersistenceResult = {
    sessionId: SESSION_ID,
    hasPendingPrompt: false,
    promptId: null,
    generation: 'generation-a',
    applied: true,
    superseded: false,
    local: { attempted: true, succeeded: true, skippedReason: null },
    sync: { attempted: true, succeeded: true, skippedReason: null },
    fullyPropagated: true,
  };
  const provider = {
    interruptCurrentTurn: vi.fn().mockResolvedValue({ method: 'graceful-interrupt' }),
  };
  const deps: InterruptCurrentTurnDependencies = {
    getSession: vi.fn().mockResolvedValue({ provider: providerType }),
    setSessionPendingPrompt: vi.fn().mockResolvedValue(promptClear),
    cancelAllAttentionForSession: vi.fn().mockResolvedValue(undefined),
    isTerminalActive: vi.fn().mockReturnValue(true),
    writeToTerminal: vi.fn(),
    getProvider: vi.fn().mockReturnValue(provider),
    deleteFromProcessingQueue: vi.fn(),
    sweepExecutingForSession: vi.fn().mockResolvedValue({
      completed: 1,
      failed: 0,
      rolledBack: 0,
    }),
    getCurrentAttentionGeneration: vi.fn().mockReturnValue('generation-a'),
    getSessionStatus: vi.fn().mockReturnValue('running'),
    logInfo: vi.fn(),
    logError: vi.fn(),
  };
  return { deps, promptClear, provider };
}

describe('runInterruptCurrentTurnForSession', () => {
  it('preserves the unconditional renderer path for claude-code-cli terminals', async () => {
    const { deps, promptClear, provider } = createFakes('claude-code-cli');

    const result = await runInterruptCurrentTurnForSession(deps, SESSION_ID);

    expect(result).toEqual({
      success: true,
      method: 'terminal-ctrl-c',
      promptClear,
    });
    expect(deps.getCurrentAttentionGeneration).not.toHaveBeenCalled();
    expect(deps.getSessionStatus).not.toHaveBeenCalled();
    expect(deps.getSession).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.setSessionPendingPrompt).toHaveBeenCalledWith(SESSION_ID, false);
    expect(deps.cancelAllAttentionForSession).toHaveBeenCalledWith(SESSION_ID, 'interrupted');
    expect(deps.isTerminalActive).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.writeToTerminal).toHaveBeenCalledWith(SESSION_ID, '\x03');
    expect(deps.getProvider).not.toHaveBeenCalled();
    expect(deps.deleteFromProcessingQueue).not.toHaveBeenCalled();
    expect(deps.sweepExecutingForSession).not.toHaveBeenCalled();
    expect(provider.interruptCurrentTurn).not.toHaveBeenCalled();
  });

  it('preserves the unconditional renderer path for non-CLI providers', async () => {
    const { deps, promptClear, provider } = createFakes('claude-code');

    const result = await runInterruptCurrentTurnForSession(deps, SESSION_ID);

    expect(result).toEqual({
      success: true,
      method: 'graceful-interrupt',
      promptClear,
    });
    expect(deps.getCurrentAttentionGeneration).not.toHaveBeenCalled();
    expect(deps.getSessionStatus).not.toHaveBeenCalled();
    expect(deps.setSessionPendingPrompt).toHaveBeenCalledWith(SESSION_ID, false);
    expect(deps.cancelAllAttentionForSession).toHaveBeenCalledWith(SESSION_ID, 'interrupted');
    expect(deps.getProvider).toHaveBeenCalledWith('claude-code', SESSION_ID);
    expect(deps.deleteFromProcessingQueue).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.sweepExecutingForSession).toHaveBeenCalledWith(SESSION_ID);
    expect(provider.interruptCurrentTurn).toHaveBeenCalledTimes(1);
  });

  it('proceeds normally when the expected generation matches', async () => {
    const { deps, provider } = createFakes('openai-codex');

    const result = await runInterruptCurrentTurnForSession(deps, SESSION_ID, {
      expectedGeneration: 'generation-a',
      priorityRowId: 'control-row',
    });

    expect(result).toMatchObject({ success: true, method: 'graceful-interrupt' });
    expect(deps.getCurrentAttentionGeneration).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.getSessionStatus).toHaveBeenCalledTimes(2);
    expect(deps.getSession).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.setSessionPendingPrompt).toHaveBeenCalledWith(SESSION_ID, false);
    expect(deps.cancelAllAttentionForSession).toHaveBeenCalledWith(SESSION_ID, 'interrupted');
    expect(deps.getProvider).toHaveBeenCalledWith('openai-codex', SESSION_ID);
    expect(deps.deleteFromProcessingQueue).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.sweepExecutingForSession).toHaveBeenCalledWith(SESSION_ID);
    expect(provider.interruptCurrentTurn).toHaveBeenCalledTimes(1);
  });

  it('fails stale generations before every interrupt side effect', async () => {
    const { deps, provider } = createFakes('claude-code');
    vi.mocked(deps.getCurrentAttentionGeneration).mockReturnValue('generation-b');

    const result = await runInterruptCurrentTurnForSession(deps, SESSION_ID, {
      expectedGeneration: 'generation-a',
      priorityRowId: 'control-row',
    });

    expect(result).toEqual({
      success: false,
      error: 'stale generation',
      promptClear: undefined,
    });
    expect(deps.getCurrentAttentionGeneration).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.getSessionStatus).not.toHaveBeenCalled();
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.setSessionPendingPrompt).not.toHaveBeenCalled();
    expect(deps.cancelAllAttentionForSession).not.toHaveBeenCalled();
    expect(deps.isTerminalActive).not.toHaveBeenCalled();
    expect(deps.writeToTerminal).not.toHaveBeenCalled();
    expect(deps.getProvider).not.toHaveBeenCalled();
    expect(deps.deleteFromProcessingQueue).not.toHaveBeenCalled();
    expect(deps.sweepExecutingForSession).not.toHaveBeenCalled();
    expect(provider.interruptCurrentTurn).not.toHaveBeenCalled();
  });

  it('fails a generation-bound interrupt before session lookup when input is already pending', async () => {
    const { deps, provider } = createFakes('claude-code');
    vi.mocked(deps.getSessionStatus).mockReturnValue('waiting_for_input');

    const result = await runInterruptCurrentTurnForSession(deps, SESSION_ID, {
      expectedGeneration: 'generation-a',
      priorityRowId: 'control-row',
    });

    expect(result).toEqual({
      success: false,
      error: 'session is waiting for input',
      promptClear: undefined,
    });
    expect(deps.getCurrentAttentionGeneration).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.getSessionStatus).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.setSessionPendingPrompt).not.toHaveBeenCalled();
    expect(deps.cancelAllAttentionForSession).not.toHaveBeenCalled();
    expect(deps.isTerminalActive).not.toHaveBeenCalled();
    expect(deps.writeToTerminal).not.toHaveBeenCalled();
    expect(deps.getProvider).not.toHaveBeenCalled();
    expect(deps.deleteFromProcessingQueue).not.toHaveBeenCalled();
    expect(deps.sweepExecutingForSession).not.toHaveBeenCalled();
    expect(provider.interruptCurrentTurn).not.toHaveBeenCalled();
  });

  it('fails a generation-bound interrupt when input opens during session lookup', async () => {
    const { deps, provider } = createFakes('claude-code');
    vi.mocked(deps.getSessionStatus)
      .mockReturnValueOnce('running')
      .mockReturnValueOnce('waiting_for_input');

    const result = await runInterruptCurrentTurnForSession(deps, SESSION_ID, {
      expectedGeneration: 'generation-a',
      priorityRowId: 'control-row',
    });

    expect(result).toEqual({
      success: false,
      error: 'session is waiting for input',
      promptClear: undefined,
    });
    expect(deps.getSession).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.getSessionStatus).toHaveBeenCalledTimes(2);
    expect(deps.setSessionPendingPrompt).not.toHaveBeenCalled();
    expect(deps.cancelAllAttentionForSession).not.toHaveBeenCalled();
    expect(deps.isTerminalActive).not.toHaveBeenCalled();
    expect(deps.writeToTerminal).not.toHaveBeenCalled();
    expect(deps.getProvider).not.toHaveBeenCalled();
    expect(deps.deleteFromProcessingQueue).not.toHaveBeenCalled();
    expect(deps.sweepExecutingForSession).not.toHaveBeenCalled();
    expect(provider.interruptCurrentTurn).not.toHaveBeenCalled();
  });

  it('preserves manual interrupts while the session is waiting for input', async () => {
    const { deps, promptClear, provider } = createFakes('claude-code-cli');
    vi.mocked(deps.getSessionStatus).mockReturnValue('waiting_for_input');

    const result = await runInterruptCurrentTurnForSession(deps, SESSION_ID);

    expect(result).toEqual({
      success: true,
      method: 'terminal-ctrl-c',
      promptClear,
    });
    expect(deps.getCurrentAttentionGeneration).not.toHaveBeenCalled();
    expect(deps.getSessionStatus).not.toHaveBeenCalled();
    expect(deps.setSessionPendingPrompt).toHaveBeenCalledWith(SESSION_ID, false);
    expect(deps.cancelAllAttentionForSession).toHaveBeenCalledWith(SESSION_ID, 'interrupted');
    expect(deps.isTerminalActive).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.writeToTerminal).toHaveBeenCalledWith(SESSION_ID, '\x03');
    expect(provider.interruptCurrentTurn).not.toHaveBeenCalled();
  });

  it('keeps the existing missing-session-id exception', async () => {
    const { deps } = createFakes();

    await expect(runInterruptCurrentTurnForSession(deps, '')).rejects.toThrow(
      'Session ID is required to interrupt',
    );
    expect(deps.getCurrentAttentionGeneration).not.toHaveBeenCalled();
    expect(deps.getSessionStatus).not.toHaveBeenCalled();
    expect(deps.getSession).not.toHaveBeenCalled();
  });
});
