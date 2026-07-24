import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPriorityPromptDeliveryService,
  type PriorityControlPrompt,
  type PriorityInterruptReceipt,
  type PriorityTargetState,
} from '../PriorityPromptDeliveryService';

const SESSION_ID = 'target-session';
const WORKSPACE = 'D:\\repo';

function controlRow(overrides: Partial<PriorityControlPrompt> = {}): PriorityControlPrompt {
  return {
    id: 'control-row-1',
    sessionId: SESSION_ID,
    status: 'pending',
    deliveryClass: 'control',
    priorityRank: 100,
    deliveryReady: false,
    interruptTargetGeneration: null,
    interruptReservationOwner: null,
    interruptReceipt: null,
    ...overrides,
  };
}

function state(
  status: PriorityTargetState['status'],
  generation = `${status}:10:20`,
): PriorityTargetState {
  return {
    status,
    generation,
    lastActivity: 10,
    updatedAt: 20,
  };
}

describe('PriorityPromptDeliveryService', () => {
  const createControlPrompt = vi.fn();
  const getTargetState = vi.fn();
  const hasStructuredPendingPrompt = vi.fn();
  const reserveInterrupt = vi.fn();
  const recordInterruptReceipt = vi.fn();
  const interruptCurrentTurn = vi.fn();
  const triggerProcessing = vi.fn();
  const getControlPrompt = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    createControlPrompt.mockResolvedValue({
      row: controlRow(),
      replayed: false,
    });
    getTargetState.mockResolvedValue(state('idle'));
    hasStructuredPendingPrompt.mockResolvedValue(false);
    reserveInterrupt.mockImplementation(async ({ generation, owner }) => ({
      row: controlRow({
        interruptTargetGeneration: generation,
        interruptReservationOwner: owner,
      }),
      reserved: true,
    }));
    recordInterruptReceipt.mockImplementation(async ({ receipt }) =>
      controlRow({
        status: 'executing',
        interruptTargetGeneration: receipt.generation,
        interruptReservationOwner: 'owner-1',
        interruptReceipt: receipt,
      }),
    );
    interruptCurrentTurn.mockResolvedValue({
      success: true,
      method: 'interrupt',
      nativeEntered: true,
    });
    triggerProcessing.mockResolvedValue(true);
    getControlPrompt.mockResolvedValue(controlRow({ status: 'executing' }));
  });

  function createService() {
    return createPriorityPromptDeliveryService({
      createControlPrompt,
      getTargetState,
      hasStructuredPendingPrompt,
      reserveInterrupt,
      recordInterruptReceipt,
      interruptCurrentTurn,
      triggerProcessing,
      getControlPrompt,
      createReservationOwner: () => 'owner-1',
    });
  }

  it('interrupts an ordinary-text waiting session only with explicit authority', async () => {
    getTargetState
      .mockResolvedValueOnce(state('waiting_for_input'))
      .mockResolvedValueOnce(state('waiting_for_input'))
      .mockResolvedValueOnce(state('running', 'running:30:40'));

    const result = await createService().deliver({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      prompt: 'Approved; continue',
      idempotencyKey: 'reply-1',
      producer: 'send_prompt_now:caller',
      controlOperation: 'waiting_reply',
      interruptWaitingForInput: true,
    });

    expect(hasStructuredPendingPrompt).toHaveBeenCalledWith(SESSION_ID);
    expect(reserveInterrupt).toHaveBeenCalledWith(expect.objectContaining({
      generation: 'waiting_for_input:10:20',
    }));
    expect(interruptCurrentTurn).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ generation: 'waiting_for_input:10:20' }),
    );
    expect(triggerProcessing).toHaveBeenCalledWith(SESSION_ID, WORKSPACE);
    expect(result).toMatchObject({
      action: 'interrupt_attempted',
      processingTriggerCalled: true,
      processingTriggerAccepted: true,
      interrupt: {
        attempted: true,
        success: true,
      },
    });
  });

  it('durably releases an idle control row before triggering queue processing', async () => {
    getTargetState
      .mockResolvedValueOnce(state('idle'))
      .mockResolvedValueOnce(state('idle'))
      .mockResolvedValueOnce(state('running', 'running:30:40'));

    const result = await createService().deliver({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      prompt: 'Start now',
      idempotencyKey: 'idle-1',
      producer: 'send_prompt_now:caller',
      controlOperation: 'operator_directive',
      interruptWaitingForInput: false,
    });

    expect(interruptCurrentTurn).not.toHaveBeenCalled();
    expect(recordInterruptReceipt).toHaveBeenCalledWith(expect.objectContaining({
      receipt: expect.objectContaining({
        attempted: false,
        success: true,
        method: 'not-required',
        nativeEntered: false,
      }),
    }));
    expect(recordInterruptReceipt.mock.invocationCallOrder[0])
      .toBeLessThan(triggerProcessing.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({
      action: 'processing_triggered',
      processingTriggerCalled: true,
      processingTriggerAccepted: true,
    });
  });

  it('leaves a waiting answer queued when interruption authority is absent', async () => {
    getTargetState.mockResolvedValue(state('waiting_for_input'));

    const result = await createService().deliver({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      prompt: 'Continue',
      idempotencyKey: 'reply-2',
      producer: 'send_prompt_now:caller',
      controlOperation: 'waiting_reply',
      interruptWaitingForInput: false,
    });

    expect(reserveInterrupt).not.toHaveBeenCalled();
    expect(interruptCurrentTurn).not.toHaveBeenCalled();
    expect(triggerProcessing).not.toHaveBeenCalled();
    expect(result.action).toBe('queued_waiting_for_authority');
  });

  it('requires respond_to_prompt for a structured pending prompt', async () => {
    getTargetState.mockResolvedValue(state('waiting_for_input'));
    hasStructuredPendingPrompt.mockResolvedValue(true);

    const result = await createService().deliver({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      prompt: 'Approve',
      idempotencyKey: 'reply-3',
      producer: 'send_prompt_now:caller',
      controlOperation: 'waiting_reply',
      interruptWaitingForInput: true,
    });

    expect(reserveInterrupt).not.toHaveBeenCalled();
    expect(interruptCurrentTurn).not.toHaveBeenCalled();
    expect(result.action).toBe('structured_prompt_requires_response');
  });

  it('fails closed when the lifecycle changes after reservation', async () => {
    getTargetState
      .mockResolvedValueOnce(state('running', 'running:10:20'))
      .mockResolvedValueOnce(state('idle', 'idle:30:40'))
      .mockResolvedValueOnce(state('idle', 'idle:30:40'));

    const result = await createService().deliver({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      prompt: 'Act now',
      idempotencyKey: 'directive-1',
      producer: 'send_prompt_now:caller',
      controlOperation: 'operator_directive',
      interruptWaitingForInput: false,
    });

    expect(interruptCurrentTurn).not.toHaveBeenCalled();
    expect(recordInterruptReceipt).toHaveBeenCalledWith(expect.objectContaining({
      receipt: expect.objectContaining({
        success: false,
        nativeEntered: false,
        error: 'stale lifecycle generation',
      }),
    }));
    expect(result.action).toBe('stale_generation_rejected');
  });

  it('replays a durable interrupt receipt without interrupting twice', async () => {
    const receipt: PriorityInterruptReceipt = {
      generation: 'running:10:20',
      attempted: true,
      success: true,
      method: 'interrupt',
      error: null,
      nativeEntered: true,
      recordedAt: 30,
    };
    createControlPrompt.mockResolvedValue({
      row: controlRow({
        status: 'executing',
        interruptTargetGeneration: receipt.generation,
        interruptReceipt: receipt,
      }),
      replayed: true,
    });
    getControlPrompt.mockResolvedValue(controlRow({
      status: 'executing',
      interruptTargetGeneration: receipt.generation,
      interruptReceipt: receipt,
    }));

    const result = await createService().deliver({
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      prompt: 'Act now',
      idempotencyKey: 'directive-2',
      producer: 'send_prompt_now:caller',
      controlOperation: 'operator_directive',
      interruptWaitingForInput: false,
    });

    expect(reserveInterrupt).not.toHaveBeenCalled();
    expect(interruptCurrentTurn).not.toHaveBeenCalled();
    expect(result.action).toBe('interrupt_receipt_replayed');
    expect(result.interrupt).toMatchObject({ attempted: true, success: true });
  });
});
