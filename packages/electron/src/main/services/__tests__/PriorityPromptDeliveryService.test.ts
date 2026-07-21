import { describe, expect, it, vi } from 'vitest';
import type { QueuedPrompt } from '../PGLiteQueuedPromptsStore';
import {
  createPriorityPromptDeliveryService,
  PRIORITY_PROMPT_MAX_CHARS,
  type DeliverPriorityPromptInput,
  type PriorityPromptDeliveryDependencies,
  type PrioritySessionStatus,
} from '../PriorityPromptDeliveryService';
import {
  resolveQueuedPromptDispatchTarget,
  type QueuedPromptDispatchSessionLike,
} from '../ai/queuedPromptDispatcher';

const input: DeliverPriorityPromptInput = {
  sessionId: 'session-priority',
  workspacePath: 'D:\\workspace',
  prompt: 'Inspect the obligation and resume safely.',
  idempotencyKey: 'priority:key-1',
  producer: 'watcher-obligation',
  controlOperation: 'terminal_observed',
};

const session: QueuedPromptDispatchSessionLike = {
  id: input.sessionId,
  workspacePath: input.workspacePath,
  isArchived: false,
};

function queuedRow(overrides: Partial<QueuedPrompt> = {}): QueuedPrompt {
  return {
    id: 'control-row-1',
    sessionId: input.sessionId,
    prompt: input.prompt,
    status: 'pending',
    createdAt: 1,
    deliveryClass: 'control',
    priorityRank: 100,
    producer: input.producer,
    idempotencyKey: input.idempotencyKey,
    controlOperation: input.controlOperation,
    ...overrides,
  };
}

function createFakes(options: {
  initialStatus?: PrioritySessionStatus;
  freshStatus?: PrioritySessionStatus;
  finalStatus?: PrioritySessionStatus;
  initialRow?: QueuedPrompt;
  finalRow?: QueuedPrompt | null;
  targetSession?: QueuedPromptDispatchSessionLike | null;
} = {}) {
  const initialStatus = options.initialStatus ?? 'idle';
  const freshStatus = options.freshStatus ?? initialStatus;
  const finalStatus = options.finalStatus ?? initialStatus;
  const initialRow = options.initialRow ?? queuedRow();
  const finalRow = options.finalRow === undefined ? initialRow : options.finalRow;
  const getSessionStatus = initialStatus === 'running'
    ? vi.fn()
      .mockResolvedValueOnce(initialStatus)
      .mockResolvedValueOnce(freshStatus)
      .mockResolvedValueOnce(finalStatus)
    : vi.fn()
      .mockResolvedValueOnce(initialStatus)
      .mockResolvedValueOnce(finalStatus);
  const interruptCurrentTurnForSession = vi.fn().mockResolvedValue({
    success: true,
    method: 'graceful-interrupt',
    nativeCertainty: 'applied',
    nativeEntered: true,
  });
  const queueStore = {
    createPriorityControlQueuedPrompt: vi.fn().mockResolvedValue(initialRow),
    reserveInterrupt: vi.fn().mockResolvedValue({
      reserved: true,
      takenOver: false,
      row: queuedRow({
        interruptTargetGeneration: 'generation-a',
        interruptReservationOwner: 'owner-a',
        interruptLeaseExpiresAt: Date.parse('2026-07-20T10:00:30.000Z'),
        interruptOperationId: 'operation-a',
        interruptFence: 1,
        interruptApplicationState: 'not_started',
      }),
    }),
    beginInterruptApplication: vi.fn().mockResolvedValue({
      started: true,
      row: queuedRow({
        interruptTargetGeneration: 'generation-a',
        interruptReservationOwner: 'owner-a',
        interruptOperationId: 'operation-a',
        interruptFence: 1,
        interruptApplicationState: 'unknown',
      }),
    }),
    verifyInterruptApplication: vi.fn().mockResolvedValue(true),
    enterInterruptApplication: vi.fn(async (_input, action) => ({
      owned: true as const,
      value: await action(),
    })),
    recordInterruptApplication: vi.fn().mockImplementation(async (
      application: { receipt: unknown },
    ) => queuedRow({
      interruptTargetGeneration: 'generation-a',
      interruptReservationOwner: 'owner-a',
      interruptOperationId: 'operation-a',
      interruptFence: 1,
      interruptApplicationState: 'applied',
      interruptApplicationReceipt: application.receipt,
    })),
    claimInterruptCleanup: vi.fn().mockResolvedValue(true),
    recordInterruptReceipt: vi.fn().mockResolvedValue(
      queuedRow({
        interruptTargetGeneration: 'generation-a',
        interruptReceipt: { method: 'graceful-interrupt' },
      }),
    ),
    get: vi.fn().mockResolvedValue(finalRow),
  };
  const deps: PriorityPromptDeliveryDependencies = {
    getSession: vi.fn().mockResolvedValue(
      options.targetSession === undefined ? session : options.targetSession,
    ),
    resolveDispatchTarget: vi.fn(resolveQueuedPromptDispatchTarget),
    queueStore,
    getCurrentAttentionGeneration: vi.fn().mockResolvedValue('generation-a'),
    getSessionStatus,
    interruptCurrentTurnForSession,
    triggerQueuedPromptProcessingForSession: vi.fn().mockResolvedValue(true),
    now: vi.fn(() => Date.parse('2026-07-20T10:00:00.000Z')),
    createInterruptReservationOwner: vi.fn(() => 'owner-a'),
  };
  return { deps, queueStore, interruptCurrentTurnForSession, getSessionStatus };
}

