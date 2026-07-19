import { describe, expect, it, vi } from 'vitest';
import {
  handleInjectAttentionReply,
  type AttentionEventLike,
  type AttentionReplyDependencies,
  type InjectAttentionReplyRequest,
} from '../AttentionReplyInjectionService';
import type { HostControlReceiptRow } from '../HostControlReceiptsStore';

const questionText = 'Which deployment ring?';
const validRequest: InjectAttentionReplyRequest = {
  watchId: 'watch-1',
  sessionId: 'session-1',
  promptId: 'prompt-1',
  attentionGeneration: 'generation-1',
  promptType: 'ask_user_question_request',
  answer: 'Canary',
};

const validEvent: AttentionEventLike = {
  id: 'event-1',
  sessionId: 'session-1',
  promptId: 'prompt-1',
  attentionGeneration: 'generation-1',
  kind: 'interactive_prompt',
  promptType: 'AskUserQuestion',
  context: { questions: [{ question: questionText }] },
  status: 'pending',
};

function row(overrides: Partial<HostControlReceiptRow> = {}): HostControlReceiptRow {
  return {
    id: 'receipt-1',
    reservationKey: 'attention-reply:watch-1',
    requestDigest: 'digest',
    operation: 'inject_attention_reply',
    sessionId: 'session-1',
    eventIdentity: 'prompt-1',
    attentionGeneration: 'generation-1',
    state: 'reserved',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeDeps(event: AttentionEventLike | null = validEvent): AttentionReplyDependencies & {
  getPendingInteractiveEvent: ReturnType<typeof vi.fn>;
  respondToInteractivePrompt: ReturnType<typeof vi.fn>;
  reserveReceipt: ReturnType<typeof vi.fn>;
  finalizeReceipt: ReturnType<typeof vi.fn>;
} {
  return {
    getPendingInteractiveEvent: vi.fn(async () => event),
    respondToInteractivePrompt: vi.fn(async () => ({
      success: true,
      attentionCancelledCount: 1,
    })),
    reserveReceipt: vi.fn(async (input) => ({
      row: row({
        reservationKey: input.reservationKey,
        requestDigest: input.requestDigest,
      }),
      isNewReservation: true,
    })),
    finalizeReceipt: vi.fn(async (input) => row({
      state: input.state,
      receipt: input.receipt,
    })),
  };
}

describe('handleInjectAttentionReply', () => {
  it.each([
    ['missing watch', { ...validRequest, watchId: '' }],
    ['missing identity', { ...validRequest, promptId: undefined }],
    ['mismatched dual identity', { ...validRequest, toolUseId: 'other' }],
    ['oversized generation', { ...validRequest, attentionGeneration: 'x'.repeat(301) }],
    ['missing answer', { ...validRequest, answer: undefined }],
  ])('rejects %s before reservation or lookup', async (_name, request) => {
    const deps = makeDeps();
    const result = await handleInjectAttentionReply(deps, request as InjectAttentionReplyRequest);

    expect(result).toEqual({
      status: 400,
      receipt: { outcome: 'failed', verified: false, errorClass: 'invalid_request' },
    });
    expect(deps.reserveReceipt).not.toHaveBeenCalled();
    expect(deps.getPendingInteractiveEvent).not.toHaveBeenCalled();
    expect(deps.respondToInteractivePrompt).not.toHaveBeenCalled();
  });

  it('reserves before lookup and native mutation', async () => {
    const deps = makeDeps();

    await handleInjectAttentionReply(deps, validRequest);

    expect(deps.reserveReceipt.mock.invocationCallOrder[0])
      .toBeLessThan(deps.getPendingInteractiveEvent.mock.invocationCallOrder[0]);
    expect(deps.getPendingInteractiveEvent.mock.invocationCallOrder[0])
      .toBeLessThan(deps.respondToInteractivePrompt.mock.invocationCallOrder[0]);
  });

  it('returns a bounded conflict for a different digest under the same watch key', async () => {
    const seen = new Map<string, string>();
    const deps = makeDeps();
    deps.reserveReceipt.mockImplementation(async (input) => {
      const prior = seen.get(input.reservationKey);
      if (prior && prior !== input.requestDigest) throw new Error('idempotency_conflict');
      seen.set(input.reservationKey, input.requestDigest);
      return { row: row({ requestDigest: input.requestDigest }), isNewReservation: !prior };
    });

    await handleInjectAttentionReply(deps, validRequest);
    const result = await handleInjectAttentionReply(deps, {
      ...validRequest,
      answer: 'Production',
    });

    expect(result).toEqual({
      status: 409,
      receipt: { outcome: 'failed', verified: false, errorClass: 'idempotency_conflict' },
    });
    expect(JSON.stringify(result)).not.toContain('Production');
  });

  it.each([
    ['missing event', null],
    ['session mismatch', { ...validEvent, sessionId: 'session-2' }],
    ['identity mismatch', { ...validEvent, promptId: 'prompt-2' }],
    ['generation mismatch', { ...validEvent, attentionGeneration: 'generation-2' }],
  ])('fails closed as already_resolved for %s', async (_name, event) => {
    const deps = makeDeps(event as AttentionEventLike | null);
    const result = await handleInjectAttentionReply(deps, validRequest);

    expect(result).toEqual({
      status: 200,
      receipt: {
        outcome: 'already_resolved',
        verified: true,
        receipt: { route: 'host-attention-answer', event_cleared: true },
      },
    });
    expect(deps.respondToInteractivePrompt).not.toHaveBeenCalled();
  });

  it('fails closed for free text against persisted multi-question context', async () => {
    const deps = makeDeps({
      ...validEvent,
      context: {
        questions: [
          { question: 'First secret question?' },
          { question: 'Second secret question?' },
        ],
      },
    });
    const result = await handleInjectAttentionReply(deps, validRequest);

    expect(result).toEqual({
      status: 422,
      receipt: {
        outcome: 'failed',
        verified: false,
        errorClass: 'ambiguous_or_incomplete_answer',
      },
    });
    expect(deps.respondToInteractivePrompt).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('secret question');
  });

  it('accepts only a complete structured answer for persisted multi-question context', async () => {
    const deps = makeDeps({
      ...validEvent,
      context: { questions: [{ question: 'First?' }, { question: 'Second?' }] },
    });
    const result = await handleInjectAttentionReply(deps, {
      ...validRequest,
      answer: { answers: { 'First?': 'One', 'Second?': 'Two' } },
    });

    expect(result.status).toBe(200);
    expect(deps.respondToInteractivePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        response: {
          answers: { 'First?': 'One', 'Second?': 'Two' },
          cancelled: false,
        },
      }),
    );
  });

  it.each(['yes', 'allow', true, { decision: 'allow' }])(
    'never grants a non-allowlisted permission token (%j)',
    async (answer) => {
      const deps = makeDeps({
        ...validEvent,
        toolUseId: 'permission-1',
        promptId: undefined,
        promptType: 'ToolPermission',
      });
      const result = await handleInjectAttentionReply(deps, {
        watchId: 'watch-permission',
        sessionId: 'session-1',
        toolUseId: 'permission-1',
        promptType: 'permission_request',
        answer,
      });

      expect(result.status).toBe(400);
      expect(deps.respondToInteractivePrompt).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'permission approve',
      'permission_request' as const,
      'ToolPermission',
      'approve',
      { decision: 'allow', scope: 'once', cancelled: false },
    ],
    [
      'permission deny',
      'permission_request' as const,
      'ToolPermission',
      'deny',
      { decision: 'deny', scope: 'once', cancelled: false },
    ],
    [
      'plan approve',
      'exit_plan_mode_request' as const,
      'ExitPlanMode',
      'approve',
      { approved: true, clearContext: true },
    ],
    [
      'plan deny',
      'exit_plan_mode_request' as const,
      'ExitPlanMode',
      'deny',
      { approved: false, clearContext: false },
    ],
  ])('maps the exact allowlist token for %s', async (
    _name,
    promptType,
    eventPromptType,
    answer,
    expectedResponse,
  ) => {
    const deps = makeDeps({
      ...validEvent,
      promptType: eventPromptType,
    });
    const result = await handleInjectAttentionReply(deps, {
      ...validRequest,
      promptType,
      answer,
    });

    expect(result.status).toBe(200);
    expect(deps.respondToInteractivePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ promptType, response: expectedResponse, respondedBy: 'telegram' }),
    );
  });

  it('produces the exact success contract and a telegram native response', async () => {
    const deps = makeDeps();
    const result = await handleInjectAttentionReply(deps, validRequest);

    expect(result).toEqual({
      status: 200,
      receipt: {
        outcome: 'injected',
        verified: true,
        receipt: { route: 'host-attention-answer', event_cleared: true },
      },
    });
    expect(deps.respondToInteractivePrompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      promptId: 'prompt-1',
      promptType: 'ask_user_question_request',
      response: { answers: { [questionText]: 'Canary' }, cancelled: false },
      respondedBy: 'telegram',
    });
  });

  it('maps an atomically stale native response to verified already_resolved', async () => {
    const deps = makeDeps();
    deps.respondToInteractivePrompt.mockResolvedValue({ success: false, staleAction: true });

    const result = await handleInjectAttentionReply(deps, validRequest);

    expect(result.receipt).toEqual({
      outcome: 'already_resolved',
      verified: true,
      receipt: { route: 'host-attention-answer', event_cleared: true },
    });
  });

  it('does not expose answer or question text in failed receipts or errors', async () => {
    const secretAnswer = 'ANSWER-TEXT-DO-NOT-STORE';
    const secretQuestion = 'QUESTION-TEXT-DO-NOT-STORE';
    const deps = makeDeps({
      ...validEvent,
      context: { questions: [{ question: secretQuestion }, { question: 'second' }] },
    });

    const result = await handleInjectAttentionReply(deps, {
      ...validRequest,
      answer: secretAnswer,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretAnswer);
    expect(serialized).not.toContain(secretQuestion);
  });
});
