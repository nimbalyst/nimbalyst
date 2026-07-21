import { describe, expect, it, vi } from 'vitest';
import {
  handleHostControlRequest,
  type HostControlDependencies,
} from '../HostControlService';
import {
  PRIORITY_PROMPT_MAX_CHARS,
  type PriorityPromptDeliveryResult,
} from '../PriorityPromptDeliveryService';

const validRequest = {
  version: 1 as const,
  operation: 'watcher_obligation_event' as const,
  sessionId: 'session-1',
  prompt: 'deliver this now',
  obligationId: 'obligation-1',
  eventKey: 'terminal_observed',
};

function deliveryResult(
  deliveryObserved: boolean,
  overrides: Partial<PriorityPromptDeliveryResult> = {},
): PriorityPromptDeliveryResult {
  return {
    controlRowId: 'row-1',
    routingWorkspacePath: 'D:/exact-workspace',
    action: 'idle_dispatch_triggered',
    processingTriggerCalled: true,
    processingTriggerAccepted: true,
    interrupt: null,
    verification: {
      row: {
        id: 'row-1',
        status: deliveryObserved ? 'executing' : 'pending',
        deliveryClass: 'control',
        priorityRank: 0,
        interruptTargetGeneration: null,
        hasInterruptReceipt: false,
      },
      sessionStatus: deliveryObserved ? 'running' : 'idle',
      deliveryObserved,
    },
    ...overrides,
  };
}

function makeDeps(result = deliveryResult(true)): HostControlDependencies & {
  getSession: ReturnType<typeof vi.fn>;
  deliverPriorityPrompt: ReturnType<typeof vi.fn>;
} {
  return {
    getSession: vi.fn(async (sessionId: string) => ({
      id: sessionId,
      workspacePath: 'D:/exact-workspace',
    })),
    deliverPriorityPrompt: vi.fn(async () => result),
  };
}

