import { describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  runInterruptCurrentTurnForSession,
  type InterruptCurrentTurnDependencies,
} from '../interruptCurrentTurnForSession';
import type { PendingPromptPersistenceResult } from '../pendingPromptPersistence';
import { createPGLiteQueuedPromptsStore } from '../../PGLiteQueuedPromptsStore';

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

    expect(result).toMatchObject({
      success: true,
      method: 'graceful-interrupt',
      nativeCertainty: 'applied',
      nativeEntered: true,
    });
    expect(deps.getCurrentAttentionGeneration).toHaveBeenCalledWith(SESSION_ID);
    expect(vi.mocked(deps.getSessionStatus).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(deps.getSession).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.setSessionPendingPrompt).not.toHaveBeenCalled();
    expect(deps.cancelAllAttentionForSession).not.toHaveBeenCalled();
    expect(deps.getProvider).toHaveBeenCalledWith('openai-codex', SESSION_ID);
    expect(deps.deleteFromProcessingQueue).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.sweepExecutingForSession).not.toHaveBeenCalled();
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
      nativeCertainty: 'not_applied',
      nativeEntered: false,
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
      nativeCertainty: 'not_applied',
      nativeEntered: false,
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
      .mockReturnValue('waiting_for_input');

    const result = await runInterruptCurrentTurnForSession(deps, SESSION_ID, {
      expectedGeneration: 'generation-a',
      priorityRowId: 'control-row',
    });

    expect(result).toEqual({
      success: false,
      error: 'session is waiting for input',
      promptClear: undefined,
      nativeCertainty: 'not_applied',
      nativeEntered: false,
    });
    expect(deps.getSession).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.getSessionStatus).toHaveBeenCalledTimes(3);
    expect(deps.setSessionPendingPrompt).not.toHaveBeenCalled();
    expect(deps.cancelAllAttentionForSession).not.toHaveBeenCalled();
    expect(deps.isTerminalActive).not.toHaveBeenCalled();
    expect(deps.writeToTerminal).not.toHaveBeenCalled();
    expect(deps.getProvider).not.toHaveBeenCalled();
    expect(deps.deleteFromProcessingQueue).not.toHaveBeenCalled();
    expect(deps.sweepExecutingForSession).not.toHaveBeenCalled();
    expect(provider.interruptCurrentTurn).not.toHaveBeenCalled();
  });

  it('rechecks stale A after the last awaited lookup and performs zero B native mutations', async () => {
    const { deps, provider } = createFakes('claude-code');
    vi.mocked(deps.getCurrentAttentionGeneration)
      .mockReturnValueOnce('generation-a')
      .mockReturnValue('generation-b');

    const result = await runInterruptCurrentTurnForSession(deps, SESSION_ID, {
      expectedGeneration: 'generation-a',
      priorityRowId: 'control-row',
    });

    expect(result).toEqual({
      success: false,
      error: 'stale generation',
      promptClear: undefined,
      nativeCertainty: 'not_applied',
      nativeEntered: false,
    });
    expect(deps.getSession).toHaveBeenCalledOnce();
    expect(deps.setSessionPendingPrompt).not.toHaveBeenCalled();
    expect(deps.cancelAllAttentionForSession).not.toHaveBeenCalled();
    expect(deps.deleteFromProcessingQueue).not.toHaveBeenCalled();
    expect(deps.sweepExecutingForSession).not.toHaveBeenCalled();
    expect(provider.interruptCurrentTurn).not.toHaveBeenCalled();
  });

  it.each(['claude-code', 'claude-code-cli'])(
    'rechecks the durable unknown-outcome fence at the final %s boundary',
    async (providerType) => {
      const { deps, provider } = createFakes(providerType);
      const assertInterruptFence = vi.fn(async () => false);

      const result = await runInterruptCurrentTurnForSession(deps, SESSION_ID, {
        expectedGeneration: 'generation-a',
        priorityRowId: 'control-row',
        assertInterruptFence,
      });

      expect(result).toEqual({
        success: false,
        error: 'interrupt application fence lost',
        nativeCertainty: 'not_applied',
        nativeEntered: false,
      });
      expect(assertInterruptFence).toHaveBeenCalledOnce();
      expect(deps.writeToTerminal).not.toHaveBeenCalled();
      expect(provider.interruptCurrentTurn).not.toHaveBeenCalled();
      expect(deps.setSessionPendingPrompt).not.toHaveBeenCalled();
      expect(deps.sweepExecutingForSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['idle', 'session is idle'],
    ['error', 'session is in error state'],
    [undefined, 'session status is missing'],
  ] as const)(
    'fails closed when the last eligible status is %s on provider and CLI paths',
    async (lastStatus, expectedError) => {
      for (const providerType of ['claude-code', 'claude-code-cli']) {
        const { deps, provider } = createFakes(providerType);
        vi.mocked(deps.getSessionStatus)
          .mockReturnValueOnce('running')
          .mockReturnValue(lastStatus);

        const result = await runInterruptCurrentTurnForSession(deps, SESSION_ID, {
          expectedGeneration: 'generation-a',
          priorityRowId: 'control-row',
        });

        expect(result).toMatchObject({
          success: false,
          error: expectedError,
          nativeCertainty: 'not_applied',
          nativeEntered: false,
        });
        expect(deps.writeToTerminal).not.toHaveBeenCalled();
        expect(provider.interruptCurrentTurn).not.toHaveBeenCalled();
        expect(deps.setSessionPendingPrompt).not.toHaveBeenCalled();
        expect(deps.sweepExecutingForSession).not.toHaveBeenCalled();
      }
    },
  );

  it('persists provider rejection after native entry as unknown rather than applied', async () => {
    const { deps, provider } = createFakes('claude-code');
    provider.interruptCurrentTurn.mockRejectedValueOnce(new Error('provider transport lost'));

    const result = await runInterruptCurrentTurnForSession(deps, SESSION_ID, {
      expectedGeneration: 'generation-a',
      priorityRowId: 'control-row',
    });

    expect(result).toMatchObject({
      success: false,
      error: 'provider transport lost',
      nativeCertainty: 'unknown',
      nativeEntered: true,
    });
    expect(provider.interruptCurrentTurn).toHaveBeenCalledOnce();
  });

  it('leaves a real executing B row untouched when B is claimed during the provider await', async () => {
    const db = new PGlite();
    await (db as unknown as { waitReady: Promise<void> }).waitReady;
    try {
      await db.exec(`
        CREATE TABLE queued_prompts (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', attachments JSONB,
          document_context JSONB, delivery_class TEXT NOT NULL DEFAULT 'ordinary',
          priority_rank INTEGER NOT NULL DEFAULT 0, producer TEXT,
          idempotency_key TEXT, request_digest TEXT, control_operation TEXT,
          interrupt_target_generation TEXT, interrupt_reservation_owner TEXT,
          interrupt_lease_expires_at TIMESTAMPTZ, interrupt_operation_id TEXT,
          interrupt_fence INTEGER NOT NULL DEFAULT 0,
          interrupt_application_state TEXT NOT NULL DEFAULT 'not_started',
          interrupt_started_at TIMESTAMPTZ, interrupt_applied_at TIMESTAMPTZ,
          interrupt_application_receipt JSONB, interrupt_receipt JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          claimed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, error_message TEXT
        );
      `);
      const store = createPGLiteQueuedPromptsStore(db);
      const b = await store.create({
        id: 'replacement-b-row',
        sessionId: SESSION_ID,
        prompt: 'replacement B',
      });
      let releaseNative!: () => void;
      let nativeStarted!: () => void;
      const started = new Promise<void>((resolve) => { nativeStarted = resolve; });
      const gate = new Promise<void>((resolve) => { releaseNative = resolve; });
      const { deps, provider } = createFakes('claude-code');
      provider.interruptCurrentTurn.mockImplementationOnce(async () => {
        nativeStarted();
        await gate;
        return { method: 'graceful-interrupt' };
      });
      deps.sweepExecutingForSession = vi.fn((id) => store.sweepExecutingForSession(id));

      const pending = runInterruptCurrentTurnForSession(deps, SESSION_ID, {
        expectedGeneration: 'generation-a',
        priorityRowId: 'control-row-a',
      });
      await started;
      await store.claim(b.id);
      releaseNative();
      await expect(pending).resolves.toMatchObject({ success: true });

      expect((await store.get(b.id))?.status).toBe('executing');
      expect(deps.sweepExecutingForSession).not.toHaveBeenCalled();
      expect(deps.setSessionPendingPrompt).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
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