describe('createPriorityPromptDeliveryService', () => {
  it.each([
    ['sessionId', ''],
    ['prompt', '   '],
    ['idempotencyKey', ''],
    ['producer', ''],
    ['controlOperation', ''],
  ] as const)('rejects an empty %s before session lookup or queue access', async (field, value) => {
    const { deps, queueStore } = createFakes();
    const service = createPriorityPromptDeliveryService(deps);

    await expect(service.deliverPriorityPrompt({ ...input, [field]: value })).rejects.toThrow(
      `${field} must be a non-empty string`,
    );
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(queueStore.createPriorityControlQueuedPrompt).not.toHaveBeenCalled();
  });

  it('rejects an oversized prompt before session lookup or queue access', async () => {
    const { deps, queueStore } = createFakes();
    const service = createPriorityPromptDeliveryService(deps);

    await expect(service.deliverPriorityPrompt({
      ...input,
      prompt: 'x'.repeat(PRIORITY_PROMPT_MAX_CHARS + 1),
    })).rejects.toThrow(`prompt exceeds ${PRIORITY_PROMPT_MAX_CHARS} characters`);
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(queueStore.createPriorityControlQueuedPrompt).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['wrong identity', { ...session, id: 'different-session' }],
    ['archived', { ...session, isArchived: true }],
    ['retired worktree', {
      ...session,
      worktreeId: 'worktree-1',
      worktreePath: 'D:\\workspace-worktrees\\one',
      worktreeIsArchived: true,
    }],
  ] satisfies Array<[string, QueuedPromptDispatchSessionLike | null]>) (
    'fails a %s target before enqueue',
    async (_label, targetSession) => {
      const { deps, queueStore } = createFakes({ targetSession });
      const service = createPriorityPromptDeliveryService(deps);

      await expect(service.deliverPriorityPrompt(input)).rejects.toThrow('is not addressable');
      expect(deps.getSession).toHaveBeenCalledWith(input.sessionId);
      expect(queueStore.createPriorityControlQueuedPrompt).not.toHaveBeenCalled();
    },
  );

  it('fails a workspace mismatch before enqueue', async () => {
    const { deps, queueStore } = createFakes();
    const service = createPriorityPromptDeliveryService(deps);

    await expect(service.deliverPriorityPrompt({
      ...input,
      workspacePath: 'D:\\another-workspace',
    })).rejects.toThrow('is not addressable');
    expect(queueStore.createPriorityControlQueuedPrompt).not.toHaveBeenCalled();
  });

  it('propagates idempotency conflicts unchanged', async () => {
    const { deps, queueStore } = createFakes();
    queueStore.createPriorityControlQueuedPrompt.mockRejectedValueOnce(
      new Error(`idempotency_conflict:${input.idempotencyKey}`),
    );
    const service = createPriorityPromptDeliveryService(deps);

    await expect(service.deliverPriorityPrompt(input)).rejects.toThrow(
      `idempotency_conflict:${input.idempotencyKey}`,
    );
  });

  it('resolves an exact worktree alias to canonical routing and verifies post-action state', async () => {
    const worktreePath = 'D:\\workspace-worktrees\\priority';
    const finalRow = queuedRow({ status: 'completed', completedAt: 50 });
    const { deps, queueStore, getSessionStatus } = createFakes({
      initialStatus: 'idle',
      finalStatus: 'running',
      finalRow,
      targetSession: {
        ...session,
        worktreeId: 'worktree-1',
        worktreePath,
        worktreeIsArchived: false,
      },
    });
    const service = createPriorityPromptDeliveryService(deps);

    const result = await service.deliverPriorityPrompt({ ...input, workspacePath: worktreePath });

    expect(deps.triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith(
      input.sessionId,
      input.workspacePath,
    );
    expect(queueStore.get).toHaveBeenCalledWith('control-row-1');
    expect(getSessionStatus).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      routingWorkspacePath: input.workspacePath,
      action: 'idle_dispatch_triggered',
      processingTriggerCalled: true,
      processingTriggerAccepted: true,
      verification: {
        row: { id: finalRow.id, status: 'completed' },
        sessionStatus: 'running',
        deliveryObserved: true,
      },
    });
  });

  it('interrupts one active generation, records a prompt-free bounded receipt, then dispatches', async () => {
    const finalRow = queuedRow({
      status: 'executing',
      claimedAt: 10,
      interruptTargetGeneration: 'generation-a',
      interruptReceipt: { recorded: true },
    });
    const { deps, queueStore, interruptCurrentTurnForSession } = createFakes({
      initialStatus: 'running',
      finalStatus: 'running',
      finalRow,
    });
    interruptCurrentTurnForSession.mockResolvedValueOnce({
      success: false,
      error: 'e'.repeat(2_000),
      method: 'graceful-interrupt',
      nativeCertainty: 'applied',
      nativeEntered: true,
    });
    const service = createPriorityPromptDeliveryService(deps);

    const result = await service.deliverPriorityPrompt(input);

    expect(deps.getCurrentAttentionGeneration).toHaveBeenCalledWith(input.sessionId);
    expect(queueStore.reserveInterrupt).toHaveBeenCalledWith({
      id: 'control-row-1',
      expectedGeneration: 'generation-a',
      reservationOwner: 'owner-a',
      now: new Date('2026-07-20T10:00:00.000Z'),
      leaseExpiresAt: new Date('2026-07-20T10:00:30.000Z'),
    });
    expect(interruptCurrentTurnForSession).toHaveBeenCalledWith(input.sessionId, expect.objectContaining({
      expectedGeneration: 'generation-a',
      priorityRowId: 'control-row-1',
      assertInterruptFence: expect.any(Function),
    }));
    const nativeOptions = interruptCurrentTurnForSession.mock.calls[0][1]!;
    await expect(nativeOptions.assertInterruptFence!()).resolves.toBe(true);
    expect(queueStore.verifyInterruptApplication).toHaveBeenCalledWith({
      id: 'control-row-1',
      expectedGeneration: 'generation-a',
      reservationOwner: 'owner-a',
      operationId: 'operation-a',
      fence: 1,
      now: new Date('2026-07-20T10:00:00.000Z'),
    });
    expect(queueStore.recordInterruptReceipt).toHaveBeenCalledTimes(1);
    const receipt = queueStore.recordInterruptReceipt.mock.calls[0][0].receipt as Record<string, unknown>;
    expect(receipt).toMatchObject({
      method: 'graceful-interrupt',
      generation: 'generation-a',
      success: false,
      certainty: 'applied',
      nativeEntered: true,
      error: 'e'.repeat(1_000),
      attemptedAt: expect.any(String),
      resultAt: expect.any(String),
    });
    expect(queueStore.recordInterruptApplication.mock.invocationCallOrder[0])
      .toBeLessThan(queueStore.recordInterruptReceipt.mock.invocationCallOrder[0]);
    expect(JSON.stringify(receipt)).not.toContain(input.prompt);
    expect(receipt).not.toHaveProperty('prompt');
    expect(deps.triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith(
      input.sessionId,
      input.workspacePath,
    );
    expect(result).toMatchObject({
      action: 'interrupt_attempted',
      interrupt: {
        generation: 'generation-a',
        reserved: true,
        attempted: true,
        success: false,
        method: 'graceful-interrupt',
        error: 'e'.repeat(1_000),
      },
      verification: {
        row: {
          status: 'executing',
          interruptTargetGeneration: 'generation-a',
          hasInterruptReceipt: true,
        },
        deliveryObserved: true,
      },
    });
  });

  it.each([
    ['not_applied', false, true],
    ['unknown', true, false],
  ] as const)(
    'records honest %s native certainty without inventing an applied fact',
    async (nativeCertainty, nativeEntered, recordsApplicationFact) => {
      const { deps, queueStore, interruptCurrentTurnForSession } = createFakes({
        initialStatus: 'running',
        finalStatus: 'running',
      });
      interruptCurrentTurnForSession.mockResolvedValueOnce({
        success: false,
        error: nativeCertainty === 'unknown' ? 'transport lost after entry' : 'fence rejected',
        nativeCertainty,
        nativeEntered,
      });

      const result = await createPriorityPromptDeliveryService(deps).deliverPriorityPrompt(input);

      expect(result.interrupt).toMatchObject({ attempted: nativeEntered, success: false });
      expect(queueStore.recordInterruptApplication).toHaveBeenCalledTimes(
        recordsApplicationFact ? 1 : 0,
      );
      if (recordsApplicationFact) {
        expect(queueStore.recordInterruptApplication).toHaveBeenCalledWith(
          expect.objectContaining({ certainty: 'not_applied' }),
        );
      }
      expect(queueStore.recordInterruptReceipt).toHaveBeenCalledWith(expect.objectContaining({
        receipt: expect.objectContaining({ certainty: nativeCertainty, nativeEntered }),
      }));
    },
  );

  it('dispatches an idle row without reserving or interrupting', async () => {
    const { deps, queueStore, interruptCurrentTurnForSession } = createFakes({
      initialStatus: 'idle',
    });
    const service = createPriorityPromptDeliveryService(deps);

    const result = await service.deliverPriorityPrompt(input);

    expect(result.action).toBe('idle_dispatch_triggered');
    expect(queueStore.reserveInterrupt).not.toHaveBeenCalled();
    expect(interruptCurrentTurnForSession).not.toHaveBeenCalled();
    expect(queueStore.recordInterruptReceipt).not.toHaveBeenCalled();
    expect(deps.triggerQueuedPromptProcessingForSession).toHaveBeenCalledTimes(1);
  });

  it('defers a waiting native prompt without interrupting or triggering dispatch', async () => {
    const { deps, queueStore, interruptCurrentTurnForSession } = createFakes({
      initialStatus: 'waiting_for_input',
      finalStatus: 'waiting_for_input',
    });
    const service = createPriorityPromptDeliveryService(deps);

    const result = await service.deliverPriorityPrompt(input);

    expect(result).toMatchObject({
      action: 'deferred_waiting_for_input',
      processingTriggerCalled: false,
      processingTriggerAccepted: false,
      interrupt: null,
      verification: { sessionStatus: 'waiting_for_input', deliveryObserved: false },
    });
    expect(queueStore.reserveInterrupt).not.toHaveBeenCalled();
    expect(interruptCurrentTurnForSession).not.toHaveBeenCalled();
    expect(queueStore.recordInterruptReceipt).not.toHaveBeenCalled();
    expect(deps.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
  });

  it('defers when a native prompt opens after the initial running-status read', async () => {
    const { deps, queueStore, interruptCurrentTurnForSession, getSessionStatus } = createFakes({
      initialStatus: 'running',
      freshStatus: 'waiting_for_input',
      finalStatus: 'waiting_for_input',
    });
    const service = createPriorityPromptDeliveryService(deps);

    const result = await service.deliverPriorityPrompt(input);

    expect(result).toMatchObject({
      action: 'deferred_waiting_for_input',
      processingTriggerCalled: false,
      processingTriggerAccepted: false,
      interrupt: null,
      verification: { sessionStatus: 'waiting_for_input', deliveryObserved: false },
    });
    expect(getSessionStatus).toHaveBeenCalledTimes(3);
    expect(queueStore.reserveInterrupt).not.toHaveBeenCalled();
    expect(interruptCurrentTurnForSession).not.toHaveBeenCalled();
    expect(queueStore.recordInterruptReceipt).not.toHaveBeenCalled();
    expect(deps.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
  });

  it('replays a stored terminal interrupt receipt without interrupting again', async () => {
    const { deps, queueStore, interruptCurrentTurnForSession } = createFakes({
      initialStatus: 'running',
      initialRow: queuedRow({
        interruptTargetGeneration: 'generation-a',
        interruptReceipt: {
          method: 'terminal-ctrl-c',
          error: null,
          success: true,
          generation: 'g1',
          attemptedAt: '2026-07-19T10:00:00.000Z',
          resultAt: '2026-07-19T10:00:01.000Z',
        },
      }),
    });
    const service = createPriorityPromptDeliveryService(deps);

    const result = await service.deliverPriorityPrompt(input);

    expect(result.action).toBe('interrupt_already_reserved');
    expect(result.interrupt).toMatchObject({
      generation: 'g1',
      reserved: false,
      attempted: false,
      success: true,
      method: 'terminal-ctrl-c',
      error: null,
    });
    expect(interruptCurrentTurnForSession).not.toHaveBeenCalled();
    expect(queueStore.reserveInterrupt).not.toHaveBeenCalled();
    expect(queueStore.recordInterruptReceipt).not.toHaveBeenCalled();
    expect(deps.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
  });

  it.each(['idle', 'waiting_for_input', 'error', undefined] as const)(
    'replays the identical durable receipt before volatile %s routing',
    async (volatileStatus) => {
      const durableReceipt = {
        method: null,
        error: 'application outcome unknown',
        success: false,
        generation: 'generation-a',
        attemptedAt: '2026-07-20T00:00:00.000Z',
        resultAt: '2026-07-20T00:00:01.000Z',
      };
      const { deps, queueStore, interruptCurrentTurnForSession } = createFakes({
        initialRow: queuedRow({
          interruptTargetGeneration: 'generation-a',
          interruptReceipt: durableReceipt,
        }),
      });
      vi.mocked(deps.getSessionStatus).mockReset().mockResolvedValue(volatileStatus);
      const result = await createPriorityPromptDeliveryService(deps)
        .deliverPriorityPrompt(input);

      expect(result.action).toBe('interrupt_already_reserved');
      expect(result.interrupt).toMatchObject({
        generation: durableReceipt.generation,
        success: durableReceipt.success,
        method: durableReceipt.method,
        error: durableReceipt.error,
        attempted: false,
      });
      expect(queueStore.reserveInterrupt).not.toHaveBeenCalled();
      expect(interruptCurrentTurnForSession).not.toHaveBeenCalled();
      expect(deps.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
    },
  );

  it('reports an unexpired owner lease and preserves fresh post-trigger verification', async () => {
    const finalRow = queuedRow({
      status: 'executing',
      claimedAt: 10,
      interruptTargetGeneration: 'generation-a',
    });
    const { deps, queueStore, interruptCurrentTurnForSession, getSessionStatus } = createFakes({
      initialStatus: 'running',
      finalStatus: 'idle',
      finalRow,
    });
    queueStore.reserveInterrupt.mockResolvedValueOnce({
      reserved: false,
      takenOver: false,
      row: queuedRow({
        interruptTargetGeneration: 'generation-a',
        interruptReservationOwner: 'other-owner',
        interruptLeaseExpiresAt: Date.parse('2026-07-20T10:00:30.000Z'),
        interruptOperationId: 'operation-a',
        interruptFence: 1,
        interruptReceipt: undefined,
      }),
    });
    const service = createPriorityPromptDeliveryService(deps);

    const result = await service.deliverPriorityPrompt(input);

    expect(result).toMatchObject({
      action: 'interrupt_reservation_in_progress',
      interrupt: {
        generation: 'generation-a',
        reserved: false,
        attempted: false,
        success: null,
        method: null,
        error: 'interrupt reservation is owned by an unexpired lease',
      },
      verification: {
        row: { id: finalRow.id, status: 'executing' },
        sessionStatus: 'idle',
        deliveryObserved: true,
      },
    });
    expect(result.interrupt?.error).not.toContain(input.prompt);
    expect(interruptCurrentTurnForSession).not.toHaveBeenCalled();
    expect(queueStore.recordInterruptReceipt).not.toHaveBeenCalled();
    expect(deps.triggerQueuedPromptProcessingForSession).toHaveBeenCalledTimes(1);
    expect(queueStore.get).toHaveBeenCalledWith('control-row-1');
    expect(getSessionStatus).toHaveBeenCalledTimes(3);
  });

  it('takes over a crash before native intent and applies the same stable A operation once', async () => {
    const { deps, queueStore, interruptCurrentTurnForSession } = createFakes({
      initialStatus: 'running',
    });
    deps.onInterruptReconciliationPoint = vi.fn(async (point) => {
      if (point === 'after_interrupt_reserved') throw new Error('simulated_process_loss');
    });
    const service = createPriorityPromptDeliveryService(deps);

    await expect(service.deliverPriorityPrompt(input)).rejects.toThrow('simulated_process_loss');
    expect(interruptCurrentTurnForSession).not.toHaveBeenCalled();

    deps.onInterruptReconciliationPoint = undefined;
    vi.mocked(deps.getSessionStatus).mockResolvedValue('running');
    queueStore.reserveInterrupt.mockResolvedValueOnce({
      reserved: true,
      takenOver: true,
      row: queuedRow({
        interruptTargetGeneration: 'generation-a',
        interruptReservationOwner: 'owner-a',
        interruptOperationId: 'operation-a',
        interruptFence: 2,
        interruptApplicationState: 'not_started',
      }),
    });
    const replay = await service.deliverPriorityPrompt(input);

    expect(replay).toMatchObject({
      action: 'interrupt_attempted',
      interrupt: {
        generation: 'generation-a',
        attempted: true,
        success: true,
      },
    });
    expect(interruptCurrentTurnForSession).toHaveBeenCalledOnce();
    expect(queueStore.recordInterruptReceipt).toHaveBeenCalledOnce();
  });

  it('reconstructs an applied A result after process loss without reapplying it to B', async () => {
    const { deps, queueStore, interruptCurrentTurnForSession } = createFakes({
      initialStatus: 'running',
    });
    deps.onInterruptReconciliationPoint = vi.fn(async (point) => {
      if (point === 'after_interrupt_application_recorded') {
        throw new Error('simulated_process_loss');
      }
    });
    const service = createPriorityPromptDeliveryService(deps);

    await expect(service.deliverPriorityPrompt(input)).rejects.toThrow('simulated_process_loss');
    expect(interruptCurrentTurnForSession).toHaveBeenCalledOnce();
    queueStore.recordInterruptReceipt.mockClear();
    deps.onInterruptReconciliationPoint = undefined;
    vi.mocked(deps.getSessionStatus).mockResolvedValue('running');
    vi.mocked(deps.getCurrentAttentionGeneration).mockResolvedValue('generation-b');
    queueStore.reserveInterrupt.mockResolvedValueOnce({
      reserved: true,
      takenOver: true,
      row: queuedRow({
        interruptTargetGeneration: 'generation-a',
        interruptReservationOwner: 'owner-a',
        interruptOperationId: 'operation-a',
        interruptFence: 2,
        interruptApplicationState: 'applied',
        interruptApplicationReceipt: {
          method: 'graceful-interrupt',
          error: null,
          success: true,
          generation: 'generation-a',
          certainty: 'applied',
          nativeEntered: true,
          attemptedAt: '2026-07-20T10:00:00.000Z',
          resultAt: '2026-07-20T10:00:00.000Z',
        },
      }),
    });

    const replay = await service.deliverPriorityPrompt(input);

    expect(replay).toMatchObject({
      action: 'interrupt_reservation_reconciled',
      interrupt: { generation: 'generation-a', attempted: true, success: true },
    });
    expect(interruptCurrentTurnForSession).toHaveBeenCalledOnce();
    expect(queueStore.recordInterruptReceipt).toHaveBeenCalledOnce();
  });

  it('fails closed on a running session with no current generation', async () => {
    const { deps, queueStore, interruptCurrentTurnForSession } = createFakes({
      initialStatus: 'running',
    });
    vi.mocked(deps.getCurrentAttentionGeneration).mockResolvedValueOnce(undefined);
    const service = createPriorityPromptDeliveryService(deps);

    const result = await service.deliverPriorityPrompt(input);

    expect(result.action).toBe('deferred_missing_generation');
    expect(queueStore.reserveInterrupt).not.toHaveBeenCalled();
    expect(interruptCurrentTurnForSession).not.toHaveBeenCalled();
    expect(queueStore.recordInterruptReceipt).not.toHaveBeenCalled();
    expect(deps.triggerQueuedPromptProcessingForSession).toHaveBeenCalledTimes(1);
  });

  it('returns null verification when the post-action row disappears', async () => {
    const { deps } = createFakes({ finalRow: null });
    const service = createPriorityPromptDeliveryService(deps);

    const result = await service.deliverPriorityPrompt(input);

    expect(result.verification).toEqual({
      row: null,
      sessionStatus: 'idle',
      deliveryObserved: false,
    });
  });
});