describe('handleHostControlRequest', () => {
  it.each([
    ['non-object envelope', null],
    ['array envelope', []],
    ['wrong version', { ...validRequest, version: 2 }],
    ['unknown operation', { ...validRequest, operation: 'other' }],
  ])('rejects a %s with a bounded 400 receipt', async (_name, body) => {
    const deps = makeDeps();
    const result = await handleHostControlRequest(deps, body);

    expect(result.status).toBe(400);
    expect(result.receipt.accepted).toBe(false);
    expect(JSON.stringify(result.receipt).length).toBeLessThan(512);
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.deliverPriorityPrompt).not.toHaveBeenCalled();
  });

  it.each([
    ['sessionId', undefined],
    ['sessionId', '   '],
    ['prompt', undefined],
    ['prompt', ''],
    ['obligationId', undefined],
    ['obligationId', '\t'],
    ['eventKey', undefined],
    ['eventKey', '   '],
    ['eventKey', 'x'.repeat(513)],
    ['prompt', 'x'.repeat(PRIORITY_PROMPT_MAX_CHARS + 1)],
  ])('rejects invalid or oversized %s before resolving a session', async (field, value) => {
    const deps = makeDeps();
    const result = await handleHostControlRequest(deps, {
      ...validRequest,
      [field]: value,
    });

    expect(result.status).toBe(400);
    expect(result.receipt.accepted).toBe(false);
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.deliverPriorityPrompt).not.toHaveBeenCalled();
  });

  it('rejects a stale session with 404 and never calls delivery', async () => {
    const deps = makeDeps();
    deps.getSession.mockResolvedValue(null);

    const result = await handleHostControlRequest(deps, validRequest);

    expect(result).toEqual({
      status: 404,
      receipt: {
        accepted: false,
        outcome: 'session_not_found',
        errorClass: 'stale_or_missing_session',
      },
    });
    expect(deps.deliverPriorityPrompt).not.toHaveBeenCalled();
  });

  it('derives workspace only from the exact persisted session', async () => {
    const deps = makeDeps();
    deps.getSession.mockResolvedValue({
      id: validRequest.sessionId,
      workspacePath: 'D:/persisted-session-workspace',
    });

    await handleHostControlRequest(deps, {
      ...validRequest,
      workspacePath: 'D:/caller-forged-workspace',
    });

    expect(deps.deliverPriorityPrompt).toHaveBeenCalledWith({
      sessionId: validRequest.sessionId,
      workspacePath: 'D:/persisted-session-workspace',
      prompt: validRequest.prompt,
      idempotencyKey: 'watcher-obligation:obligation-1:terminal_observed',
      producer: 'watcher_obligation_event',
      controlOperation: 'watcher_obligation_event',
    });
  });

  it('returns the exact success receipt only when deliveryObserved is true', async () => {
    const verified = await handleHostControlRequest(makeDeps(deliveryResult(true)), validRequest);
    const unverified = await handleHostControlRequest(
      makeDeps(deliveryResult(false, { processingTriggerAccepted: true })),
      validRequest,
    );

    expect(verified).toEqual({
      status: 200,
      receipt: { accepted: true, outcome: 'priority_delivery_verified' },
    });
    expect(unverified.status).toBe(409);
    expect(unverified.receipt).toEqual({
      accepted: false,
      outcome: 'delivery_unverified',
      action: 'idle_dispatch_triggered',
    });
  });

  it('converts idempotency conflicts to bounded negative receipts', async () => {
    const deps = makeDeps();
    deps.deliverPriorityPrompt.mockRejectedValue(
      new Error('idempotency_conflict:watcher-obligation:secret-content'),
    );

    const result = await handleHostControlRequest(deps, validRequest);

    expect(result).toEqual({
      status: 409,
      receipt: {
        accepted: false,
        outcome: 'delivery_rejected',
        errorClass: 'idempotency_conflict',
      },
    });
    expect(JSON.stringify(result.receipt)).not.toContain(validRequest.prompt);
  });

  it('recognizes inject_attention_reply but rejects it without injected dependencies', async () => {
    const deps = makeDeps();
    const result = await handleHostControlRequest(deps, {
      version: 1,
      operation: 'inject_attention_reply',
    });

    expect(result).toEqual({
      status: 501,
      receipt: { accepted: false, outcome: 'not_yet_available' },
    });
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.deliverPriorityPrompt).not.toHaveBeenCalled();
  });

  it('routes inject_attention_reply through the exact-answer service', async () => {
    const deps = makeDeps();
    const successReceipt = {
      outcome: 'injected',
      verified: true,
      receipt: { route: 'host-attention-answer', event_cleared: true },
    };
    deps.attentionReply = {
      getPendingInteractiveEvent: vi.fn(async () => ({
        id: 'event-1',
        sessionId: 'session-1',
        promptId: 'prompt-1',
        attentionGeneration: 'generation-1',
        kind: 'interactive_prompt' as const,
        promptType: 'AskUserQuestion',
        context: { questions: [{ question: 'Deployment ring?' }] },
        status: 'pending' as const,
      })),
      respondToInteractivePrompt: vi.fn(async () => ({
        success: true,
        attentionCancelledCount: 1,
        eventCleared: true,
        nativeCertainty: 'applied' as const,
        cleanupVerified: true,
      })),
      reserveReceipt: vi.fn(async (input) => ({
        isNewReservation: true,
        row: {
          id: 'receipt-1',
          reservationKey: input.reservationKey,
          requestDigest: input.requestDigest,
          operation: 'inject_attention_reply' as const,
          sessionId: input.sessionId,
          eventIdentity: input.eventIdentity,
          attentionGeneration: input.attentionGeneration,
          state: 'reserved' as const,
          createdAt: 1,
          updatedAt: 1,
        },
      })),
      finalizeReceipt: vi.fn(async (input) => ({
        id: input.id,
        reservationKey: 'attention-reply:watch-1',
        requestDigest: 'digest',
        operation: 'inject_attention_reply' as const,
        sessionId: 'session-1',
        eventIdentity: 'prompt-1',
        attentionGeneration: 'generation-1',
        state: input.state,
        receipt: input.receipt,
        createdAt: 1,
        updatedAt: 2,
      })),
    };

    const result = await handleHostControlRequest(deps, {
      version: 1,
      operation: 'inject_attention_reply',
      watchId: 'watch-1',
      sessionId: 'session-1',
      promptId: 'prompt-1',
      attentionGeneration: 'generation-1',
      promptType: 'ask_user_question_request',
      answer: 'Canary',
    });

    expect(result).toEqual({ status: 200, receipt: successReceipt });
    expect(deps.attentionReply!.respondToInteractivePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ respondedBy: 'telegram' }),
    );
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.deliverPriorityPrompt).not.toHaveBeenCalled();
  });

  it('derives the same idempotency key for concurrent identical identities', async () => {
    const deps = makeDeps();

    await Promise.all([
      handleHostControlRequest(deps, validRequest),
      handleHostControlRequest(deps, validRequest),
    ]);

    expect(deps.deliverPriorityPrompt).toHaveBeenCalledTimes(2);
    const keys = deps.deliverPriorityPrompt.mock.calls.map(
      ([input]) => input.idempotencyKey,
    );
    expect(keys).toEqual([
      'watcher-obligation:obligation-1:terminal_observed',
      'watcher-obligation:obligation-1:terminal_observed',
    ]);
  });
});
